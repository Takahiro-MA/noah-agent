FROM node:22-bookworm-slim

# Install Python and common dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    git \
    openssh-client \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Reuse built-in 'node' user (uid=1000) — matches host user for volume permissions
RUN usermod -d /home/noah node && mv /home/node /home/noah

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code@latest

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built application
COPY dist/ dist/
COPY config/ config/

# Ensure directories exist (node user owns them)
RUN mkdir -p /home/noah/.noah-agent/state /workspace /trading && \
    chown -R 1000:1000 /home/noah /workspace /trading

# Switch to uid 1000 (node user, renamed home to /home/noah)
USER 1000

# Environment defaults
ENV NODE_ENV=production
ENV NOAH_PORT=18790
ENV NOAH_WORKSPACE_DIR=/workspace
ENV NOAH_PROJECT_ROOT=/app
ENV HOME=/home/noah

EXPOSE 18790

CMD ["node", "dist/core/server.js"]
