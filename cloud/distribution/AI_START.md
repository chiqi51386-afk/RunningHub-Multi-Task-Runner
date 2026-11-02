# AI 操作入口（先读本页）

Linux 无 UI。你只负责按用户要求调用接口、提交任务、返回软件的数据和文件。

1. 不读源码、数据库、服务内部密钥，不修改后端，不用 shell 绕过接口。只可由客户端读取本机 api.token 用于鉴权。
2. 不自行评价任务是否正确、不审查生成词或成片、不擅自优化参数、不自行决定重做。用户没指定的参数交给软件默认规则。
3. 正常生成不用预览、不检测全部账号、不遍历工作流、不读取完整指南。软件负责参数校验。用户要求预览或管理时才调用相应接口。
4. 使用 MODULE_GUIDE.md 的表单，加入批次后直接提交；只保存批次号和 jobIds。每30秒查一次自己的任务（需要时可延长到60秒），不轮询全部队列。
5. 查询只是取得状态和结果，不是人工核实任务内容。出错原样简短报告，不自动换请求号重提。提交超时重用同一个批次号；下载失败只能重试下载。
6. 回答只给：任务名、状态、结果路径；失败加错误摘要。API原始大JSON保存文件，不整段输出。密钥不得回显。

## 调用方法

```bash
cd ~/rh-runner-cloud
python3 current/cloud/client.py METHOD /path --file request.json --output response.json
```

GET和无请求体操作省略 --file。需要下载媒体时 --output 指定文件名。读取response.json时只取所需字段。自定义安装路径替换上面的路径；RH_TOKEN_FILE为data/api.token，RH_BASE_URL默认http://127.0.0.1:17863。

## 最短生成流程

已有素材 localPath 后，按 MODULE_GUIDE.md 选模块填写form：

1. POST /workspace/batches，body：`{"requestId":"本次唯一批次号","tasks":[form]}`。
2. POST /workspace/batches/批次号/submit，无body，保存返回jobIds。
3. GET /jobs/任务ID，取status、lastError、outputs。
4. 完成后 GET /jobs/任务ID/files/0，--output保存结果。其余结果文件按outputs.files索引获取。

默认分辨率1.5，Plus由软件按时长与分辨率计算。H3数字人默认完整音频向上取整。不要自己算节点参数。

账号或设置操作只按用户明确要求执行。接口方法和参数查 API_REFERENCE.md；模块表单查 MODULE_GUIDE.md；缺项查 UNAVAILABLE.md。不必每次读取全部文档。

**范围说明：这是AI操作约定，并非操作系统安全隔离。当前包仍包含源码；闭源可执行版和独立权限部署尚未完成。不得宣称已技术上禁止有root权限的AI访问后端。**
