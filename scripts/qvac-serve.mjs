// qvac-serve.mjs — REST API wrapper around the QVAC SDK LLM, running on riscv64 / VF2.
//
// Runs ENTIRELY inside the self-built riscv64 `bare` runtime (VF2's Node is too old
// for @qvac/sdk). The model is loaded ONCE at startup and kept warm; bare-http1 serves
// an OpenAI-compatible HTTP API so any device on the LAN can call it.
//
//   ~/rvbare/bare qvac-serve.mjs [port] [model.gguf]
//   defaults: port 8080, model ~/models/qwen2.5-0.5b-instruct-q4_k_m.gguf
//
// Endpoints:
//   GET  /health                 -> { status, model, modelId }
//   GET  /v1/models              -> OpenAI-style model list
//   POST /v1/chat/completions    -> OpenAI-compatible (messages[] or prompt; stream:true => SSE)
//   POST /generate               -> alias of the above
//
// Inference is single-instance, so requests are serialized through a one-at-a-time lock.

import { plugins } from '@qvac/sdk'
import { llmPlugin } from '@qvac/sdk/llamacpp-completion/plugin'
import http from 'bare-http1'

// Safety net: a client dropping mid-request (the VF2 link is flaky) makes bare-tcp
// emit a socket 'error'; unhandled, it would crash the whole server. Swallow these
// so a single broken connection can never take the service down.
Bare.on('uncaughtException', (err) => console.log('[qvac-serve] uncaughtException (ignored):', String((err && err.stack) || err)))
Bare.on('unhandledRejection', (err) => console.log('[qvac-serve] unhandledRejection (ignored):', String((err && err.stack) || err)))

const PORT  = parseInt(Bare.argv[2] || '8080', 10)
// Pass an explicit .gguf path as the 2nd arg, or run from the dir that holds `model.gguf`
// (setup-vf2.sh puts it at $WORK/model.gguf).
const MODEL = Bare.argv[3] || 'model.gguf'
const HOST  = '0.0.0.0'
const CTX_SIZE = 1024
const DEFAULT_MAX_TOKENS = 256

console.log('[qvac-serve] loading model:', MODEL)
const { loadModel, completion } = plugins([llmPlugin])
const model = await loadModel({
  modelSrc: MODEL,
  modelType: 'llamacpp-completion',
  modelConfig: { ctx_size: CTX_SIZE }
})
const modelId = model.modelId || model
console.log('[qvac-serve] model loaded, modelId=', String(modelId))

// ---- single-flight guard: only ONE inference at a time; if busy, reject (429) ----
// The model is a single instance — a concurrent run would corrupt its state, double the
// CPU load and risk the board's power budget. We fail fast rather than queue unbounded.
// `busy` is checked-and-set with no `await` in between, so the guard is race-free.
let busy = false

// ---- core inference: drive the QVAC completion run, optionally streaming deltas ----
async function infer (history, maxTokens, onDelta) {
  const run = completion({ modelId, history, maxTokens, stream: true })
  let out = ''
  for await (const ev of run.events) {
    if (ev.type === 'contentDelta' && ev.text) {
      out += ev.text
      if (onDelta) onDelta(ev.text)
    }
  }
  const final = await run.final
  return { text: out, final }
}

// ---- helpers ----
function readBody (req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += typeof c === 'string' ? c : c.toString() })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJSON (res, code, obj) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.writeHead(code)
  res.write(JSON.stringify(obj))
  res.end()
}

function toHistory (body) {
  if (Array.isArray(body.messages) && body.messages.length) {
    return body.messages.map((m) => ({ role: m.role || 'user', content: String(m.content ?? '') }))
  }
  if (typeof body.prompt === 'string') {
    return [{ role: 'user', content: body.prompt }]
  }
  return null
}

const now = () => Math.floor(Date.now() / 1000)

// ---- HTTP server ----
const safeWrite = (res, s) => { try { res.write(s) } catch (_) {} }

const server = http.createServer(async (req, res) => {
  // never let a dropped client crash us
  req.on('error', () => {})
  res.on('error', () => {})
  try {
    const path = (req.url || '/').split('?')[0]

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      return sendJSON(res, 200, {
        status: 'ok', engine: 'qvac-sdk', runtime: 'bare', arch: 'riscv64',
        model: MODEL, modelId: String(modelId)
      })
    }

    if (req.method === 'GET' && path === '/v1/models') {
      return sendJSON(res, 200, {
        object: 'list',
        data: [{ id: String(modelId), object: 'model', created: now(), owned_by: 'qvac-riscv64' }]
      })
    }

    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/generate')) {
      const raw = await readBody(req)
      let body
      try { body = raw ? JSON.parse(raw) : {} } catch (e) { return sendJSON(res, 400, { error: 'invalid JSON body' }) }

      const history = toHistory(body)
      if (!history) return sendJSON(res, 400, { error: 'request needs messages[] or prompt' })
      const maxTokens = Number(body.max_tokens || body.maxTokens || DEFAULT_MAX_TOKENS)
      const stream = body.stream === true

      // Reject if an inference is already running — do NOT start a second one.
      // (check + set with no `await` between them => no race in single-threaded JS)
      if (busy) {
        res.setHeader('Retry-After', '5')
        return sendJSON(res, 429, { error: 'server busy: an inference is already in progress, retry later', busy: true })
      }
      busy = true
      try {
        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.writeHead(200)
          await infer(history, maxTokens, (delta) => {
            safeWrite(res, 'data: ' + JSON.stringify({
              id: 'chatcmpl-rv', object: 'chat.completion.chunk', created: now(), model: String(modelId),
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
            }) + '\n\n')
          })
          safeWrite(res, 'data: ' + JSON.stringify({
            id: 'chatcmpl-rv', object: 'chat.completion.chunk', created: now(), model: String(modelId),
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          }) + '\n\n')
          safeWrite(res, 'data: [DONE]\n\n')
          res.end()
          return
        }

        const { text, final } = await infer(history, maxTokens)
        const stats = (final && final.stats) || {}
        return sendJSON(res, 200, {
          id: 'chatcmpl-rv', object: 'chat.completion', created: now(), model: String(modelId),
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: {
            completion_tokens: stats.completionTokens ?? null,
            tokens_per_second: stats.tokensPerSecond ?? null
          },
          qvac: { runtime: 'bare', arch: 'riscv64', backendDevice: stats.backendDevice ?? 'cpu', stats }
        })
      } finally {
        busy = false   // always release, even on error / client disconnect
      }
    }

    return sendJSON(res, 404, {
      error: 'not found',
      endpoints: ['GET /health', 'GET /v1/models', 'POST /v1/chat/completions', 'POST /generate']
    })
  } catch (err) {
    try { sendJSON(res, 500, { error: String((err && err.message) || err) }) } catch (_) {}
  }
})

server.on('listening', () => console.log(`[qvac-serve] listening on http://${HOST}:${PORT}  (POST /v1/chat/completions)`))
server.on('error', (e) => console.log('[qvac-serve] server error:', String(e)))
server.listen(PORT, HOST)
