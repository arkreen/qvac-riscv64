# 把 Tether QVAC SDK 移植到 RISC-V(StarFive VisionFive 2)

> 状态:**核心目标达成** —— 官方 `@qvac/sdk@0.13.5` + 自编 riscv64 V8/bare + 自编 riscv64 llama 引擎,在 VF2 真机加载 `qwen2.5-0.5b` 并完成真实流式 LLM 推理(`"hello from risc-v"`,~1.3 tok/s,CPU)。
>
> 记录日期:2026-06-22

---

## 0. 一句话总结

QVAC 官方只发布 x64/arm64/darwin/android/ios 的预编译,**没有 riscv64**。其运行时是 holepunch 的 **Bare**(默认引擎 V8),官方也不提供 riscv64 的 V8/Bare 预编译。本次工作 = **从源码为 riscv64 交叉编译整条链**(V8 → libjs → bare → 全部 bare-* / native addon → qvac-fabric 推理引擎 → @qvac 各引擎 addon),过程中修了 **6 类上游缺陷**,最终让**字节级官方 SDK** 在 RISC-V 上真跑。

---

## 1. 目标设备与约束

| 项 | 值 |
|---|---|
| 板子 | StarFive VisionFive 2,JH7110(SiFive U74,4 核,**rv64gc,无 RVV 向量扩展**) |
| 系统 | Debian,kernel `6.12.5-starfive`,**glibc 2.36**,系统 libstdc++ 到 `GLIBCXX_3.4.30`(GCC 12) |
| 网络 | npmjs 直连可用;github 时好时坏;huggingface 被墙(模型走 ModelScope) |
| 关键约束 | 无 RVV → 所有 ggml/llama 必须走标量;glibc/libstdc++ 偏旧 → 二进制不能依赖太新的符号 |

构建机:GCP `c2d-standard-32`(32 核,x64,非抢占)。**重活全在 GCP 交叉编译,只把产物运到 VF2**(VF2 算力/网络都弱)。

---

## 2. 架构与依赖链(为什么这么难)

```
@qvac/sdk (JS, 官方 npm)
   └─ 运行时: Bare (holepunch, 默认引擎 = V8)
        ├─ V8 14.8.178.31  ← 来自 chromium 148.0.7778.265,官方无 riscv64 预编译
        ├─ libjs (V8 的 C ABI 封装) + libuv + libutf
        └─ 一堆 native addon (.bare):
             ├─ bare-* 基础设施 (bare-fs/tls/crypto/...)  ×20
             ├─ holepunch native (sodium/udx/rocksdb/...)
             └─ @qvac/<engine> 推理引擎 addon
                  └─ vcpkg 拉 qvac-fabric (Tether fork 的 llama.cpp+ggml) 等
```

**关键认知**:QVAC 跟 Bare 强绑定(即便客户端在 Node 上,也会 `spawn` 一个 `bare` worker 做推理)。所以"绕过 Bare 用 Node"行不通,**必须把 Bare 连同它的引擎 V8 一起移植到 riscv64**。曾尝试用 holepunch 的 **libqjs(QuickJS 引擎)替代 V8** 绕开,但 QuickJS 在 worker bootstrap 撞 **动态 import() 被 stub** + CJS interop,满血 SDK 跑不起来 → 最终回到**啃 V8**。

---

## 3. 怎么做的(构建流水线)

### 3.1 交叉编译 V8(最硬的一关)

- 复用 holepunch 的 **`chromium-prebuilds`** 仓库(它定义了 Bare 用的 V8 GN 配置:monolithic、关指针压缩/sandbox/temporal)。它支持 android/darwin/ios/linux-arm64/linux-x64/win32,**唯独没有 linux-riscv64**。
- 只需新增两个文件即可让它认 riscv64(见 §6 PR-1):
  - `arch/riscv64.gni` = `target_cpu = "riscv64"`
  - `target/linux-riscv64.gni` = `import platform/linux.gni + arch/riscv64.gni`
