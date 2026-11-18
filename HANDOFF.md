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

## 发布到 npm（2026-11-18 修订：脚本 + 三条失败经验）

**一条命令**：`scripts/publish.sh`——自动做：登录态检查（失效则走网页登录并打开授权页）、引擎指纹核对、打包预检、发布并自动打开二次认证页、轮询注册表可见、从注册表回下载复核包内引擎。`--check` 只体检不发布；`--login` 只登录。

手动流程（脚本不可用时的退路）：

1. bump `package.json` 的 version
2. `scripts/build-engine.sh`（引擎版本须与 ClamAwake 当期发布一致）
3. `npm pack --dry-run` 核内容
4. commit + push GitHub
5. `script -q /tmp/pub.log npm publish`（**不要把 stdin 重定向到文件/FIFO**，见下）
6. 从 `/tmp/pub.log` 抓 `Authenticate your account at: <url>` → `open <url>` → 用户在网页点通过（**不需要在终端按 ENTER**）
7. 成功输出 `+ dsh-clamawake@X.Y.Z`；注册表有分钟级延迟，`curl 'https://registry.npmjs.org/dsh-clamawake?write=true'` 轮询 `dist-tags.latest`，别因 `npm view` 404 就重发
8. 验证要走「回下载」：`npm pack dsh-clamawake@X.Y.Z` 解包后跑 `bin/vd-engine version` 与看 `ENGINE-FINGERPRINT`

### 2026-11-18 失败经验（都已固化进脚本）

- **本地 token 失效有两种面孔**：`npm whoami` 报 `401 Unauthorized`；而 `npm publish` 报的是 `404 Not Found`（npm 对无权限账号隐藏包存在性）。见到 404 先查登录态，不要怀疑包名或权限配置。
- **`script` 的 stdin 不能重定向**：`script -q log cmd < file` 会报 `tcgetattr/ioctl: Operation not supported on socket`；想给 pty 喂输入而先 `mkfifo` 再 `exec 3> fifo` 会让 shell 卡死在打开 FIFO 上（无 reader）。保持 stdin 默认即可，脚本会自己抓链接并 `open`。
- **网页授权不依赖 ENTER**：终端提示 `Press ENTER to open in the browser...`，但浏览器点通过后 npm 会自己继续完成登录/发布。

实测序列（0.1.4）：`npm publish` 404 → `npm whoami` 401 → 网页登录（打开 login 链接）→ 发布触发二次认证（打开 auth 链接）→ 通过 → `+ dsh-clamawake@0.1.4` → 注册表约 5 分钟后 `latest=0.1.4`。

稳定版默认发 `latest`（不带 `--tag`）；预览才用 `--tag next`。


## 本机安装态与已知问题（2026-11-12）

- `~/.dsh/profiles/desktop/node_modules/dsh-clamawake` 是一个**软链**，指向 `.../ClamAwake/dsh-plugin`——该路径已不存在，本机实际没有装载这个插件。正确安装应走 `plugin_manager install_bundle`（指向本目录），或按插件规范落到 `工具库/`；不要在 profile 里手挂研发仓软链。
- npm：0.1.4 已发布（2026-11-18；包内引擎 0.3.4，`source_commit=c2ecaa4` = ClamAwake v0.3.4）。0.1.3（2026-11-12 19:41，引擎 0.3.3）为其前一版。
