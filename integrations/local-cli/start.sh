#!/bin/sh
# FluentRead 本机 CLI 桥接启动脚本（macOS / Linux）。额外参数会原样传给桥接，例如 ./start.sh --port 18800
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 20 或更高版本：https://nodejs.org/" >&2
  exit 1
fi
exec node "$(dirname "$0")/cli.mjs" "$@"
