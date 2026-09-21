# Third-party source references

This project was implemented from public contracts and small, adapted implementation
ideas. The original license texts are retained in this directory.

| Project | Role | License file |
| --- | --- | --- |
| HM-RunningHub/RH_CLI | Official HTTP, account, upload, polling, output, AI App, node-update reference | `RH_CLI-APACHE-2.0.txt` |
| HM-RunningHub/ComfyUI_RH_OpenAPI | Official API contract and lifecycle | `ComfyUI_RH_OpenAPI-APACHE-2.0.txt` |
| XmYx/ComfyStudio | Generic literal workflow parameter scanner reference | `ComfyStudio-MIT.txt` |
| Einzieg/Comfyui2api | Semantic candidate scoring and workflow-profile reference | `comfyui2api-MIT.txt` |
| mcmonkeyprojects/SwarmUI | Capacity-one resource claim/release reference | `SwarmUI-MIT.txt` |
| rainhon/runninghub-batch-api | Media SHA-256 upload-cache and mock-client design reference | Repository README declares MIT; the inspected revision did not contain a root `LICENSE` file |

Reviewed source revisions are pinned here so future audits can reproduce the comparison:

| Project | Origin | Reviewed commit |
| --- | --- | --- |
| RH_CLI | https://github.com/HM-RunningHub/RH_CLI | `0ed2b31d50fbfef114304fae78d24d4c9e371b68` |
| ComfyUI_RH_OpenAPI | https://github.com/HM-RunningHub/ComfyUI_RH_OpenAPI | `8f9c858e7e631a1c1c49df0c4defd77fdd690dd4` |
| ComfyStudio | https://github.com/XmYx/ComfyStudio | `46416846d44b544396e66d9c6f29fccc1b30971d` |
| comfyui2api | https://github.com/Einzieg/Comfyui2api | `3743008cc0553f21a2d04b7306c73f540aefd6e7` |
| SwarmUI | https://github.com/mcmonkeyprojects/SwarmUI | `eb39c7d103c245dba37fdc1a1389e4df32d82179` |
| runninghub-batch-api | https://github.com/rainhon/runninghub-batch-api | `1ee1de3841ed675ca76fb4425fb280e343dec8d8` |

## Architecture-only references

The following projects informed gap analysis or architecture comparisons. No verbatim
source block from these projects was identified in the application source:

| Project | Role | License note |
| --- | --- | --- |
| ai-dock/comfyui-api-wrapper | Generation/download separation and worker queue comparison | No clear root license was present when reviewed; architecture only |
| invoke-ai/InvokeAI | SQLite queue, history, and independent download retry comparison | Apache-2.0 |
| co5dt/ComfyUI-Persistent-Queue | Restart recovery and recovery revalidation comparison | GPL-3.0; design ideas only |
| widecyruschan/runninghub-app | RunningHub response compatibility comparison | No clear license was present when reviewed; compatibility ideas only |

## Inspected but not used as an application source

`difyz9/runninghub-sdk` and `HM-RunningHub/ComfyUI_RH_APICall` are retained only in the
local `_reference` research directory. The production source does not import either
project. Their code must not be copied without independently verifying their complete
license terms.

VideoKit was inspected only for behavioral concepts around key-status migration,
manual/automatic disabling, masking, and failure evidence. No VideoKit source file is
included here or used as the project base.

## npm dependencies

`NPM_DEPENDENCIES.md` is generated from both lockfiles and inventories direct and
transitive package license metadata. Regenerate it with `npm run licenses:generate` and
verify it with `npm run licenses:check` before release. Upstream package license files
must remain available in any final distributable where their terms require it.

## Distribution boundary

`_reference/` and `work/` contain research clones and inspection material. They are not
application inputs and are excluded by both the package allowlist and the automated
`npm run package:verify` check. A future Electron packager must use the same allowlist;
it must never package these directories by starting from the repository root without
explicit file filters.
