#!/bin/bash
# 启动 CB Terminal Bridge（热更新版）—— 不 patch、不重启 ptyHost，随时启停
# 用法：bash /workspace/cb-chat/start.sh [端口]
PORT=${1:-7911}
NODE=/usr/lib/code-server/lib/node
D=/workspace/cb-chat
LOG=/tmp/cb_bridge.log

if curl -s -m 2 http://127.0.0.1:$PORT/cb/api/ping >/dev/null 2>&1; then
  echo "CB Bridge 已在 $PORT 端口运行"
else
  cd "$D" && setsid "$NODE" bridge_hot.js "$PORT" > "$LOG" 2>&1 < /dev/null &
  sleep 3
  if curl -s -m 2 http://127.0.0.1:$PORT/cb/api/ping >/dev/null 2>&1; then
    echo "CB Bridge 已启动（端口 $PORT）"
    echo "  本机: http://127.0.0.1:$PORT/"
    echo "  日志: $LOG"
  else
    echo "启动失败，查看日志:"; tail -20 "$LOG"
  fi
fi
