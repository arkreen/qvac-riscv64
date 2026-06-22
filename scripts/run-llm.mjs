// Run a real LLM completion through the official @qvac/sdk on riscv64.
// Usage:  ~/qvac-rv/bare scripts/run-llm.mjs ./model.gguf "your prompt"
import { plugins } from '@qvac/sdk'
import { llmPlugin } from '@qvac/sdk/llamacpp-completion/plugin'

const argv = (typeof Bare !== 'undefined') ? Bare.argv : process.argv
const modelPath = argv[2] || './model.gguf'
const prompt = argv[3] || 'Reply with exactly: hello from risc-v'

const { loadModel, completion } = plugins([llmPlugin])
console.log('Loading model:', modelPath)
const model = await loadModel({ modelSrc: modelPath, modelType: 'llamacpp-completion', modelConfig: { ctx_size: 1024 } })
const mid = model.modelId || model
const run = completion({ modelId: mid, history: [{ role: 'user', content: prompt }], maxTokens: 48, stream: true })
let out = ''
for await (const ev of run.events) {
  if (ev.type === 'contentDelta' && ev.text) { out += ev.text; console.log('TOK', JSON.stringify(ev.text)) }
}
const fin = await run.final
console.log('\n=== OUTPUT:', JSON.stringify(out))
try { console.log('=== stats:', JSON.stringify(fin.stats || {})) } catch {}
