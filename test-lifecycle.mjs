#!/usr/bin/env node
/**
 * dsh-clamawake 生命周期自测——不经 DSH 宿主，node 直接模拟 cordis 插件装载协议。
 *
 * 模拟方式：构造最小 ctx（effect(setup) → setup 同步执行、返回值按 disposer 收集，
 * 语义与 dsh-member / dsh-spacemgr 的用法一致），动态 import 本插件 index.js 并 apply。
 *
 * 两个阶段：
 *   A 建屏路径（CLAMAWAKE_REUSE=0）：start → `vd-engine list` 出现新的 kya=yes 屏
 *     → dispose → 屏消失；
 *   B 复用路径（默认）：start → 不建新屏、复用既有 kya=yes 屏 → dispose → 既有屏原样。
 *
 * 安全红线（本脚本的实现边界）：
 *   · 全程只读查询用 `vd-engine list`（不 remove、不 kill 任何外部进程）；
 *   · 清理只发生在本脚本/插件自己 spawn 的子进程上（dispose → SIGTERM 子进程 →
 *     屏随进程消失），复用的外部屏绝不动；
 *   · 结束时核对在线屏集合与开始时一致（含用户常驻保活屏），不一致则退出码 1。
 *
 * 引擎二进制：CLAMAWAKE_ENGINE → 插件既有候选 → 都没有就现场
 * `swiftc -O ../src/vd-engine.swift -o .test-engine/vd-engine`（缓存：src 未变则复用）。
 *
 * 用法：node test-lifecycle.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(PLUGIN_DIR, '..')
const INDEX_PATH = path.join(PLUGIN_DIR, 'index.js')
const TEST_ENGINE_DIR = path.join(PLUGIN_DIR, '.test-engine')
const LIST_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 300

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- 引擎二进制就位（env → 既有候选 → 现场编译缓存） ----------

function findExistingEngine() {
  const candidates = []
  const envPath = String(process.env.CLAMAWAKE_ENGINE || '').trim()
  if (envPath) candidates.push(envPath)
  candidates.push(
    path.join(PLUGIN_DIR, 'bin', 'vd-engine'),
    '/Applications/ClamAwake.app/Contents/Resources/vd-engine',
    path.join(process.env.HOME || '', 'Applications', 'ClamAwake.app', 'Contents', 'Resources', 'vd-engine'),
  )
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {}
  }
  return null
}

function buildTestEngine() {
  const src = path.join(REPO_ROOT, 'src', 'vd-engine.swift')
  if (!fs.existsSync(src)) {
    throw new Error(`现场编译需要 ${src}（测试须放在仓内 dsh-plugin/ 下跑），或设 CLAMAWAKE_ENGINE 指向已有二进制`)
  }
  const out = path.join(TEST_ENGINE_DIR, 'vd-engine')
  const cached = (() => {
    try {
      return fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs
    } catch {
      return false
    }
  })()
  if (cached) return { engine: out, built: false }

  console.log(`[test] 引擎二进制未命中缓存，现场编译：swiftc -O ${path.relative(PLUGIN_DIR, src)} -o ${path.relative(PLUGIN_DIR, out)}`)
  fs.mkdirSync(TEST_ENGINE_DIR, { recursive: true })
  const run = spawnSync('swiftc', ['-O', src, '-o', out], { encoding: 'utf8', timeout: 120000 })
  if (run.error) {
    throw new Error(`swiftc 不可用（${run.error.message}）——装 Xcode Command Line Tools（xcode-select --install），或设 CLAMAWAKE_ENGINE 指向已有 vd-engine`)
  }
  if (run.status !== 0) {
    throw new Error(`swiftc 编译失败（退出码 ${run.status}）：\n${run.stderr}`)
  }
  return { engine: out, built: true }
}

const foundEngine = findExistingEngine()
const resolved = foundEngine ? { engine: foundEngine, built: false } : buildTestEngine()
const ENGINE = resolved.engine
console.log(`[test] 引擎二进制：${ENGINE}${resolved.built ? '（本次现场编译）' : ''}`)
process.env.CLAMAWAKE_ENGINE = ENGINE

// ---------- 只读读数与断言（独立实现，不用插件自己的解析器） ----------

function runList() {
  const run = spawnSync(ENGINE, ['list'], { encoding: 'utf8', timeout: LIST_TIMEOUT_MS })
  if (run.error || run.status !== 0) {
    throw new Error(`vd-engine list 失败：${(run.error && run.error.message) || run.stderr || ('exit ' + run.status)}`)
  }
  const screens = []
  for (const line of String(run.stdout || '').split('\n')) {
    const m = line.match(/^id=(\d+)\b.*\bkya=(yes|no)\b/)
    if (m) screens.push({ id: Number(m[1]), kya: m[2] === 'yes' })
  }
  return screens
}

function screenSet(screens) {
  return new Map(screens.map((s) => [s.id, s.kya]))
}

function assert(cond, message) {
  if (!cond) throw new Error(`断言失败：${message}`)
}

async function pollUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`轮询超时（${label}，${timeoutMs}ms）${lastError ? `，最后一次错误：${lastError.message}` : ''}`)
}

async function waitChildExit(child, timeoutMs, label) {
  if (!child) return
  await pollUntil(() => child.exitCode !== null || child.signalCode !== null, timeoutMs, label)
}

/** 最小 cordis ctx：effect(setup) → setup 同步跑，返回的函数按 disposer 收集（dsh-member/spacemgr 同语义）。 */
function makeCtx(label) {
  const disposers = []
  return {
    label,
    disposers,
    effect(setup) {
      const disposer = setup()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
}

async function importPlugin(tag) {
  return await import(pathToFileURL(INDEX_PATH).href + `?phase=${tag}`)
}

async function disposeAll(ctx, timeoutMs = 8000) {
  for (const disposer of ctx.disposers.splice(0)) {
    try {
      disposer()
    } catch (error) {
      console.warn(`[test] dispose 抛错（忽略，继续收尾）：${error.message}`)
    }
  }
  const state = ctx.state
  await waitChildExit(state && state.caffeinate_child, timeoutMs, 'caffeinate 退出')
  await waitChildExit(state && state.engine_child, timeoutMs, '引擎子进程退出')
}

// ---------- 看门狗：任何挂死路径下 150s 强制收尾退出 ----------

const watchdog = setTimeout(() => {
  console.error('[test] 看门狗超时（150s）：测试挂死，强制退出 1（子进程清理已尽力）')
  process.exit(1)
}, 150000)
watchdog.unref()

// ---------- 主流程 ----------

let ctxA = null
let ctxB = null
let testScreenId = null
let exitCode = 0

try {
  // 基线：只读 list，记录开始时的在线屏集合
  const baseline = runList()
  const baselineSet = screenSet(baseline)
  const baselineKya = baseline.filter((s) => s.kya).map((s) => s.id)
  console.log(`[test] 基线在线屏 ${baseline.length} 块：${baseline.map((s) => `id=${s.id}(kya=${s.kya ? 'yes' : 'no'})`).join(' ')}；其中 kya=yes：${baselineKya.length ? baselineKya.join(', ') : '无'}`)

  // ---- 阶段 A：建屏路径（CLAMAWAKE_REUSE=0 强制绕过复用） ----
  process.env.CLAMAWAKE_REUSE = '0'
  const pluginA = await importPlugin('a')
  ctxA = makeCtx('A')
  const t0 = Date.now()
  pluginA.default.apply(ctxA)
  ctxA.state = pluginA.getState()
  assert(ctxA.state && ctxA.state.mode === 'created', `阶段 A 应走建屏路径，实得 mode=${ctxA.state && ctxA.state.mode}`)
  assert(ctxA.state.engine_child && ctxA.state.engine_pid > 0, '阶段 A 应已 spawn 引擎子进程并持句柄')
  console.log(`[test] 阶段 A start 完成（${Date.now() - t0}ms）：mode=created，引擎 pid=${ctxA.state.engine_pid}，caffeinate pid=${ctxA.state.caffeinate_pid}`)

  const appeared = await pollUntil(() => {
    const fresh = runList().find((s) => s.kya && !baselineSet.has(s.id))
    return fresh || null
  }, 12000, '等待新建 kya=yes 屏出现在在线列表')
  testScreenId = appeared.id
  console.log(`[test] 阶段 A：新建虚拟屏 id=${testScreenId}（kya=yes）已出现在 list，距 start ${Date.now() - t0}ms`)

  await pollUntil(() => Array.isArray(ctxA.state.screen_ids) && ctxA.state.screen_ids.includes(testScreenId) || null,
    12000, '等待插件内部读到屏 id 并交叉核验')
  console.log(`[test] 阶段 A：插件内部确认 screen_ids=[${ctxA.state.screen_ids.join(', ')}]（异步尾段交叉核验已走完）`)

  const t1 = Date.now()
  await disposeAll(ctxA)
  console.log(`[test] 阶段 A dispose 完成（${Date.now() - t1}ms）：引擎子进程与 caffeinate 均已退出`
    + `（engine exit=${ctxA.state.engine_child && ctxA.state.engine_child.exitCode}/${ctxA.state.engine_child && ctxA.state.engine_child.signalCode}）`)

  await pollUntil(() => (!runList().some((s) => s.id === testScreenId)) || null, 8000, `等待自建屏 id=${testScreenId} 消失`)
  console.log(`[test] 阶段 A：自建屏 id=${testScreenId} 已从在线列表消失`)
  testScreenId = null // 收尾责任已履行

  // ---- 阶段 B：复用路径（默认 CLAMAWAKE_REUSE=1；基线无 kya 屏时无可复用对象，跳过） ----
  if (baselineKya.length === 0) {
    console.log('[test] 阶段 B 跳过：基线没有 kya=yes 屏可复用（复用路径无从验证）')
  } else {
  // ---- 阶段 B：复用路径（默认 CLAMAWAKE_REUSE=1） ----
  delete process.env.CLAMAWAKE_REUSE
  const pluginB = await importPlugin('b')
  ctxB = makeCtx('B')
  pluginB.default.apply(ctxB)
  ctxB.state = pluginB.getState()
  assert(ctxB.state && ctxB.state.mode === 'reused', `阶段 B 应走复用路径，实得 mode=${ctxB.state && ctxB.state.mode}`)
  assert(ctxB.state.engine_child === null, '阶段 B 复用模式下不应 spawn 引擎子进程（外部屏持有者不属于本插件）')
  const reusedIds = ctxB.state.screen_ids
  for (const id of baselineKya) {
    assert(reusedIds.includes(id), `阶段 B 复用集应包含基线 kya=yes 屏 id=${id}，实得 [${reusedIds.join(', ')}]`)
  }
  console.log(`[test] 阶段 B start 完成：mode=reused，复用屏 id=[${reusedIds.join(', ')}]，未建新屏（caffeinate pid=${ctxB.state.caffeinate_pid}）`)

  await sleep(2500)
  const duringB = runList()
  const newInB = duringB.filter((s) => !baselineSet.has(s.id))
  assert(newInB.length === 0, `阶段 B 复用期间不应出现新屏，实得多出 id=${newInB.map((s) => s.id).join(', ')}`)
  console.log('[test] 阶段 B：2.5s 复用观察窗内在线屏集合无变化（未重复建屏）')

  await disposeAll(ctxB)
  const caffeinateB = ctxB.state.caffeinate_child
  assert(!caffeinateB || caffeinateB.exitCode !== null || caffeinateB.signalCode !== null, '阶段 B dispose 后本插件的 caffeinate 应退出')
  console.log('[test] 阶段 B dispose 完成：本插件 caffeinate 已退出，外部持有屏未触碰')
  }

  // ---- 终态复核：与基线一致 ----
  const finalSet = screenSet(runList())
  const gone = [...baselineSet.keys()].filter((id) => !finalSet.has(id))
  const extra = [...finalSet.keys()].filter((id) => !baselineSet.has(id))
  const flipped = [...baselineSet.keys()].filter((id) => baselineSet.get(id) && finalSet.get(id) === false)
  assert(gone.length === 0, `基线屏消失：${gone.join(', ')}`)
  assert(extra.length === 0, `残留多余屏：${extra.join(', ')}`)
  assert(flipped.length === 0, `基线 kya=yes 屏标记变化：${flipped.join(', ')}`)
  console.log(`[test] 终态复核通过：在线屏集合与基线一致（${[...finalSet.keys()].map((id) => `id=${id}`).join(' ')}），用户常驻保活屏原样`)
  console.log('[test] 全部通过（exit 0）')
} catch (error) {
  exitCode = 1
  console.error(`[test] 失败：${error.message}`)
  console.error(`[test] 失败时的终态 list 读数：`)
  try {
    for (const s of runList()) console.error(`  id=${s.id} kya=${s.kya ? 'yes' : 'no'}`)
  } catch (e) {
    console.error(`  （list 读数失败：${e.message}）`)
  }
} finally {
  // 任何路径下收掉本插件 spawn 的子进程（红线：只动自己的）
  for (const ctx of [ctxA, ctxB]) {
    if (ctx) await disposeAll(ctx)
  }
  if (testScreenId !== null) {
    console.error(`[test] 警告：自建屏 id=${testScreenId} 未能确认消失（子进程已 SIGTERM；屏随持有进程死亡，勿跨进程 remove）`)
  }
}
process.exit(exitCode)
