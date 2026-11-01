# 视频任务使用方法 — 从一句需求到成片交付

本手册是视频生成的操作入口（原理见 `ANALYSIS.md`，账号与 TTS 细节见 `AGENT_GUIDE.md`）。目标：正确、不重复提交地完成需求确认 → 提交 → 生成 → 下载 → 交付。

全程只用海外站 `https://www.runninghub.ai`。命令在安装目录运行，统一使用：
`python3 current/cloud/client.py <方法> <路径> --token-file data/api.token`（下文简称 cli）。

## 先理解这套软件

用户提出视频需求 → 操作者（AI 或用户）确认内容、素材、时长、画幅、分辨率选择、生成数量及生成授权 → 将素材和任务交给本地服务 `127.0.0.1:17863` → 本服务自动从 RunningHub 海外站账号池轮询可用账号；需要配音时调用 Gemini TTS，需要生成词优化时先调用 Gemini 改词 → RunningHub 按选定的内置工作流生成视频 → 本服务查询进度并自动下载成片到本机 → 操作者检查画面、声音和规格，再将文件交付用户。提交成功不等于成片已下载，本机路径也不是公网下载链接。

最容易误解的五件事：
1. 账号池自动轮询，提交者不用选号。
2. 金币从实际承接任务的 RunningHub 账号扣除。
3. Gemini 负责配音和改词，不负责生成视频。
4. 生成词优化是在提交视频前改词，不是生成后修视频。
5. `requestId` 是防重复的钥匙，同一需求不能换 ID 重提。

## 第一次安装必读（先看这里）

- 只用海外站。
- 安装完成后，先导入账号，再跑一次积分查询。
- 提交者不选号，账号池自动轮询。
- `requestId` 用于幂等；同一需求绝不换 ID 重提。
- 生成词优化默认全开，不用手动开启；InfiniTalk 没有这个功能，不用管。
- 数字人必须有音频，由用户提供或用 Gemini TTS 生成。
- MV 的 `duration` 是音频起点，`duration_2` 才是片段时长。
- 分辨率与 Plus 严格按触发条件表执行。
- 高分辨率分块 `193_highres_tiling` 默认开启，不要改动。
- 下载失败只重试下载，不重新提交任务。
- 状态不明只查询，不重新提交任务。

## 1. 需求确认

先整理并告知需求方；缺项按缺省规则执行并声明，不自行编造。

- **内容**：用途、主体、动作、场景、风格，必须保留与禁止出现的内容。
- **规格**：时长、画幅、**分辨率选择**（按第 4 节触发表定）、**生成数量**（同一个任务要生成几份，必填），是否需要配音、口型同步、音乐。
- **素材**：首尾帧、人物图、参考图、音频是否齐备；使用 TTS 时确认文字、语言与音色。
- **授权**：是否立即生成；缺关键素材或生成授权不明时先确认。

缺省：1 条；H3 首尾帧 4 秒、`9:16 (Portrait Widescreen)`、1.5 MP；数字人 MV 音频起点 0 秒、片段 10 秒、分辨率固定 1.5 MP（所有者定版，覆盖出厂默认 2.0）；SelfLift 10 秒、分辨率按档位选（720→0.9 / 1080→2.0）。InfiniTalk 成片长度由音频长度决定，且始终不开 Plus。

**生成词优化默认全开**：有优化映射的工作流（首尾帧、MV、SelfLift）提交时自动先用 Gemini 优化生成词，不需要填 `optimize`；只有用户明确要求不优化时才填 `"optimize": false`。InfiniTalk 没有优化功能，不受影响。优化失败时任务会直接失败且不提交视频（见第 8 节），要如实反馈用户。

## 2. 选工作流

| 需求 | workflowId | 媒体槽位 |
| --- | --- | --- |
| 首尾两帧之间的过渡视频 | `builtin:h3-first-last.rhworkflow.json` | 首帧 `image`、尾帧 `image_2` |
| 人物图与音频生成 MV 式表演 | `builtin:h3-digital-human-mv.rhworkflow.json` | 人物图 `image`～`image_6`、音频 `audio` |
| 人物图与较长音频生成口型同步数字人 | `builtin:infinitetalk-digital-human.rhworkflow.json` | 人物图 `image`、音频 `audio` |
| 多张参考图生成视频并锐化放大 | `builtin:minimax-h3-sharp.rhworkflow.json` | 参考图 `image`～`image_9` |

