#!/usr/bin/env bash
set -euo pipefail
PROJECT_NAME="understanding-ai"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
export PORT="${PORT:-4186}" API_PORT="${API_PORT:-4188}"
# Trusted local configuration; never committed.
if [ -f .env ]; then set -a; source .env; set +a; fi
PID_FILE="/tmp/ai-lab-setup-${PROJECT_NAME}-dev.pid"
LOG_FILE="/tmp/ai-lab-setup-${PROJECT_NAME}-dev.log"
log() { printf '\033[36m[%s]\033[0m %s\n' "$PROJECT_NAME" "$*"; }
ok() { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
prereqs() {
  for tool in node pnpm curl lsof; do command -v "$tool" >/dev/null || { err "Missing prerequisite: $tool"; exit 1; }; done
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<14))process.exit(1)' || { err "Node 22.14+ required"; exit 1; }
}
owned() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid="$(cat "$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ "$(ps -p "$pid" -o command=)" == *"$SCRIPT_DIR/scripts/dev.mjs"* ]]
}
check_port() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
stop() {
  if owned; then
    local pid; pid="$(cat "$PID_FILE")"; kill "$pid"
    for _ in {1..30}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    rm -f "$PID_FILE"; ok "Stopped owned project processes; data preserved."
  else warn "No owned process running."; fi
}
start() {
  prereqs
  if owned; then ok "Already running: http://127.0.0.1:$PORT"; return; fi
  [ -d node_modules ] || { err "Run ./setup.sh setup first."; exit 1; }
  for port in "$PORT" "$API_PORT"; do
    if check_port "$port"; then err "Port $port is occupied. Set PORT/API_PORT to free ports."; exit 1; fi
  done
  mkdir -p data/chats data/kb
  node --input-type=module - "$SCRIPT_DIR/scripts/dev.mjs" "$LOG_FILE" "$PID_FILE" <<'JS'
import { spawn } from 'node:child_process';
import { openSync, writeFileSync } from 'node:fs';
const [script, log, pid] = process.argv.slice(2);
const output = openSync(log, 'a');
const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', output, output] });
writeFileSync(pid, String(child.pid));
child.unref();
JS
  for _ in {1..60}; do
    if curl -fsS "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
      ok "Understanding AI: http://127.0.0.1:$PORT"; log "Logs: $LOG_FILE"; return
    fi
    if ! owned; then break; fi
    sleep 0.5
  done
  err "Startup failed. See $LOG_FILE"; stop; exit 1
}
case "${1:-help}" in
  setup) prereqs; [ -f .env ] || cp .env.example .env; pnpm install --frozen-lockfile; start ;;
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) if owned; then ok "Running: http://127.0.0.1:$PORT"; else warn "Stopped"; fi ;;
  logs) touch "$LOG_FILE"; tail -n 80 -f "$LOG_FILE" ;;
  test) pnpm typecheck; pnpm test ;;
  build) pnpm typecheck; pnpm build ;;
  help|-h|--help) echo "Usage: ./setup.sh setup|start|stop|restart|status|logs|test|build|help" ;;
  *) err "Unknown command: $1"; exit 1 ;;
esac
