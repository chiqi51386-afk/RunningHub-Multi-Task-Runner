# RunningHub Multi-Task Runner

一个面向 RunningHub 海外站的 Windows 桌面客户端，用来管理多个工作流、账号和生成任务。当前版本：**v0.1.3**。

## 主要功能

- 导入 RunningHub / ComfyUI API JSON，自动识别生成词、图片、音频、视频和常用生成参数。
- 支持多个账号和统一任务队列；每个账号同一时间只运行一个远端任务。
- 支持图片预览、音频播放、视频预览、再次生成、停止生成和任务删除。
- 自动查询任务状态，生成完成后统一下载，并显示生成耗时。
- 工作流参数可显示、隐藏和重新命名；工作流配置可导入、导出。
- 下载目录可以在“设置”中修改。
- 可以在“设置”中检查正式 GitHub 仓库的新版本。

## 直接使用 Windows 版

1. 打开 [Releases](https://github.com/secure-artifacts/RunningHub-Multi-Task-Runner/releases)。
2. 下载 `RunningHub-Runner-v0.1.3-windows-x64.zip`。
3. 解压全部文件，不能只把 EXE 单独拖出来。
4. 双击 `RunningHub Runner.exe`。
5. 添加 RunningHub API Key，导入或选择工作流，然后创建任务。

当前应用没有代码签名。Windows 第一次运行时如果出现安全提示，请先核对下载来源确实是本仓库。

## 内置工作流

首次启动会自动加入四个默认工作流：

- MiniMax H3 多参考生视频优化版
- MiniMax H3 中文生成词版
- InfiniTetalk 单人图像驱动数字人
- LTX 2.3 数字人

四个工作流只保留节点结构、参数映射和使用说明。内置生成词、图片、视频和音频素材均已清空，使用前需要填写或上传自己的内容。

## 基本使用流程

1. 在“账号池”添加 API Key，并确认账号可用和余额正常。
2. 在“工作流”选择内置工作流，或导入新的 API JSON / `.rhworkflow.json`。
3. 在“创建任务”填写生成词、上传媒体并设置参数。
4. 加入制作批次，或直接提交当前任务。
5. 在“任务队列”查看状态、生成耗时、缩略图和输出文件。
6. 在“设置”中打开或修改统一下载目录。

## 数据和安全说明

- API Key 按当前产品要求以明文保存在本机 SQLite 数据库中。
- 请勿把数据库、API Key、日志或包含隐私的截图上传到 GitHub。
- 发布源码和可执行压缩包不包含账号、API Key、历史任务、下载文件或本地测试素材。
- 如果提交状态未知，软件不会自动重复提交，避免重复扣费。
- 软件更新只替换程序目录；API Key、工作流、任务和设置位于独立的用户数据库中，更新不会删除这些数据。

## 从源码运行

需要 Node.js 20 或更高版本。

```powershell
npm install
npm --prefix frontend install
npm run desktop:start
```

运行自动化检查：

```powershell
npm run typecheck
npm test
npm run frontend:typecheck
npm run desktop:smoke
```

制作 Windows x64 可执行压缩包：

```powershell
npm run release:win
```

输出文件位于：

```text
release-build/RunningHub-Runner-v0.1.3-windows-x64.zip
```

普通测试全部使用本地模拟接口，不会调用 RunningHub，也不会消耗余额。真实接口测试只有在明确设置确认变量和测试 API Key 后才会执行。

## 目录说明

- `src/core`：账号、工作流、任务、调度、下载和 RunningHub API 核心逻辑。
- `src/desktop`：Electron 主进程和桌面桥接。
- `frontend`：React 前端界面。
- `bundled-workflows`：四个清理后的默认工作流。
- `tests`：自动化测试。
- `THIRD_PARTY_LICENSES`：第三方来源和许可证清单。
- `_reference`：仅供本地研究，不会进入 Git 或发布包。

## 当前限制

- 仅构建和验证 Windows x64 版本。
- 可执行文件尚未进行代码签名。
- 单个工作流内部的一采预览后再决定是否执行二采，仍需要把远端工作流拆成两个阶段后才能可靠实现。
