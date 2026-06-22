# QVAC SDK on RISC-V (riscv64)

Run Tether's official **[@qvac/sdk](https://www.npmjs.com/package/@qvac/sdk)** (a local, on-device AI SDK)
on **RISC-V Linux** boards such as the **StarFive VisionFive 2** (JH7110 / SiFive U74, `rv64gc`).

Tether and Holepunch only publish prebuilt binaries for x64 / arm64 / darwin / android / ios — **there is no
riscv64 build**. This repo supplies the missing riscv64 pieces so the *unmodified* SDK runs on RISC-V:

- a **Bare** runtime built on **V8** (`14.8.x`), cross-compiled for `riscv64`
- every required **native addon** (`bare-*`, `sodium-native`, `rocksdb-native`, …) as a `.bare` prebuild
- Tether's inference engines (`@qvac/llm-llamacpp`, `embed`, `tts`, `diffusion`, `vla`, `classification`) as riscv64 `.bare`

The SDK JavaScript is installed from npm and is **byte-for-byte the official release** — we only add the native binaries.

> **Verified:** on a VisionFive 2 this loads `qwen2.5-0.5b` through the official SDK and streams real tokens
> (`"hello from risc-v"`, ~1.3 tok/s, CPU). See [`docs/QVAC-on-RISCV-port.md`](docs/QVAC-on-RISCV-port.md) for the
> full porting writeup.

---

## 1. Requirements

| | |
|---|---|
| **CPU** | RISC-V 64-bit, `rv64gc` (RVV/vector **not** required — the build is portable scalar) |
| **OS** | Linux with **glibc ≥ 2.35** and a libstdc++ providing **`GLIBCXX_3.4.30`** (e.g. Debian 12 “bookworm”-era, GCC 12) |
| **Libs** | OpenSSL 3 (`libssl.so.3`, `libcrypto.so.3`) — present on any current Debian/Ubuntu |
| **Tools** | `node` + `npm` (Node 18+), `curl`, `tar` |
| **Disk** | ~1.5 GB free (SDK + engines + a 0.5B model) |
| **RAM** | ≥ 2 GB (4 GB+ recommended) |

Check your board:
```bash
uname -m                  # must print: riscv64
ldd --version | head -1   # glibc version
strings /usr/lib/riscv64-linux-gnu/libstdc++.so.6 | grep -m1 GLIBCXX_3.4.30 && echo "libstdc++ OK"
node -v && npm -v
```

> Tested on **Debian (glibc 2.36)** on a VisionFive 2. The binaries only reference glibc symbols ≤ 2.33 and
> `GLIBCXX` ≤ 3.4.30, so any reasonably current riscv64 Linux should work. **Do not** bundle a newer glibc —
> use the system one (a newer dynamic loader can crash on these boards).

---

## 2. Quick start (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/boat-x/qvac-riscv64/main/scripts/setup-vf2.sh | bash
```

This installs `@qvac/sdk` from npm, downloads the riscv64 runtime + prebuilds from
[Releases](https://github.com/boat-x/qvac-riscv64/releases/latest), wires them in, fetches a small GGUF model,
and runs a real completion. Expected tail of the output:

```
TOK "hello"
TOK " from"
TOK " r"
TOK "isc"
TOK "-v"
=== OUTPUT: "hello from risc-v"
=== stats: {"tokensPerSecond":1.28,...,"backendDevice":"cpu"}
```

Everything lands in `~/qvac-rv/`. To run again later:
```bash
~/qvac-rv/bare ~/qvac-rv/run-llm.mjs ~/qvac-rv/model.gguf "Write a haiku about RISC-V"
```

If `~/qvac-rv` is taken, set `QVAC_RV_HOME=/path` before running the script.

---

## 3. Manual setup (step by step)

Prefer to understand / debug each step? The one-liner above just automates this:

```bash
WORK=$HOME/qvac-rv
mkdir -p "$WORK" && cd "$WORK"

# 3a. Official SDK from npm (unmodified JavaScript). Pinned to the version these
# riscv64 prebuilds were validated against.
npm init -y >/dev/null
npm install @qvac/sdk@0.13.5

