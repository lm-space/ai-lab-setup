#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cmd="${1:-help}"
case "$cmd" in
  list) echo "understanding-ai — inspect a working agent harness"; exit 0 ;;
  help|-h|--help) echo "Usage: ./setup.sh <setup|start|stop|restart|status|logs|test|build> [understanding-ai]"; echo "       ./setup.sh list"; exit 0 ;;
esac
project="${2:-understanding-ai}"
[ "$project" = understanding-ai ] || { echo "Unknown project: $project" >&2; exit 1; }
exec "$ROOT/projects/$project/setup.sh" "$cmd" "${@:3}"
