FROM node:22-bookworm-slim

# Install Python and common dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash noah

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

# Ensure directories exist
RUN mkdir -p /home/noah/.noah-agent/state /workspace /trading && \
    chown -R noah:noah /home/noah /workspace /trading

# Switch to non-root user
USER noah

# Environment defaults
ENV NODE_ENV=production
ENV NOAH_PORT=18790
ENV NOAH_WORKSPACE_DIR=/workspace
ENV NOAH_PROJECT_ROOT=/app
ENV HOME=/home/noah

EXPOSE 18790

CMD ["node", "dist/core/server.js"]
