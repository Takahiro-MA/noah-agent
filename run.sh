#!/bin/bash
# Run Noah Agent in Docker
#
# Mounts:
#   ~/.claude/ (ro)  → Claude CLI config, auth, rules, agents, skills
#   ~/noah-agent/.env → Environment variables (Slack tokens, etc.)
#   /workspace       → Writable workspace for Claude CLI (isolated)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="noah-agent"

# Build if image doesn't exist or --build flag passed
if [[ "${1:-}" == "--build" ]] || ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "[noah] Building Docker image..."
  cd "$SCRIPT_DIR"
  npm run build
  docker build -t "$IMAGE_NAME" .
fi

echo "[noah] Starting Noah Agent..."
docker run --rm -it \
  --name noah-agent \
  --env-file "$SCRIPT_DIR/.env" \
  -v "$HOME/.claude:/home/noah/.claude:ro" \
  -v "$SCRIPT_DIR/config:/app/config:ro" \
  -p 18790:18790 \
  "$IMAGE_NAME"
