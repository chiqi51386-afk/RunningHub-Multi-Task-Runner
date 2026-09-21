# Backend Gap Audit

本审计按《后端增量补强 Codex 指南》执行。原则是保留现有 TypeScript、SQLite、Scheduler、Workflow Parser 与 Account Pool，只补缺口。

| 功能 | 当前是否存在 | 当前实现文件 | 是否需要修改 | 参考项目/依据 | 修改建议 | 风险/优先级 |
|---|---|---|---|---|---|---|
| taskId 提交后立即落库 | 是 | `src/core/scheduler/scheduler.ts`、`src/core/database.ts` | 否 | RunningHub batch 思路 | 保持 `runWorkflow → REMOTE_QUEUED(remoteTaskId) → poll` | P0 已满足 |
| remoteTaskId 恢复只 Query | 是 | `src/core/scheduler/scheduler.ts` | 否 | Restart Recovery | 保持恢复任务直接 `launch`，不得重新 Submit | P0 已满足 |
| SUBMITTING 崩溃保护 | 是 | `src/core/scheduler/scheduler.ts` | 否 | 指南 | 恢复为 `SUBMIT_UNKNOWN` | P0 已满足 |
| Account Claim 原子性 | 是 | `src/core/database.ts` | 否 | SwarmUI | SQLite transaction + 条件更新已覆盖 | P0 已满足 |
| Account Release 幂等且校验所有权 | 原实现不完整，已补 | `src/core/database.ts`、`src/core/accounts/accountPool.ts` | 已修改 | SwarmUI | Release 必须匹配 `current_job_id = jobId` | P0，已测试 |
| SUCCESS 后立即释放账号 | 是 | `src/core/scheduler/scheduler.ts` | 否 | ai-dock | 在进入 Download Queue 前释放 | P0 已满足 |
| Download 失败不重新生成 | 是 | `src/core/downloads/downloads.ts`、`src/core/jobs/jobs.ts` | 否 | ai-dock / InvokeAI | 保持独立下载重试 | P0 已满足 |
| Workflow Profile / Job Snapshot 隔离 | 是 | `src/core/database.ts`、`src/core/jobs/jobs.ts` | 否 | comfyui2api | 创建 Job 时冻结完整 Profile | 已满足 |
| 未知 Workflow 参数保留 | 是 | `src/core/workflows/parser.ts`、`profiles.ts` | 否 | comfyui2api | 前端也必须显示并提交未知参数 | 已满足 |
| COMBO 提交真实 value | Backend 支持，前端原实现不完整，已补 | `frontend/src/App.tsx` | 已修改 | ResolutionSelector 实测事故 | label 只展示，Job Snapshot 保存 option value | P0，已构建 |
| 动态 Workflow 参数 UI | 原不存在，已补 | `frontend/src/App.tsx`、`frontend/src/types.ts` | 已修改 | Workflow Profile | 不再使用固定 Prompt/Duration/Ratio 字段 | 已完成 |
| Media SHA256 Upload Cache | 已补 | `src/core/database.ts`、`src/core/scheduler/scheduler.ts` | 已修改 | runninghub-batch-api | `accountId + SHA256` 唯一缓存；命中后复用上传值 | P1 已测试 |
| Recovery Revalidation | 已补 | `src/core/scheduler/scheduler.ts` | 已修改 | ComfyUI-Persistent-Queue | 恢复前验证 Workflow、Profile、媒体、Account、Snapshot | P1 已测试 |
| RunningHub Response Normalizer | 已补 | `src/core/runninghub/normalizer.ts` | 已修改 | widecyruschan/runninghub-app | 统一 taskId/status/error/results/usage/fileName | P1 已测试 |
| Mock RunningHub Client | 已补 | `src/core/runninghub/mockClient.ts` | 已修改 | runninghub-batch-api | 可注入 Client interface，支持延迟、状态序列和错误脚本 | P1 已测试 |
| Queue 最大容量 | 否 | — | 可后续 | ai-dock | 增加 `maxPendingJobs` 配置 | P2 |

## 本轮结论

P0 与 P1 已完成。实现保持现有 TypeScript、SQLite、Scheduler、Workflow Parser 与 Account Pool 架构；P2 项仍按指南保留为后续增强，不影响 Backend V1 稳定状态。
