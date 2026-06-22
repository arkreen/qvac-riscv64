# QVAC SDK on RISC-V (riscv64) — prebuilt runtime & engines

Run Tether's official **[@qvac/sdk](https://www.npmjs.com/package/@qvac/sdk)** (local AI SDK) on
**RISC-V Linux** boards such as the **StarFive VisionFive 2** (JH7110 / SiFive U74, `rv64gc`, no vector ext).

This repo provides the missing **riscv64** pieces — Tether/Holepunch only ship x64/arm64/darwin/android/ios:

- a **Bare** runtime built on **V8** (`14.8.x`), cross-compiled for `riscv64`
- all required **native addons** (`bare-*`, `sodium-native`, `rocksdb-native`, …) as `.bare` prebuilds
- Tether's inference engines (`@qvac/llm-llamacpp`, `embed`, `tts`, `diffusion`, `vla`, `classification`) as `riscv64` `.bare`

The SDK JavaScript itself is **unmodified** and installed from npm. We only supply the `riscv64` binaries.

> Proof: on a VisionFive 2 this loads `qwen2.5-0.5b` through the official SDK and streams real tokens
> (`"hello from risc-v"`, ~1.3 tok/s, CPU). See [`docs/QVAC-on-RISCV-port.md`](docs/QVAC-on-RISCV-port.md)
> for the full porting writeup (6 upstream RISC-V fixes, build pipeline, what works / what's missing).

## Quick start (on a RISC-V board, glibc ≥ 2.36)

```bash
curl -fsSL https://raw.githubusercontent.com/arkreen/qvac-riscv64/main/scripts/setup-vf2.sh | bash
```

This installs the official `@qvac/sdk` from npm, downloads the `riscv64` runtime + prebuilds from
[Releases](https://github.com/arkreen/qvac-riscv64/releases), wires them in, fetches a small GGUF model,
and runs a completion. Requires: `riscv64` Linux, `node`/`npm`, glibc ≥ 2.36, libstdc++ with `GLIBCXX_3.4.30`.

## What works

| Modality | Engine | Status |
|---|---|---|
| Text generation | `@qvac/llm-llamacpp` | ✅ real inference verified |
| Embeddings | `@qvac/embed-llamacpp` | ✅ loads |
| TTS / Diffusion / VLA / Classification | ggml-based | ✅ engines load |
| Transcription (whisper/parakeet), Translation (nmt) | — | ⚠️ engine build gaps (see docs) |
| OCR / ONNX | onnxruntime/opencv | ⛔ not attempted on riscv64 |

## Components & licenses

Binaries are compiled from open-source upstreams: V8 (BSD), Bare/libjs/bare-* (Apache-2.0),
ggml (MIT), qvac-fabric / @qvac engines (Apache-2.0). The official SDK is fetched from npm under its own license.
See [`NOTICE.md`](NOTICE.md).

## Related upstream contribution

[tetherto/qvac-registry-vcpkg#201](https://github.com/tetherto/qvac-registry-vcpkg/pull/201) — make the
`ggml`/`ggml-speech` vcpkg ports build CPU-scalar on no-vector riscv64.
