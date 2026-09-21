# RunningHub Multi-Task Runner

RunningHub 多工作流、多任务、多账号桌面客户端。当前发布版本为 **0.1.0**。
每个账号同一时间只领取一个远端任务，任务统一进入 FIFO 队列，并在完成后自动下载到本地下载库。

The backend core stays independent from renderer frameworks and does not expose an HTTP
server. The `frontend/` directory contains the React/Vite renderer surface; Electron's
isolated preload bridge connects it to the backend without exposing API keys to the page.

## Implemented

- Official RunningHub account-status, binary-upload, AI App submit, query/poll, output
  parsing, and download lifecycle.
- Configurable RunningHub host and bounded request/upload/query/download timeouts.
- API-key masking、SHA-256 排重指纹，以及用户明确选择的本机 SQLite 明文保存。
- API-format ComfyUI workflow scanning with primitive literals, graph-link exclusion,
  semantic recognition, unknown-parameter preservation, workflow hashes, and versioned
  profiles.
- Immutable Job snapshots and an explicit validated Job state machine.
- SQLite persistence with WAL, atomic account/job claim, task/account affinity, and
  restart recovery.
- Recovery revalidation for workflow/profile snapshots, media files, parameters, and
  assigned accounts before work is resumed.
- Per-account SHA-256 media upload cache, preventing duplicate uploads without assuming
  that RunningHub filenames are portable across accounts.
- A unified RunningHub response normalizer for task/status/error/result/usage and upload
  field variants.
- Injectable `RunningHubClientLike` plus a scripted `MockRunningHubClient` for scheduler,
  failure, delay, and crash-recovery testing without network or coin usage.
- Multi-account FIFO scheduling with one remote task per account.
- `SUBMIT_UNKNOWN` protection: ambiguous submissions are never automatically repeated.
- Account error separation (including RunningHub 605) from parameter/workflow failures
  (including 1007 and 433).
- Account release immediately after remote success and an independent download queue.
- Graceful shutdown that preserves remote tasks for the next recovery cycle.

## Install and verify

```bash
npm install
npm run typecheck
npm test
npm run build
```

The normal test suite uses local mocks and does not call RunningHub or consume balance.

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Or from the repository root:

```bash
npm run frontend:dev
npm run frontend:typecheck
npm run frontend:build
```

前端源码不携带演示账号或演示任务。Electron preload 提供隔离的
`window.runningHub` 桥接，页面本身不能直接读取 API Key。

首次启动会自动导入 `bundled-workflows/` 中的四个默认工作流：两个 MiniMax H3、
InfiniTetalk 和 LTX 2.3。发布包中的生成词、图片、视频和音频默认值均已清空，
不会携带作者测试素材；工作流节点结构、参数映射和使用说明仍完整保留。

## Desktop application

```bash
npm run desktop:start
```

桌面应用使用 RunningHub 海外站，将 API Key 按用户要求以明文保存在本机 SQLite，
并持久化账号、工作流和任务。请勿上传用户数据目录中的 `runninghub.sqlite`，也不要
把真实 API Key 写入源码、日志、截图或 Issue。首次启动可能会为 Electron 重建
SQLite 原生模块；回到 Node 后端测试时，`npm test` 会恢复 Node 兼容版本。

The non-billable desktop bridge check is:

```bash
npm run desktop:smoke
```

## Minimal use

```ts
import {
  PlainTextSecretStore,
  RunningHubBackend,
} from "./src/core/index.js";

const backend = new RunningHubBackend({
  databasePath: "./data/runninghub.sqlite",
  secretStore: new PlainTextSecretStore(),
});

const account = backend.accounts.add("RH-01", process.env.RH_API_KEY!);

const workflow = backend.workflows.importApiJson({
  name: "My Workflow",
  runningHubWorkflowId: "1234567890123456789",
  workflow: apiFormatWorkflowJson,
});

const job = backend.jobs.create({
  workflowId: workflow.id,
  parameters: { prompt: "A cinematic landscape" },
});

backend.events.on("job.updated", updated => {
  console.log(updated.id, updated.status);
});

await backend.start();
// Later:
await backend.stop();
await backend.close();
```

明文存储便于当前版本排查和迁移，但任何能读取该 Windows 用户数据目录的程序都可能
读取 API Key。发布源码和问题报告时必须排除数据库文件。

## Workflow input

V1 accepts RunningHub/ComfyUI API-format JSON:

```json
{
  "123": {
    "class_type": "CLIPTextEncode",
    "inputs": { "text": "prompt", "clip": ["10", 0] },
    "_meta": { "title": "Positive Prompt" }
  }
}
```

All primitive literal inputs are retained. `[nodeId, outputSlot]` values are graph
connections and are not exposed as parameters. Low-confidence mappings and unknown
future-node fields remain in the profile with `needsReview: true`.

## Development CLI

```bash
npm run dev -- accounts
npm run dev -- jobs
npm run dev -- import-workflow workflow-api.json 1234567890123456789 "H3"
npm run dev -- run
```

CLI 示例默认不导入账号；如需持久化账号，必须显式传入 `PlainTextSecretStore`。

## Opt-in real integration test

The real integration script can submit a billable workflow. It only runs when explicitly
confirmed:

```powershell
$env:RH_TEST_CONFIRM = "YES"
$env:RH_TEST_API_KEY = "..."
$env:RH_TEST_WORKFLOW_ID = "..."
$env:RH_TEST_NODE_INFO_JSON = '[{"nodeId":"1","fieldName":"text","fieldValue":"test"}]'
npm run test:integration
```

Optional `RH_TEST_MEDIA_FILE` tests upload. No real integration call is made by the normal
test suite.

See [BACKEND_IMPLEMENTATION_PLAN.md](./BACKEND_IMPLEMENTATION_PLAN.md) for architecture,
state machines, source boundaries, and error policy.