重点使用前三种工作流。缺少必需图片时先补素材；**MV 与 InfiniTalk 都必须有音频**，不能用台词文本代替音频。

SelfLift 输入是参考图片，不是现成视频，不是“任意视频放大”接口。

## 3. 照着做的剧本

### 六个剧本共用的操作

以下命令均在安装目录运行，`cli` 代表：

```text
python3 current/cloud/client.py <方法> <路径> --token-file data/api.token
```

例如 `cli GET /health`，实际执行：

```bash
python3 current/cloud/client.py GET /health --token-file data/api.token
```

开始前确认生成授权、服务正常及有可用账号；无可用账号立即反馈用户，不等待假进度。先用 `cli GET "/workflows/<workflowId>"` 核对参数与合法画幅。本例 H3 使用 `9:16 (Portrait Widescreen)`。

外部文件逐个上传，例如：

```text
cli POST "/uploads?filename=first.jpg" --file first.jpg
```

下文 `<U1>`、`<U2>`、`<U3>` 都必须替换为**对应文件上传返回的、位于 data/uploads 下的真实 localPath**；`<T>` 替换为 TTS 返回的 **data/tts 下真实 WAV 路径**。占位符不能原样提交，不能填外部 URL。

将每个剧本的任务 JSON 保存为 `job.json`，保存其 `requestId`，执行一次：

```text
cli POST /jobs --file job.json
```

提交后保存每项的 jobId、远端 taskId；每隔 15～30 秒执行 `cli GET /jobs/<jobId>`。等待生成及自动下载完成，从 `outputs.files[].localPath` 取得成片。验收后交付文件，不只报路径。

以下 H3 示例均省略 `optimize`，即默认启用 Gemini 生成词优化；用户明确不要时才加 `"optimize":false`。InfiniTalk 无优化功能。内部参数及默认开启的 `193_highres_tiling` 不改。

### 剧本一：首尾帧视频——城市昼夜 10 秒

**适用：**让同一城市机位的白天画面平滑过渡到夜晚。

**准备：**同机位白天首帧、夜晚尾帧；确认竖屏、10 秒、固定 1.5 MP、生成 1 份。

**步骤：**上传白天图取得 `<U1>`、夜晚图取得 `<U2>`，提交：

```json
{"requestId":"video-city-20261031-001","jobs":[{"workflowId":"builtin:h3-first-last.rhworkflow.json","taskName":"城市昼夜-01","parameters":{"duration":10,"aspect_ratio":"9:16 (Portrait Widescreen)","resolution":1.5,"prompt":"固定机位，城市从白天平滑过渡到夜晚，楼宇灯光依次亮起，保持建筑结构，不加文字。"},"media":[{"parameterId":"image","localPath":"<U1>"},{"parameterId":"image_2","localPath":"<U2>"}],"instanceType":"default"}]}
```

**参数规则：**首尾帧固定 `resolution:1.5`；10 秒未超过 13 秒，不开 Plus。

**等待与验收：**拿到 1 条视频，检查约 10 秒、首尾对应、建筑不乱变。

### 剧本二：数字人说话——用户自带 30 秒音频

**适用：**用一张人物图，生成与完整音频同步说话的数字人。

**准备：**获授权的人物图、实际长度为 30 秒的讲话音频；确认生成 1 份。InfiniTalk 没有分辨率参数，不用选档位。

**步骤：**人物图上传取得 `<U1>`，音频上传取得 `<U2>`，提交：

```json
{"requestId":"video-talk-20261031-001","jobs":[{"workflowId":"builtin:infinitetalk-digital-human.rhworkflow.json","taskName":"数字人讲话-01","parameters":{"prompt":"人物正对镜头自然讲话，口型同步，表情亲切，轻微点头，保持身份与背景稳定。"},"media":[{"parameterId":"image","localPath":"<U1>"},{"parameterId":"audio","localPath":"<U2>"}],"instanceType":"default"}]}
```

**参数规则：**不加 `duration`、`resolution` 或优化参数；成片长度等于音频长度，30 秒也始终不开 Plus。

**等待与验收：**拿到 1 条约 30 秒视频，检查整段音频、口型及人脸稳定性。

### 剧本三：数字人说话——先用 TTS 配音

**适用：**只有人物图和台词，需要先生成声音，再制作口型同步视频。

**准备：**人物图；确认中文台词、音色（示例用 Puck，可从 `cli GET /tts` 的音色表里选）、生成 1 份。

