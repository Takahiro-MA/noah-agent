#!/bin/bash
# Run Noah Agent in Docker
#
# Mounts:
#   ~/.claude/ (ro)              → Claude CLI config, auth, rules, agents, skills
#   ~/noah-agent/.env            → Environment variables (Slack tokens, API keys, etc.)
#   ~/noah-agent/config/         → Schedule definitions, config
#   ~/noah-workspace/            → Persistent workspace for Claude CLI (rw)
#   ~/.openclaw/workspace/projects/gmo-trading/ → GMO trading bot (rw)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="noah-agent"
WORKSPACE_DIR="${NOAH_WORKSPACE_DIR:-$HOME/noah-workspace}"
GMO_TRADING_DIR="$HOME/.openclaw/workspace/projects/gmo-trading"

# Ensure directories exist on host
mkdir -p "$WORKSPACE_DIR"

# Build if image doesn't exist or --build flag passed
if [[ "${1:-}" == "--build" ]] || ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "[noah] Building Docker image..."
  cd "$SCRIPT_DIR"
  npm run build
  docker build -t "$IMAGE_NAME" .
fi

# Build volume mount args
VOLUMES=(
  -v "$HOME/.claude:/home/noah/.claude:ro"
  -v "$SCRIPT_DIR/config:/app/config:ro"
  -v "$WORKSPACE_DIR:/workspace"
)

# Mount GMO trading bot if it exists
if [[ -d "$GMO_TRADING_DIR" ]]; then
  VOLUMES+=(-v "$GMO_TRADING_DIR:/trading")
  echo "[noah] GMO trading bot: $GMO_TRADING_DIR → /trading"
fi

echo "[noah] Starting Noah Agent..."
echo "[noah] Workspace: $WORKSPACE_DIR"
docker run --rm -it \
  --name noah-agent \
  --env-file "$SCRIPT_DIR/.env" \
  -e "NOAH_WORKSPACE_DIR=/workspace" \
  -e "GMO_TRADING_DIR=/trading" \
  "${VOLUMES[@]}" \
  -p 18790:18790 \
  "$IMAGE_NAME"
