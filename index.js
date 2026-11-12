/**
 * dsh-clamawake —— ClamAwake 合盖保活与 DSH 宿主生命周期的绑定（宿主半边）。
 *
 * 绑定语义：DSH 起来 = 保活配方在跑；DSH 停 = 配方停。配方两件套
 * （见仓 README「快速上手」）：
 *
 *   1. 虚拟屏：spawn `vd-engine create 1800 1169 --hidpi --hold --mirror-main`
 *      子进程持有屏——屏活在该子进程生命周期内（CGVirtualDisplay 无跨进程销毁 API，
 *      见 src/vd-engine.swift remove 子命令的结论注释）；给子进程 SIGTERM → 引擎的
 *      signal handler exit(0) → 屏随之消失。`--mirror-main` 与应用版
 *      （shell/Sources/ClamAwake/EngineController.swift）同参：每次宿主启动＝新进程＝
 *      新建屏，镜像基线不会自动回来（vd-engine 用法说明的 launchd/自启形态同判），
 *      必须启动即自挂主屏镜像；否则建出来的是扩展屏，合盖后不是镜像接管。
 *   2. caffeinate -d 显示断言：独立子进程，停止时一并 SIGTERM。
 *
 * 重复启动防护（判据与 `vd-engine doctor` 的 keepalive_running 同源）：
 * start 时先跑一次只读 `vd-engine list`，已有 kya=yes 的屏（本引擎的 KYA vendor 标记）
 * 就复用、不重建。所有权边界（安全红线）：复用的屏持有者不属于本插件（别的 vd-engine
 * 进程 / 菜单栏壳 / 其他虚拟屏工具），本插件 dispose 时绝不动它们——停止动作只落在
 * 自己 spawn 的子进程上。
 *
 * 测试逃生阀：CLAMAWAKE_REUSE=0（或 false）强制走建屏路径——本机常驻保活屏会被
 * 默认复用逻辑命中，test-lifecycle.mjs 用它验证「建→拆」全链路。
 *
 * 引擎二进制解析（第一个存在且可执行的生效，详见 README）：
 *   1. 环境变量 CLAMAWAKE_ENGINE（绝对路径；本机调试或替换引擎用）
 *   2. <插件目录>/bin/vd-engine        （随包分发的引擎，自包含的主路径）
 *   3. /Applications/ClamAwake.app/Contents/Resources/vd-engine（已装应用的兜底位）
 *   4. ~/Applications/ClamAwake.app/Contents/Resources/vd-engine（用户目录安装位）
 * 全部落空 → 抛明确错误：列尝试过的路径 + 引擎来源说明。
 *
 * 没有 npm 依赖：node:child_process 的 spawn / spawnSync，数组参数不经 shell。
 *
 * 状态暴露：cordis 把 apply 的返回值当 effect 处理（普通对象直接报 TypeError: Invalid effect），
 * 所以 apply 不返回 state；最近一次启动的 state 经 getState() 提供（test-lifecycle.mjs 消费）。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.1.2'
const LOG = '[clamawake]'

// 保活配方固定参数：常见 MacBook 内屏逻辑分辨率（1800x1169，HiDPI 像素 3600x2338）
const SCREEN_W = 1800
const SCREEN_H = 1169

const CAFFEINATE = '/usr/bin/caffeinate'
const LIST_TIMEOUT_MS = 5000            // 只读 list 的一次性上限
const CREATE_ID_TIMEOUT_MS = 10000      // 引擎自己最多等 3s WindowServer，留足余量
const KILL_GRACE_MS = 3000              // dispose 的 SIGTERM 升级 SIGKILL 的宽限
const RESTART_BASE_MS = 1000            // 引擎意外退出后的重启退避：1s 起、每次翻倍
const RESTART_MAX_MS = 30000            // 退避封顶

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

// MARK: - 引擎定位

function engineCandidates() {
  const list = []
  const envPath = String(process.env.CLAMAWAKE_ENGINE || '').trim()
  if (envPath) list.push(envPath)
  list.push(
    path.join(PLUGIN_DIR, 'bin', 'vd-engine'),
    '/Applications/ClamAwake.app/Contents/Resources/vd-engine',
    path.join(process.env.HOME || '', 'Applications', 'ClamAwake.app', 'Contents', 'Resources', 'vd-engine'),
  )
  return list
}

/** 返回 { engine }；全部落空则抛错（列尝试路径 + 构建命令，不给静默降级）。 */
function resolveEngine() {
  const tried = []
  for (const candidate of engineCandidates()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return { engine: candidate, tried }
    } catch {
      tried.push(candidate)
    }
  }
  throw new Error([
    `${LOG} 找不到 vd-engine 可执行文件，依次尝试过：`,
    ...tried.map((p) => `${LOG}   · ${p}`),
    `${LOG} 修复办法（任选一）：`,
    `${LOG}   1. 仓根编译：swiftc -O src/vd-engine.swift -o vd-engine（落点即候选 3）；`,
    `${LOG}   2. 设环境变量 CLAMAWAKE_ENGINE 指向已有的 vd-engine 绝对路径（GUI 宿主需 launchctl setenv，见 README）；`,
    `${LOG}   3. 把编译产物拷进 <插件目录>/bin/vd-engine（自包含安装）。`,
  ].join('\n'))
}