- `gclient sync` 拉 chromium 148 全树(~115GB),用 chromium **自带 clang** + 下载的 **trixie riscv64 sysroot** 交叉编。chromium 148 对 riscv64 是一等支持(`clang_toolchain("clang_riscv64")` / `clang_v8_toolchain("clang_x64_v8_riscv64")`)。
- 产物:`libv8.a`(154MB)+ `libc++.a`,riscv64 对象(`rv64gc/lp64d`)。

### 3.2 交叉编译 bare(BYO-V8)

- libjs/bare 支持 **BYO-V8**:`bare-make generate -D GN_DIR=<chromium>/src -D GN_OUT_DIR=...`。但 bare-make 自带的 `cmake-toolchains/linux-riscv64.cmake` **没设 sysroot** → 改用自写 toolchain(§4)直接驱动 cmake-runtime 的 cmake(满足 bare 要的 cmake≥4.0)。
- 关键开关:`-DBARE_PREBUILDS=OFF`(否则 bare 会去 holepunch 的 Hyperdrive 拉无 riscv64 的预编译 libc++ 而失败),让 libjs 经 cmake-gn 的 `add_gn_target(v8/c++ prebuilds:...)` 从我的 GN 树取 V8/libc++。
- 产物:`bare`(89MB,riscv64),**真机能执行 JS**(算术/JIT/Promise/事件循环全过)。

### 3.3 全部 native addon

- 一个可复用脚本 `build_engine.sh <pkg>`:`npm i`(取 cmake-bare 等)→ patch CMakeLists → vcpkg 装依赖 → cmake 配置(用我的 toolchain + `CMAKE_PREFIX_PATH` 指向已装好的依赖树)→ ninja → 收集 `.bare`。
- bare-* × 20、sodium/udx/rocksdb/fs-native-extensions/rabin、以及 @qvac 各引擎都走这条流水线。

### 3.4 推理引擎(qvac-fabric)

- `@qvac/llm-llamacpp` 等用 **vcpkg** 从 `tetherto/qvac-registry-vcpkg` 拉 `qvac-fabric`(Tether fork 的 llama.cpp+ggml)。
- 用 vcpkg **overlay-triplet**(`riscv64-linux`,`VCPKG_CHAINLOAD_TOOLCHAIN_FILE` 指我的 toolchain)+ **overlay-ports**(关 RVV/Vulkan,见 §5)交叉编。产物 `libllama.a`/`libggml*.a`/`libmtmd.a`/`libcommon.a`。

### 3.5 部署与运行

- 产物打包,VF2 经 `scp` 直接从构建机拉(VF2→GCP:22 可达),放进各 `node_modules/<pkg>/prebuilds/linux-riscv64/`。
- **不捆绑 glibc**(关键教训,见 §5.7):bare 只需 `GLIBC≤2.33`/`GLIBCXX≤3.4.30`,VF2 系统库直接满足。`bare-runtime-linux-riscv64` shim 指向 `~/rvbare/bare`。

---

## 4. 最终 toolchain(交叉编译的核心配置)

`riscv64-clang.cmake`(逐行都是踩坑换来的):
```cmake
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR riscv64)
# 复用 chromium 自带 clang + lld(它能编 riscv64 V8 → 一定支持 riscv64)
set(CMAKE_C_COMPILER   <chromium>/src/third_party/llvm-build/Release+Asserts/bin/clang)
set(CMAKE_CXX_COMPILER <chromium>/.../clang++)
set(CMAKE_AR/RANLIB/NM  .../llvm-ar | llvm-ranlib(符号链接到 llvm-ar) | llvm-nm)
set(CMAKE_SYSROOT <chromium>/src/build/linux/debian_trixie_riscv64-sysroot)
# 与 V8 的 riscv64 对象严格一致;-U 撤销 clang 对 rv64gc 误定义的向量宏
set(_t "--target=riscv64-linux-gnu -march=rv64gc -mabi=lp64d -U__riscv_v_intrinsic")
set(CMAKE_{C,CXX,ASM}_FLAGS_INIT "${_t}")
set(CMAKE_{EXE,SHARED,MODULE}_LINKER_FLAGS_INIT "-fuse-ld=lld --target=riscv64-linux-gnu")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)   # 用 host 程序
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH)    # 不能 ONLY:否则 find_library 被锁死在 sysroot,找不到 vcpkg 装的库
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE BOTH)    # 让 cmake-* helper 能从 node_modules/CMAKE_PREFIX_PATH 找到
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)            # chromium clang 无 clang-scan-deps,关掉 C++20 模块扫描
set(CMAKE_POSITION_INDEPENDENT_CODE ON)        # .a 要进 .bare(shared),必须 PIC
```