# 3b. riscv64 Bare runtime + native prebuilds (from this repo's Release)
REL=https://github.com/boat-x/qvac-riscv64/releases/latest/download
curl -fL "$REL/bare-riscv64.tar.gz"           -o /tmp/bare-rv.tgz
curl -fL "$REL/qvac-prebuilds-riscv64.tar.gz"  -o /tmp/pb-rv.tgz
tar xzf /tmp/bare-rv.tgz -C "$WORK"            # -> $WORK/bare  (the runtime)
chmod +x "$WORK/bare"
mkdir -p /tmp/pb && tar xzf /tmp/pb-rv.tgz -C /tmp/pb
# drop each <pkg>/*.bare into node_modules/.../prebuilds/linux-riscv64/
for d in /tmp/pb/prebuilds-riscv64/*/; do
  pkg=$(basename "$d")
  for c in "node_modules/@qvac/$pkg" "node_modules/$pkg"; do
    [ -d "$c" ] || continue
    mkdir -p "$c/prebuilds/linux-riscv64"
    cp "$d"*.bare "$c/prebuilds/linux-riscv64/"
    # also an unversioned <name>.bare so it matches any installed package version
    for f in "$d"*.bare; do n=$(basename "$f"); cp "$f" "$c/prebuilds/linux-riscv64/${n%@*}.bare"; done
  done
done

# 3c. Tell the SDK which `bare` binary to spawn (riscv64 has no published bare-runtime package)
mkdir -p node_modules/bare-runtime-linux-riscv64
echo '{"name":"bare-runtime-linux-riscv64","version":"1.0.0","main":"index.js"}' \
  > node_modules/bare-runtime-linux-riscv64/package.json
printf 'module.exports = { bare: "%s/bare" }\n' "$WORK" \
  > node_modules/bare-runtime-linux-riscv64/index.js

# 3d. A model (see §4)
curl -fL "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf" \
  -o "$WORK/model.gguf"

# 3e. Run
curl -fsSL https://raw.githubusercontent.com/boat-x/qvac-riscv64/main/scripts/run-llm.mjs -o "$WORK/run-llm.mjs"
"$WORK/bare" "$WORK/run-llm.mjs" "$WORK/model.gguf" "In 5 words, what is RISC-V?"
```

---

## 4. Models

Any **GGUF** model that llama.cpp supports works (`modelType: "llamacpp-completion"`). The demo uses a small one
so it loads fast:

| Source | URL |
|---|---|
| Hugging Face (default) | `https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf` |
| ModelScope (better in China) | `https://modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/master/qwen2.5-0.5b-instruct-q4_k_m.gguf` |

Override the model the setup script downloads:
```bash
QVAC_MODEL_URL="https://modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/master/qwen2.5-0.5b-instruct-q4_k_m.gguf" \
  bash <(curl -fsSL https://raw.githubusercontent.com/boat-x/qvac-riscv64/main/scripts/setup-vf2.sh)
```
Or point `run-llm.mjs` at any local `.gguf`:
```bash
~/qvac-rv/bare ~/qvac-rv/run-llm.mjs /path/to/your-model.gguf "your prompt"
```
Bigger models work too but are slow on CPU without the vector extension — start small.

---

## 5. Using the SDK in your own code

[`scripts/run-llm.mjs`](scripts/run-llm.mjs) is the minimal example. The key bit: register only the engines you
have via the official `plugins([...])` API (Bare-client mode), then call `loadModel` / `completion`:

```js
import { plugins } from '@qvac/sdk'
import { llmPlugin } from '@qvac/sdk/llamacpp-completion/plugin'

const { loadModel, completion } = plugins([llmPlugin])
const model = await loadModel({ modelSrc: './model.gguf', modelType: 'llamacpp-completion', modelConfig: { ctx_size: 1024 } })
const run = completion({ modelId: model.modelId, history: [{ role: 'user', content: 'Hello' }], stream: true })
for await (const ev of run.events) if (ev.type === 'contentDelta') console.log(ev.text)
await run.final
```
Run it with the riscv64 bare: `~/qvac-rv/bare your-script.mjs`. (Under Bare use `Bare`, not `process`.)

---

## 6. What works on riscv64

| Modality | Engine | Status |
|---|---|---|
| Text generation | `@qvac/llm-llamacpp` | ✅ real inference verified |
| Embeddings | `@qvac/embed-llamacpp` | ✅ loads |
| Text classification | `@qvac/classification-ggml` | ✅ loads |
| VLA | `@qvac/vla-ggml` | ✅ loads |
| Text-to-speech | `@qvac/tts-ggml` | ✅ loads |
| Image generation | `@qvac/diffusion-cpp` | ✅ loads |
| Transcription (whisper / parakeet) | whisper-cpp | ⚠️ engine build gaps (`<format>` / `bare-ffmpeg`) |
| Translation (nmt) | sentencepiece | ⚠️ not yet building on riscv64 |
| OCR / generic ONNX | onnxruntime / opencv | ⛔ not attempted on riscv64 |

Details and the remaining work are in [`docs/QVAC-on-RISCV-port.md`](docs/QVAC-on-RISCV-port.md).

---

## 7. Troubleshooting

- **`uname -m` is not `riscv64`** — these binaries are riscv64-only; you're on the wrong architecture.
- **`version 'GLIBC_2.xx' not found` / `GLIBCXX_3.4.3x not found`** — your system libs are too old. These builds
  target glibc ≤ 2.33 / `GLIBCXX_3.4.30`; update to a current Debian/Ubuntu riscv64. (Don't try to bundle a newer
  glibc — a newer loader can segfault on JH7110-class boards.)
- **`Cannot find addon … bare-ffmpeg`** when loading transcription plugins — those plugins aren't built yet; only
  register the engines you have (the demo registers `llmPlugin` only).
- **Model download is slow / blocked** — use the ModelScope URL (China) or any local `.gguf` (see §4).
- **GitHub Release download is slow** — mirror the two tarballs to a host near you and `curl` from there; the
  layout is identical.
- **`bare: not found` / permission denied** — `chmod +x ~/qvac-rv/bare`.

---

## 8. How it was built

[`docs/QVAC-on-RISCV-port.md`](docs/QVAC-on-RISCV-port.md) covers the full pipeline: cross-compiling V8 from
Chromium source, BYO-V8 Bare, the cross toolchain, the six upstream RISC-V fixes, and what's left. Upstream
contribution: [tetherto/qvac-registry-vcpkg#201](https://github.com/tetherto/qvac-registry-vcpkg/pull/201)
(ggml/ggml-speech no-vector riscv64 support).

## 9. Licenses

Binaries are compiled from open-source upstreams (V8 BSD; Bare / bare-* Apache-2.0; ggml MIT; qvac engines
Apache-2.0). The SDK is installed from npm under its own license. See [`NOTICE.md`](NOTICE.md).
