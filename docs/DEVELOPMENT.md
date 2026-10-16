# Developing Sketchy

## Run from source

```bash
npm install
node server.js &    # optional: accounts and storage API on :8080 (run `npm run build` first for the static files)
npm run dev         # http://localhost:5173
```

Without `server.js` the app still works, but there are no accounts: saving downloads a file instead.

## Build the Docker image yourself

```bash
docker build -t sketchy .
docker run -d -p 8080:8080 -v sketchy-data:/data sketchy
```

The image works on x86-64 PCs, Raspberry Pi 4/5 (64-bit OS) and Apple silicon: the app is plain JavaScript and WebAssembly with no native modules, and the Node base image is multi-architecture. To build both architectures at once (needs Docker buildx):

```bash
./build-multiarch.sh                      # build amd64 + arm64
./build-multiarch.sh --push you/sketchy   # push one multi-arch image
```

## Releases

Publishing a GitHub release runs `.github/workflows/docker.yml`, which builds a `linux/amd64` + `linux/arm64` image and pushes it to GitHub Container Registry. Tags: the release version (for example `0.0.2` and `0.0`) and `latest`. Bump `version` in `package.json` when you cut a release.

## Layout

* `server.js` accounts, storage, version history and the static files; `mcp.js` the MCP endpoint
* `src/kernel.js` the modelling kernel (also runs in Node for MCP); `src/headless.js` replays a design without the UI
* `src/main.js` the app; `src/style.css` all styling (colours are CSS variables with a generated dark theme at the end of the file)
