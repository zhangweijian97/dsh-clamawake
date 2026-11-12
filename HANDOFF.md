# dsh-clamawake 项目 HANDOFF

> 本文件是项目级长期上下文：定位、结构、发布流程与坑。**进度以 goal board 为准**（产品线方向卡 `goal-85105e`），这里不复制进度。

## 定位与边界

DSH 宿主插件：把 ClamAwake 的保活配方绑到 DSH 生命周期——DSH 启动 = 保活在跑，DSH 停止 = 保活停。包自包含引擎（`bin/vd-engine`），不需要单独安装 ClamAwake 应用。

**独立发布链**：npm 包 `dsh-clamawake`（GitHub 同步）。不在个人成长系统工具库 / 部署链内（工具管理系统口径：自研独立项目，部署属性只是维度）。

同一个产品的另一仓：`项目库/研发项目/ClamAwake`（应用 + 引擎正本）。插件包内引擎从那边编译。

## 结构

- `index.js` — 宿主半边：生命周期、引擎解析、复用防护（已有 kya 屏则复用）、交叉核验、崩溃重启。无 npm 依赖。
- `bin/vd-engine` — 随包分发的引擎（GPL-3.0，来源见 `NOTICE`）。
- `bin/ENGINE-FINGERPRINT` — 引擎来源指纹：version / arch / sha256 / source_commit / built_at。
- `scripts/build-engine.sh` — 产包内引擎：默认从兄弟仓 `../ClamAwake` 编译，`--copy` 从已安装应用复制；同时刷新指纹。
- `test-lifecycle.mjs` — 生命周期自测（不经宿主）。

## 版本与引擎对齐

- **插件版本**（`package.json`，0.1.x）独立递增；**包内引擎**跟随 ClamAwake 的当期发布版（0.3.x）。
- 重建引擎后看 `bin/ENGINE-FINGERPRINT` 的 `source_commit` 是否等于 ClamAwake 当前 HEAD。
- 跨通道对账靠 `vd-engine version`（应用与插件都用它比对）。

## 发布到 npm（2026-11-12 实测，含认证实况）

1. bump `package.json` 的 version
2. `scripts/build-engine.sh`（引擎版本须与 ClamAwake 当期发布一致）
3. `npm pack --dry-run` 核内容（index.js / locale / bin / README / NOTICE / LICENSE / package.json）
4. commit + push GitHub
5. `npm publish` —— **本账号的 2FA 是浏览器授权，没有 6 位验证码**（不要问用户要 OTP）：
   - **非交互 shell（AI 环境）里直接 `npm publish` 会被打码**：报 `EOTP` 并输出 `https://www.npmjs.com/auth/cli/***`，人无法点击；
   - **必须用伪终端跑**：`script -q /dev/null npm publish`。它会打印明文 `Authenticate your account at: https://www.npmjs.com/auth/cli/<uuid>` 并挂起等待；
   - 然后 `open <该 URL>`（或让用户自己点），**用户在网页上点通过**，命令自动继续完成发布；
   - `npm login --auth-type=web` 同理走浏览器（非 TTY 下也会打印明文 URL）。
6. 成功输出 `+ dsh-clamawake@X.Y.Z`；HTTP 上是 `PUT 401 → 网页授权 → PUT 202`。npm 会提示「Your package is being processed and may take a few minutes to become available」——**注册表可见有延迟（分钟级），不要因为 `npm view` 立刻 404 就重发**。
7. 验证：`npm view dsh-clamawake dist-tags`（latest 应为新版本）、`npm view dsh-clamawake@X.Y.Z bin`。

稳定版默认发 `latest`（不带 `--tag`）；预览才用 `--tag next`。

## 本机安装态与已知问题（2026-11-12）

- `~/.dsh/profiles/desktop/node_modules/dsh-clamawake` 是一个**软链**，指向 `.../ClamAwake/dsh-plugin`——该路径已不存在，本机实际没有装载这个插件。正确安装应走 `plugin_manager install_bundle`（指向本目录），或按插件规范落到 `工具库/`；不要在 profile 里手挂研发仓软链。
- npm：0.1.3 已发布（latest=0.1.3，2026-11-12 19:41；注册表可见性滞后约 4 分钟，`?write=true` 可立刻读到）。包内引擎 0.3.3，`source_commit=4c7113a`（= ClamAwake v0.3.3）。
