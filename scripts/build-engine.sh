#!/bin/bash
# 产出插件包内的自包含引擎 bin/vd-engine。
#
# 来源（按顺序尝试）：
#   1. CLAMAWAKE_SRC 指向 ClamAwake 仓（默认 ../ClamAwake）——从源码编译，保证与仓一致；
#   2. 已安装的 /Applications/ClamAwake.app（复制其 Resources/vd-engine）；
#   3. CLAMAWAKE_ENGINE 指向已有的 vd-engine。
#
# 用法：scripts/build-engine.sh            # 默认取兄弟仓 ../ClamAwake 编译
#       scripts/build-engine.sh --copy     # 直接从已安装的 app 复制
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/bin/vd-engine"
SRC="${CLAMAWAKE_SRC:-$ROOT/../ClamAwake}"
mkdir -p "$ROOT/bin"

if [ "${1:-}" = "--copy" ]; then
  cp /Applications/ClamAwake.app/Contents/Resources/vd-engine "$OUT"
elif [ -f "$SRC/src/vd-engine.swift" ]; then
  echo "==> swiftc -O $SRC/src/vd-engine.swift -o $OUT"
  swiftc -O "$SRC/src/vd-engine.swift" -o "$OUT"
elif [ -f /Applications/ClamAwake.app/Contents/Resources/vd-engine ]; then
  echo "==> 未找到 ClamAwake 源码（CLAMAWAKE_SRC=$SRC），从已安装的应用复制"
  cp /Applications/ClamAwake.app/Contents/Resources/vd-engine "$OUT"
elif [ -n "${CLAMAWAKE_ENGINE:-}" ]; then
  cp "$CLAMAWAKE_ENGINE" "$OUT"
else
  echo "找不到引擎来源：设 CLAMAWAKE_SRC=<ClamAwake 仓路径>、先安装 ClamAwake.app，或设 CLAMAWAKE_ENGINE" >&2
  exit 1
fi
chmod +x "$OUT"

# 指纹：让「插件包里的引擎来自哪」可查（缓解应用版/插件版不同步）。
SRC_COMMIT="unknown"
if [ -d "${SRC:-}/.git" ]; then SRC_COMMIT="$(git -C "$SRC" rev-parse --short HEAD)"; fi
SHA="$(shasum -a 256 "$OUT" | awk '{print $1}')"
VER="$(/usr/bin/env "$OUT" version 2>/dev/null | sed -n 's/^version=//p')"
ARCH="$(/usr/bin/env "$OUT" version 2>/dev/null | sed -n 's/^arch=//p')"
cat > "$ROOT/bin/ENGINE-FINGERPRINT" <<FP
version=${VER:-unknown}
arch=${ARCH:-unknown}
sha256=$SHA
source_commit=$SRC_COMMIT
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FP
echo "==> 已产出 $OUT ($(file -b "$OUT"))"
echo "==> 指纹 bin/ENGINE-FINGERPRINT: version=${VER:-unknown} arch=${ARCH:-unknown} sha256=${SHA:0:12}… source=${SRC_COMMIT}"