/** 读引擎自报版本（vd-engine version）；旧引擎没有该子命令时降级为不可知，不阻断启动。 */
function describeEngine(engine) {
  let run
  try {
    run = spawnSync(engine, ['version'], { encoding: 'utf8', timeout: LIST_TIMEOUT_MS })
  } catch (error) {
    return { label: `版本读取失败（${error.message}）` }
  }
  if (run.error || run.status !== 0) {
    return { label: '版本不可知（引擎没有 version 子命令，可能是旧版）' }
  }
  const version = /^version=(.+)$/m.exec(String(run.stdout || ''))?.[1]?.trim() ?? 'unknown'
  const arch = /^arch=(.+)$/m.exec(String(run.stdout || ''))?.[1]?.trim() ?? 'unknown'
  return { version, arch, label: `${version} (${arch})` }
}

/**
 * 与包内指纹（bin/ENGINE-FINGERPRINT，构建脚本产出）比对：应用版与插件版的引擎不同步时打 warn。
 * 只提示不阻断——版本不符时保活配方仍然可用，只是行为可能与应用版不一致。
 */
function checkEngineFingerprint(engine, info) {
  const fpPath = path.join(PLUGIN_DIR, 'bin', 'ENGINE-FINGERPRINT')
  let fp
  try {
    fp = fs.readFileSync(fpPath, 'utf8')
  } catch {
    return
  }
  const expected = /^version=(.+)$/m.exec(fp)?.[1]?.trim()
  if (expected && info.version && expected !== info.version) {
    console.warn(`${LOG} 引擎版本与包内指纹不符：包内 ${expected}，实际 ${info.version}`
      + `（引擎被替换过，或包未按 scripts/build-engine.sh 重建）`)
  }
}

// MARK: - 引擎只读读数

/**
 * 跑一次 `vd-engine list`，解析出行 [{ id, kya }]。
 * list 的行形如 `id=20 main=no ... vendor=4938049 ... kya=yes`；kya=yes 即本引擎
 * KYA vendor 标记（0x4B5941），与 doctor 的 keepalive_running 判据同源。
 * 退出码非 0 / 超时 / 一行都解析不出 → 抛错（不猜）。
 */
function listScreens(engine) {
  const run = spawnSync(engine, ['list'], { encoding: 'utf8', timeout: LIST_TIMEOUT_MS })
  if (run.error) throw new Error(`${LOG} vd-engine list 执行失败：${run.error.message}`)
  if (run.status !== 0) {
    throw new Error(`${LOG} vd-engine list 退出码 ${run.status}：${String(run.stderr || '').trim()}`)
  }
  const screens = []
  for (const line of String(run.stdout || '').split('\n')) {
    const m = line.match(/^id=(\d+)\b.*\bkya=(yes|no)\b/)
    if (m) screens.push({ id: Number(m[1]), kya: m[2] === 'yes' })
  }
  if (!screens.length) {
    throw new Error(`${LOG} vd-engine list 输出解析不出任何显示器行，输出原文：\n${run.stdout}`)
  }
  return screens
}

// MARK: - 子进程动作

/**
 * spawn 建屏子进程（create --hold），返回 { child, screenIdPromise }。
 * 引擎先建屏、stdout 打印屏 id、随后常驻持有；这里不阻塞 apply——id 的到达在
 * 异步尾段确认（确认成功/失败都打日志），dispose 在 id 到达前触发也能正确收场
 * （SIGTERM 让引擎退出，屏未建或随进程消失）。
 */
