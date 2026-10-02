# v0.1.50 安全与可靠性审核报告

日期：2026-10-02（Asia/Tokyo）；基础审计执行于 2026-10-01。项目：RunningHub Multi-Task Runner。
发布目标：个人私有仓库 `chiqi51386-afk/RunningHub-Multi-Task-Runner`，Windows x64 ZIP，不是安装器。

## 结论与边界

本轮发现并修复了提交中取消竞态、重复节点映射、更新版本路径校验、IPC 来源及本地凭据保护等问题。当前本地 182 项自动化测试通过、8 项隔离 Electron 桌面检查通过；已运行构建和依赖扫描。**这不是“没有任何漏洞”的保证，也不代表 RunningHub 云端生成效果已经实测。**

覆盖：第一方 TypeScript/React/Electron 源码全范围风险模式检索，关键输入→节点→提交、账号占用→取消→恢复、下载→落盘、IPC、数据库迁移、更新及 CI 路径人工复核；两份依赖锁文件；当前源码、生成的文本文件和本地可达 Git 历史的特征密钥扫描。未对每个依赖源码、第三方原生二进制、所有历史备份做逐行审核。没有执行真实付费生成，没有删除个人数据，也没有运行旧数据库清理脚本。

本报告写入源码时 GitHub 新版构建尚未完成，不能把本地通过当成云端成功；云端结果以对应 Actions 运行及 Release 产物为准。此前两个 2026-10-01 阶段报告保留历史含义，当前进展以本报告为准。

## 项目概况与依赖

TypeScript、Electron、React、Vite、better-sqlite3；npm 根目录与 frontend 各一份 package-lock.json。16 条直接依赖声明、15 个不同包名；两锁文件合并去重有 409 个包名/版本组合（含开发、可选和不同版本）。

