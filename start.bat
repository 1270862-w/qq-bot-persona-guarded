@echo off
chcp 65001 >nul
cd /d "%~dp0"

if "%DEEPSEEK_API_KEY%"=="" (
  echo [!] 未设置 DEEPSEEK_API_KEY
  echo     先执行: set DEEPSEEK_API_KEY=sk-你的key
  pause
  exit /b 1
)

where node >nul 2>nul || (echo [!] 没装 Node.js，需要 22 以上 & pause & exit /b 1)

if not exist logs mkdir logs

echo === 自检（连上后打印群列表） ===
node bot.js --check

echo.
echo === 开始运行（Ctrl+C 退出） ===
node bot.js
