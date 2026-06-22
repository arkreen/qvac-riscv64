# Porting the Tether QVAC SDK to RISC-V (StarFive VisionFive 2)

> Status: **core goal achieved** — the official `@qvac/sdk@0.13.5` + a self-built riscv64 V8/Bare + a self-built
> riscv64 llama engine load `qwen2.5-0.5b` on a real VisionFive 2 and stream real LLM tokens
> (`"hello from risc-v"`, ~1.3 tok/s, CPU).
>
> Written: 2026-06-22

---

## 0. TL;DR

QVAC only ships prebuilds for x64/arm64/darwin/android/ios — **no riscv64**. Its runtime is Holepunch's **Bare**
(default engine V8), and there's no riscv64 V8/Bare prebuild either. This work **cross-compiles the entire chain
from source for riscv64** (V8 → libjs → Bare → all `bare-*` / native addons → the qvac-fabric inference engine →
the `@qvac` engine addons), fixing **6 classes of upstream defects** along the way, so that the **byte-for-byte
official SDK** runs on RISC-V.

---

## 1. Target device & constraints

| | |
|---|---|
| Board | StarFive VisionFive 2, JH7110 (SiFive U74, 4 cores, **rv64gc, no RVV vector extension**) |
| OS | Debian, kernel `6.12.5-starfive`, **glibc 2.36**, system libstdc++ up to `GLIBCXX_3.4.30` (GCC 12) |
| Network | npmjs reachable; GitHub intermittent; Hugging Face blocked (models fetched from ModelScope) |
| Key constraints | No RVV → all ggml/llama must run scalar; older glibc/libstdc++ → binaries must not need newer symbols |

Build host: GCP `c2d-standard-32` (32 cores, x64, on-demand). **All heavy lifting is cross-compiled on GCP;
only the artifacts are shipped to the VF2** (the board is weak on both compute and network).

---

## 2. Architecture & dependency chain (why this is hard)

```
@qvac/sdk (JS, official npm)
   └─ runtime: Bare (Holepunch, default engine = V8)
        ├─ V8 14.8.178.31  ← from Chromium 148.0.7778.265, no official riscv64 prebuild
        ├─ libjs (V8's C ABI wrapper) + libuv + libutf
        └─ native addons (.bare):
             ├─ bare-* infrastructure (bare-fs/tls/crypto/...)  ×20
             ├─ Holepunch native (sodium/udx/rocksdb/...)
             └─ @qvac/<engine> inference-engine addons
                  └─ vcpkg pulls qvac-fabric (Tether's llama.cpp+ggml fork) etc.
```

**Key realization:** QVAC is tightly bound to Bare (even a Node-side client *spawns a `bare` worker* for inference).
So "skip Bare, use Node" does not work — **Bare itself, together with its V8 engine, must be ported to riscv64.**
We first tried replacing V8 with Holepunch's **libqjs (QuickJS engine)** to dodge V8, but QuickJS hit a
**stubbed dynamic `import()`** plus CJS-interop problems in the worker bootstrap and the full SDK wouldn't run →
we went back to **building V8**.

---

## 3. How it was done (build pipeline)

### 3.1 Cross-compile V8 (the hardest part)

- Reuse Holepunch's **`chromium-prebuilds`** repo (it defines the exact V8 GN config Bare uses: monolithic, no
  pointer compression / sandbox / temporal). It supports android/darwin/ios/linux-arm64/linux-x64/win32 —
  **but not linux-riscv64**.
- Two tiny new files make it recognize riscv64 (see §6, PR-2):
  - `arch/riscv64.gni` = `target_cpu = "riscv64"`
  - `target/linux-riscv64.gni` = `import platform/linux.gni + arch/riscv64.gni`
- `gclient sync` pulls the full Chromium 148 tree (~115 GB); cross-compile with Chromium's **bundled clang** +
  the downloaded **trixie riscv64 sysroot**. Chromium 148 has first-class riscv64 support
  (`clang_toolchain("clang_riscv64")` / `clang_v8_toolchain("clang_x64_v8_riscv64")`).