---

## 5. 发现并修复的问题(共 6 类)

### 5.1 V8 RISC-V 后端缺 `VisitWord64MulWide`(真·上游缺陷)
- **现象**:`gn`/`ninja` 编 V8 到 89% 时 `mksnapshot` link 失败:`undefined symbol: InstructionSelector::VisitWord64MulWide(turboshaft::OpIndex, bool)`。
- **根因**:Turboshaft 共享层 `instruction-selector.cc` 对所有后端分派 `Word64MulWide`(64×64→128 位宽乘),x64/arm64/mips64/loong64 都有定义,**riscv64 漏了**。
- **修复**:补一个与 mips64/loong64 完全一致的空桩(64 位 RISC 架构上该算子实际不会被生成):
  ```cpp
  // src/compiler/backend/riscv/instruction-selector-riscv64.cc
  void InstructionSelector::VisitWord64MulWide(OpIndex node, bool is_signed) {
    UNIMPLEMENTED();
  }
  ```

### 5.2 ggml 在无向量 riscv64 + clang 上误编 RVV(真·上游缺陷,影响面最大)
- **现象**:ggml-cpu 编译报 `RISC-V type 'vfloat32m8_t' requires the 'zve32f' extension`(我们 `-march=rv64gc` 没有 V)。
- **根因**:ggml 用 `#if defined(__riscv_v_intrinsic)` 当作"有向量扩展"的判据,但 **chromium clang 对 `rv64gc`(无 V)也定义了 `__riscv_v_intrinsic=1000000`**(gcc 只在真有 V 时才定义,所以原生 gcc 编没事,换 clang 交叉编暴露)。
- **修复(两道)**:
  1. toolchain 全局 `-U__riscv_v_intrinsic`(撤销该宏)。
  2. 对 qvac-fabric 自带 ggml,overlay portfile 里 sed 把 `__riscv_v_intrinsic` → `__riscv_vector`(后者仅在 V 真启用时定义),并传 `-DGGML_RVV=OFF -DGGML_RV_ZFH/ZVFH/ZICBOP/ZIHINTPAUSE=OFF`。

### 5.3 standalone `ggml` / `ggml-speech` vcpkg port 对 riscv64 强开向量 + Vulkan
- **现象**:whisper/tts/diffusion 卡 `Adding CPU backend variant ggml-cpu: -march=rv64gcv_zfh_zvfh...`(强加 `v`!)+ `Could NOT find Vulkan (missing: glslc)`。
- **根因**:这俩 port 假设 `riscv64 ⟹ 有 RVV`,且默认/硬编 `GGML_VULKAN=ON`。
- **修复**:给 `ggml`、`ggml-speech` 各做 overlay-port,强制 `-DGGML_VULKAN=OFF` + `GGML_RVV/RV_*=OFF`,并从 `ggml` 的 vcpkg.json 去掉 linux 的 `vulkan` default-feature。

### 5.4 libjstl `js_create_string_utf8` 签名漂移(上游小缺陷)
- **现象**:sodium-native/udx-native 编译报 `no matching function for call to 'js_create_string_utf8'`,`const char*` vs `const utf8_t*`。
- **根因**:`libjstl/include/jstl.h` 的 `template<size_t N> js_create_string(const char[N])` 调 `js_create_string_utf8` 时没 cast,而 `bare-compat-napi/js.h` 要 `const utf8_t*`。
- **修复**:`reinterpret_cast<const utf8_t *>(value)`。

