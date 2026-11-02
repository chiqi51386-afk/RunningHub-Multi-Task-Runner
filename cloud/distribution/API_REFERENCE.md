# 已接入接口手册

仅按需查阅。以下是当前软件已实现的方法，不是未来规划。日常生成只读 AI_START.md 与 MODULE_GUIDE.md。

## 统一调用

本机地址默认 http://127.0.0.1:17863；Authorization: Bearer 为data/api.token二进制内容的十六进制文本。用随包client.py自动处理，不打印token。不得发送Origin头（会被拒绝）。JSON请求Content-Type为application/json，最多32MB。

```bash
cd ~/rh-runner-cloud
python3 current/cloud/client.py POST /accounts/runninghub --file add-account.json --output response.json
python3 current/cloud/client.py GET /accounts --output accounts.json
```

表中body为请求示例；`<ID>`等占位符必须替换。空body写“无”，client.py省略--file。普通成功HTTP200，TTS创建HTTP202；错误一般HTTP400 `{"error":"原因"}`，鉴权失败401，未知路径404。按状态处理，不仅看是否返回JSON。个别查询不存在返回null/空体；不要当成成功生成。响应字段以下列关键字段为准，其余字段无需输出。

所有调用步骤：①准备表中body文件（如需）②执行对应method/path③只取关键响应④失败报告，不自建替代任务。设置成功仅表示已保存，不代表远端服务可用。

## 系统与素材

| 操作 | 方法／路径 | body／参数 | 返回及后续 |
|---|---|---|---|
| 服务状态 | GET /health | 无 | ready、scheduler；不包含账号可用性保证 |
| 可用模块 | GET /workspace/modules | 无 | modules、speech、operations |
| 上传素材 | POST /uploads?filename=voice.wav | 原始文件字节，不是JSON或multipart | localPath、bytes；音频另有durationSeconds、suggestedEndSeconds；在表单引用localPath |

上传支持jpg/jpeg/png/webp/wav/mp3/aac/flac/ogg/m4a/mp4/mov/webm，单文件上限2GB。上传支持某格式不等于某模块支持该素材。音频无法解析会报错并移除这次上传。优化图片最大20MB、音频最大13MB（与上传上限不同）。

```python
# 上传：保存此脚本在操作目录运行，改file路径即可；不输出token。
import json, os, urllib.request, urllib.parse
from pathlib import Path
root=Path.home()/'rh-runner-cloud'
f=Path('/absolute/path/voice.wav')
token=Path(os.environ.get('RH_TOKEN_FILE',str(root/'data/api.token'))).read_bytes().hex()
base=os.environ.get('RH_BASE_URL','http://127.0.0.1:17863')
req=urllib.request.Request(base+'/uploads?filename='+urllib.parse.quote(f.name),data=f.read_bytes(),method='POST',headers={'Authorization':'Bearer '+token})
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=180) as r:
    Path('upload-result.json').write_bytes(r.read())
```

## 账号池：RunningHub

先通过GET /accounts取runninghub数组中的id，再按用户要求操作。不要用标签或API Key冒充id。

| 操作 | 方法／路径 | body示例 | 返回 |
|---|---|---|---|
| 两个账号池列表 | GET /accounts | 无 | runninghub数组；gemini对象含model、keys、optimizationEnabled；密钥为掩码 |
| 添加账号 | POST /accounts/runninghub | `{"label":"账号A","apiKey":"<完整Key>"}` | 账号对象，保存id；添加不等于检测 |
| 导入桌面账号 | POST /accounts/import | 桌面导出的完整JSON文件 | runninghub、gemini新增数量、skipped去重数量 |
| 检测一个账号 | POST /accounts/<ID>/test | 无 | 更新后的账号状态；调用远端查询 |
| 检测全部RH账号 | POST /accounts/test-all | 无 | 账号列表；仅用户要求时使用 |
| 启用／禁用 | PATCH /accounts/<ID> | `{"enabled":true}` 或false | 更新后的账号对象 |
| 优先使用 | PATCH /accounts/<ID> | `{"preferred":true}` 或false | 更新后的账号对象；无需手填权重 |
| 并发设置 | PATCH /accounts/<ID> | `{"maxConcurrency":3}` | 更新后的账号对象；普通账号通常1，受远端真实权限限制 |
| 合并设置 | PATCH /accounts/<ID> | `{"enabled":true,"preferred":true,"maxConcurrency":3}` | 同上 |
| 删除账号 | DELETE /accounts/<ID> | 无 | removed布尔值；不要用删除解决临时网络问题 |

