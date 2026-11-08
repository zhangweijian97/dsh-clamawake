# dsh-clamawake（ClamAwake 的 DSH 插件）

把 ClamAwake 的合盖保活配方绑到 DSH 宿主生命周期上：**DSH 启动 = 保活在跑，DSH 停止 = 保活停**。没有 web 面板（无 UI 需求），纯宿主半边的后台插件。

**前置条件**：macOS + 已安装 [ClamAwake](https://github.com/zhangweijian97/ClamAwake)。本仓只放插件代码，引擎（`vd-engine`）随应用提供。

保活配方两件套（与 ClamAwake 应用同一配方）：

1. **虚拟屏**：spawn `vd-engine create 1800 1169 --hidpi --hold --mirror-main` 子进程持有屏——虚拟屏活在持有进程的生命周期内（CGVirtualDisplay 没有跨进程销毁 API，见 ClamAwake 仓 `src/vd-engine.swift` 的结论注释）；对子进程 SIGTERM → 引擎的 signal handler `exit(0)` → 屏随之消失。`--mirror-main` 与应用版同参：每次宿主启动＝新进程＝新建屏，镜像基线不会自动回来，必须启动即自挂主屏镜像；不带它是扩展屏，合盖后不是镜像接管。
2. **`caffeinate -d` 显示断言**：独立子进程，停止时一并 SIGTERM。

## 生命周期语义

| 阶段 | 动作 |
|---|---|
| 插件 start（`apply` → `ctx.effect` setup） | 解析引擎二进制 → 核对 `/usr/bin/caffeinate` 存在 → 跑一次只读 `vd-engine list` → **已有 `kya=yes` 的屏则复用不重建**（判据与 `vd-engine doctor` 的 `keepalive_running` 同源：KYA vendor 标记 `0x4B5941`）→ 否则 spawn 建屏子进程 + caffeinate 子进程，异步尾段读回屏 id 并再 list 一遍交叉核验（执行后验证，不信子进程一面之词） |
| 插件 dispose（`ctx.effect` 的 disposer） | **只 SIGTERM 自己 spawn 的子进程**（引擎建屏子进程 + caffeinate），3s 未退升级 SIGKILL 兜底；屏随引擎子进程退出消失 |

**所有权边界（安全红线）**：复用的外部屏（别的 vd-engine 进程 / 菜单栏壳 / 其他虚拟屏工具持有）**绝不动**——本插件 dispose 不碰任何不是自己 spawn 的进程。引擎子进程意外退出时打显著日志并自动重启（退避 1s 起、每次翻倍、30s 封顶；caffeinate 断言独立保留）。

**日志**：`console.log` 前缀 `[clamawake]`，进宿主控制台输出（启动/复用/建屏/核验/停止各一行，失败带原因）。

## 环境变量

| 变量 | 语义 | 默认 |
|---|---|---|
| `CLAMAWAKE_ENGINE` | vd-engine 可执行文件的绝对路径（解析链第 1 级） | 未设 |
| `CLAMAWAKE_REUSE` | 设 `0`/`false`/`no` 强制走建屏路径（测试逃生阀；生产不要设） | 复用开启 |

## 引擎二进制怎么来

插件不编译 Swift，只调用 `vd-engine` 可执行文件。**发布形态依赖已安装的 ClamAwake.app**：引擎随应用打包在 `Contents/Resources/`，插件只负责把它绑到 DSH 生命周期上。

解析链（第一个存在且可执行的生效，全落空则插件装载报明确错误——列尝试过的路径）：

1. 环境变量 `CLAMAWAKE_ENGINE`（绝对路径）；
2. `<插件目录>/bin/vd-engine` —— **本机开发便利**：把编译产物拷进插件包（不入库，见 `.gitignore`）；
3. `/Applications/ClamAwake.app/Contents/Resources/vd-engine` —— 已安装的应用；
4. `~/Applications/ClamAwake.app/Contents/Resources/vd-engine` —— 用户目录安装位。

**为什么不自带二进制**：引擎是 ClamAwake 的主体，插件只是宿主适配层。二进制跟着应用走，插件仓只放代码——这样引擎升级不用重发插件，也不会出现「一份引擎、多处副本」的漂移。DSH 是 GUI 应用，从 launchd/Finder 启动不继承 shell 环境变量，所以生产环境用第 3/4 条定位。

## 装载步骤（插件管理器路径已实测，见「已知边界」）

1. 先装 ClamAwake（DMG 拖进「应用程序」即可，引擎随之就位）；本机开发可改用 `bin/vd-engine` 或 `CLAMAWAKE_ENGINE`。
2. 把本目录作为插件包装进 DSH，两种等价路径：
   - **界面/插件管理器**：`plugin_manager(action=install_bundle, target=<本目录绝对路径>)`（装成的是 profile 下指向本目录的 link，改代码后重新启用即可生效，无需拷贝）；
   - **文件级**（DSH 插件接入的硬约束：必须是 profile 下**实体目录** + 双登记）：把本目录拷到 `~/.dsh/profiles/<profile>/node_modules/dsh-clamawake/`，并在该 profile 的 `package.json` 里同时登记 `dependencies` 与 `dsh.profile.bundles`。手工符号链接不要用——宿主 import 会失败且只打一行「entry did not activate」；插件管理器的 link 依赖不同，已实测可用。
3. **重启 DSH**（插件只在应用启动时加载；已装好后改代码，重新启用插件（`set_plugin` 关→开）即可让宿主读到新模块）。
4. 验证：宿主控制台出现 `[clamawake]` 启动日志（复用或建屏 + 核验通过）；`vd-engine list` 里出现 `kya=yes` 屏（若此前没有的话）；退出 DSH 后该屏消失、本插件挂的 caffeinate 断言释放。
5. 移除/更新插件：`remove_bundle`（或文件级删除 + 重启）；更新 `index.js` 后需重装并重启。

`package.json` 的 `dsh` 段只有 `bundle.patch`（指向 `cordis.patch.yml`，往宿主 bundle 插一行 `dsh-clamawake`）——没有 `dsh.client` 段（无 web 面板、无客户端模块）。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半边：start/dispose 生命周期、引擎解析、复用防护、交叉核验。无 npm 依赖（`node:child_process`，数组参数不经 shell） |
| `cordis.patch.yml` | bundle patch：插入一行 `dsh-clamawake`（仅宿主半边） |
| `locale/zh.json` / `locale/en.json` | Plugin Manager 读的标题/描述 |
| `test-lifecycle.mjs` | 生命周期自测（不经宿主，见下） |

## 自测

```sh
node test-lifecycle.mjs
```

模拟 cordis 装载协议（最小 ctx：`effect(setup)` → setup 同步执行、返回值当 disposer），两个阶段：

- **阶段 A 建屏路径**（`CLAMAWAKE_REUSE=0`）：start → `vd-engine list` 出现新的 kya=yes 屏 → dispose → 屏消失；
- **阶段 B 复用路径**（默认）：start → 不建新屏、复用既有 kya=yes 屏 → dispose → 既有屏原样；
- **终态复核**：在线屏集合与测试开始时一致。

引擎按解析链取（已装的应用 / `bin/vd-engine` / `CLAMAWAKE_ENGINE`）；本机开发可先把 ClamAwake 仓构建产物拷进 `bin/`（不入库）。**安全边界**：脚本全程只读查询 + 只 SIGTERM 自己 spawn 的子进程，绝不 kill 外部保活引擎、绝不跨进程 remove 任何屏。

## 已知边界

- **无 Config 导出**：配置只走环境变量（与 dsh-member/spacemgr 一致，无 UI 场景够用）。
- **引擎意外退出自动重启（2026-11-08）**：子进程 exit 触发退避重启（1s 起、每次翻倍、30s 封顶），成功建屏后轮次归零；插件停止时清掉待执行的定时器，不再拉起。实测 `kill -9` 引擎后约 1s 恢复新屏，caffeinate 不断。
- **真实 DSH 宿主装载已验收（2026-11-08）**：`install_bundle` 装载并在宿主激活（`application: applied`）；复用模式下挂自有 `caffeinate -d`、不动外部 kya=yes 屏；`set_plugin` 关闭只收自有 caffeinate（用户 ClamAwake.app 保活与外部屏原样），重新开启重挂。协议级自测（`node test-lifecycle.mjs`）同一轮通过：建屏 → 核验 → 拆屏 → 屏消失，复用路径不重复建屏、终态与基线一致。
- **宿主被强杀时的孤儿子进程（未验证）**：正常退出走 cordis dispose（SIGTERM 自有子进程）；若宿主进程被 `kill -9` 之类强杀，dispose 不执行，插件 spawn 的 vd-engine / caffeinate 可能成孤儿继续保活，需手动 `kill`（下次宿主启动时插件会按 kya 标记复用该屏）。
- **GUI 宿主的环境变量缺口**：见「引擎二进制怎么来」——发布形态用应用安装位定位，本机开发用 `bin/vd-engine` 或 `CLAMAWAKE_ENGINE`。
