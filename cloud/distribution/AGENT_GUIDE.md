# AGENT_GUIDE — 给操作本系统的 AI看的手册

你是一台 Linux 机器上的个人代理。这套系统让你调用 RunningHub（海外站）+ Gemini
替用户生成视频和语音。先读完本手册再动手；ANALYSIS.md 是原理篇。

## 0. 铁律（违反任何一条都可能让用户多花钱或丢账号）

1. **只用海外站**：API Host 必须永远是 `https://www.runninghub.ai`。不许访问国内站，不许把 RH_API_HOST 改成别的域名。
2. **requestId 幂等**：提交任务超时/断线时，用**同一个 requestId + 完全相同的载荷**重发（会拿到 replay 和原 jobIds）；绝不为“没等到结果”新编 requestId。TTS 同理。
3. **恢复只查不建**：任务状态不明时用 `GET /jobs/:id` 和 `POST /jobs/:id/query` 查原远端任务；下载失败用 `POST /jobs/:id/retry-download`。永远不要用“重新提交一条”来恢复。
4. **不回显密钥**：任何回复、日志、文件里都不许出现完整 API Key / api.token。账号列表接口本身只给元数据和掩码，照常使用即可。
5. **花钱动作要有着落**：提交视频和 TTS/优化（都消耗账号额度）前，确认用户确实要生成；把 requestId、jobId、远端 taskId 记进你的记忆/任务记录，方便跨会话找回。

## 1. 安装

```bash
unzip RH-Runner-Cloud-*.zip && cd RH-Runner-Cloud
bash install.sh                 # 默认装到 ~/rh-runner-cloud，含 systemd 服务
# 选项：--dir DIR --port 17863 --no-service
```

装完确认：`systemctl is-active rh-runner` 为 active，
`cd ~/rh-runner-cloud && python3 smoke/smoke_test.py --dir .` 输出 SMOKE TEST PASSED。
没有 systemd 时按 install.sh 结尾打印的命令手动启动（注意 RH_API_HOST 与代理环境）。

环境变量速查：`RH_DATA_DIR`（默认 ./data）、`RH_PORT`（17863）、`RH_BIND`（127.0.0.1，勿改公网）、
`RH_API_HOST`（固定海外站）。受管网络还要：http_proxy/https_proxy、`NODE_USE_ENV_PROXY=1`、
`NODE_EXTRA_CA_CERTS`（代理 CA 包路径，下载结果文件要用）。install.sh 会自动透传安装者当前环境的这些变量。

## 2. 账号管理（以后加新账号就走这里）

全部通过 `scripts/accounts.py`（在安装目录下运行，Token 自动读 data/api.token）：

```bash
python3 scripts/accounts.py list [--state IDLE]          # 看账号与金币（无明文）
python3 scripts/accounts.py import rh-accounts.json      # 批量导入桌面版导出文件（重复 Key 自动跳过）
echo "<RH-KEY>" > key.txt
python3 scripts/accounts.py add-rh "新账号名" --key-file key.txt --test   # 单个加 RunningHub 并立即检测
python3 scripts/accounts.py add-gemini --key-file gemini-keys.txt          # 一行一个 Gemini Key
python3 scripts/accounts.py test "0 03"                  # 按 label 或 id 检测单个（查金币）
python3 scripts/accounts.py test-all                     # 全量检测（约 1-2 分钟）
python3 scripts/accounts.py patch "0 03" --preferred --concurrency 2       # 设优先/并发/启停
python3 scripts/accounts.py remove "0 03"
python3 scripts/accounts.py gemini-remove <key-id>
```

要点：
- Key 只从文件或隐藏输入读，不要把 Key 写进命令行参数、聊天或代码仓库。导入文件用完即删。
- 加完必须 `--test` 或 test 单个：状态 IDLE 且金币 > 0 才算可用。INVALID_KEY = Key 错或不属于海外站；NO_BALANCE = 没金币了（自动禁用属正常）；TEMP_UNAVAILABLE = 先查网络/代理（第 6 节）。
- 轮换规则是软件内置的（优先号 → 最久未用 → 并发/金币过滤），你**不需要**也**不要**自己挑账号，提交任务后调度器自动分配；`PATCH preferred` 是唯一的官方干预手段。

## 3. 每日积分自动查询

- 手动：`python3 scripts/check_credits.py`（全量刷新约 1–2 分钟；`--no-refresh` 只汇总已存状态；结果追加到 data/credits-history.jsonl）。
- 定时（二选一，不要重复）：
  a) systemd timer：改 `systemd/rh-credits.service` 里的安装路径后与 .timer 一起拷到 /etc/systemd/system 并 enable。
  b) 你是 AI：用你的定时任务能力每天约 09:00 调一次上面的脚本并向用户汇报（账号总数、可用数、总金币、与昨日变化、INVALID_KEY 的 label；总金币 < 300 或可用 < 5 时预警）。

## 4. 提交视频任务

> 视频任务的完整流程（需求确认→选工作流→备料→参数→提交→交付）以 **VIDEO_GUIDE.md** 为准，本节只是速记。特别注意 H3数字人 MV 的 `duration` 是音频起点、`duration_2` 才是片段时长，填反不拦截、直接错花钱。
> **提交后必做核实**：逐条 GET 回任务记录，核对素材槽位与路径、生成词原文与实际提交词、参数（时长/画幅/分辨率/Plus）、状态推进与远端 taskId，并把核实结果汇报用户（清单见 VIDEO_GUIDE 第 6 节）。交付按定版：原片进 Google 网盘「AI 专用」分类存放，聊天里发 720 宽预览版附件供直接预览，生成期间报进度、完成一条交付一条。

