# ─── Runtime image for the phone-mcp broker server ────────────────────────────
# The MCP itself runs locally next to your AI agent (stdio); this image hosts the
# broker that devices connect to and that the MCP drives.
FROM oven/bun:1.4-alpine
WORKDIR /app

# Manifests first for layer caching, then the workspace sources.
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/mcp/package.json packages/mcp/

# Full source is needed so Bun can link the workspace packages.
COPY packages ./packages

RUN bun install --frozen-lockfile

ENV NODE_ENV=production
USER bun

EXPOSE 8080
ENV PORT=8080

# A token MUST be supplied at runtime: -e PHONE_MCP_TOKEN=...
CMD ["bun", "run", "packages/server/src/index.ts"]