账号导入文件使用桌面导出的原文件，不手动重组密钥：format= rh-runner-accounts、version=1，含exportedAt、runninghub、gemini。runninghub每项label/apiKey/enabled/preferred/maxConcurrency；gemini含model及keys，每项label/apiKey/enabled。重复Key跳过，已有Gemini池不会因导入自动切换模型。导入不执行检测。账号文件含明文Key，保存在私有目录，不打印或放入公开包。

## 账号池：Gemini

Gemini id取GET /accounts返回的gemini.keys[].id，与RH id不是一回事。

| 操作 | 方法／路径 | body示例 | 返回 |
|---|---|---|---|
| 添加Key | POST /accounts/gemini | `{"keys":["<Key1>","<Key2>"]}` | Gemini设置含keys；一次1–100个 |
| 指定Key检测 | POST /gemini/test | `{"id":"<Gemini ID>"}` | success、keyId、model、latencyMs、message |
| 测试一次轮询 | POST /gemini/test | `{}` | 同上；只测试一个请求，不是检测全部 |
| 启停Key | POST /gemini/enabled | `{"id":"<Gemini ID>","enabled":false}` | 更新的Gemini设置 |
| 删除Key | POST /gemini/remove | `{"id":"<Gemini ID>"}` | 更新的Gemini设置 |
| 生成词优化模型 | POST /gemini/model | `{"model":"gemini-3.8-flash"}` | 更新的Gemini设置；名称写入不保证账号可访问，且不改变TTS模型 |

Key允许现有AIza/AQ等安全字符格式，最终访问权限由服务验证。指定检测可能尝试禁用或冷却的Key；只在用户主动要求时操作。模型检测会发简短生成请求，可能消耗额度。逐个检测全部Gemini没有专用接口，用户明确要求时可按keys列表逐个调用指定检测，不能说测试轮询等于全部检测。

优化最多4项同时工作；Gemini池最多4个请求、同一Key不重叠，按顺序轮询、跳过禁用和冷却Key；最多尝试3个可用候选。检测、TTS与优化共用请求池。TTS入口最多2个活跃请求。并发数量当前没有可修改接口。

## 工作区：填写、批次、提交

表单字段与五模块示例见MODULE_GUIDE.md。不要向操作表单填节点ID。支持四个视频module；TTS使用独立接口。

| 操作 | 方法／路径 | body | 返回／行为 |
|---|---|---|---|
| 按要求预览 | POST /workspace/preview | 单个表单 | jobs数组含最终参数；不创建任务，也不提前生成优化词 |
| 加入制作批次 | POST /workspace/batches | `{"requestId":"batch-001","tasks":[表单]}` | id、tasks、jobs、jobIds、submitted；未提交时jobIds为空 |
| 批次列表 | GET /workspace/batches | 无 | 批次数组；通常不需要每次全量查询 |
| 指定批次 | GET /workspace/batches/batch-001 | 无 | 批次对象；不存在null |
| 修改未提交批次 | PATCH /workspace/batches/batch-001 | `{"tasks":[修改后的完整表单列表]}` | 替换后的批次；不是局部字段合并 |
| 提交批次 | POST /workspace/batches/batch-001/submit | 无 | replay、jobIds；重复提交返回原jobIds |
| 删除未提交批次 | DELETE /workspace/batches/batch-001 | 无 | removed；已提交不能这样删除 |

