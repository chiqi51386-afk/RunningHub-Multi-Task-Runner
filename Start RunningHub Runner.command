#!/bin/bash
# macOS 源码启动器：双击运行（首次会自动构建）。
cd "$(dirname "$0")" || exit 1
RUNNER_EXE="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
RUNNER_MAIN="dist/src/desktop/main.js"

fail() {
  echo
  echo "RunningHub Runner failed to build. Keep this window open and send the error message for diagnosis."
  read -r -p "按回车键关闭…"
  exit 1
}

if [ ! -d node_modules ] || [ ! -d frontend/node_modules ]; then
  echo "First launch: installing dependencies..."
  npm install && npm --prefix frontend install || fail
fi
if [ ! -x "$RUNNER_EXE" ] || [ ! -f "$RUNNER_MAIN" ]; then
  echo "First launch files are missing. Building RunningHub Runner..."
  npm run desktop:build || fail
fi
npm run native:ensure-electron || fail
nohup "$RUNNER_EXE" "$RUNNER_MAIN" >/dev/null 2>&1 &
