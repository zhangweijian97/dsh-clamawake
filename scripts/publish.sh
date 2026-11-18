#!/bin/bash
# dsh-clamawake 发布脚本 — 把「发布时最容易卡住的三件事」固化掉：
#   1) 登录态失效（npm whoami 401 / 发布 404）：自动走网页登录，并把授权链接打开；
#   2) 二次认证（发布时要求浏览器点通过）：自动从输出里抓授权链接并 open；
#   3) 注册表延迟（发布成功但 npm view 还是旧版）：轮询 ?write=true，不因 404 重发。
#
# 关键坑（2026-11-18 实测）：不要给 script 重定向 stdin（< 文件 / FIFO）——script 会对非 tty
# 报 "tcgetattr: Operation not supported"，或让打开 FIFO 的 shell 直接挂死。让 stdin 保持默认即可；
# 网页授权通过后 npm 会自己继续，不需要在终端按 ENTER。
#
# 用法:
#   scripts/publish.sh             # 完整发布（未登录会先登录）
#   scripts/publish.sh --check     # 只体检：登录态 / 引擎版本 / 打包内容，不发布
#   scripts/publish.sh --login     # 只做网页登录
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
PKG="$(node -p "require('./package.json').name")"
MODE="${1:-publish}"

log() { printf '==> %s\n' "$*"; }

# 等 log 里出现授权链接就打开浏览器；等命令结束
watch_and_open() {
  local logfile="$1"; shift
  local pid="$1"; shift
  local opened=""
  for _ in $(seq 1 1200); do   # 最多等 10 分钟（等人去浏览器点通过）
    if [ -z "$opened" ]; then
      local url
      url="$(grep -oE 'https://www\.npmjs\.com/(login\?next=[^ ]+|auth/cli/[0-9a-fA-F-]+)' "$logfile" 2>/dev/null | head -1 || true)"
      if [ -n "$url" ]; then
        log "已打开浏览器授权页：$url（请在网页上点通过）"
        open "$url" || true
        opened=1
      fi
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  wait "$pid"
}

ensure_login() {
  if npm whoami >/dev/null 2>&1; then
    log "npm 登录态正常：$(npm whoami)"
    return 0
  fi
  log "npm 未登录或令牌失效——走网页登录"
  : > /tmp/dsh-clamawake-login.log
  # 注意：stdin 保持默认，不要 < 重定向
  script -q /tmp/dsh-clamawake-login.pty npm login --auth-type=web > /tmp/dsh-clamawake-login.log 2>&1 &
  local pid=$!
  watch_and_open /tmp/dsh-clamawake-login.log "$pid"
  if npm whoami >/dev/null 2>&1; then
    log "登录完成：$(npm whoami)"
  else
    log "登录失败：见 /tmp/dsh-clamawake-login.log"
    return 1
  fi
}

check_engine() {
  local fp="bin/ENGINE-FINGERPRINT"
  [ -f "$fp" ] || { log "缺少 $fp（先跑 scripts/build-engine.sh）"; return 1; }
  local ver arch src
  ver="$(sed -n 's/^version=//p' "$fp")"
  arch="$(sed -n 's/^arch=//p' "$fp")"
  src="$(sed -n 's/^source_commit=//p' "$fp")"
  local real
  real="$(./bin/vd-engine version 2>/dev/null | sed -n 's/^version=//p')"
  log "包内引擎：version=${ver} arch=${arch} source_commit=${src}（实际自报 ${real}）"
  [ "$ver" = "$real" ] || { log "指纹与实际引擎版本不一致"; return 1; }
}

ensure_login
check_engine
log "打包预检（npm pack --dry-run）"
npm pack --dry-run 2>&1 | sed -n '/Tarball Contents/,/total files/p'

if [ "$MODE" = "--login" ]; then exit 0; fi

if [ "$MODE" = "--check" ]; then
  log "体检完成（未发布）"
  exit 0
fi

if npm view "$PKG@$VERSION" version >/dev/null 2>&1; then
  log "版本 $VERSION 已存在于注册表——先 bump package.json 再发"
  exit 1
fi

log "发布 $PKG@$VERSION"
: > /tmp/dsh-clamawake-publish.log
script -q /tmp/dsh-clamawake-publish.pty npm publish > /tmp/dsh-clamawake-publish.log 2>&1 &
PUB_PID=$!
watch_and_open /tmp/dsh-clamawake-publish.log "$PUB_PID" || { log "发布命令失败：见 /tmp/dsh-clamawake-publish.log"; exit 1; }

log "等注册表可见（npm 有分钟级延迟，别因 404 重发）"
for _ in $(seq 1 120); do   # 最多 10 分钟
  latest="$(curl -s "https://registry.npmjs.org/$PKG?write=true" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j["dist-tags"]?.latest||"")}catch{console.log("")}})' 2>/dev/null || true)"
  if [ "$latest" = "$VERSION" ]; then
    log "注册表已可见：latest=$latest"
    break
  fi
  sleep 5
done
[ "${latest:-}" = "$VERSION" ] || { log "注册表 10 分钟内未更新到 $VERSION（发布可能成功但仍在处理中，过几分钟用 npm view 复核）"; exit 1; }

log "从注册表下载复核"
TMP="$(mktemp -d)"
( cd "$TMP" && npm pack "$PKG@$VERSION" >/dev/null 2>&1 && tar xzf "$PKG-$VERSION.tgz" && ./package/bin/vd-engine version | head -2 && cat package/bin/ENGINE-FINGERPRINT )
rm -rf "$TMP"
log "发布完成：$PKG@$VERSION"