**步骤一：**将以下内容保存为 `tts.json`，保存独立的 TTS requestId：

```json
{"requestId":"tts-guide-20261031-001","input":{"text":"大家好，欢迎使用云端视频生成服务。请先准备人物照片和台词，确认视频规格，再开始生成。完成后记得检查画面和声音。","voice":"Puck","language":"en","style":"Speak Mandarin Chinese (Putonghua) naturally; read the exact Chinese transcript, do not translate."}}
```

TTS 的模型是软件内置的 `gemini-3.8-flash-tts`，不用在请求里写。中文台词没有独立语言条目，用 `language:"en"` 占位 + style 指令指定普通话（见上）。执行：

```text
cli POST /tts --file tts.json
cli GET /tts/tts-guide-20261031-001
```

等待 TTS 状态为 `completed`，取得 `data/tts` 下的双声道 `.wav` 路径，记为 `<T>`。试听并测量实际秒数；不要按台词字数猜时长，也不要再次上传该文件。

**步骤二：**上传人物图取得 `<U1>`，提交视频：

```json
{"requestId":"video-tts-20261031-001","jobs":[{"workflowId":"builtin:infinitetalk-digital-human.rhworkflow.json","taskName":"配音数字人-01","parameters":{"prompt":"人物面向镜头自然介绍，口型同步，表情友好，保持人物身份稳定。"},"media":[{"parameterId":"image","localPath":"<U1>"},{"parameterId":"audio","localPath":"<T>"}],"instanceType":"default"}]}
```

**参数规则：**InfiniTalk 时长由 WAV 实际长度决定，无 `resolution`、无优化、始终不开 Plus。若改用 MV，须按音频实际秒数确定 `duration_2`，并保证音频覆盖 `duration + duration_2`。

**等待与验收：**先取得并确认 WAV，再等待 1 条视频下载完成；检查有声、无截断、口型同步。

### 剧本四：数字人 MV——第 5 秒起取 10 秒

**适用：**人物随指定歌曲片段表演，音频从第 5 秒开始截取。

**准备：**人物图、获授权歌曲；音频实际长度至少 15 秒。确认竖屏、固定 1.5 MP、生成 1 份。

**步骤：**人物图上传取得 `<U1>`，歌曲上传取得 `<U2>`，提交：

```json
{"requestId":"video-mv-20261031-001","jobs":[{"workflowId":"builtin:h3-digital-human-mv.rhworkflow.json","taskName":"歌曲片段-01","parameters":{"duration":5,"duration_2":10,"aspect_ratio":"9:16 (Portrait Widescreen)","resolution":1.5,"prompt":"人物随歌曲自然演唱，口型配合音频，轻微律动，镜头稳定，保持人物身份。"},"media":[{"parameterId":"image","localPath":"<U1>"},{"parameterId":"audio","localPath":"<U2>"}],"instanceType":"default"}]}
```

**参数规则：**`duration:5` 是音频起点，`duration_2:10` 才是成片时长；必须覆盖 5＋10 秒。分辨率固定 1.5，片段未超过 13 秒，不开 Plus。

**等待与验收：**拿到 1 条约 10 秒 MV，核对声音确实从歌曲第 5 秒开始，而非开头。

### 剧本五：同一个首尾帧任务一次生成 3 份

**适用：**同一城市昼夜需求要 3 个结果供用户挑选。

**准备：**白天图、夜晚图；确认每份 10 秒、竖屏、固定 1.5 MP，生成数量为 3。

**步骤：**两图各上传一次，分别取得 `<U1>`、`<U2>`；以下整份 JSON 只提交一次：

```json
{"requestId":"video-city3-20261031-001","jobs":[{"workflowId":"builtin:h3-first-last.rhworkflow.json","taskName":"城市昼夜-01","parameters":{"duration":10,"aspect_ratio":"9:16 (Portrait Widescreen)","resolution":1.5,"prompt":"固定机位，城市白天平滑转为夜晚，灯光依次亮起，保持建筑结构。"},"media":[{"parameterId":"image","localPath":"<U1>"},{"parameterId":"image_2","localPath":"<U2>"}],"instanceType":"default"},{"workflowId":"builtin:h3-first-last.rhworkflow.json","taskName":"城市昼夜-02","parameters":{"duration":10,"aspect_ratio":"9:16 (Portrait Widescreen)","resolution":1.5,"prompt":"固定机位，城市白天平滑转为夜晚，灯光依次亮起，保持建筑结构。"},"media":[{"parameterId":"image","localPath":"<U1>"},{"parameterId":"image_2","localPath":"<U2>"}],"instanceType":"default"},{"workflowId":"builtin:h3-first-last.rhworkflow.json","taskName":"城市昼夜-03","parameters":{"duration":10,"aspect_ratio":"9:16 (Portrait Widescreen)","resolution":1.5,"prompt":"固定机位，城市白天平滑转为夜晚，灯光依次亮起，保持建筑结构。"},"media":[{"parameterId":"image","localPath":"<U1>"},{"parameterId":"image_2","localPath":"<U2>"}],"instanceType":"default"}]}
```

