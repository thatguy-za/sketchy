#!/bin/sh
# Start as root only long enough to make the data directory writable, then run the server as the unprivileged "node" user.
# This is what makes bind mounts (./data:/data) and volumes created by an older setup work: they are often owned by root.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || echo "Warning: could not change the owner of $DATA_DIR (a read-only or network mount?)" >&2
  exec su-exec node "$@"
fi
exec "$@"
