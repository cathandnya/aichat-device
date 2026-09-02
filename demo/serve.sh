#!/bin/bash
#
# デモ音声リモコンを開く。
#
# **file:// では動かない。** commands.json を fetch するので、
# ブラウザに止められる。だから静的サーバー越しに出す。
#
#   ./demo/serve.sh          # 開く
#   PORT=9000 ./demo/serve.sh
#
set -e
PORT="${PORT:-8777}"
HERE="$(cd "$(dirname "$0")" && pwd)"
URL="http://127.0.0.1:$PORT/remote.html"

if [ ! -f "$HERE/commands.json" ]; then
  echo "音声がまだ無い。先に作る:" >&2
  echo "  $HERE/gen.sh" >&2
  exit 1
fi

# すでに上がっていれば開くだけ。撮影中に何度も叩くので。
if curl -sf -o /dev/null "$URL"; then
  echo "起動済み: $URL"
else
  cd "$HERE"
  python3 -m http.server "$PORT" --bind 127.0.0.1 > /dev/null 2>&1 &
  echo "起動した (pid $!): $URL"
  # 上がるまで待つ。すぐ open すると空振りする。
  for _ in $(seq 20); do curl -sf -o /dev/null "$URL" && break; sleep 0.1; done
fi
open "$URL" 2>/dev/null || true