### 5.5 cmake 工具链一组"模式"坑
- **`CMAKE_CXX_SCAN_FOR_MODULES`**:rocksdb 在 cmake4 下触发 C++20 模块扫描,但 chromium clang 没打包 `clang-scan-deps` → `code=127`。修:toolchain `set(... OFF)`。
- **`CMAKE_FIND_ROOT_PATH_MODE_{PACKAGE,INCLUDE,LIBRARY}`**:默认 `ONLY` 把 `find_package/find_path/find_library` 锁死在 sysroot,导致找不到 vcpkg 装的库/cmake-* helper/sd-cpp 的 `find_library`。修:改 `BOTH`。**注意**:toolchain 里的普通 `set()` 会遮蔽命令行 `-D` cache 变量,必须改 toolchain 本身。
- **`CMAKE_POSITION_INDEPENDENT_CODE`**:vcpkg 静态库默认非 PIC,链进 `.bare`(shared)报 `R_RISCV_PCREL_HI20 ... recompile with -fPIC`。修:`set(... ON)`。

### 5.6 C++ stdlib ABI(libc++ vs libstdc++)
- **现象**:@qvac addon CMakeLists 强制 `-stdlib=libc++ -static-libstdc++`,但引擎 .a 是用默认 libstdc++(gnu)编的 → ABI 冲突;且 trixie sysroot 没有静态 `libstdc++.a`。
- **修复**:统一用 libstdc++(去掉 addon 的 `-stdlib=libc++` 和 `-static-libstdc++`,用动态 libstdc++,VF2 系统有)。

### 5.7 ⚠️ 不要捆绑 glibc(自己给自己挖的坑)
- **现象**:最初以为要把 trixie 的 `ld-linux`+`libc` 捆绑下 VF2,结果 bare 在真机**段错误**。
- **根因**:trixie 的 **glibc 2.41 loader 在 VF2 的 StarFive 内核上直接崩**(对照实验:同一 trixie 编的 hello 用 VF2 系统 loader 正常、用捆绑 2.41 loader 崩)。
- **修复**:**完全不捆绑**。bare 实测只需 `GLIBC≤2.33`/`GLIBCXX≤3.4.30`,VF2 系统 glibc 2.36 直接满足。直接 `./bare app.js`。

---

## 6. 最终形态

### 运行时(VF2,`~/rvbare/bare` 89MB)
- V8 `14.8.178.31` + bare `1.29.4` + libuv `1.52.1`,riscv64 真机执行 JS。

### 基础设施 addon(全部 riscv64,已部署)
`bare-abort/buffer/crypto/dns/fs/hrtime/inspect/module-lexer/os/pipe/signals/stdio/structured-clone/subprocess/tcp/tls/tty/type/url/zlib`(20)+ `sodium-native/udx-native/rocksdb-native/fs-native-extensions/rabin-native`。

### 推理引擎(7 个编出 `.bare`,6 个插件实测可加载)
| 引擎 | 版本 | 插件可加载 | 备注 |
|---|---|---|---|
| llm-llamacpp | 0.24.0 | ✅ | **已验证真实推理** |
| embed-llamacpp | 0.19.1 | ✅ | |
| tts-ggml | 0.2.5 | ✅ | |
| diffusion-cpp | 0.11.2 | ✅ | |
| vla-ggml | 0.3.2 | ✅ | |
| classification-ggml | 0.3.1 | ✅ | |
| transcription-parakeet | 0.7.2 | ⚠️ 引擎编出但插件需 `bare-ffmpeg` | |

### 一键复现(VF2)
```bash
cd ~/qvtest && ~/rvbare/bare test.mjs
# → loadModel(qwen2.5-0.5b) → completion → "hello from risc-v" (~1.3 tok/s, CPU)
```
官方 bare-client API:`import { plugins } from '@qvac/sdk'` + `import { llmPlugin } from '@qvac/sdk/llamacpp-completion/plugin'` → `plugins([llmPlugin]).loadModel(...).completion(...)`。

