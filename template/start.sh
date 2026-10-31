#!/usr/bin/env bash
# macOS / Linux 启动脚本
set -e
cd "$(dirname "$0")"

if [ -z "$DEEPSEEK_API_KEY" ]; then
  echo "⚠️  未设置 DEEPSEEK_API_KEY"
  echo "   export DEEPSEEK_API_KEY=sk-你的key   然后重跑"
  exit 1
fi

node -v | grep -qE "v(2[2-9]|[3-9][0-9])" || { echo "需要 Node >= 22，当前：$(node -v)"; exit 1; }

if [ ! -d logs ]; then mkdir -p logs; fi

echo "=== 自检（连上后打印群列表） ==="
node bot.js --check || true

echo
echo "=== 开始运行（Ctrl+C 退出） ==="
node bot.js
