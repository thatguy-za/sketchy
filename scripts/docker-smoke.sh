#!/usr/bin/env bash
# Starts an image the way a person would and checks that it works: it must stay up, report "Sketchy on", serve the page, answer the API and
# refuse the MCP endpoint without a token. Used by the release workflow before an image is published, and runnable by hand:
#   docker build -t sketchy:smoke . && scripts/docker-smoke.sh sketchy:smoke
set -u
IMAGE="${1:?usage: docker-smoke.sh IMAGE}"
NAME="sketchy-smoke-$$"
PORT="${SMOKE_PORT:-18080}"
fail() { echo "SMOKE TEST FAILED: $1"; echo "---- container logs"; docker logs "$NAME" 2>&1 | tail -40; docker rm -f "$NAME" >/dev/null 2>&1; exit 1; }

docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" -p "$PORT:8080" -e ADMIN_USER=smoke -e ADMIN_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)" "$IMAGE" >/dev/null || fail "the container could not be created"

up=0
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ] || fail "the container stopped"
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/me"; then up=1; break; fi
  sleep 1
done
[ "$up" = 1 ] || fail "the server did not answer within 60 seconds"

docker logs "$NAME" 2>&1 | grep -q "Sketchy on" || fail "the log never says the server started"
docker logs "$NAME" 2>&1 | grep -qiE "Error \[ERR_|Cannot find module|Uncaught|SyntaxError" && fail "the log shows an error"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/");                       [ "$code" = 200 ] || fail "GET / answered $code, not 200"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/me");                 [ "$code" = 200 ] || fail "GET /api/me answered $code, not 200"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PORT/mcp"); { [ "$code" = 401 ] || [ "$code" = 403 ]; } || fail "POST /mcp without a token answered $code, not 401 or 403"
# the assistant worker is started on the first request that needs it: an unauthenticated call does not reach it, so check that its files are there
for f in mcp-defs.js mcp-tools.js mcp-worker.js mcp-pool.js mcp.js mcp-validate.js design-validate.js oauth.js server.js package.json; do
  docker exec "$NAME" test -f "/app/$f" || fail "/app/$f is missing from the image"
done
[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = "true" ] || fail "the container stopped while it was being checked"
docker rm -f "$NAME" >/dev/null 2>&1
echo "smoke test passed: $IMAGE starts, serves the page and the API, and refuses MCP without a token"
