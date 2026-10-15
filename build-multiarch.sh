#!/usr/bin/env bash
# Build Sketchy for amd64 + arm64 (Raspberry Pi, Apple silicon, PCs).
#   ./build-multiarch.sh                       # build both, keep in the build cache
#   ./build-multiarch.sh --push you/sketchy    # build and push a multi-arch manifest
#   ./build-multiarch.sh --load                # build for this machine only and load it into Docker
set -euo pipefail
cd "$(dirname "$0")"
docker buildx version >/dev/null 2>&1 || { echo "Docker buildx is required (https://docs.docker.com/build/install-buildx/)"; exit 1; }
docker buildx inspect sketchy-builder >/dev/null 2>&1 || docker buildx create --name sketchy-builder --driver docker-container --use >/dev/null
docker buildx use sketchy-builder
case "${1:-}" in
  --push) docker buildx build --platform linux/amd64,linux/arm64 -t "${2:?image name, e.g. you/sketchy}:latest" --push . ;;
  --load) docker buildx build --load -t sketchy:dev . ;;
  *)      docker buildx build --platform linux/amd64,linux/arm64 -t sketchy:multiarch . ;;
esac
