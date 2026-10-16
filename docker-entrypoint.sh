#!/bin/sh
# Start as root only long enough to make the data directory writable, then run the server as an unprivileged user.
# PUID and PGID choose that user's ids (default 1000:1000, the "node" user). Set them to your own ids, from `id -u` and
# `id -g`, when /data is a folder on your computer, so the files in it belong to you.
set -e
DATA_DIR="${DATA_DIR:-/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
case "$PUID$PGID" in *[!0-9]*|'') echo "PUID and PGID must be numbers (got PUID=$PUID PGID=$PGID)" >&2; exit 1 ;; esac
if [ "$(id -u)" = "0" ]; then
  [ "$PUID" = "0" ] && echo "Warning: PUID=0 runs the server as root. Use your own user id instead." >&2
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || echo "Warning: could not change the owner of $DATA_DIR (a read-only or network mount?)" >&2
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@" # started with --user / user: already, so there is nothing to switch
