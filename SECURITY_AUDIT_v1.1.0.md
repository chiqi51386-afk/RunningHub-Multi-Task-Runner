# RunningHub Runner 安全审核报告

审核日期：2026-10-06
审核对象：正式版 `v1.1.0` 源码、依赖锁文件、构建配置、Git 历史和已生成桌面资源
结论：未发现 Critical 问题；3 项可安全处理的问题已修复，任务输出下载按兼容性要求保留宽松策略。剩余 2 组构建期依赖告警和发行包签名需要开发者决定或等待上游。

## 1. 项目概况

- 技术栈：Electron 44、Node.js/TypeScript、React 19、Vite 7、SQLite（better-sqlite3）。
- 包管理器：npm；根工程与 `frontend/` 各有独立 `package-lock.json`。
- 规模：210 个 Git 跟踪文件；178 个 TypeScript/JavaScript/JSON/HTML/CI 配置文件纳入静态审查。
- 依赖规模：根锁文件 342 个依赖记录，前端锁文件 120 个依赖记录；16 个直接依赖声明（15 个不同包）。
- 审核范围：依赖、网络边界、下载与更新、SQLite、工作流导入、文件处理、Electron 主进程/预加载/渲染器、密钥存储、日志、CI/CD、Git 历史与构建产物。
- 工具与交叉核验：`npm audit`、OSV Query API、GitHub Advisory Database、NVD 引用、npm registry 元数据、项目密钥扫描器、TypeScript 类型检查、259 项测试、生产构建、Electron 桌面 smoke test。

## 2. 直接依赖与锁定版本

| 清单 | 直接依赖 | 实际锁定版本 | 用途 | OSV 精确版本结果 |
|---|---|---:|---|---|
| 根 | better-sqlite3 | 12.11.1 | 运行时数据库 | 0 |
| 根 | @electron/rebuild | 4.2.0 | 原生模块构建 | 0 |
| 根 | @types/better-sqlite3 | 7.6.13 | 类型 | 0 |
| 根 | @types/node | 24.19.1 | 类型 | 0 |
| 根 | electron | 44.5.1 | 桌面运行时 | 0 |
| 根 | electron-builder | 26.15.3 | 打包 | 0（其间接依赖有告警） |
| 根 | tsx | 4.23.15 | 测试/脚本 | 0 |
| 根 | typescript | 5.9.3 | 编译 | 0 |
| 前端 | @vitejs/plugin-react | 5.2.0 | 构建 | 0 |
| 前端 | lucide-react | 0.544.0 | 图标 | 0 |
| 前端 | react | 19.3.0 | UI | 0 |
| 前端 | react-dom | 19.3.0 | UI | 0 |
| 前端 | vite | 7.3.7 | 构建 | 0 |
| 前端 | @types/react | 19.3.0 | 类型 | 0 |
| 前端 | @types/react-dom | 19.3.0 | 类型 | 0 |
| 前端 | typescript | 5.9.3 | 编译 | 0 |

本次同时升级了可无损更新的补丁版本：Electron 44.4.3 → 44.5.1、tsx 4.23.13 → 4.23.15、`@types/node` 24.13.6 → 24.19.1、Vite 7.3.6 → 7.3.7。

关键间接依赖实际版本：

| 依赖链 | 版本 |
|---|---:|
| app-builder-lib | 26.15.3 |
| @electron/get（electron-builder 内） | 3.1.0 |
| @electron/get（Electron 内） | 5.1.0 |
| global-agent | 3.0.0 |
| got | 11.8.6 |
| cacheable-request | 7.0.4 |
| http-cache-semantics | 4.2.0 |
| roarr | 2.15.4 |
| sprintf-js | 1.1.3 |
| esbuild | 0.28.2 |
| rollup | 4.63.4 |
| postcss | 8.5.28 |
| source-map-js | 1.2.2（已修复） |

维护状态检查：15 个不同的直接包在 npm registry 均未标记 deprecated，近期均有发布或元数据更新；未发现疑似仿冒包。better-sqlite3、类型包、TypeScript、Vite 插件和 lucide-react 存在新主版本，但本次不擅自进行破坏性升级。

## 3. 问题汇总

| 编号 | 类别 | 严重级别 | 位置 | 状态 |
|---|---|---|---|---|
| DEP-01 | 依赖 | High | `frontend/package-lock.json`：source-map-js 1.2.1 | 已修复为 1.2.2 |
| NET-01 | 代码 | Low | 任务输出下载链 | 已按产品兼容性决定接受 |
| UPD-01 | 代码 | Medium | `src/desktop/main.ts:202` | 已修复 |
| SEC-01 | 密钥 | Low | `scripts/security-scan.mjs:6` | 已修复 |
| SEC-02 | 密钥 | High | 仓库外：此前会话中曾粘贴 API Key | 待开发者轮换 |
| DEP-02 | 依赖 | High（项目实际暴露低） | electron-builder → http-cache-semantics 4.2.0 | 待上游/开发者决定 |
| DEP-03 | 依赖 | Medium（项目实际暴露低） | electron-builder → global-agent/roarr/sprintf-js | 待上游/开发者决定 |
| SUP-01 | 供应链 | Medium | `package.json` macOS identity/notarize；Windows 未配置签名 | 待开发者决定 |
| DATA-01 | 本地数据 | Low | 用户数据库与草稿 | 建议关注 |