---

## 7. 能用 / 不能用

**能用(已验证或已编出)**:
- ✅ 文本生成(LLM completion,流式,真实推理)
- ✅ 文本嵌入(embed)
- ✅ 分类(classification)、VLA、TTS、图像生成(diffusion)—— 引擎+插件可加载(未逐个跑模型验证,缺对应模型文件)

**不能用 / 未完成**:
- ❌ **语音转写 whisper/bci**:引擎卡 `<format>`(trixie sysroot 只带 GCC 12 c++ 头,无 C++23 `<format>`;且 VF2 系统 libstdc++ 也 GCC12,运行期可能缺符号)。
- ❌ **翻译 nmt**:`sentencepiece` 在 riscv64 build 失败(未深查)。
- ❌ **parakeet 转写**:引擎编出,但插件还需 `bare-ffmpeg`(要 ffmpeg riscv64)。
- ⛔ **OCR / ONNX**:依赖 `onnxruntime`/`opencv4`,riscv64 上极难,**主动跳过**(用户决定)。

---

## 8. 后续可做的改进

1. **whisper/bci**:换一个带 GCC 13+ c++ 头的 sysroot(如 Debian sid/forky riscv64),或单独提供 `<format>` 头;同时确认 VF2 运行期 libstdc++ 符号够用(否则需要静态链或升级 VF2 的 libstdc++)。
2. **nmt**:逐个调 `sentencepiece` 的 riscv64 build(大概率 protobuf/线程/原子相关)。
3. **bare-ffmpeg**:为 riscv64 编 ffmpeg(vcpkg 或系统),解锁 whisper/parakeet 的音频解码。
4. **性能**:VF2 无 RVV,LLM 只有 ~1.3 tok/s。可探索:(a) 更小/更量化的模型;(b) 给 ggml 写 **RVV 1.0 内核**并在**有 RVV 的** RISC-V 板子(如带 V 扩展的新 SoC)上跑——这才是 RISC-V AI 的真正价值点。
5. **可复现性**:把整套(toolchain + overlay-ports + build_engine.sh + chromium-prebuilds 的 riscv64 target)固化成一个 Docker/脚本化的 SDK,一键产出 riscv64 prebuilds。
6. **prebuild 分发**:给 `@qvac/*` 各包补 `prebuilds/linux-riscv64/*.bare`,让别人 `npm i` 即得(无需自己交叉编)。

---

## 9. 🎁 可提交给上游的 PR(按价值/可行性排序)

> 这些都是**通用修复**,不只对 VF2 有意义,对任何 riscv64 + clang 场景都适用。

### PR-1 ⭐ ggml / llama.cpp:`__riscv_v_intrinsic` 不是"有向量扩展"的正确判据
- **仓库**:`ggml-org/llama.cpp`(以及 `ggerganov/ggml`)→ 间接惠及 `tetherto/qvac-fabric-llm.cpp`。
- **问题**:`ggml/src/ggml-cpu/*`(vec.h/simd-gemm.h/...)用 `#if defined(__riscv_v_intrinsic)` gate RVV 代码。**Clang 对 `rv64gc`(无 V)也定义此宏**,导致无向量的 riscv64 + clang 误编 RVV 内联 → 编译失败。
- **修复**:把这些 guard 改成 `#if defined(__riscv_vector)`(GCC/Clang 都只在 `-march` 含 `v` 时定义)。这是**纯正确性修复**,对有 V 的平台无影响。
- **影响**:让 ggml/llama.cpp 在所有"无向量 riscv64 + clang"组合开箱即用(目前需要 `-U__riscv_v_intrinsic` 绕)。

