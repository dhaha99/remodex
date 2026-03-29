#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "$0")" && pwd)
WORKSPACE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="${REMODEX_ENV_FILE:-$WORKSPACE_DIR/ops/remodex.env}"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

LABEL_PREFIX="${REMODEX_LAUNCHD_LABEL_PREFIX:-com.remodex}"
SCHEDULER_KIND="${REMODEX_SCHEDULER_KIND:-launchd_launchagent}"

if [[ "$SCHEDULER_KIND" != "launchd_launchagent" ]]; then
  echo "uninstall_launchd_services.sh only supports REMODEX_SCHEDULER_KIND=launchd_launchagent" >&2
  exit 1
fi

echo "Bootout bridge daemon if loaded:"
echo "launchctl bootout gui/$(id -u) \"$LAUNCH_AGENTS_DIR/${LABEL_PREFIX}.bridge-daemon.plist\""
echo "Bootout scheduler tick if loaded:"
echo "launchctl bootout gui/$(id -u) \"$LAUNCH_AGENTS_DIR/${LABEL_PREFIX}.scheduler-tick.plist\""
if [[ "${REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER:-false}" == "true" ]]; then
  echo "Bootout Discord Gateway adapter if loaded:"
  echo "launchctl bootout gui/$(id -u) \"$LAUNCH_AGENTS_DIR/${LABEL_PREFIX}.discord-gateway-adapter.plist\""
fi
if [[ "${REMODEX_ENABLE_DASHBOARD_SERVER:-false}" == "true" ]]; then
  echo "Bootout dashboard server if loaded:"
  echo "launchctl bootout gui/$(id -u) \"$LAUNCH_AGENTS_DIR/${LABEL_PREFIX}.dashboard-server.plist\""
fi
echo "Remove copied plists:"
echo "rm -f \"$LAUNCH_AGENTS_DIR/${LABEL_PREFIX}.bridge-daemon.plist\" \"$LAUNCH_AGENTS_DIR/${LABEL_PREFIX}.scheduler-tick.plist\" \"$LAUNCH_AGENTS_DIR/${LABEL_PREFIX}.discord-gateway-adapter.plist\" \"$LAUNCH_AGENTS_DIR/${LABEL_PREFIX}.dashboard-server.plist\""
