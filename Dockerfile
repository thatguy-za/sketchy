# Multi-arch (linux/amd64, linux/arm64, e.g. Raspberry Pi 4/5 and Apple silicon).
# The app is plain JS + WASM (no native modules), so one Dockerfile serves every architecture.
# Plain `docker build` builds for the machine you're on; use build-multiarch.sh for both.
# BuildKit fills in BUILDPLATFORM (the machine doing the build); the default only matters for the old non-BuildKit builder
ARG BUILDPLATFORM
FROM --platform=${BUILDPLATFORM:-linux/amd64} node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && mkdir -p /data-empty

# The runtime dependencies are pure JavaScript and WebAssembly, so they are installed once on the machine doing the build (not
# emulated for each target architecture). Running node under QEMU emulation crashes now and then ("Illegal instruction").
FROM --platform=${BUILDPLATFORM:-linux/amd64} node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
# runtime needs only the modelling kernel (replicad and OpenCascade, the 23 MB WebAssembly file included) for the MCP server; the other browser libraries are bundled into dist
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 SKETCHY_DROP_ROOT=1
COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server.js design-validate.js addin-validate.js oauth.js mcp.js mcp-defs.js mcp-tools.js mcp-validate.js mcp-pool.js mcp-worker.js ./
COPY src ./src
COPY --from=build --chown=node:node /data-empty /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# starts as root only to fix the ownership of /data, then server.js switches to PUID:PGID (default 1000:1000)
CMD ["node", "server.js"]
