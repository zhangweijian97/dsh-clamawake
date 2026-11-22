# dsh-clamawake 项目 HANDOFF

> 本文件是项目级长期上下文：定位、结构、发布流程与坑。**进度以 goal board 为准**（产品线方向卡 `goal-85105e`），这里不复制进度。

## 定位与边界

DSH 宿主插件：把 ClamAwake 的保活配方绑到 DSH 生命周期——DSH 启动 = 保活在跑，DSH 停止 = 保活停。包自包含引擎（`bin/vd-engine`），不需要单独安装 ClamAwake 应用。

**独立发布链**：npm 包 `dsh-clamawake`（GitHub 同步）。不在个人成长系统工具库 / 部署链内（制品管理系统口径：自研独立项目，部署属性只是维度）。

同一个产品的另一仓：`项目库/研发项目/ClamAwake`（应用 + 引擎正本）。插件包内引擎从那边编译。

## 结构

- `index.js` — 宿主半边：生命周期、引擎解析、复用防护（已有 kya 屏则复用）、交叉核验、崩溃重启。无 npm 依赖。
- `bin/vd-engine` — 随包分发的引擎（GPL-3.0，来源见 `NOTICE`）。
- `bin/ENGINE-FINGERPRINT` — 引擎来源指纹：version / arch / sha256 / source_commit / built_at。
- `scripts/build-engine.sh` — 产包内引擎：默认从兄弟仓 `../ClamAwake` 编译，`--copy` 从已安装应用复制；同时刷新指纹。
- `scripts/publish.sh` — 发布编排：登录态检查/网页登录、引擎指纹核对、打包预检、发布并自动打开二次认证页、轮询注册表、回下载复核（`--check` 只体检，`--login` 只登录）。
- `test-lifecycle.mjs` — 生命周期自测（不经宿主）。

## 版本与引擎对齐

- **插件版本**（`package.json`，0.1.x）独立递增；**包内引擎**跟随 ClamAwake 的当期发布版（0.3.x）。
- 重建引擎后看 `bin/ENGINE-FINGERPRINT` 的 `source_commit` 是否等于 ClamAwake 当前 HEAD。
- 跨通道对账靠 `vd-engine version`（应用与插件都用它比对）。

## 发布到 npm（2026-11-22 修订：npm 原生命令，publish.sh 已退役）

**发布 = 真终端跑 npm 原生三条**，npm 自己处理全部交互（登录开浏览器、二次认证弹窗）：

```sh
npm login --auth-type=web   # 未登录才需要；浏览器点 Authorize + 通行密钥确认
npm whoami                  # 验证登录态
npm publish                 # 成功标志 = 终端输出 + dsh-clamawake@X.Y.Z
```

发前两件：`scripts/build-engine.sh`（引擎对齐主应用当期版，构建时已刷指纹）→ bump `package.json` → commit + push。
发后核验一条（回下载）：`npm pack dsh-clamawake@X.Y.Z` 解包跑 `bin/vd-engine version`、看 `ENGINE-FINGERPRINT`。注册表可见性有 >3 分钟延迟——**成功判据 = 终端的 `+ dsh-clamawake@…` 输出**，注册表读数只作延迟复核。

### publish.sh 退役记（2026-11-22）

脚本 2026-11-18 建，动机是把当时 AI 代跑发布踩的三个坑固化下来；2026-11-22 发 0.1.5 时在 otty 终端崩溃（pty 包装层），用户以 npm 原生三条一次成功。复盘定论：那三个坑是「AI 非交互终端代跑」的环境局限，不是发布的固有复杂度——npm 原生已把交互处理干净，脚本包装层（pty、日志监视、自动开页）是替 npm 做它已会做的事，且自身引入新坑。退役（git 历史可考），教训：**固化坑之前先问「这个坑属于流程，还是属于环境」——环境局限该修环境用法，不该固化为流程资产**。

### 2026-11-18 失败经验（历史留档，AI 代跑场景仍适用）

- **本地 token 失效有两种面孔**：`npm whoami` 报 `401 Unauthorized`；而 `npm publish` 报的是 `404 Not Found`（npm 对无权限账号隐藏包存在性）。见到 404 先查登录态，不要怀疑包名或权限配置。
- **`script` 的 stdin 不能重定向**：`script -q log cmd < file` 会报 `tcgetattr/ioctl: Operation not supported on socket`；想给 pty 喂输入而先 `mkfifo` 再 `exec 3> fifo` 会让 shell 卡死在打开 FIFO 上（无 reader）。保持 stdin 默认即可，脚本会自己抓链接并 `open`。
- **网页授权不依赖 ENTER，也不发验证码**：终端提示 `Press ENTER to open in the browser...`；真正的动作在浏览器里——页面按钮叫 **Authorize**，点完由密码管理器弹**通行密钥（passkey）**，确认后 npm 收到授权、自己继续完成登录/发布。全程没有 6 位验证码，不要让用户去找。

实测序列（0.1.4）：`npm publish` 404 → `npm whoami` 401 → 网页登录（打开 login 链接，同一套 Authorize + 通行密钥确认）→ 发布触发二次认证（打开 auth 链接，再点一次 Authorize + 通行密钥）→ `+ dsh-clamawake@0.1.4` → 注册表约 5 分钟后 `latest=0.1.4`。

稳定版默认发 `latest`（不带 `--tag`）；预览才用 `--tag next`。


## 本机安装态与已知问题（2026-11-12；2026-11-22 定位修正）

- **定位（2026-11-22 用户定调）：本插件是给别人用的**——对外分发（npm），本机 DSH 不装载是常态不是缺口；不要主动往本机 profile 装。
- 原 11-12 记录的坏软链（`~/.dsh/profiles/desktop/node_modules/dsh-clamawake` 指向已不存在的 `.../ClamAwake/dsh-plugin`）属悬空残留，2026-11-22 已清。
- npm：0.1.5 已发布（2026-11-22；包内引擎 0.3.7，`source_commit=08687b6` = ClamAwake v0.3.7 发版态）。0.1.4（引擎 0.3.4）为其前一版。

## 0.1.5 发版（2026-11-22；包内引擎对齐 ClamAwake v0.3.7）

- 包内引擎 version=0.3.7 / source_commit=08687b6（= ClamAwake HEAD，含发版 docs commit）；回下载复核通过（注册表包 sha256 与本地构建一致）。
- **发布实际走 npm 原生命令**（`npm login --auth-type=web` → `npm whoami` → `npm publish`，二次认证浏览器 Authorize + 通行密钥）：publish.sh 的 script 包装层在 otty 终端下崩溃（现象：watch_and_open 报 `url…: unbound variable` 已修一处 `${url}` 定界，但修复后仍有崩溃，根因未查明——下次发版先试脚本，崩了直接用原生三条，不再排查阻塞发布）。
- **npm 注册表延迟实测 >3 分钟**（0.1.5 发布成功后 versions/dist-tags 迟迟不刷）：发布成功的即时判据=终端 `+ dsh-clamawake@X.Y.Z` 输出；注册表读数只作延迟后复核，不作即时判据（本次误判教训：拿延迟读数否定了用户终端的成功输出）。