```bash
# 1) 先看工作流参数（id 必须逐字用这里的）
python3 current/cloud/client.py GET "/workflows/builtin:h3-first-last.rhworkflow.json" --token-file data/api.token
# 2) 上传素材（返回 localPath，只能用 data/uploads 或 data/tts 下的路径提交）
python3 current/cloud/client.py POST "/uploads?filename=first.jpg" --file first.jpg --token-file data/api.token
# 3) 写任务 JSON 后提交（requestId 自己生成且要记下来，如业务日期+序号）
python3 current/cloud/client.py POST /jobs --file job.json --token-file data/api.token
# 4) 轮询到 COMPLETED，outputs.files[].localPath 就是成片
python3 current/cloud/client.py GET /jobs/<jobId> --token-file data/api.token
```

任务 JSON 形态：

```json
{
  "requestId": "my-batch-20260101-01",
  "jobs": [{
    "workflowId": "builtin:h3-first-last.rhworkflow.json",
    "taskName": "给人看的名字",
    "parameters": {"duration": 4, "aspect_ratio": "9:16 (Portrait Widescreen)", "prompt": "..."},
    "media": [
      {"parameterId": "image", "localPath": "<uploads 返回的路径>"},
      {"parameterId": "image_2", "localPath": "<同上>"}
    ],
    "optimize": false, "instanceType": "default"
  }]
}
```

- 首尾帧工作流参数 id 就叫 `image`（首帧）/`image_2`（尾帧）；duration 默认就是 4（秒）。
- 生成词优化**默认全开**（分发补丁 #5）：有优化映射的工作流（首尾帧/MV/SelfLift）不填 `optimize` 就自动优化；只有用户明确要求不优化时才填 false。InfiniTalk 无此功能。优化模型是 Gemini 设置里的 model（当前 gemini-3.5-flash-lite）；TTS 模型是软件内置的 gemini-3.8-flash-tts，与该设置无关。优化失败任务会 FAILED 且不提交视频，按失败反馈处理。
- 别自己拼 nodeInfoList 或直调 RunningHub——走 /jobs，软件的防重复与换号逻辑都在这条路上。

## 5. 语音生成（TTS）

```bash
python3 current/cloud/client.py GET /tts --token-file data/api.token   # 语言/音色表
# POST /tts  {"requestId":"tts-业务id","input":{"text":"...","voice":"Puck","language":"en","style":"..."}}
# GET  /tts/<requestId> 直到 completed；GET /tts/<requestId>/audio --output out.wav 下载
```

- 输出是 24kHz 双声道 WAV（Gemini 原生单声道，服务端复制成双声道），文件落在 data/tts/，可直接当视频任务的音频素材（localPath）。
- 语言表没有中文条目：中文文本把 language 选 en 占位，并在 style 里写明 “Speak Mandarin Chinese (Putonghua) naturally; read the exact Chinese transcript, do not translate.”（实测可行）。
- TTS 中断不自动重跑（防重复计费）；state=interrupted 时先向用户确认再发新 requestId。

## 6. 故障速查

| 现象 | 真因与处理 |
| --- | --- |
| 全部账号 TEMP_UNAVAILABLE | 服务进程没网：多半是 systemd 单元缺代理环境（http_proxy 等 + NODE_USE_ENV_PROXY=1），或 RH_API_HOST 被改错。修单元后重启并 test 单个账号验证 |
| 无效 Key 显示 TEMP_UNAVAILABLE 而非 INVALID_KEY | 旧版本分类器不认海外站 806 错误码；本分发包已修（PATCHES.md #2），确认在用本包代码 |
| 任务 COMPLETED 前卡 RETRY_WAIT、错误含 self-signed certificate | 下载域名证书校验失败：给服务加 NODE_EXTRA_CA_CERTS=<代理 CA 包>，重启后下载会自动续上，不要重提任务 |
| 服务重启后任务不见踪影的恐慌 | 数据库在 data/ 里，重启自动恢复 RUNNING 任务并继续查询原远端任务；先 GET /jobs 看状态 |
| systemctl 查不到 rh-runner | 某些 VM 重启会清 /etc：按 systemd/rh-runner.service.tpl 重建单元（补齐代理/CA 环境），enable --now |
| NO_BALANCE 一大片 | 不是故障：金币耗尽的号被自动禁用。跑 check_credits.py 看总数，提醒用户补号/充值 |
| 提交后立刻 FAILED 且没扣费 | 多半参数 id 写错或工作流校验不过（prepare 阶段拦截）；按报错改参数，不要换 requestId 试错；载荷要改时先确认原需求从未成功提交（无 job 记录、无扣费），已有任务记录的按 VIDEO_GUIDE 第 8 节处理 |
| 端口被占/装了两个实例 | 同一个 data 目录只许一个实例（SQLite）；先停旧实例再起新的 |

## 7. 交付与汇报规范（给 AI 的）

每次替用户跑完任务，按 VIDEO_GUIDE 第 7 节的五项格式交代：任务/工作流、关键参数、requestId/jobId/远端 taskId、状态与成片路径、异常或待确认项。长任务中途至少同步一次进度，不要让用户干等。
