@echo off
setlocal
rem 清掉会让 Electron 退化成纯 Node 的环境变量
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="
cd /d "%~dp0"
if not exist ".\node_modules\electron\dist\electron.exe" (
  echo [x] 未找到 electron，请先运行: npm install
  pause
  exit /b 1
)
".\node_modules\electron\dist\electron.exe" . --no-sandbox %*
