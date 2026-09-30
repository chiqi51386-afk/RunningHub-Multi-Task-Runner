# Apple Silicon test build (0.1.46)

Personal private repository: `chiqi51386-afk/RunningHub-Multi-Task-Runner`.
Run **macOS Apple Silicon ZIP** in Actions. The workflow uses a native arm64
`macos-15` runner and uploads a ZIP and SHA-256 checksum as a private Actions
artifact (14-day retention). No Windows release or public publication is triggered.

The ZIP contains `RunningHub Runner.app`. Extract on an Apple Silicon Mac and
copy the app to Applications. This initial test build uses an ad-hoc signature,
not an Apple Developer ID signature, and is not notarized. Gatekeeper may block
it. Do not disable system-wide security protections.

Cloud checks include tests, type checking, arm64 binary/native SQLite checks,
signature integrity, and packaged-app UI smoke tests with isolated temporary
data. They do not submit paid generation tasks or prove all real-world behavior.
The previously reported intermittent batch/single click issue is not fixed by
this packaging change.

User data on macOS resides under
`~/Library/Application Support/runninghub-multi-task-runner-core/`.
The Windows-only in-app automatic installer is not supported on macOS;
replace the app manually when updating, keeping the user-data directory.