## 4. 已修复问题

### DEP-01：source-map-js 事件循环拒绝服务

- 原版本：1.2.1；修复版本：1.2.2。
- 风险：恶意 indexed source map 的极端 offset 可长时间阻塞事件循环。
- 利用条件：构建过程必须处理攻击者提供的 source map；该包不进入桌面应用运行时，但仍属于应修复的高危构建依赖。
- 修改：更新 `frontend/package-lock.json` 并重新生成第三方许可证清单。

### NET-01：任务输出下载兼容 HTTP 与外部 CDN 重定向

- 产品决定：任务结果可能来自 RunningHub 使用的不同存储/CDN。为避免误伤有效链接和降低下载成功率，不限制下载域名、协议或最终重定向地址。
- 风险：HTTP 链路可能被同网络攻击者观察或替换；任务输出不是应用更新包，不会作为程序执行，因此在当前产品风险模型中接受该兼容性取舍。
- 保留保护：续传身份、Content-Range、ETag/Last-Modified、最终字节数、排他发布和不覆盖已有文件仍然有效。
- 自动更新不适用此兼容策略：更新包会被执行，因此仍强制 HTTPS、GitHub 来源和 SHA-256 校验。

### UPD-01：更新 ZIP 解压前缺少 Zip Slip 路径预检

- 位置：`src/desktop/main.ts:202-216`。
- 风险：异常 ZIP 条目中的 `../` 或绝对路径可能把文件写出 staging 目录。
- 利用条件：攻击者需要控制通过 GitHub Release 摘要校验的更新包，通常还意味着发布账号或发布流程已被攻破。
- 修改：使用 .NET ZipArchive 逐条计算规范化目标路径，任何条目越出 staging 根目录即停止解压；更新重定向最终地址同时强制 HTTPS。

### SEC-01：密钥扫描覆盖不足

- 位置：`scripts/security-scan.mjs:6-22`。
- 风险：原扫描器未覆盖 Google `AIza`/`AQ.` 密钥以及 Slack、Discord webhook。
- 修改：增加上述模式，同时避免把明确标记为 synthetic/invalid/not-a-real 的测试样本当成泄漏。
- 验证：扫描 244 个当前工作树文件、234 个生成文件及 611 个 Git 历史 blob，结果 0 命中。
- 注意：模式扫描无法证明不存在未知格式、不可达 Git 对象或外部备份中的凭据。

### SEC-02：此前会话中粘贴过 API Key

- 仓库、构建产物和可达 Git 历史中均未发现该 Key，本报告也不会复述其内容。
- 但聊天记录不应作为秘密存储。请在对应 Google 项目中作废并重新生成曾粘贴到会话中的 Key；仅删除代码或聊天显示并不能撤销凭据。
- 新 Key 只应通过应用的 Gemini Key 管理界面保存，由系统安全存储加密，不要再次写入源码、文档、日志或聊天。

### 其他安全补丁维护

- 更新 Electron、tsx、Vite 和 Node 类型补丁版本。
- 将明文 SecretStore 的注释明确为“仅测试和显式受控的旧维护工具”，避免误用于桌面持久化；正式桌面端仍强制使用系统安全存储。
- 许可证清单已与新锁文件同步为 462 个条目。

## 5. 代码审查结果

### Electron 与 Web

- `src/desktop/main.ts:682` 已启用 `contextIsolation`、sandbox，关闭 `nodeIntegration` 和 webview。
- `src/desktop/main.ts:55` 对每个 IPC 调用校验发送者、主 frame 与精确页面 URL。
- `src/desktop/main.ts:686-690` 禁止新窗口、页面导航、webview attach 和所有权限请求。
- `desktop/preload.cjs` 只暴露按用途命名的方法，没有把原始 `ipcRenderer` 暴露给页面。
- `frontend/vite.config.ts:14` 在生产构建注入 CSP；脚本仅允许 self，连接被禁用，object/frame 被禁用。样式保留 `unsafe-inline` 以兼容 React 内联样式。
- 未发现 `dangerouslySetInnerHTML`、`eval`、动态 Function、远程脚本或开放 CORS。

### 注入、数据库、文件和反序列化

- 业务 SQL 使用 prepared statements；未发现用户输入直接拼接到查询。
- 数据库迁移中的动态 SQL来源于本机 SQLite schema，不来自网络请求。
- PowerShell 以参数数组启动；用户内容没有拼成命令行脚本。
- 工作流导入会校验 JSON 结构、节点/字段映射、重复目标和工作流身份；未发现不安全对象反序列化。
- 媒体输出命名经过清洗，发布文件使用排他创建，避免覆盖和 TOCTOU 冲突。
- 下载续传校验 ETag/Last-Modified、Content-Range 和最终字节数。