### PR-2 ⭐ holepunchto/chromium-prebuilds:新增 `linux-riscv64` target
- **问题**:仓库支持 8 个平台,无 riscv64。
- **修复**:加两个文件 `arch/riscv64.gni`(`target_cpu="riscv64"`)+ `target/linux-riscv64.gni`(import platform/linux + arch/riscv64),并在 `.github/workflows/prebuild.yml` 加一个 `Build linux-riscv64` step + 安装 trixie riscv64 sysroot。**chromium 148 已原生支持 riscv64 工具链**,改动极小。
- **影响**:让 Bare 生态官方支持 riscv64 V8 预编译。

### PR-3 V8(chromium):riscv64 后端补 `VisitWord64MulWide` 空桩
- **仓库**:V8(chromium gerrit)。
- **修复**:`instruction-selector-riscv64.cc` 加 `void InstructionSelector::VisitWord64MulWide(OpIndex, bool) { UNIMPLEMENTED(); }`,与 mips64/loong64 一致。
- **影响**:修复 riscv64 V8 在该 Turboshaft 算子上的 link 缺口(否则 mksnapshot 链接失败)。

### PR-4 holepunchto/libjstl:`js_create_string(const char[N])` 缺 cast
- **修复**:`jstl.h` 的 `template<size_t N> js_create_string(const char value[N], ...)` 里 `js_create_string_utf8(env, reinterpret_cast<const utf8_t*>(value), N, ...)`。
- **影响**:修复严格类型下(`utf8_t` ≠ `char`)的编译错误,非 riscv64 特有。

### PR-5 tetherto/qvac-registry-vcpkg:`ggml`/`ggml-speech` port 的 riscv64 无向量支持
- **问题**:这俩 port 对 riscv64 强加 `-march=rv64gcv...`(假设有 RVV)+ 默认开 Vulkan。
- **修复**:port 里检测 riscv64 时,允许通过 feature/triplet 关 RVV(`GGML_RVV=OFF` + `GGML_RV_*=OFF`)与 Vulkan;或对无 V 的 triplet 默认 CPU-only。同时可顺手加官方 `riscv64-linux` triplet 支持。
- **影响**:让 QVAC 的 whisper/tts/diffusion 等引擎在无向量 riscv64 上可构建。

### PR-6 holepunchto/cmake-toolchains:`linux-riscv64.cmake` 补 sysroot/交叉支持
- **问题**:现有 `linux-riscv64.cmake` 只 `find-clang`,**不设 sysroot**,在没有系统 riscv64 sysroot 的机器上无法交叉编。
- **修复**:支持通过环境变量/约定指定 riscv64 sysroot(或文档说明)。

### PR-7(文档/示例)给 `@qvac/*` 引擎包补 `prebuilds/linux-riscv64/`
- 把本次产出的 `.bare` 作为 riscv64 prebuild 贡献回去(或提供构建脚本),让社区 `npm i` 即用。

---

## 10. 资源位置(便于续做)

| 在哪 | 是什么 |
|---|---|
| **GCP `v8b`**(c2d-32,RUNNING) | 完整构建环境:`~/cr`(chromium 148 全树+V8)、`~/bare`、`~/vcpkg` + `~/vcpkg-installed-rv64`、`~/overlay-ports/{ggml,ggml-speech,qvac-fabric}`、`~/riscv64-clang.cmake`、`~/build_engine.sh`、`~/prebuilds-riscv64/` |
| **GCP `rv64-build`**(TERMINATED) | 早期 QEMU 容器(QuickJS-bare 探索 + 老 overlay),留底 |
| **VF2** `~/rvbare/` | `bare` 运行时 + 捆绑库(实际只用系统库) |
| **VF2** `~/qvtest/` | 官方 @qvac/sdk + 引擎 prebuild + `test.mjs`/`capstone.mjs` |
| **VF2** `~/models/` | `qwen2.5-0.5b-instruct-q4_k_m.gguf` |
| Claude 记忆 | `vf2-qvac-riscv.md` 等:完整配方/补丁/版本 pin |

**版本 pin**:chromium `148.0.7778.265` · V8 `14.8.178.31` · bare `1.29.4` · @qvac/sdk `0.13.5` · qvac-fabric `8828.1.2`。
