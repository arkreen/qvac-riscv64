#!/usr/bin/env bash
# One-command setup: run the official @qvac/sdk on a riscv64 Linux board.
set -euo pipefail
REPO_RAW="https://raw.githubusercontent.com/arkreen/qvac-riscv64/main"
REL="https://github.com/arkreen/qvac-riscv64/releases/latest/download"
WORK="${QVAC_RV_HOME:-$HOME/qvac-rv}"
MODEL_URL="${QVAC_MODEL_URL:-https://modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/master/qwen2.5-0.5b-instruct-q4_k_m.gguf}"

echo "== checks =="
[ "$(uname -m)" = "riscv64" ] || { echo "ERROR: not riscv64 (this build is riscv64-only)"; exit 1; }
command -v node >/dev/null || { echo "ERROR: need node/npm"; exit 1; }
ldd --version | head -1

mkdir -p "$WORK" && cd "$WORK"
echo "== 1. official @qvac/sdk from npm (JS, unmodified) =="
[ -f package.json ] || npm init -y >/dev/null
npm install @qvac/sdk >/dev/null 2>&1 && echo "  @qvac/sdk @ $(node -e 'console.log(require(JSON.parse(require("fs").readFileSync("node_modules/@qvac/sdk/package.json")).version||"")||"installed")' 2>/dev/null || echo installed)"

echo "== 2. riscv64 bare runtime + native prebuilds (from Release) =="
curl -fL "$REL/bare-riscv64.tar.gz"          -o /tmp/bare-rv.tgz
curl -fL "$REL/qvac-prebuilds-riscv64.tar.gz" -o /tmp/pb-rv.tgz
tar xzf /tmp/bare-rv.tgz -C "$WORK"            # -> $WORK/bare
chmod +x "$WORK/bare"
rm -rf /tmp/pb && mkdir -p /tmp/pb && tar xzf /tmp/pb-rv.tgz -C /tmp/pb
PB=/tmp/pb/prebuilds-riscv64
for d in "$PB"/*/; do
  pkg=$(basename "$d")
  for cand in "node_modules/@qvac/$pkg" "node_modules/$pkg"; do
    if [ -d "$cand" ]; then mkdir -p "$cand/prebuilds/linux-riscv64"; cp "$d"*.bare "$cand/prebuilds/linux-riscv64/" 2>/dev/null || true; fi
  done
done
echo "  prebuilds deployed"

echo "== 3. bare-runtime shim (so SDK spawns our bare) =="
mkdir -p node_modules/bare-runtime-linux-riscv64
echo '{"name":"bare-runtime-linux-riscv64","version":"1.0.0","main":"index.js"}' > node_modules/bare-runtime-linux-riscv64/package.json
printf 'module.exports = { bare: %s }\n' "\"$WORK/bare\"" > node_modules/bare-runtime-linux-riscv64/index.js

echo "== 4. model =="
[ -f "$WORK/model.gguf" ] || curl -fL "$MODEL_URL" -o "$WORK/model.gguf"
ls -lh "$WORK/model.gguf"

echo "== 5. demo =="
curl -fsSL "$REPO_RAW/scripts/run-llm.mjs" -o "$WORK/run-llm.mjs"
echo ">>> running official QVAC SDK LLM inference on riscv64..."
"$WORK/bare" "$WORK/run-llm.mjs" "$WORK/model.gguf" "In 5 words, what is RISC-V?"
echo ""
echo "Done. To run again:  $WORK/bare $WORK/run-llm.mjs $WORK/model.gguf \"your prompt\""
