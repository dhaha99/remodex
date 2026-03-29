#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "$0")" && pwd)
WORKSPACE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="${REMODEX_ENV_FILE:-$WORKSPACE_DIR/ops/remodex.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

: "${REMODEX_WORKSPACE:=$WORKSPACE_DIR}"
: "${REMODEX_BRIDGE_PORT:=${REMODEX_OPERATOR_HTTP_PORT:-8787}}"
: "${REMODEX_DASHBOARD_PORT:=${REMODEX_DASHBOARD_HTTP_PORT:-8790}}"
: "${REMODEX_APP_SERVER_PORT:=4517}"
: "${REMODEX_METRICS_DIR:=$REMODEX_WORKSPACE/runtime/metrics}"
: "${REMODEX_SHARED_BASE:=$REMODEX_WORKSPACE/runtime/external-shared-memory}"
: "${REMODEX_WORKSPACE_KEY:=remodex}"

TIMESTAMP="${1:-$(date +%Y%m%dT%H%M%S)}"
PS_DIR="$REMODEX_METRICS_DIR/ps-snapshots"
PORT_DIR="$REMODEX_METRICS_DIR/ports"
DISK_DIR="$REMODEX_METRICS_DIR/disk"
HEALTH_DIR="$REMODEX_METRICS_DIR/health"

mkdir -p "$PS_DIR" "$PORT_DIR" "$DISK_DIR" "$HEALTH_DIR"

{
  echo "timestamp=$TIMESTAMP"
  date -Iseconds
  (ps -axo pid,ppid,rss,%cpu,etime,command | rg 'Codex|codex app-server|remodex_' || true) 2>&1
} > "$PS_DIR/$TIMESTAMP.txt"

{
  echo "timestamp=$TIMESTAMP"
  date -Iseconds
  (lsof -nP -iTCP -sTCP:LISTEN | rg "${REMODEX_BRIDGE_PORT}|${REMODEX_DASHBOARD_PORT}|${REMODEX_APP_SERVER_PORT}|Codex|codex" || true) 2>&1
} > "$PORT_DIR/$TIMESTAMP.txt"

{
  echo "timestamp=$TIMESTAMP"
  date -Iseconds
  du -sh "$REMODEX_WORKSPACE/runtime" 2>/dev/null || true
  find "$REMODEX_WORKSPACE/runtime" -type f 2>/dev/null | wc -l | awk '{print "runtime_file_count=" $1}'
} > "$DISK_DIR/$TIMESTAMP.txt"

{
  echo "timestamp=$TIMESTAMP"
  date -Iseconds
  SCHEDULER_FILE=$(find "$REMODEX_SHARED_BASE/$REMODEX_WORKSPACE_KEY/projects" -path "*/runtime/scheduler_runtime.json" 2>/dev/null | sort | tail -n 1 || true)
  if [[ -n "$SCHEDULER_FILE" && -f "$SCHEDULER_FILE" ]]; then
    echo "scheduler_runtime_file=$SCHEDULER_FILE"
    sed -n '1,120p' "$SCHEDULER_FILE"
  else
    echo "scheduler_runtime=missing"
  fi
} > "$HEALTH_DIR/$TIMESTAMP.txt"

echo "$TIMESTAMP"
