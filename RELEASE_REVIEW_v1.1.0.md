# v1.1.0 正式版发布检查

## 本地审核结果

- 完整安全审核已记录于 `SECURITY_AUDIT_v1.1.0.md`。
- 根工程和前端 TypeScript 类型检查通过。
- 259 项自动化测试全部通过。
- 生产桌面构建和 12 项 Electron smoke 场景通过。
- 前端 `npm audit` 为 0；运行时 `npm audit --omit=dev` 为 0。
- 当前工作树、构建产物和 611 个可达 Git 历史 blob 的凭据模式扫描无命中。
- 节点映射检查覆盖 4 个内置工作流的全部输入、媒体顺序和输出配置。
- 发布包边界检查确认本地数据库、API Key、日志、生成结果及临时文件不会进入源码包。

## 已完成的安全加固

- 升级有安全修复的前端间接依赖，并同步 Electron、Vite、tsx 等补丁版本。
- 更新包解压前检查所有 ZIP 条目，拒绝越出 staging 目录的路径。
- 自动更新下载最终地址必须为 HTTPS，并验证 GitHub SHA-256 摘要。
- 密钥扫描覆盖 Google、GitHub、AWS、常见服务 Token、数据库凭据 URL 和 webhook。
- 正式桌面端使用系统安全存储；系统加密不可用时拒绝明文持久化。

## 已接受或待处理事项

- 任务输出文件为提高第三方 CDN 兼容性，不限制下载域名、协议或最终重定向；更新程序不采用此宽松策略。
- electron-builder 的构建期间接依赖仍有上游暂无修复的告警，但不进入应用运行时；打包只在受信任开发机和 GitHub Actions 中执行。
- Windows 尚未配置 Authenticode 签名，macOS 尚未签名和 Apple 公证。
- 曾粘贴到会话中的 API Key 必须由开发者在服务商后台轮换；该 Key 未进入仓库或 Git 历史。
