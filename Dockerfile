# Dùng Node.js 20 + Debian (có thể apt-get install ffmpeg)
FROM node:20-slim

# Cài FFmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg wget curl --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Verify FFmpeg
RUN ffmpeg -version | head -1

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm install --production

# Copy source
COPY server.js .

# Render dùng PORT env variable
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s \
  CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

CMD ["node", "server.js"]
