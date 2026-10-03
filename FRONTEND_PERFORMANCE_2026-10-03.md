# 前端性能与结构调整

日期：2026-10-03。基于当前 0.1.50 工作目录，未发布 GitHub 或生成发行压缩包。

## 已完成

| 范围 | 修改 | 原因 |
| --- | --- | --- |
| 任务队列 | 筛选排序使用 useMemo；JobRow 使用 memo；行事件使用稳定回调并读取最新处理函数 | 避免无关状态更新重画所有任务，同时避免回调读取旧任务 |
| 运行时间 | 所有活动时间组件订阅一个共享时钟；最后一个订阅卸载后清除计时器 | 减少 timer，秒级更新只发生在时间组件 |
| 长列表 | 可变行高虚拟列表，ResizeObserver 测量，视口外保留少量行；保留正在聚焦的行 | 任务增加时不持续增加图片和 DOM 数量；允许展开错误详情 |
| 概览统计 | 账号与任务分别单次遍历；最近任务使用 useMemo | 减少重复扫描 |
| 组件结构 | Overview、Accounts、Jobs、Workflows 拆到 views；任务行拆到 components；设置、账户、工作流编辑、任务预览拆到 modals | App.tsx 从 894 行减至 351 行 |
| 草稿存储 | 常规草稿、MV 草稿、制作批次、浏览器工作流和界面设置采用 300ms 防抖 | 序列化不再随每次输入立即执行；pagehide、beforeunload、隐藏页面和卸载时保存待写内容 |
| 通知 | 完成通知保留最近 5 条；错误改为最多 5 条队列并去重 | 避免通知无上限累积和单条错误相互覆盖 |
| 媒体 | 有 previewUrl 时不再额外创建 objectURL；输出播放器切换时卸载，关闭时暂停并释放 src | 减少多余资源；兼容开发环境 StrictMode 重放 |
| 类型 | 前端直接引用 core 的 AccountState、JobStatus、WorkflowValueType、WorkflowSemanticType、MediaControlBinding | 消除这几项重复定义；界面专用字段保留 |
| 构建 | 工作流页面及弹窗延迟加载；React 独立 chunk；明确关闭生产 sourcemap | 首屏不必加载所有编辑弹窗；局部 Suspense 不隐藏整个应用 |

新增功能未引入 npm 依赖。原有参数映射、任务提交数量检查及草稿迁移规则保留。

## 验证

- `npm run desktop:build`：前端和后端构建通过。
- 现有测试：186/186 通过。使用 Electron 对应的 Node 运行环境，以匹配当前 SQLite 原生模块 ABI；系统 Node 直接运行时会发生 ABI 不匹配。
- `npm run licenses:check`、`npm run package:verify`：通过。
- 独立 Electron 渲染测试：1000 条任务初始挂载 10 行；滚动可到最后一条；滚动期间 DOM 数量保持受限。
- 验证 10 个运行任务共用一个 timer，筛选后无订阅时 timer 被释放。
- 验证一个任务变化时其他 JobRow 跳过渲染；取消和再次生成调用最新回调并传入正确任务。
- 验证媒体关闭释放 src、StrictMode 重放保留 src。
- 验证连续输入合并保存、pagehide 和卸载保存最后的输入。

渲染测试复现：先运行 `npm --prefix frontend run dev -- --port 4174`，再运行 `npx electron scripts/test-frontend-performance.cjs`。该测试使用独立隐藏窗口，无 preload、个人数据库或真实 API 任务。

## 边界

- useMemo 无法免除真实 jobs 数据变化后的筛选；本次主要减少无关更新、行渲染和挂载数量。
- 原先每个 ElapsedTime 的状态更新并不直接引起整张任务列表重渲染，不能将列表卡顿全部归因于 timer。
- migrateWorkflowView 用于持久化数据兼容，不因共用类型而删除。
- 强制结束进程或断电无法保证执行退出保存；防抖窗口内最多约 300ms 的最新编辑仍可能未写入。
- 测试没有执行收费生成或测量真实大视频的 GPU 内存；不能据此宣称所有场景均无卡顿。
