# RunningHub Backend Core Implementation Plan

## Scope

Build a renderer-independent Node.js/TypeScript backend for RunningHub multi-workflow,
multi-job, multi-account execution. The core exposes an in-process API and Node
`EventEmitter`; it does not start an HTTP server and contains no frontend code.

## Source hierarchy

1. RunningHub Developer Kit (`llms.txt`, `rh-api-contract.md`) is authoritative for
   authentication, upload, query statuses, output parsing, retries, and security.
2. Official `RH_CLI` is the implementation reference for HTTP behavior, account
   status, media upload, polling, errors, output parsing, download, AI App submission,
   and `nodeInfoList` updates.
3. ComfyStudio supplies the generic API-workflow literal scanner rule.
4. comfyui2api supplies semantic scoring ideas and stable workflow profiles.
5. SwarmUI supplies the one-capacity resource claim/release model.
6. VideoKit is consulted only for key status migration, manual/automatic disabling,
   disable reasons, masking, and failure evidence. Its UI and product architecture are
   not reused.

## Directory

```text
src/core/
  accounts/accountPool.ts
  downloads/downloads.ts
  jobs/jobs.ts
  runninghub/client.ts
  runninghub/errors.ts
  scheduler/scheduler.ts
  workflows/nodeInfo.ts
  workflows/parser.ts
  workflows/profiles.ts
  workflows/recognizer.ts
  config.ts
  database.ts
  events.ts
  index.ts
  logger.ts
  secretStore.ts
  types.ts
scripts/dev.ts
tests/
  fixtures/
  *.test.ts
THIRD_PARTY_LICENSES/
```

## Official RunningHub logic to translate

- `http.py`: bearer headers, timeouts, JSON validation, status handling, secret masking.
- `media.py`: binary multipart upload and `data.download_url` validation.
- `account.py`: `/uc/openapi/accountStatus` normalization of `remainMoney`,
  `remainCoins`, `currentTaskCounts`, and `apiType`.
- `app/client.py`: AI App submit payload, `taskId`, node validation, result parsing.
- `poll.py`: five-second bounded polling and transient query tolerance.
- `output.py`: `results[].url/outputUrl/text/content/output` parsing and safe filenames.
- `app/nodes.py`: minimal upsert-based `nodeInfoList` builder.

Submit safety is intentionally stricter than generic retry advice: after a submit request
is dispatched, a timeout, reset, or process crash without a `taskId` becomes
`SUBMIT_UNKNOWN` and is never automatically resubmitted.

## VideoKit concepts to retain

- Normalize legacy string arrays into status-bearing key records.
- Separate `manualDisabled` and `autoDisabled`; manual disable always wins.
- Preserve `autoDisabledReason` and bounded failure evidence.
- Return masked key previews only; never put raw keys in renderer-safe DTOs.
- Do not use VideoKit quota thresholds as RunningHub account facts.

## Workflow parsing and profiles

- Accept ComfyUI/RunningHub API-format JSON only in V1.
- Scan every primitive `string | number | boolean` input.
- Treat `[nodeId, outputSlot]` as graph links and exclude it from parameters.
- Preserve unknown literal parameters as `semanticType: unknown`.
- Score semantics from field name, class type, node title, value type, and light graph
  context. Low-confidence or ambiguous results set `needsReview`.
- Store workflow hash, increment profile version when the normalized workflow changes,
  and freeze the complete profile inside every Job snapshot.

## Database schema

SQLite uses `better-sqlite3`, WAL, `busy_timeout=5000`, and foreign keys. Tables:

- `accounts`: encrypted key, unique SHA-256 fingerprint, enable/disable flags, state,
  current job, normalized account facts, cooldown and timestamps.
- `workflows`: raw API JSON, stable profile JSON, hash, profile version and timestamps.
- `jobs`: immutable snapshot JSON plus account/task affinity, state, uploaded media,
  outputs, bounded raw result/error data, retry phase and lifecycle timestamps.

Claims atomically change the oldest `PENDING` job to `ASSIGNED` and an eligible account
to `BUSY` in one SQLite transaction.

## Job state machine

```text
PENDING -> ASSIGNED -> UPLOADING -> SUBMITTING
SUBMITTING -> REMOTE_QUEUED | RUNNING | SUBMIT_UNKNOWN
REMOTE_QUEUED <-> RUNNING
REMOTE_QUEUED | RUNNING -> REMOTE_SUCCESS | FAILED | RETRY_WAIT
REMOTE_SUCCESS -> DOWNLOAD_PENDING -> DOWNLOADING -> COMPLETED
DOWNLOAD_PENDING | DOWNLOADING -> RETRY_WAIT | FAILED
PENDING -> CANCELLED
```

`remoteTaskId` forbids further submission. Query and download retries preserve it.

## Account state machine

`IDLE`, `BUSY`, `REMOTE_BUSY`, `CHECKING`, `COOLDOWN`, `NO_BALANCE`,
`INVALID_KEY`, `TEMP_UNAVAILABLE`, `DISABLED`.

- Eligible means enabled, not manually/automatically disabled, `IDLE`, no current job,
  and cooldown expired.
- `currentTaskCounts > 0` without a local job maps to `REMOTE_BUSY`.
- A local job with `remoteTaskId` keeps the account `BUSY` regardless of a transient
  account-status count of zero.
- Remote success/failure releases the account before local downloading.

## Error classification

| Class | Account action | Job action |
| --- | --- | --- |
| `ACCOUNT_INVALID_KEY` | auto-disable | requeue before task creation |
| `ACCOUNT_NO_BALANCE` / code 605 | auto-disable | requeue before task creation |
| `RATE_LIMIT` / 429 | cooldown | retry only safe phase |
| `CONCURRENCY_LIMIT` | refresh/remote busy | requeue before task creation |
| `INVALID_PARAMETER` / code 1007 | none | fail |
| `WORKFLOW_VALIDATION` / code 433 | none | fail |
| submit transport ambiguity | keep claimed | `SUBMIT_UNKNOWN` |
| query transport error | keep busy and task affinity | retry query |
| download error | account already released | retry download only |

## Runtime dependencies

- Runtime: `better-sqlite3` only.
- Node built-ins: `fetch`, `FormData`, `Blob`, `fs`, `path`, `crypto`, `events`.
- Development: TypeScript, `tsx`, Node and better-sqlite3 type definitions.

## Verification

- Parser literals, graph links, unknown nodes, titles, and semantic candidates.
- State transition legality and immutable snapshots.
- Three accounts / ten jobs with max one remote task per account.
- Faster account claims the next FIFO job immediately.
- Codes 605, 1007, and 433 have distinct account/job behavior.
- Query failures never resubmit; submit ambiguity becomes `SUBMIT_UNKNOWN`.
- Restart recovery resumes query/download and never duplicates generation.
- Mock contract tests validate auth, account status, upload, submit, query, and masking.
- Real integration is opt-in through `RH_TEST_API_KEY` and `RH_TEST_WORKFLOW_ID`.

