For normal AI operation, use `/workspace` and the included `MODULE_GUIDE.md`. Desktop draft and segment logic is shared in `src/core/drafts`; no UI is installed. Raw `/jobs` endpoints below remain for compatibility.

# RH Runner Cloud (Linux)

Headless service. No Electron, web frontend, whitebox preview or proxy configuration.
Shares the desktop task engine, Gemini optimizer/TTS, workflow profiles and download recovery.
Runtime npm dependency: better-sqlite3 (and its native installation dependencies).

## Deploy

From the repository root: `docker compose -f cloud/compose.yaml up -d --build`.
The service is exposed on **localhost only**. The AI must run inside the same cloud computer.
Data persists in the `runner-data` volume. Never remove this volume during upgrades.
Stop the old instance before starting another instance against the same database.

For a direct Node 22.21+ or 24.5+ install: create a separate directory, copy `cloud/package*.json` into its root,
copy `src/core`, `src/cloud`, `cloud/tsconfig.json`, `bundled-workflows`, and `prompt-skills` preserving paths.
Run `npm ci`, `npx tsc -p cloud/tsconfig.json`, `npm prune --omit=dev`, then `npm start`.
The standalone source ZIP already contains this layout. If a native SQLite prebuild is unavailable, install Python 3, make and g++ before `npm ci`.
`RH_DATA_DIR` defaults to `./data`. `RH_PORT` defaults to 17863; keep `RH_BIND=127.0.0.1` outside Docker.
Use a service manager to keep it running. No proxy variables or Electron networking are used.

## Migrate accounts

1. Desktop → Account pool → **导出全部账号**. This file contains complete keys; do not publish it.
2. Upload `rh-accounts.json` to the Linux computer.
3. For Docker, copy the local API token (not platform keys):
   `docker compose -f cloud/compose.yaml cp runner:/data/api.token ./api.token`
   and `chmod 600 api.token`.
4. Run `python3 cloud/client.py POST /accounts/import --file rh-accounts.json --token-file api.token`.
5. GET `/accounts` to verify counts/settings. Repeat imports skip existing keys without resetting them.
   POST `/accounts/test-all` explicitly checks RunningHub accounts.
6. Delete the transfer file when no longer needed. The cloud service encrypts keys using its own `secrets.key`.
   Back up the whole data volume, including this key; desktop DPAPI ciphertext cannot be copied across OSes.

## AI API

All requests require `Authorization: Bearer <hex of api.token bytes>`. No browser/CORS access.
`cloud/client.py METHOD /endpoint --file body.json` reads the token locally and sends JSON.
GET responses include parameter snapshots, original/optimized text, statuses and local output paths.

| Endpoint | Purpose |
| --- | --- |
| GET /health | Service / scheduler status |
| GET /accounts | Account metadata only (no keys) |
| POST /accounts/import | Entire exported account JSON, both platforms |
| POST /accounts/runninghub | `{label, apiKey}` |
| POST /accounts/gemini | `{keys:[...]}` |
| PATCH /accounts/:id | `{enabled, preferred, maxConcurrency}` |
| POST /accounts/:id/test, /accounts/test-all | Account checks |
| DELETE /accounts/:id | Remove RunningHub account |
| POST /gemini/model, /gemini/test, /gemini/enabled, /gemini/remove | `{model}`, `{id}`, `{id,enabled}`, `{id}` |
| GET /workflows, /workflows/:id | Profiles, input IDs, defaults, workflow IDs |
| POST /workflows/import, /workflows/import-api | Portable workflow or `{name,runningHubWorkflowId,workflow}` |
| PATCH /workflows/:id | Personal workflow `{profile,metadata}` |
| DELETE /workflows/:id | Personal workflow removal |
| GET /skills/:runningHubWorkflowId | Built-in / custom Skills |
| POST /skills/:id/import, /skills/:id/select | `{name,content}` / `{skillId}` |
| POST /uploads?filename=photo.jpg | Raw bytes; returns localPath; maximum 2 GB |
| POST /jobs | `{requestId,jobs:[...]}`; persistent deduplication |
| GET /jobs?search=..., /jobs/:id | List/search and full submission/optimization records |
| POST /jobs/:id/query | Query original remote task; never create a new task |
| POST /jobs/:id/retry-download | Retry only download |
| POST /jobs/:id/cancel | Explicit remote cancellation |
| DELETE /jobs/:id | Delete task record (files retained) |
| GET /jobs/:id/files/:index | Download completed file; index starts at zero |
| GET /tts | Voice and language choices |
| POST /tts | `{requestId,input:{text,voice,language,style}}` |
| GET /tts/:requestId, /tts/:requestId/audio | TTS state / stereo WAV |
| POST /tts/:requestId/cancel | Cancel local TTS request |

Fetch workflows first. Each submitted job uses `{workflowId,taskName,parameters:{parameterId:value},
media:[{parameterId,localPath}],optimize:true}`.
H3 resolution defaults to 1.5 MP. Explicit resolution choices are preserved. When instanceType is omitted,
Plus is selected above 15 seconds at 0.9 MP, 13 seconds at 1.5 MP, or 12 seconds at 2.0 MP.
An explicit instanceType remains authoritative; other resolutions require an explicit choice.
H3 digital-human jobs accept `audioRange:{startSeconds:0,endSeconds:24}`. Omit the range for the full audio
rounded up to whole seconds; omit only endSeconds for the remaining audio. Explicit segment boundaries stay unchanged.
Legacy duration (start) / duration_2 (length) are supported but cannot be combined with audioRange.
Audio uploads return durationSeconds and suggestedEndSeconds. POST /jobs/preview with one job resolves
the same final parameters without creating a task or calling a generation API.
H3 optimization defaults to enabled. Use `optimize:false` for already-prepared prompts. H3 segment jobs share
`production:{groupId:"unique-group",segmentIndex:1}` with consecutive indices.
Media must be under the data `uploads/` or `tts/` directory. Generated TTS paths can directly feed Inf/H3 audio slots.
Optional media slots are cleared and their enable switches resolved using the same desktop logic.

**Billing rule:** reuse the same requestId and exact payload after a timeout. It returns original job IDs.
Never generate a new requestId merely because a response/download is missing. Query the saved job first.
An interrupted TTS call is not automatically repeated; a stored `processing` record after a restart requires checking before an explicit new request.
Generating again is a new, explicitly authorized request, never a recovery action.

## Scope / verification

This is a separate deployable target in the same source checkout so desktop and cloud fixes stay shared.
Desktop proxy settings remain desktop-only. Cloud has no updater UI: rebuild the image and retain its volume.
Desktop task history/media are not included in an account export. This migration transfers accounts/settings only.
Linux packaging and read-only smoke checks run in release CI.