function spawnEngineCreate(engine) {
  const child = spawn(engine, ['create', String(SCREEN_W), String(SCREEN_H), '--hidpi', '--hold', '--mirror-main'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const screenIdPromise = new Promise((resolve, reject) => {
    let stdoutBuf = ''
    let stderrTail = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGTERM') } catch {}
      reject(new Error(`${CREATE_ID_TIMEOUT_MS}ms 内没从引擎 stdout 读到屏 id。${stderrTail}`))
    }, CREATE_ID_TIMEOUT_MS)
    if (timer.unref) timer.unref()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (settled) return
      stdoutBuf += chunk
      const nl = stdoutBuf.indexOf('\n')
      if (nl === -1) return
      settled = true
      clearTimeout(timer)
      const id = Number(stdoutBuf.slice(0, nl).trim())
      if (Number.isInteger(id) && id > 0) {
        resolve({ screenId: id })
      } else {
        reject(new Error(`引擎 stdout 首行不是屏 id：${JSON.stringify(stdoutBuf.slice(0, nl))}`))
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      // 只留尾部供报错引用，不逐行转发（--hold 期的诊断行会太吵）
      stderrTail = (stderrTail + chunk).slice(-800)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`引擎子进程启动失败：${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`引擎子进程在建屏阶段提前退出（code=${code} signal=${signal}）。${stderrTail}`))
    })
  })
  return { child, screenIdPromise }
}

function spawnCaffeinate() {
  const child = spawn(CAFFEINATE, ['-d'], { stdio: 'ignore' })
  child.on('error', (error) => {
    console.warn(`${LOG} caffeinate 子进程出错：${error.message}`)
  })
  return child
}

// MARK: - 生命周期

function reuseEnabled() {
  const v = String(process.env.CLAMAWAKE_REUSE ?? '1').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

/** 插件启动：解析引擎 → 核对 caffeinate → 只读 list → 复用或建屏。同步完成 spawn，异步尾段只做确认与日志。 */
function startKeepalive() {
  const { engine, tried } = resolveEngine()
  const engineInfo = describeEngine(engine)
  console.log(`${LOG} 引擎 ${engineInfo.label}：${engine}`)
  checkEngineFingerprint(engine, engineInfo)
  if (!fs.existsSync(CAFFEINATE)) {
    throw new Error(`${LOG} ${CAFFEINATE} 不存在（配方另一半无法执行）。先跑 vd-engine doctor 核对环境。`)
  }

  const existing = listScreens(engine)
  const kyaScreens = existing.filter((s) => s.kya)

  const state = {
    version: VERSION,
    engine,
    engine_candidates_tried: tried,
    engine_child: null,       // 本插件 spawn 的建屏子进程（复用模式下为 null——所有权边界）
    engine_pid: null,
    caffeinate_child: null,
    caffeinate_pid: null,
    mode: null,               // 'created' | 'reused'
    screen_ids: [],           // 本插件关心的屏：created=自建屏 id；reused=复用的外部屏 id
    started_at: new Date().toISOString(),
    stopped: false,
    restart_attempt: 0,       // 自动重启轮次（成功建屏归零）
    restart_timer: null,      // 待执行的退避重启定时器
  }

  if (kyaScreens.length > 0 && reuseEnabled()) {
    state.mode = 'reused'
    state.screen_ids = kyaScreens.map((s) => s.id)
    console.log(`${LOG} 复用已有 kya=yes 屏 id=${state.screen_ids.join(', ')}，不重建；`
      + `它们的持有进程不属于本插件，本插件停止时不会动它们`)
    spawnCaffeinateFor(state)
    return state
  }

  state.mode = 'created'
  const { child, screenIdPromise } = spawnEngineCreate(engine)
  state.engine_child = child
  state.engine_pid = child.pid
  spawnCaffeinateFor(state)
  console.log(`${LOG} 已 spawn 引擎建屏子进程 pid=${child.pid}`
    + `（vd-engine create ${SCREEN_W} ${SCREEN_H} --hidpi --hold --mirror-main，engine=${engine}）`)
  watchEngine(state, child, screenIdPromise, 0)

  return state
}

/**
 * 挂接一个引擎建屏子进程：确认屏 id + 交叉核验（执行后验证——不信子进程一面之词，自己 list），
 * 并把「意外退出」接到退避重启上（attempt=0 首次，≥1 重启轮次）。
 */
function watchEngine(state, child, screenIdPromise, attempt) {
  screenIdPromise.then(({ screenId }) => {
    if (state.stopped) return
    state.screen_ids = [screenId]
    state.restart_attempt = 0
    console.log(`${LOG} 引擎建屏成功 id=${screenId}（pid=${child.pid}）`
      + `${attempt > 0 ? `，第 ${attempt} 次重启后恢复` : ''}，交叉核验在线状态…`)
    let confirm
    try {
      confirm = listScreens(state.engine)
    } catch (error) {
      console.warn(`${LOG} 建屏后核验失败（list 本身出错）：${error.message}`)
      return
    }
    const mine = confirm.find((s) => s.id === screenId)
    if (mine && mine.kya) {
      console.log(`${LOG} 核验通过：id=${screenId} 在线且 kya=yes，保活配方就位`
        + `（虚拟屏 + caffeinate pid=${state.caffeinate_pid}）`)
    } else {
      console.warn(`${LOG} 核验未通过：id=${screenId} 不在在线列表或 kya!=yes（读数：${JSON.stringify(mine)}）`)
    }
  }, (error) => {
    if (state.stopped) return
    console.warn(`${LOG} 建屏失败：${error.message}`)
    restartEngine(state, attempt + 1)
  })

  child.on('exit', (code, signal) => {
    if (state.stopped) return
    console.warn(`${LOG} 引擎子进程意外退出（pid=${child.pid} code=${code} signal=${signal}）——`
      + `自建虚拟屏随之消失，保活失效；进入自动重启`)
    restartEngine(state, attempt + 1)
  })
}

/**
 * 退避重启引擎建屏子进程：1s 起、每次翻倍、30s 封顶；插件停止（state.stopped）即不再重启。
 * caffeinate 断言独立于屏，重启期间保留不重建。
 */
function restartEngine(state, attempt) {
  if (state.stopped) return
  if (state.restart_timer) return // 已有排程（exit 与建屏失败可能同时触发）
  state.restart_attempt = attempt
  const delay = Math.min(RESTART_BASE_MS * 2 ** Math.min(attempt - 1, 5), RESTART_MAX_MS)
  console.warn(`${LOG} 第 ${attempt} 次自动重启引擎（${delay}ms 后）`)
  const timer = setTimeout(() => {
    state.restart_timer = null
    if (state.stopped) return
    const { child, screenIdPromise } = spawnEngineCreate(state.engine)
    state.engine_child = child
    state.engine_pid = child.pid
    console.log(`${LOG} 重启引擎建屏子进程 pid=${child.pid}（第 ${attempt} 次）`)
    watchEngine(state, child, screenIdPromise, attempt)
  }, delay)
  if (timer.unref) timer.unref()
  state.restart_timer = timer
}

function spawnCaffeinateFor(state) {
  const child = spawnCaffeinate()
  state.caffeinate_child = child
  state.caffeinate_pid = child.pid
  console.log(`${LOG} caffeinate -d 断言已挂（pid=${child.pid}）`)
}

/** 插件停止：只 SIGTERM 自己 spawn 的子进程（复用的外部屏绝不动），SIGKILL 只作兜底升级。同步触发、不阻塞 dispose。 */
function stopKeepalive(state) {
  if (!state || state.stopped) return
  state.stopped = true
  if (state.restart_timer) {
    clearTimeout(state.restart_timer)
    state.restart_timer = null
  }
  let killedAny = false
  for (const child of [state.engine_child, state.caffeinate_child]) {
    if (!child || child.exitCode !== null || child.signalCode !== null) continue
    try { child.kill('SIGTERM') } catch {}
    killedAny = true
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        console.warn(`${LOG} 子进程 pid=${child.pid} SIGTERM 后 ${KILL_GRACE_MS}ms 未退出，升级 SIGKILL`)
        try { child.kill('SIGKILL') } catch {}
      }
    }, KILL_GRACE_MS)
    if (escalate.unref) escalate.unref()
  }
  if (state.mode === 'reused') {
    console.log(`${LOG} 已停止：释放本插件的 caffeinate 断言；复用的屏 id=${state.screen_ids.join(', ')}`
      + `保持原样（持有者不是本插件）`)
  } else {
    console.log(`${LOG} 已停止：SIGTERM 引擎子进程${killedAny ? '（pid=' + state.engine_pid + '）' : ''}`
      + `与 caffeinate（pid=${state.caffeinate_pid}），自建虚拟屏随引擎退出消失`)
  }
}

// 最近一次 start 的 state。apply 的返回值会被 cordis 当 effect 消费（返回普通对象 →
// TypeError: Invalid effect），所以状态不经 apply 返回，改用 getState() 暴露。
let latestState = null

export function getState() {
  return latestState
}

export default {
  name: 'dsh-clamawake',
  apply(ctx) {
    let state = null
    ctx.effect(() => {
      state = startKeepalive()
      latestState = state
      return () => stopKeepalive(state)
    }, 'clamawake: keepalive engine (vd-engine --hold + caffeinate -d)')
  },
}
