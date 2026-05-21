#!/bin/bash
# Run Noah Agent in Docker
#
# Mounts:
#   ~/.claude/                   → Claude CLI config, auth, rules, agents, skills (rw: CLI writes state)
#   ~/.claude.json               → Claude CLI global settings (rw: CLI writes debug/todos)
#   ~/noah-agent/.env            → Environment variables (Slack tokens, API keys, etc.)
#   ~/noah-agent/config/         → Schedule definitions, config (ro)
#   ~/noah-workspace/            → Persistent workspace for Claude CLI (rw)
#   ~/.openclaw/workspace/projects/gmo-trading/ → GMO trading bot (rw)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="noah-agent"
WORKSPACE_DIR="${NOAH_WORKSPACE_DIR:-$HOME/noah-workspace}"
STATE_DIR="${NOAH_STATE_DIR:-$HOME/noah-state}"
GMO_TRADING_DIR="$HOME/.openclaw/workspace/projects/gmo-trading"

# Ensure directories exist on host
mkdir -p "$WORKSPACE_DIR"
mkdir -p "$STATE_DIR"

# Build if image doesn't exist or --build flag passed
if [[ "${1:-}" == "--build" ]] || ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "[noah] Building Docker image..."
  cd "$SCRIPT_DIR"
  npm run build
  docker build -t "$IMAGE_NAME" .
fi

# Build volume mount args
# Note: ~/.claude and ~/.claude.json need rw — Claude CLI writes session state, debug, todos
VOLUMES=(
  -v "$HOME/.claude:/home/noah/.claude"
  -v "$HOME/.claude.json:/home/noah/.claude.json"
  -v "$HOME/.ssh:/home/noah/.ssh:ro"
  -v "$HOME/.gitconfig:/home/noah/.gitconfig:ro"
  -v "$SCRIPT_DIR/config:/app/config:ro"
  -v "$WORKSPACE_DIR:/workspace"
  -v "$STATE_DIR:/home/noah/.noah-agent"
)

# Mount GMO trading bot if it exists
if [[ -d "$GMO_TRADING_DIR" ]]; then
  VOLUMES+=(-v "$GMO_TRADING_DIR:/trading")
  echo "[noah] GMO trading bot: $GMO_TRADING_DIR → /trading"
fi

echo "[noah] Starting Noah Agent..."
echo "[noah] Workspace: $WORKSPACE_DIR"
DOCKER_TTY=""
if [ -t 0 ]; then
  DOCKER_TTY="-it"
fi

docker run --rm $DOCKER_TTY \
  --name noah-agent \
  --env-file "$SCRIPT_DIR/.env" \
  -e "NOAH_WORKSPACE_DIR=/workspace" \
  -e "GMO_TRADING_DIR=/trading" \
  -e "TZ=Asia/Tokyo" \
  "${VOLUMES[@]}" \
  -p 18790:18790 \
  "$IMAGE_NAME"
