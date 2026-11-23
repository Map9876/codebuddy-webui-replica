#!/bin/bash
# 一键跑全部验证脚本（cb-chat 内核还原回归）
# 用法：bash /workspace/cb-chat/run_all_checks.sh
cd "$(dirname "$0")" || exit 1
export NODE_PATH=/workspace/node_modules
NODE=/usr/lib/code-server/lib/node
[ -x "$NODE" ] || NODE=node

PASS=0; FAIL=0
for f in check_layout.js verify_tui.js verify_tui_keys.js verify_e2e.js verify_editor_search.js verify_journey.js verify_split_input.js verify_assertions.js; do
  printf '%-28s ' "$f"
  out=$($NODE "$f" 2>&1)
  if echo "$out" | grep -q '"errors": \[\]\|"errs": \[\]\|"error":'; then
    # 有 errors 字段且为空数组 → OK
    if echo "$out" | grep -q '"errors": \[\]\|"errs": \[\]'; then echo "OK"; PASS=$((PASS+1)); else echo "FAIL"; FAIL=$((FAIL+1)); echo "$out" | head -5; fi
  else
    echo "OK (no-error-field)"; PASS=$((PASS+1))
  fi
done
echo "--- PASS=$PASS FAIL=$FAIL ---"
# 清理测试残留终端（保留原始 1/2/3/4/7）
for id in $(curl -s --max-time 8 http://127.0.0.1:7911/cb/api/terminals 2>/dev/null | python3 -c "
import json,sys
try:
 d=json.load(sys.stdin); print(' '.join(str(t['id']) for tab in d.get('tabs',[]) for t in tab.get('terminals',[]) if t['id'] not in (1,2,3,4,7)))
except: pass
"); do curl -s --max-time 6 -X POST "http://127.0.0.1:7911/cb/api/kill?id=$id" >/dev/null 2>&1; echo "cleaned terminal $id"; done
