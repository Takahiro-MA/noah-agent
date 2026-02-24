FROM node:22-bookworm-slim

# Create non-root user
RUN useradd -m -s /bin/bash noah

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code@latest

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy built application
COPY dist/ dist/
COPY config/ config/

# Ensure state directory exists
RUN mkdir -p /home/noah/.noah-agent/state && chown -R noah:noah /home/noah

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
