# 已知问题

## RunningHub 工作流远端模型环境

- 工作流：`MiniMax_H3-中文生成词版本`
- Workflow ID：`2101869007837089794`
- 节点：`323`（`QwenH3PromptLocal`）
- 远端错误：无法加载 `/workspace/ComfyUI/models/LLM/Qwen3.8/Qwen3.8-27B-Q4_K_M.gguf`
- 判断：RunningHub 远端工作流的模型文件缺失、损坏、格式不兼容或运行资源不足；不是账号、余额、上传或本地调度错误。
- 当前处理：不自动换账号重试。需要在 RunningHub 工作流中重新选择可用模型，或绕过节点 323 后发布新的工作流版本。