**参数规则：**一个 requestId、一次 POST、jobs 三项；不是提交三次。每项固定 1.5，10 秒不开 Plus。

**等待与验收：**分别跟踪三个 jobId，下载得到 3 条成片，保留编号对应关系；部分失败不能整批重提。

### 剧本六：SelfLift——3 张参考图、1080 档、8 秒

**适用：**用同一主体的多张参考图片生成视频并锐化放大，不是上传现成视频做放大。

**准备：**同一人物的正面、侧面、全身参考图；确认竖屏、1080 档、8 秒、生成 1 份。

**步骤：**依次上传三图取得 `<U1>`、`<U2>`、`<U3>`，提交：

```json
{"requestId":"video-selflift-20261031-001","jobs":[{"workflowId":"builtin:minimax-h3-sharp.rhworkflow.json","taskName":"多参考人物-01","parameters":{"duration":8,"aspect_ratio":"9:16 (Portrait Widescreen)","resolution":2.0,"prompt":"参考三图保持同一人物身份与服装，人物缓慢转身并微笑，镜头轻推，背景稳定，不加文字。"},"media":[{"parameterId":"image","localPath":"<U1>"},{"parameterId":"image_2","localPath":"<U2>"},{"parameterId":"image_3","localPath":"<U3>"}],"instanceType":"default"}]}
```

**参数规则：**SelfLift 的 1080 档填 `2.0`，超过 12 秒才开 Plus，8 秒不开；若选 720 档则填 `0.9`，超过 15 秒才开 Plus。

**等待与验收：**拿到 1 条约 8 秒视频，检查多视角身份一致、画面清晰及动作完整。

### 所有剧本的失败处理与交付

任何错误都反馈用户，说明任务、状态和原因。优化失败即任务失败，视频未提交；TTS 失败不进入视频步骤。状态不明只查询，不换 requestId 重提；下载失败只调用 `cli POST /jobs/<jobId>/retry-download`。

最终汇报：任务/工作流、关键参数、requestId/jobId/远端 taskId、状态与成片路径、异常或待确认项。确认文件可播放后，再按约定方式交付用户。

## 4. 参数填写

只修改公开用户参数，其余内部参数保持默认；未使用的可选图片槽位省略。

| 工作流 | 参数 |
| --- | --- |
| H3 首尾帧 | `duration` 视频时长秒（默认 4）、`aspect_ratio`、`resolution`（默认 1.5 MP）、`prompt`、`seed` |
| H3 数字人 MV | `duration` **音频起点秒**（默认 0）、`duration_2` **片段时长秒**（默认 10）、`aspect_ratio`、`resolution`（固定 1.5，见下节）、`prompt` |
| InfiniTalk | `prompt`、`negative_prompt`（无特殊要求保持默认） |
| SelfLift（多图参考） | `duration`（默认 10）、`aspect_ratio`、`resolution`（按档位填 0.9 / 2.0）、`prompt` |

- 时长按用户需求填写；未指定时使用上述默认值，不另设时长规则。MV 两个 duration 不得填反。
- `aspect_ratio` 使用工作流返回的合法选项原文，不把宽高像素填进 `resolution`。
- 提示词写清主体、动作、场景、镜头、风格与约束。首尾帧重点描述过渡；数字人重点描述身份、表情、动作与镜头。

### 分辨率与 Plus 开关

Plus 由提交参数 `instanceType` 控制：`"default"` 为关闭（默认），`"plus"` 为开启。

