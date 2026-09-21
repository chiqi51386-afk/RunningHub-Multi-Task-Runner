# Download automatic naming design

## Recommended default

Store completed output under a local-date folder and derive a stable name from the
job creation time, workflow name, local job id, output order, and output label:

```text
downloads/2026-09-21/20260921-143052_MiniMax-H3_job-a1b2c3d4_01_二采.mp4
```

Template:

```text
YYYYMMDD-HHmmss_<workflow>_job-<shortJobId>_<outputIndex>_<outputLabel>.<extension>
```

## Rules

1. Use `job.createdAt` in the user's local timezone. A retry therefore keeps the same
   destination instead of creating a new date-based name.
2. Keep Unicode letters and numbers. Replace Windows-invalid characters
   (`< > : " / \\ | ? *` and control characters) with `_`, collapse repeated spaces,
   and remove trailing dots/spaces.
3. Limit the sanitized workflow segment to 48 characters, the label to 32 characters,
   and the complete filename to 180 characters.
4. Use the first eight hexadecimal characters of the local immutable job id. Do not
   rely only on the remote task id because it does not exist before submission.
5. Number every output from `01` in the order recorded in the job snapshot. Preserve
   a configured output label such as `一采` or `二采`; otherwise use `node-<nodeId>` or
   the normalized media type.
6. Keep the extension determined from the actual response/content type. Never trust a
   remote filename to change the destination directory.
7. Download to `<finalName>.part`, then atomically rename after success. Never expose a
   partial file as a completed output.
8. Never overwrite an unrelated existing file. If the same final name exists with a
   different job/output identity, append `_02`, `_03`, and so on.
9. Retain the remote URL and original remote filename in job metadata for diagnosis;
   only the local display/download name changes.
10. Existing downloaded files are not renamed retroactively. The setting applies to
    new downloads after the feature is enabled.

## Future settings

The first implementation should expose three presets rather than a free-form template:

- `日期 + 工作流 + 任务` (recommended default)
- `日期 + 任务`
- `保留远端文件名`

A custom template can be added later after collision, path-length, and migration rules
are stable.
