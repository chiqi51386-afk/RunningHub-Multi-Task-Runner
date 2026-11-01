# Linux 无界面操作指南

Linux 没有可视界面。AI 通过操作接口完成桌面端的填写、预览、加入制作批次、编辑及提交。不要手拼节点参数。本文是日常操作入口；VIDEO_GUIDE.md 中 /jobs 底层示例仅用于兼容旧调用。

## 接口流程

1. GET /workspace/modules 查看模块；GET /workflows 查看实际工作流。
2. POST /uploads?filename=voice.wav 上传原始文件字节，取得 localPath。或把素材放进 data/uploads。音频返回实际时长和向上取整时长。
3. POST /workspace/preview，传一条下方的操作表单：预览最终参数，不创建任务、不调用 Gemini、不扣费。
4. POST /workspace/batches，传 `{"requestId":"唯一批次号","tasks":[表单1,表单2]}`，对应“加入制作批次”。会保存素材、开关、名称、参数、Skill 快照。
5. GET /workspace/batches/批次号 查看；PATCH 同一路径传 `{"tasks":[修改后的完整表单列表]}` 替换未提交批次。清空文字用空字符串，清空图片用空数组，删除未提交批次用 DELETE。
6. POST /workspace/batches/批次号/submit 对应“批量提交”，此步才创建生成任务。重复点提交返回原 jobIds，不重复创建。已提交批次不允许修改。
7. GET /jobs/任务ID 查询；完成并下载后 GET /jobs/任务ID/files/0 取文件。

修改输入后须重新预览。工作流版本已变化会阻止旧批次提交，需要重新编辑确认。预览不会提前生成优化词，优化发生于正式任务执行阶段。

## 通用字段

- module：下列四个视频模块标识。
- taskName：整体任务名称。H3 多段也只填一次，软件添加段落信息。
- prompt：中英文生成词。optimize 为中文生成词优化开关，H3 默认打开，成品词不需再优化时设 false。
- images：按顺序排列的图片 localPath；audio：音频 localPath。首尾帧使用 firstFrame、lastFrame。
- aspectRatio：接口合法选项，如 `9:16 (Portrait Widescreen)`。
- resolution：默认 1.5 MP；主动选 720 档填 0.9，1080 档填 2.0。Inf 没有此字段。
- plus：可明确开关；省略时按当前分辨率和时长判断：0.9 超过15秒、1.5超过13秒、2.0超过12秒开启，等于阈值关闭。非预设分辨率须明确选择。
- highresTiling：高分辨率分块，默认开启；保留原规则。
- 每条表单对应一次整体制作；tasks 可装多个表单。所有路径必须是这台 Linux 上 uploads/tts 内可访问的素材。

## H3 数字人

完整音频只需：
```json
{"module":"h3-mv","taskName":"人物讲话","prompt":"人物自然讲话，保持身份，镜头稳定。","images":["<人物图localPath>"],"audio":"<音频localPath>","optimize":true}
```

默认一段。软件读取音频：23.4 秒自动使用结束 24 秒，不回退为10秒。音频文件本身不改写。可使用最多6张人物参考图。

多段只增加 segments：
```json
{"module":"h3-mv","taskName":"人物讲话","images":["<人物图>"],"audio":"<音频>","optimize":true,"segments":[{"prompt":"第一段动作","endSeconds":10},{"prompt":"第二段动作","endSeconds":20},{"prompt":"第三段动作"}]}
```

第一段默认从0开始，下一段默认从上一段结束开始。每段也可明确 startSeconds。前面的段必须填 endSeconds，最后一段省略结束则到音频向上取整的末尾。显式边界不移动，软件计算结束减起点，不需要填写 duration 或 duration_2。

各段可独立填 images、prompt、optimize。未填图片继承整体图片；优化开关继承前段状态，第一段继承整体状态。名称、音频、比例、分辨率属于整体设置；自动 Plus 按各段最终时长计算。所有段一次加入同一制作批次，软件维护分组及段号。