requestId为1–100个字母、数字、下划线或连字符；同名POST只接受完全相同tasks。tasks为1–100个整体表单，展开最多500段。每个H3数字人表单最多100段。已提交批次不可编辑；工作流版本变化需用户允许后重新编辑批次。保存批次冻结设置，之后改模型/Skill不会自动替换已保存内容。

正常生成无需调用preview：软件在加入和提交时执行校验。只有用户要求查看参数时才预览。

## 任务状态、结果、恢复

| 操作 | 方法／路径 | body／查询参数 | 返回／注意 |
|---|---|---|---|
| 任务列表／搜索 | GET /jobs?search=名称 | 无；search须URL编码 | 匹配名称、ID及参数的任务数组 |
| 单个任务 | GET /jobs/<JOB_ID> | 无 | 任务对象：id、status、remoteTaskId、lastError、parameters、profileSnapshot、outputs等 |
| 下载某个结果 | GET /jobs/<JOB_ID>/files/0 | 无 | 二进制；必须用--output；索引从0开始，任务文件需已下载 |
| 取消 | POST /jobs/<JOB_ID>/cancel | 无 | 更新后的任务；取消不保证已发生的扣费退回 |
| 重试下载 | POST /jobs/<JOB_ID>/retry-download | 无 | 当前下载重试结果；随后查原job，不新建视频 |
| 查询原远端任务 | POST /jobs/<JOB_ID>/query | 无 | 远端响应；需要原remoteTaskId及账号，可能将失败任务恢复到下载阶段，不新建远端任务 |
| 删除记录 | DELETE /jobs/<JOB_ID> | 无 | removed；等待/执行中先取消；不提供同时删除本地文件选项 |

正常只每30–60秒GET自己的任务一次，保留状态、错误与结果路径。不分析视频是否“生成正确”。原始/优化词位于profileSnapshot.promptOptimization等返回字段，按存在的字段取值；无优化就不存在。用户要这些文本时直接返回字段，不调用新优化。fileUrl为空不等于完成，不用重新提交修复下载问题。

## TTS

| 操作 | 方法／路径 | body | 返回 |
|---|---|---|---|
| 音色语言列表 | GET /tts | 无 | languages（id/name等）、voices数组；按用户需求取一项 |
| 生成 | POST /tts | `{"requestId":"tts-001","input":{"text":"Xin chào.","voice":"Erinome","language":"vi","style":"自然温暖，适当停顿。"}}` | 202：requestId、state=processing；已存在同请求则200返回原状态 |
| 状态 | GET /tts/tts-001 | 无 | state、file；不存在null |
| 下载音频 | GET /tts/tts-001/audio | 无 | 完成且有file才下载；未就绪可能返回状态JSON，先看state |
| 取消 | POST /tts/tts-001/cancel | 无 | cancelled:true表示收到请求，不是退款或远端撤销保证 |

text非空最多12000字符，style必须为字符串、最多1500字符；不用风格填空字符串。voice/language从列表取得。state可能processing/completed/failed/interrupted。失败信息目前不详细，不能编造原因。不要以新requestId自动重做。完成file可直接作为Inf/H3表单audio，用户没要生成数字人就只交付音频。

## 工作流管理（用户明确要求时）

| 操作 | 方法／路径 | body | 返回 |
|---|---|---|---|
| 列表 | GET /workflows | 无 | 工作流数组，含id/profile等 |
| 详情 | GET /workflows/<ID> | 无 | 工作流记录；使用本地id，不是远端工作流号 |
| 导入软件工作流包 | POST /workflows/import | 桌面导出的完整便携JSON | 工作流记录；不要手造包的hash/profile |
| 导入API JSON | POST /workflows/import-api | `{"name":"个人工作流","runningHubWorkflowId":"<远端号>","workflow":{真实API节点JSON}}` | 工作流记录；sourceUrl可选；id只在明确更新已有个人工作流时使用 |
| 更新个人映射 | PATCH /workflows/<ID> | `{"profile":完整profile,"metadata":{"name":"新名称"}}` | 更新记录；metadata另支持runningHubWorkflowId/sourceUrl |
| 删除个人工作流 | DELETE /workflows/<ID> | 无 | removed；默认内置工作流不允许修改删除 |