| 直接依赖 | 锁定版本 | 作用 / 公告核验 |
|---|---|---|
| better-sqlite3 | 12.11.1 | 主进程数据库；[官方安全页](https://github.com/WiseLibs/better-sqlite3/security) |
| @electron/rebuild | 4.2.0 | 原生模块构建；[官方项目](https://github.com/electron/rebuild) |
| @types/better-sqlite3 | 7.6.13 | 类型声明；[官方定义](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/better-sqlite3) |
| @types/node | 24.13.6 | 类型声明；[官方定义](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) |
| electron | 44.4.3 | 桌面运行时；[官方安全公告](https://github.com/electron/electron/security/advisories) |
| electron-builder | 26.15.3 | 打包工具；[官方安全页](https://github.com/electron-userland/electron-builder/security) |
| tsx | 4.23.13 | 开发/测试；[官方版本记录](https://github.com/privatenumber/tsx/releases) |
| typescript（两侧） | 5.9.3 | 编译工具；[官方安全页](https://github.com/Microsoft/TypeScript/security/) |
| @vitejs/plugin-react | 5.2.0 | 前端构建插件；[官方公告](https://github.com/vitejs/vite-plugin-react/security/advisories) |
| lucide-react | 0.544.0 | 图标；[官方安全页](https://github.com/lucide-icons/lucide/security) |
| react / react-dom | 各 19.3.0 | 客户端界面；[官方公告](https://github.com/react/react/security/advisories) |
| @types/react / @types/react-dom | 各 19.3.0 | 类型声明；[官方定义项目](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| vite | 7.3.6 | 本机开发及构建；[官方公告](https://github.com/vitejs/vite/security/advisories) |

关键间接版本：esbuild 0.28.2、Rollup 4.63.4、tar 7.5.22、minimatch 10.2.6、glob 7.2.3、@electron/asar 3.4.1、@electron/get 5.1.0 / 3.1.0、app-builder-lib 26.15.3、node-gyp 12.4.0、undici 7.29.1、semver 7.8.5 / 6.3.1。

扫描结果：根 npm audit 0（依赖统计 342），frontend audit 0（120）；OSV querybatch 对 409 个包名/版本组合报告 0 受影响项。两侧统计包含重复项，不能相加当唯一依赖数。搜索无命中和数据库零结果都不是未知漏洞不存在的证明。

已核验的重要公告与适用性：

- Vite Windows 路径绕过 [GHSA-fx2h-pf6j-xcff](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)：7.3 分支修复为 7.3.5，当前 7.3.6；相关攻击面是暴露的开发服务，不是生产静态文件。
- Vite source map 穿越 [GHSA-4w7w-66w2-5vf9](https://github.com/vitejs/vite/security/advisories/GHSA-4w7w-66w2-5vf9)：7.3 分支修复为 7.3.2，当前不在列出范围。
- Electron Critical Buffer 问题 [GHSA-q6m5-f73j-m9mc](https://github.com/electron/electron/security/advisories/GHSA-q6m5-f73j-m9mc)：影响 42.3.1/42.3.2，修复 42.3.3；当前 44.4.3 不在范围。
- Electron High 沙箱弹窗问题 [GHSA-gr2m-v5gq-v685](https://github.com/electron/electron/security/advisories/GHSA-gr2m-v5gq-v685)：44 分支在 beta.5 修复；当前版本更高，应用另行拒绝新窗口。
- Electron High 缓存问题 [GHSA-qmv3-fv6v-rmhq](https://github.com/electron/electron/security/advisories/GHSA-qmv3-fv6v-rmhq)：44 分支在 beta.6 修复，当前不在列出范围。
- React/RSC 公告不应泛化为所有 React 客户端；本项目没有 React Server Components 服务。electron-builder 的 AppImage 公告也不等于本项目受影响，本项目不生成 AppImage。没有为“搜索未命中”的包虚构 CVE。

锁文件标记弃用：boolean 3.2.0、glob 7.2.3、inflight 1.0.6、prebuild-install 7.1.3、rimraf 2.6.3。主要在构建链，prebuild-install 是 SQLite 安装工具；inflight 有官方内存泄漏弃用提示。建议跟随上游兼容版本替换，不强行跨主版本覆盖。未发现直接依赖明显仿冒名称，但未做完整供应链取证。没有执行大版本升级。

## 问题汇总

严重程度包含本应用业务完整性风险，不等同于 CVSS。

| 编号 | 类别 | 严重级别 | 位置 | 状态 |
|---|---|---|---|---|
| SEC-01 | 密钥 | High | src/core/secureSecrets.ts:16；src/desktop/main.ts | 已修复：桌面系统加密、事务迁移、禁止明文回退 |
| SEC-02 | 代码 | Medium | src/desktop/main.ts:38 | 已修复：IPC 主窗口/主框架/URL 来源校验与窗口隔离 |
| SEC-03 | 密钥 | Low | .gitignore | 已修复：忽略 .env.*，保留 .env.example 例外 |
| SEC-04 | 依赖/CI | Low | .github/workflows/*.yml | 已修复：第三方 Action 固定 SHA、checkout 不持久化凭据 |
| SEC-05 | 密钥 | Medium | src/core/runninghub/errors.ts:4 | 已修复：JSON 错误中的凭据脱敏 |
| SEC-06 | 代码 | Medium | src/core/runninghub/client.ts:238 | 已修复：携带 Key 的 API 请求不跟随重定向 |
| SEC-07 | 代码/CI | Medium | .github/workflows/release.yml | 已修复：标签经环境变量作为数据传入，非插入脚本文本 |
| SEC-08 | 代码 | Low | src/core/accounts/accountPool.ts:115 | 已修复：系统解密失败分类，提示重新填写 Key |
| SEC-09 | 代码 | Medium | frontend/vite.config.ts | 已修复：生产 CSP，开发热更新保留 |
| SEC-10 | 代码/映射 | Medium | src/core/workflows/profiles.ts:88 | 已修复：拒绝重复 nodeId/fieldName 映射 |
| SEC-11 | 代码/映射 | Low | src/core/workflows/profiles.ts:113 | 已修复：仅匹配节点/inputs 自身属性 |
| REL-01 | 代码/任务一致性 | High | src/core/scheduler/scheduler.ts:81；src/core/database.ts:186 | 已修复：提交中取消持久化，保留账号和远端编号 |
| SEC-12 | 代码/路径 | Medium | src/desktop/updates.ts:49 | 已修复：完整校验版本串，更新包版本须匹配标签 |
| SEC-13 | 代码/维护工具 | Medium | scripts/prepare-release-data.mjs:13 | 已加防误用确认；该脚本不进入源码交付包、也不由正常构建执行 |
| SEC-14 | 代码/CI | Medium | .github/workflows/cloud-verify.yml；release.yml | 已修复：每条 npm 命令检查退出码，防止前一步失败被后一步成功掩盖 |
| RES-01 | 代码/网络边界 | Medium | src/core/runninghub/client.ts:296 | 建议关注：按用户兼容要求保留 HTTP(S)/重定向下载，不强制公网 HTTPS |
| RES-02 | 代码/本地文件授权 | Medium | src/desktop/main.ts:473 | 待开发者决定：可信页面被攻陷后仍可能构造本地媒体路径 |
| RES-03 | 密钥/历史副本 | Medium | 旧数据库、WAL、备份 | 建议关注：系统加密不会擦除历史明文副本 |
| RES-04 | 代码/更新渠道 | Low | src/desktop/updates.ts | 按用户要求暂不处理：私有仓库匿名检查更新可能 404 |
| DEP-01 | 依赖维护 | Low | package-lock.json | 建议关注：弃用间接依赖，不擅自跨主版本替换 |

## 修复机制、条件与验证

### 任务取消与账号占用

原触发条件：用户在提交请求已发出、taskId 未返回时取消。本地提前标记取消并释放账号，远端返回的 taskId 无法保存，造成远端继续生成但本地失联。用户选择方案 1 后：

- SUBMITTING 持久化 cancel_requested_at，不释放账号、不宣称已取消。
- 得到 taskId 后先保存，使用原账号发取消请求，并查询确认远端状态。
- 远端拒绝/网络失败时明确保留跟踪；不把“接受取消请求”当作取消完成。
- 提交响应丢失则 SUBMIT_UNKNOWN，保留账号，不自动重发付费任务。
- 上传被取消时，上传后/提交前再检查终态，禁止继续创建任务。
- 并发取消共用一个请求；重启恢复取消意图；停机等待取消请求结束再关闭数据库。
- 前端读取持久化标记，按钮显示“正在取消…”并禁用重复点击。

新增 8 项合成回归覆盖取消、拒绝、网络失败、提交未知、明确拒绝、无本地素材的重启、SQLite 重开恢复及上传期间取消；无真实 Key/付费任务。

### 映射、批次与下载

校验重复目标避免两个前端参数覆盖同一节点字段；Object.hasOwn 避免继承字段被当真实节点。既有回归覆盖五个默认工作流的逐槽编号、空素材显式清空、生成词、中文优化开关、负向默认值、Plus、MV 起止时间转 duration=end-start、二采和分辨率参数；不修改作者的 +24 逻辑。

上传记录按账号/文件隔离；最终提交参数记录保留，不能把当前页面当成历史任务实际提交值。批次独立 handler、数量检查及事务测试保留。新增下载测试验证中断不产生完整文件、重试写入选定目录、取消不覆盖已完成文件。未以单元测试保证远端模型严格遵循提示词。

### 桌面、凭据与日志

取得旧数据库副本即可读取旧 Key，是 SEC-01 的利用条件。桌面改用系统 safeStorage，逐条校验后同事务迁移，失败回滚、不明文降级；不改变账号 ID、任务和个人工作流。换机/换系统用户不能保证解密，需重填 Key。旧版本不能读取新密文，不建议用旧程序打开升级后的同一目录。

IPC 防护针对非可信窗口/子框架获得桥接能力的情况；contextIsolation、sandbox 开启，nodeIntegration/webview 关闭，导航、新窗口、权限请求受限。生产 CSP 不允许页面脚本直接联网、eval、frame/object；本地媒体预览保留。API 307/308 原可转发含 Key 请求体，现拒绝重定向；不改变不带 Key 的结果下载重定向。错误脱敏增加 JSON 字段与转义覆盖，但不能保证脱敏未知格式中的所有敏感信息。

### 更新与发布

SEC-12 需要异常/被篡改的受信 Release 元数据；旧逻辑只校验连字符前的数字，后缀又参与本地目录构建，存在路径越界风险。现在严格限制完整版本字符与资源版本匹配。更新保留个人仓库 URL 限制、SHA-256/大小验证及 PowerShell 原生解压；没有宣称摘要能抵御发布账号本身被攻陷。自动替换程序仍不是事务式回滚，磁盘/权限故障需手动恢复；未做完整恶意 ZIP 模糊测试。

SEC-13 是本机维护误操作风险：旧脚本会清空 jobs、重置账号占用。现必须传明确确认参数才会打开数据库；没有执行脚本。CI 每条 npm 命令失败即停止。

用户已同意不购买套餐的发布方式：此个人私有仓库因不具备 Enterprise 私有构建证明权限，记录明确例外并跳过额外 provenance attestation；不跳过测试/构建/摘要，不改公开、不吞掉其他构建失败。[GitHub 官方限制](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)。Windows ZIP、源码 ZIP、报告和 SHA256SUMS 保存为私有 Actions artifact，再发布到本仓库。不能称其具有构建来源签名或 Windows 代码签名。

## 密钥扫描

本地可达 30 个 Git 提交中的 381 个 blob、扫描时 159 个工作区文件与 161 个生成文本文件完成特征检索，未命中私钥头、GitHub token、AWS AccessKey、sk- 型 Key 或带凭据数据库 URL。新增 `scripts/security-scan.mjs --history` 可复查，只输出位置/类型，不输出匹配值。报告/新增文件数量会随归档增加。

没有跟踪 .env、私钥证书或个人 SQLite 文件；源码包按白名单包含程序、测试、内置工作流和构建脚本，不包含账号库、草稿、个人媒体、node_modules、诊断资料或旧清理工具。未发现需替换的实际硬编码凭据，所以不制造空环境变量配置。正则不能发现所有无特征 Key；不可达历史、外部备份和原生二进制未完整取证。若任何真实凭据曾提交/泄露，必须在对应平台撤销重发，删代码或加密本地数据库并不足够。

## 已执行检查

- npm audit 两侧为 0；OSV 409 包名/版本组合未报告漏洞。
- Electron Node 模式全部 182 项自动化测试通过，保留本机 SQLite Electron ABI；云端使用 npm test 重建 Node ABI 后测试。
- `npm run desktop:build`（前端 tsc/Vite、后端 tsc）通过。
- 隔离 Electron：BRIDGE、OVERVIEW_SCROLL、SETTINGS_SCROLL、DROPDOWN、THEMES、H3_LAYOUT、MV_LAYOUT、SHARED_BATCH 全部 PASS。
- 许可证和打包边界检查通过；安全扫描未命中，git diff 空白检查通过。
- 没有在真实账号上生成/取消任务；macOS 系统钥匙串、本次云端成品首次启动、任意第三方工作流节点和真实断电恢复仍待实际环境验证。

## 需要决定与后续建议

1. RES-02：可增加“主进程批准的媒体文件清单”来限制被攻陷页面读取本地文件，但需设计旧草稿/再次生成迁移。建议单独版本实现，当前不擅自使历史输入失效。利用前提是可信 renderer 被攻陷，并非任意网页可直接调用 IPC。
2. RES-01：保持用户要求的正常下载兼容性；其代价是恶意远端下载 URL/本地任务数据可能访问内网。若以后需要限制，使用可配置允许列表与逐跳校验，不以简单字符串过滤冒充 DNS 级防护。
3. RES-03：保留旧备份，未经许可不删除。需要凭据轮换时由用户在平台操作；跨机账号需重新录入 Key。
4. 私有仓库更新访问问题暂不改变；不要把仓库改公开解决它。Windows 包无代码签名；macOS 公证不在本次 Windows 发布范围。
5. 定期重跑依赖审计，并优先补充真实网络故障/取消响应丢失、低余额/单账号多任务、已打包程序升级回归。现有测试是明确场景证据，不是全状态空间证明。

## v0.1.50 云端构建修正

v0.1.49 云端运行 36875684828 在许可证清单校验阶段失败，没有生成 Release。原因是校验直接比较 LF 生成文本与 Windows Git checkout 的 CRLF 文本；当前只将 CRLF 归一化后比较，依赖名称、版本、许可证和其他内容校验不变。新增回归验证 CRLF 通过、内容篡改仍失败。没有绕过测试，没有覆盖旧版本标签。v0.1.50 云端构建结果以新运行记录为准。

