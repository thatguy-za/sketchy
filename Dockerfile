# Multi-arch (linux/amd64, linux/arm64, e.g. Raspberry Pi 4/5 and Apple silicon).
# The app is plain JS + WASM (no native modules), so one Dockerfile serves every architecture.
# Plain `docker build` builds for the machine you're on; use build-multiarch.sh for both.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && mkdir -p /data-empty

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
COPY package*.json ./
# runtime needs only the modelling kernel (manifold-3d + three's triangulation) for the MCP server; the other browser libraries are bundled into dist
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server.js mcp.js ./
COPY src ./src
COPY --from=build --chown=node:node /data-empty /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.js"]