更新映射步骤：读取指定工作流→只按用户明确要求修改其返回profile→提交完整profile→返回结果。不是日常生成必须执行的步骤。软件负责映射校验，不要求AI自主审核节点。用户只提供API JSON时使用import-api，不要求AI构建便携包。个人工作流还没有高层workspace表单，需用户提供明确参数映射后用下节兼容接口；不要猜节点。

## Skill

ID使用远端工作流号，仅支持当前H3三类：多参考2106577322987307010、首尾帧2106994828660080641、数字人2107063778012905474。

| 操作 | 方法／路径 | body | 返回 |
|---|---|---|---|
| 查看 | GET /skills/<远端工作流号> | 无 | selectedId、skills数组含id/name/content/hash |
| 上传并选中 | POST /skills/<远端工作流号>/import | `{"name":"我的Skill","content":"完整指令文本"}` | 更新设置，导入后自动选中；同内容去重 |
| 切换 | POST /skills/<远端工作流号>/select | `{"skillId":"<返回的ID>"}` | 更新设置 |
| 恢复内置 | 同上 | `{"skillId":"builtin"}` | 更新设置 |

name非空不超过200字符，content非空UTF-8最大256KB，不含NUL。把用户文件内容放入content，不把文件路径当作内容。不存在删除Skill接口。不要AI自行撰写或修改用户Skill。

## 旧版／个人工作流兼容接口（不是日常入口）

| 操作 | 方法／路径 | body | 返回 |
|---|---|---|---|
| 原始输入预览 | POST /jobs/preview | 单个JobInput | 最终JobInput，不生成 |
| 原始批量提交 | POST /jobs | `{"requestId":"legacy-001","jobs":[JobInput]}` | replay、jobIds；最多500条；同请求号不可改变载荷 |

JobInput示例仅在用户已有映射时使用：
```json
{"workflowId":"<本地工作流ID>","taskName":"任务名","parameters":{"<参数ID>":"用户指定值"},"media":[{"parameterId":"<素材参数ID>","localPath":"<上传返回路径>"}],"optimize":false,"instanceType":"default"}
```

workflowId必填；parameters使用profile的参数id；media只需parameterId/localPath；optimize可选；instanceType可选default/plus；taskName可选。production可选 `{groupId,segmentIndex}`；namingRule可选workflow-date/date/original。不要传promptOptimization，软件自行生成；outputDir由云端控制。

旧H3数字人可传顶层audioRange={startSeconds,endSeconds}；也兼容parameters.duration（起点）和duration_2（长度），两种方式不可同时用。日常用workspace的segments即可。不要把底层兼容能力描述成桌面全部操作已接入。

## 运维边界

安装、升级、服务重启由所有者/部署管理员负责；AI日常任务不修改runtime.env、数据库、源码和systemd。AI只调用上述接口。已有更新检查脚本只报告版本，不是自动升级API。所有未接入项见UNAVAILABLE.md。

### 从Key文本文件添加（无需手写JSON）

在安装目录执行：
```bash
python3 scripts/accounts.py add-rh "账号A" --key-file /private/rh-key.txt
python3 scripts/accounts.py add-gemini --key-file /private/gemini-keys.txt
python3 scripts/accounts.py import /private/desktop-accounts.json
python3 scripts/accounts.py list
```
RunningHub文件必须只有一条非空Key；多个RH账号用桌面导出文件批量导入。Gemini每行一个Key，一次最多100条。支持Windows UTF-8 BOM、CRLF和空行；不要加引号、编号或注释。只添加不自动检测；用户要求检测才用接口或add-rh的--test。重复RH Key报错且不新增，重复Gemini Key跳过。读取失败报告错误，不将Key内容复制到回复。