| 对象 | 分辨率（`resolution`） | Plus 触发时长 |
| --- | --- | --- |
| 使用公开 `resolution` 参数的工作流：720 档 | `0.9` | 时长 > 15 秒 |
| 使用公开 `resolution` 参数的工作流：1080 档 | `2.0` | 时长 > 12 秒 |
| H3 首尾帧 | 固定 `1.5`，不选档位 | 时长 > 13 秒 |
| H3 数字人 MV | 固定 `1.5`，不选档位；覆盖出厂默认 `2.0` | 片段时长 `duration_2` > 13 秒 |
| InfiniTalk | 无此参数，不添加 | **始终不开**（固定 `"default"`，与时长无关） |

提交前按表判断，将 `instanceType` 和适用的 `resolution` 填入 job；未超过阈值（含恰好等于阈值）一律填 `"default"`，超过才填 `"plus"`。时长按用户需求填写，MV 按 `duration_2` 判断，不按音频起点 `duration` 判断。SelfLift（多图参考）走通用档位规则：先选 720（`0.9`，>15 秒开）或 1080（`2.0`，>12 秒开），不适用首尾帧的固定 1.5 口径。

高分辨率分块参数 `193_highres_tiling` 默认开启，保持默认，不改动。

## 5. 账号池与自动轮询

**提交者永远不手动选号。**软件自动执行：

1. 过滤可用账号：启用、未禁用、状态为 `IDLE/BUSY`、并发未满、金币 > 0、冷却已过。
2. 排序：优先号优先，其次最久未用优先，实现轮换。
3. 提交失败且错误可安全换号时，自动换号并重排；余额不足自动跳过并换号，无需提交者判断单账号余额能否覆盖任务。
4. 素材按账号缓存，换号后自动重传。
5. Gemini Key 从上次使用的下一个开始轮换。

账号轮换不等于重新创建需求；不得绕过软件手动选账号或直调 RunningHub。

## 6. 提交

提交前确认服务正常、有可用账号：`cli GET /health`，并确认使用海外站。核对素材、参数和授权，保存最终 JSON 与 requestId；不做单账号余额覆盖检查。

requestId 命名：`video-<业务号>-<日期>-<批次>`，如 `video-demo-20261031-001`。提交前生成并保存；TTS 请求也须保存自身的 requestId。

```json
{
  "requestId": "video-demo-20261031-001",
  "jobs": [{
    "workflowId": "builtin:h3-first-last.rhworkflow.json",
    "taskName": "demo-01 日落到夜晚",
    "parameters": {
      "duration": 4,
      "aspect_ratio": "9:16 (Portrait Widescreen)",
      "resolution": 0.92,
      "prompt": "海面日落自然过渡到星空夜晚，镜头缓慢推进，光线平滑变化。"
    },
    "media": [
      {"parameterId": "image", "localPath": "<首帧上传返回的 localPath>"},
      {"parameterId": "image_2", "localPath": "<尾帧上传返回的 localPath>"}
    ],
    "optimize": true,
    "instanceType": "default"
  }]
}
```

执行 `cli POST /jobs --file job.json`。**一批任务只请求一次**：同一批的全部条目（含同一任务的多份）都装进一个 `jobs` 数组、共用一个 requestId、一次提交，不逐条发多次请求。同一任务要生成 N 份，就在数组里放 N 项（参数相同、`taskName` 编号区分）；每项对应一条成片，保存序号与 jobId 对应关系及后续远端 taskId。不要自行拼装 `nodeInfoList`。

**幂等铁律：同 requestId + 同载荷重发只返回原任务（replay）；同 ID 不同载荷会被拒绝。永远不要为同一需求换新 requestId 重提。**

### 提交后核实清单（每批必做，核完才能向用户报「已提交/生成中」）

提交成功只说明请求被接收，**不等于素材和生成词都对、软件真的在跑**。每批提交后，逐条 `cli GET /jobs/<jobId>` 核对下面五项，核完把结果（尤其生成词与参数）汇报给用户：

1. **图片/音频对不对**：任务用到的素材正是本次上传返回的 localPath，槽位没放反（首尾帧 `image`=首帧、`image_2`=尾帧；数字人 `audio` 是那条正确的音频）。提交前对照上传返回记录逐项打勾，提交后在 jobId 与素材的对应表里留档。
2. **生成词对不对**：`profileSnapshot.promptOptimization.originalText` 必须与用户原词一致；`parameters.prompt` 是**实际提交**的词（开优化时就是 Gemini 改写后的词）。汇报时给出原词与实际提交词（太长就存成记录文件给用户），用户问起立刻能拿出来，不许含糊。
3. **参数对不对**：`duration`、`aspect_ratio`、`resolution`、`instanceType` 与需求确认逐项一致；分辨率与 Plus 严格按第 4 节触发表。
4. **软件有没有真的在跑**：状态应从 OPTIMIZE_PENDING/PENDING 推进到 RUNNING 并出现 `remoteTaskId`。长时间不推进或变 FAILED，立即按第 8 节如实反馈用户，不许嘴上说「还在生成」。
5. **完成后验收**：COMPLETED 后核对 `outputs.files` 有文件，并抽查可播放、时长、画幅与需求一致，才算可交付。