- Output: `libv8.a` (154 MB) + `libc++.a`, riscv64 objects (`rv64gc/lp64d`).

### 3.2 Cross-compile Bare (BYO-V8)

- libjs/Bare support **BYO-V8**: `bare-make generate -D GN_DIR=<chromium>/src -D GN_OUT_DIR=...`. But bare-make's
  bundled `cmake-toolchains/linux-riscv64.cmake` **sets no sysroot** → we use our own toolchain (§4) to drive
  cmake-runtime's cmake directly (which is the cmake ≥ 4.0 Bare requires).
- Critical switch: `-DBARE_PREBUILDS=OFF` (otherwise Bare fetches a non-existent riscv64 libc++ prebuild from
  Holepunch's Hyperdrive and fails), so libjs gets V8/libc++ from our GN tree via cmake-gn's
  `add_gn_target(v8/c++ prebuilds:...)`.
- Output: `bare` (89 MB, riscv64) — **runs JS on the real board** (arithmetic / JIT / Promise / event loop).

### 3.3 All native addons

- A reusable script `build_engine.sh <pkg>`: `npm i` (for cmake-bare etc.) → patch CMakeLists → vcpkg installs
  deps → cmake configure (our toolchain + `CMAKE_PREFIX_PATH` pointing at the prebuilt dep tree) → ninja →
  collect `.bare`.
- The 20 `bare-*`, sodium/udx/rocksdb/fs-native-extensions/rabin, and every `@qvac` engine go through this.

### 3.4 Inference engine (qvac-fabric)

- `@qvac/llm-llamacpp` etc. use **vcpkg** to pull `qvac-fabric` (Tether's llama.cpp+ggml fork) from
  `tetherto/qvac-registry-vcpkg`.
- Cross-compile via a vcpkg **overlay-triplet** (`riscv64-linux`, `VCPKG_CHAINLOAD_TOOLCHAIN_FILE` = our
  toolchain) + **overlay-ports** (disable RVV/Vulkan, see §5). Output: `libllama.a`/`libggml*.a`/`libmtmd.a`/
  `libcommon.a`.

### 3.5 Deploy & run

- Tarball the artifacts; the VF2 pulls them directly from the build host (VF2→GCP:22 is reachable) into each
  `node_modules/<pkg>/prebuilds/linux-riscv64/`.
- **Don't bundle glibc** (key lesson, §5.7): Bare only needs `GLIBC ≤ 2.33` / `GLIBCXX ≤ 3.4.30`, satisfied by
  the system libs. Just run `./bare app.js`.

---

## 4. The final cross toolchain

`riscv64-clang.cmake` (every line is a lesson learned):
```cmake
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR riscv64)
# Reuse Chromium's bundled clang + lld (it builds riscv64 V8 → it supports riscv64)
set(CMAKE_C_COMPILER   <chromium>/src/third_party/llvm-build/Release+Asserts/bin/clang)
set(CMAKE_CXX_COMPILER <chromium>/.../clang++)
set(CMAKE_AR/RANLIB/NM  .../llvm-ar | llvm-ranlib(symlink to llvm-ar) | llvm-nm)
set(CMAKE_SYSROOT <chromium>/src/build/linux/debian_trixie_riscv64-sysroot)
# Match V8's riscv64 objects exactly; -U cancels the vector macro Clang wrongly defines for rv64gc
set(_t "--target=riscv64-linux-gnu -march=rv64gc -mabi=lp64d -U__riscv_v_intrinsic")
set(CMAKE_{C,CXX,ASM}_FLAGS_INIT "${_t}")
set(CMAKE_{EXE,SHARED,MODULE}_LINKER_FLAGS_INIT "-fuse-ld=lld --target=riscv64-linux-gnu")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)   # use host programs
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH)    # not ONLY: else find_library is locked to the sysroot and misses vcpkg-installed libs
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE BOTH)    # so cmake-* helpers resolve from node_modules / CMAKE_PREFIX_PATH
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)            # Chromium clang ships no clang-scan-deps; disable C++20 module scanning
set(CMAKE_POSITION_INDEPENDENT_CODE ON)        # .a goes into a .bare (shared) → must be PIC
```

---

## 5. Defects found and fixed (6 classes)

### 5.1 V8 RISC-V backend missing `VisitWord64MulWide` (a real upstream gap)
- **Symptom:** building V8 fails at 89% with `mksnapshot` link error
  `undefined symbol: InstructionSelector::VisitWord64MulWide(turboshaft::OpIndex, bool)`.
- **Cause:** the shared Turboshaft layer `instruction-selector.cc` dispatches `Word64MulWide` (64×64→128-bit
  widening multiply) to every backend; x64/arm64/mips64/loong64 define it, **riscv64 doesn't**.
- **Fix:** add a stub identical to mips64/loong64 (the op isn't actually generated on 64-bit RISC backends):
  ```cpp
  // src/compiler/backend/riscv/instruction-selector-riscv64.cc
  void InstructionSelector::VisitWord64MulWide(OpIndex node, bool is_signed) {
    UNIMPLEMENTED();
  }
  ```

### 5.2 ggml wrongly compiles RVV on no-vector riscv64 + clang (real upstream defect, biggest blast radius)
- **Symptom:** ggml-cpu fails: `RISC-V type 'vfloat32m8_t' requires the 'zve32f' extension` (we use `-march=rv64gc`,
  no V).
- **Cause:** ggml gates RVV code on `#if defined(__riscv_v_intrinsic)`, but **Chromium clang defines
  `__riscv_v_intrinsic=1000000` even for `rv64gc` (no V)** (GCC only defines it when V is enabled, so a native GCC
  build never trips this; the clang cross-build does). Per LLVM, `__riscv_v_intrinsic` means "the compiler
  supports the RVV intrinsics", while `__riscv_vector` means "the V extension is enabled".
- **Fix (two parts):**
  1. Toolchain-wide `-U__riscv_v_intrinsic` (cancel the macro).
  2. For qvac-fabric's vendored ggml, the overlay portfile rewrites `__riscv_v_intrinsic` → `__riscv_vector`
     (only defined when V is truly on) and passes `-DGGML_RVV=OFF -DGGML_RV_ZFH/ZVFH/ZICBOP/ZIHINTPAUSE=OFF`.

### 5.3 Standalone `ggml` / `ggml-speech` vcpkg ports force RVV + Vulkan on riscv64
- **Symptom:** whisper/tts/diffusion stall at `Adding CPU backend variant ggml-cpu: -march=rv64gcv_zfh_zvfh...`
  (forces `v`!) + `Could NOT find Vulkan (missing: glslc)`.
- **Cause:** these ports assume `riscv64 ⟹ has RVV`, and default/hard-code `GGML_VULKAN=ON`.
- **Fix:** overlay-port each of `ggml` and `ggml-speech`, forcing `-DGGML_VULKAN=OFF` + `GGML_RVV/RV_*=OFF`, and
  drop linux's `vulkan` default-feature from `ggml`'s vcpkg.json. (Submitted upstream — see §6 PR-1.)

### 5.4 libjstl `js_create_string_utf8` signature drift (minor upstream defect, already fixed on main)
- **Symptom:** sodium-native/udx-native fail with `no matching function for call to 'js_create_string_utf8'`,
  `const char*` vs `const utf8_t*`.
- **Cause:** `libjstl/include/jstl.h`'s `template<size_t N> js_create_string(const char[N])` calls
  `js_create_string_utf8` without a cast, while `bare-compat-napi/js.h` wants `const utf8_t*`. (The pinned libjstl
  in the qvac-fabric fork is old; **upstream main already has the cast** — no PR needed.)
- **Fix:** `reinterpret_cast<const utf8_t *>(value)`.

### 5.5 A cluster of cmake "mode" pitfalls
- **`CMAKE_CXX_SCAN_FOR_MODULES`:** rocksdb triggers C++20 module scanning under cmake 4, but Chromium clang ships
  no `clang-scan-deps` → `code=127`. Fix: `set(... OFF)`.
- **`CMAKE_FIND_ROOT_PATH_MODE_{PACKAGE,INCLUDE,LIBRARY}`:** the default `ONLY` locks `find_package`/`find_path`/
  `find_library` to the sysroot, so vcpkg-installed libs / cmake-* helpers / sd-cpp's `find_library` aren't found.
  Fix: `BOTH`. **Note:** a plain `set()` in the toolchain shadows a command-line `-D` cache var, so you must edit
  the toolchain itself.
- **`CMAKE_POSITION_INDEPENDENT_CODE`:** vcpkg static libs are non-PIC by default; linking into a `.bare` (shared)
  errors `R_RISCV_PCREL_HI20 ... recompile with -fPIC`. Fix: `set(... ON)`.

### 5.6 C++ stdlib ABI (libc++ vs libstdc++)
- **Symptom:** the @qvac addon CMakeLists force `-stdlib=libc++ -static-libstdc++`, but the engine `.a` were built
  with the default libstdc++ (gnu) → ABI clash; and the trixie sysroot has no static `libstdc++.a`.
- **Fix:** standardize on libstdc++ (drop the addon's `-stdlib=libc++` and `-static-libstdc++`; use the dynamic
  libstdc++ the board already has).

### 5.7 ⚠️ Do NOT bundle glibc (a self-inflicted trap)
- **Symptom:** we first assumed we had to bundle trixie's `ld-linux`+`libc` onto the VF2; Bare then **segfaulted**
  on the real board.
- **Cause:** trixie's **glibc 2.41 loader crashes on the VF2's StarFive kernel** (controlled test: a trixie-built
  hello runs fine with the system loader, segfaults with the bundled 2.41 loader).
- **Fix:** **don't bundle anything.** Bare only needs `GLIBC ≤ 2.33` / `GLIBCXX ≤ 3.4.30`, met by the system's
  glibc 2.36. Just `./bare app.js`.

---

## 6. Final state

### Runtime (VF2, `~/qvac-rv/bare`, ~20 MB stripped)
- V8 `14.8.178.31` + Bare `1.29.4` + libuv `1.52.1`, executing JS on real riscv64 hardware.

### Infrastructure addons (all riscv64)
`bare-abort/buffer/crypto/dns/fs/hrtime/inspect/module-lexer/os/pipe/signals/stdio/structured-clone/subprocess/`
`tcp/tls/tty/type/url/zlib` (20) + `sodium-native/udx-native/rocksdb-native/fs-native-extensions/rabin-native`.

### Inference engines (7 built to `.bare`, 6 plugins verified loadable)
| Engine | Version | Plugin loads | Note |
|---|---|---|---|
| llm-llamacpp | 0.24.0 | ✅ | **real inference verified** |
| embed-llamacpp | 0.19.1 | ✅ | |
| tts-ggml | 0.2.5 | ✅ | |
| diffusion-cpp | 0.11.2 | ✅ | |
| vla-ggml | 0.3.2 | ✅ | |
| classification-ggml | 0.3.1 | ✅ | |
| transcription-parakeet | 0.7.2 | ⚠️ engine built, but the plugin needs `bare-ffmpeg` | |

### One-line reproduction (VF2)
```bash
~/qvac-rv/bare ~/qvac-rv/run-llm.mjs ~/qvac-rv/model.gguf "your prompt"
# → loadModel(qwen2.5-0.5b) → completion → "hello from risc-v" (~1.3 tok/s, CPU)
```
Official Bare-client API: `import { plugins } from '@qvac/sdk'` + `import { llmPlugin } from
'@qvac/sdk/llamacpp-completion/plugin'` → `plugins([llmPlugin]).loadModel(...).completion(...)`.

---

## 7. What works / what doesn't

**Works (verified or built):**
- ✅ Text generation (LLM completion, streaming, real inference)
- ✅ Text embeddings
- ✅ Classification, VLA, TTS, image generation (diffusion) — engines + plugins load (not each exercised with a
  model — no model files on hand)

**Not done / missing:**
- ❌ **Speech transcription whisper/bci:** engine blocked on `<format>` (the trixie sysroot only ships GCC 12 c++
  headers, no C++23 `<format>`; the board's system libstdc++ is also GCC 12).
- ❌ **Translation nmt:** `sentencepiece` fails to build on riscv64 (not yet investigated).
- ❌ **parakeet transcription:** engine builds, but the plugin also needs `bare-ffmpeg` (needs ffmpeg for riscv64).
- ⛔ **OCR / ONNX:** depend on `onnxruntime`/`opencv4`, very hard on riscv64 — deliberately skipped.

---

## 8. Future improvements

1. **whisper/bci:** use a sysroot with GCC 13+ c++ headers (Debian sid/forky riscv64), or supply `<format>`;
   confirm the board's runtime libstdc++ has the needed symbols (else static-link or upgrade it).
2. **nmt:** work through `sentencepiece`'s riscv64 build (likely protobuf/threading/atomics).
3. **bare-ffmpeg:** build ffmpeg for riscv64 to unlock the audio decode path for whisper/parakeet.
4. **Performance:** the VF2 has no RVV, so LLM runs at ~1.3 tok/s. Explore (a) smaller/more-quantized models;
   (b) writing **RVV 1.0 kernels** for ggml and running on a RISC-V board **with** the V extension — that's where
   RISC-V AI gets interesting.
5. **Reproducibility:** package the whole toolchain + overlay-ports + build_engine.sh + the chromium-prebuilds
   riscv64 target into a Dockerized, scripted SDK that emits riscv64 prebuilds in one step.
6. **Prebuild distribution:** contribute `prebuilds/linux-riscv64/*.bare` to each `@qvac/*` so others get it from
   `npm i` (no cross-compile needed).

---

## 9. Upstream contributions (by value/feasibility)

> These are **generic fixes** — useful to any riscv64 + clang setup, not just the VF2.

### PR-1 ⭐ tetherto/qvac-registry-vcpkg: no-vector riscv64 support for ggml / ggml-speech — **submitted**
[tetherto/qvac-registry-vcpkg#201](https://github.com/tetherto/qvac-registry-vcpkg/pull/201). The ports force RVV
march + Vulkan on riscv64; this builds a portable CPU-scalar `rv64gc` library instead.

### PR-2 ⭐ holepunchto/chromium-prebuilds: add a `linux-riscv64` target
Two tiny files (`arch/riscv64.gni`, `target/linux-riscv64.gni`) + a CI step + the trixie riscv64 sysroot.
Chromium 148 already supports the riscv64 toolchain, so the change is minimal; it gives the Bare ecosystem an
official riscv64 V8 prebuild.

### PR-3 ggml / llama.cpp: gate RVV on `__riscv_vector`, not `__riscv_v_intrinsic`
`ggml/src/ggml-cpu/*` gate RVV codegen on `__riscv_v_intrinsic`, which Clang defines unconditionally (it means
"intrinsics supported", not "V enabled"); `__riscv_vector` is the correct guard. **Note:** llama.cpp and
`tetherto/qvac-fabric-llm.cpp` have a strict policy against AI-generated PRs — this one must be authored and
submitted by a human.

### PR-4 V8 (Chromium): add the riscv64 `VisitWord64MulWide` stub
Goes through Chromium **Gerrit** (CLA), not a GitHub PR.

---

## 10. Version pins

Chromium `148.0.7778.265` · V8 `14.8.178.31` · Bare `1.29.4` · @qvac/sdk `0.13.5` · qvac-fabric `8828.1.2`.
