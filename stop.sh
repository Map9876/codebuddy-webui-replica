#!/bin/bash
# 停止 CB Terminal Bridge（不影响 code-server / ptyHost / 任何终端）
PORT=${1:-7911}
PIDS=$(ps -eo pid,args | grep "bridge_hot.js $PORT" | grep -v grep | awk '{print $1}')
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs -r kill
  echo "CB Bridge 已停止（PID: $PIDS）"
else
  echo "没有运行中的 CB Bridge（端口 $PORT）"
fi