### 网络与敏感信息

- RunningHub/Gemini 携带凭据的 API 请求使用固定 HTTPS 端点并拒绝重定向，避免 Authorization 或请求体被跨域转发。
- 日志使用统一 secret masking，并限制错误详情长度；未发现主动记录完整 Key 的路径。
- RunningHub 与 Gemini Key 由 Electron safeStorage 加密；系统加密不可用或 Linux `basic_text` 后端时失败关闭，不会静默存明文。
- `.env`、`.env.local`、`.env.*` 已被 `.gitignore` 忽略，当前 Git 未跟踪任何 `.env` 文件。项目没有必须通过环境变量提供的凭据，因此未创建空的 `.env.example`。

### CI/CD

- 未使用 `pull_request_target`。
- 第三方 Actions 均固定到完整 commit SHA。
- checkout 使用 `persist-credentials: false`；普通验证工作流使用 `contents: read`，发布权限只出现在发布流程。
- 发布流程包含 SHA-256 和 provenance；应用自更新还会校验 GitHub 提供的 SHA-256。

## 6. 需要开发者决定

### DEP-02/DEP-03：electron-builder 构建链告警

`npm audit` 当前报告 1 High、8 Moderate，但 `npm audit --omit=dev` 为 0。两个独立根因均只存在于 electron-builder 构建链，不进入打包后的应用运行时：

1. `http-cache-semantics@4.2.0`：High，受影响版本 `<=4.2.0`，公告目前没有修复版本。其利用场景是共享 HTTP 缓存跨用户泄漏；本项目仅在打包工具下载依赖时经过该链，不运行共享缓存服务。
2. `sprintf-js@1.1.3`：Moderate，无修复版本；风险是攻击者控制格式串精度导致拒绝服务。本项目没有把用户输入作为该构建工具的格式串。

`npm audit` 建议把 electron-builder 降到 26.5.0，但当前使用 26.15.3，属于降级且可能影响已验证的 Windows/macOS 构建。可选方案：

- A（建议）：保持 26.15.3，只在受信任 CI/开发机执行打包，持续跟踪上游修复。
- B：专门建立兼容性分支，降到 26.5.0 后完整构建 Windows、macOS ARM64、macOS x64；验证通过后再决定是否合并。
- C：更换打包工具或自行维护依赖 override；改动较大，不建议为当前低实际暴露立即实施。

### SUP-01：发行包代码签名与 Apple 公证

- macOS 当前明确配置 `identity: "-"`、`notarize: false`；Windows 也未配置 Authenticode 证书。
- 风险：用户无法通过操作系统签名验证发布者身份，SmartScreen/Gatekeeper 信任体验较差；GitHub 账号或发布流程被攻破时，独立签名可增加一道验证边界。
- 方案：购买/配置 Windows 代码签名证书；加入 Apple Developer Program，使用 Developer ID Application 签名并提交 notarization。此项需要证书和账号，不应由代码审核擅自启用。

## 7. 剩余风险与建议

- DATA-01：任务参数、生成词、媒体路径和任务历史保存在当前系统用户的 SQLite/localStorage 中，未额外做字段级加密。它们不是 API Key，但若设备账号被他人控制，可能暴露创作内容。若这是敏感业务素材，可考虑整库加密或系统凭据保护；这会影响迁移、备份和性能，需要产品决策。
- 自动更新仍以 GitHub Release/API 和仓库控制权为信任根；SHA-256 可防传输损坏，但摘要和文件来自同一平台。代码签名是下一步最有价值的独立信任层。
- 安全扫描应加入 CI：`npm audit`、`npm --prefix frontend audit`、`node scripts/security-scan.mjs --history`，并在上游发布修复后移除构建链告警。
- 建议在每次新增 IPC、下载源、工作流导入能力或外部模型供应商时复查来源校验、大小限制、超时和日志脱敏。

## 8. 验证结果

- `npm audit --omit=dev`：0 漏洞。
- `npm --prefix frontend audit`：0 漏洞。
- OSV 对全部 15 个不同直接依赖的精确版本查询：0 个直接命中。
- TypeScript 根工程与前端 typecheck：通过。
- 生产桌面构建：通过。
- 自动化测试：259/259 通过。
- Electron 桌面 smoke：12/12 场景通过。
- 包边界：364 个发布文件，4 个干净工作流，用户数据和参考目录未进入包。
- 密钥扫描：当前文件、生成文件、Git 历史均 0 命中。

## 9. 主要外部依据

- source-map-js：<https://github.com/advisories/GHSA-68fv-2mgg-jv7q>
- http-cache-semantics：<https://github.com/advisories/GHSA-ch52-4w7c-c8xp>
- sprintf-js：<https://github.com/advisories/GHSA-hp3w-g68c-fv3c>
- Electron 官方安全清单：<https://www.electronjs.org/docs/latest/tutorial/security>
- OSV API：<https://google.github.io/osv.dev/api/>
