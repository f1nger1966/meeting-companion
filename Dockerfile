# ── Meeting Companion — Express app ──────────────────────────────────────────
# Single-stage Node 20 image. No frontend build step — vanilla JS/HTML served
# directly by Express from src/public/.
#
# Built by Vibe8 CI/CD on push to main. Not needed for local dev (use nodemon).

FROM node:20-alpine

# Install wget for the health check
RUN apk add --no-cache wget

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY src/ ./src/

# Cloud Run / Vibe8 inject PORT at runtime — default 3000 for local
EXPOSE 3000

# Platform health check — /health returns { ok: true }
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

CMD ["node", "src/server.js"]