## 7. 任务的一生

1. **提交**：`POST /jobs` 按 requestId 幂等创建或返回原任务。
2. **调度**：系统自动派活、选择账号并处理素材。
3. **远端运行**：系统约每 5 秒自动查询状态，最长 30 分钟。提交者可每 15～30 秒用 `GET /jobs/:id` 查看本地任务；长任务中途同步进度。超时未完成不代表可以重提。
4. **自动下载**：远端成功后自动进入下载队列，下载并发为 3。下载完成后从 `outputs.files[].localPath` 取成片。
5. **验收交付**：检查可播放性、时长、画幅与声音；下载未完成不得宣称已交付。交付方式（定版）：① 高清原片上传到用户 Google 网盘的「AI 专用」文件夹（只用这个文件夹），按项目/批次建子文件夹分类存放，并留意网盘容量，快满了要告诉用户；② 同时压一份聊天预览版（宽 720 等比缩放、H.264 CRF26、faststart，约 2–5MB——原片 20MB 以上聊天附件显示不出来），以附件形式发到聊天里让用户直接预览播放。生成期间主动报进度（已完成 X/N），完成一条交付一条，不许全程静默等整批完成。不公开 data 目录或密钥。
6. **失败反馈**：任务状态和错误原因见 `GET /jobs/:id`。下载失败仅重试下载；状态不明只查不重提；`SUBMIT_UNKNOWN` 绝不自动重提。**任何错误都必须如实反馈给用户**（哪个任务、什么状态、什么原因），不许静默；**发现没有可用账号时立即反馈用户**（说明可用数为 0 及主要原因，如多数账号 NO_BALANCE / INVALID_KEY），不要假装任务还在跑、不要干等。

汇报固定五项：**任务/工作流、关键参数（时长/画幅/分辨率/Plus/optimize）、requestId/jobId/远端 taskId、状态与成片路径、异常或待确认项**。

## 8. 出错处理

| 现象 | 处理 |
| --- | --- |
| 缺素材、参数非法、服务异常或无可用账号 | 补齐或恢复后再提交，不反复试错；账号轮换交给软件 |
| 提交超时、响应丢失 | 用原 requestId + 原 JSON 重发取回原任务，不生成新 ID |
| `SUBMIT_UNKNOWN`、远端状态不明 | 仅 `GET /jobs/:id` 或 `POST /jobs/:id/query`；无远端 ID 时人工核查，绝不自动重提 |
| 查询失败、服务重启 | 只查不建；服务恢复后自动续查 |
| 下载失败、证书错误 | 修复网络或 CA 后调用 `POST /jobs/:id/retry-download`，只重试下载 |
| `FAILED`、`CANCELLED`、TTS `interrupted` | 查看状态与错误原因，核查原提交并汇报，不自动重建 |
| 确需修改载荷 | 先核实原请求从未成功提交且未形成远端任务；已有任务记录不得以修改为名换 ID 重提 |

批量部分失败时只处理失败项的查询或下载，绝不整批重提。
## 9. 版本更新检查

- 服务**每次启动前**会自动检查更新源（systemd 的 ExecStartPre 调用 `scripts/check_update.py`，检查失败绝不阻挡启动）。手动随时可查：`python3 scripts/check_update.py`。
- 更新源地址通过环境变量 `RH_UPDATE_URL` 或安装目录下的 `update.json`（`{"feed": "https://.../version.json"}`）配置；清单格式为 JSON：`{"version": "1.1.1-distribution.N", "url": "下载地址", "notes": "说明"}`。未配置更新源时检查自动跳过。
- 检测到新版本时，检查结果写入 `data/update-notice.json` 并在日志里打横幅。**操作者每次开始工作前应查看该文件，有新版本必须提醒用户更新**；用户确认更新后，拿到新包按 install.sh 升级（自动保留 data 并重启服务），再用 `scripts/check_update.py --clear` 清除提醒。