## H3 多参考

最多9张参考图，按数组顺序对应 Picture 1…9，少用就少填。
```json
{"module":"h3-multi-reference","taskName":"多参考","prompt":"保持参考人物身份，缓慢转身，镜头轻推。","images":["<图片1>","<图片2>"],"durationSeconds":10,"optimize":true}
```
默认时长10秒、分辨率1.5。不能把九张图片当成九个必需槽位，未用素材由软件清空。已有优化成品词再次生成时明确 optimize:false。

## H3 首尾帧

```json
{"module":"h3-first-last","taskName":"昼夜转换","prompt":"固定镜头，从白天自然过渡到夜晚。","firstFrame":"<首帧>","lastFrame":"<尾帧>","durationSeconds":10,"optimize":true}
```
只首帧就省略 lastFrame；只尾帧就省略 firstFrame。软件保留槽位身份，不会把尾帧挪成首帧。默认时长4秒、分辨率1.5；优化根据所提供关键帧选择模式。

## Inf 数字人

```json
{"module":"digital-human","taskName":"口播","prompt":"人物自然讲话，镜头稳定。","images":["<人物图>"],"audio":"<音频>","optimize":false,"plus":false}
```
音频决定长度，不添加 H3 的起止参数、分辨率或分段。negativePrompt 可选，省略使用原默认负面词。需要多段时提供已经准备好的各段音频，分别建立表单，不假装支持 H3 的音频裁剪设置。

## Gemini TTS

语音继续用专用无界面接口。先 GET /tts 读取语言与音色，使用返回的 id。
```json
{"requestId":"tts-001","input":{"text":"Xin chào. Chúc bạn một ngày tốt lành.","language":"vi","voice":"Erinome","style":"自然温暖，语速舒缓，句间适当停顿，不翻译原文。"}}
```
POST /tts 提交上述内容；GET /tts/tts-001 查询。completed 后返回 file，把它作为数字人表单的 audio，直接发送到 Inf 或 H3；也可 GET /tts/tts-001/audio 下载双声道 WAV。单声道复制到左右声道不等于空间声场。

text最多12000字符，style最多1500字符；无需风格时填空字符串。当前支持单人。TTS模型由软件固定，生成词优化的模型选项不改变TTS模型。

## 账号与 Skill

POST /accounts/import 导入桌面导出的账号文件；GET /accounts 核对元数据，不显示完整密钥。RunningHub优先账号与并发规则由原调度器处理，不在表单中手工分配账号。

GET /skills/远端工作流ID 查看；POST /skills/远端工作流ID/import 传 name、content；POST /skills/远端工作流ID/select 传返回的 skillId。只对已有优化路由生效，Inf不套用H3 Skill。新增个人工作流仍走原 /workflows 导入接口；自定义参数使用兼容接口，不能假定支持内置模块操作字段。

## 本机调用

```bash
cd ~/rh-runner-cloud
python3 current/cloud/client.py POST /workspace/preview --file form.json
python3 current/cloud/client.py POST /workspace/batches --file batch.json
python3 current/cloud/client.py POST /workspace/batches/你的批次号/submit
python3 current/cloud/client.py GET /jobs/返回的任务ID
```
默认token位于data/api.token，自定义目录设置RH_TOKEN_FILE。所有示例占位路径须替换。预览和加入批次不生成；提交视频和TTS需用户授权。

## 恢复

- 提交超时：重复提交同一个批次号，只返回原任务，不新建。
- fileUrl异常／远端状态未知：GET /jobs/:id，必要时POST /jobs/:id/query查原任务。
- 下载失败：POST /jobs/:id/retry-download，仅重试下载。
- TTS中断：查原requestId，不自动换号再次生成。
- 不用新建批次或新requestId解决缺失结果，避免重复扣费。确实要重做须用户明确授权。
