# Developing Sketchy

## Run from source

```bash
npm install
npm run dev     # http://localhost:5173
```

`npm run dev` starts the same two pieces the Docker image runs: `server.js` (accounts, saved designs and folders, version history, the MCP endpoint) on port 8080, and the app with hot reload on port 5173, proxying `/api` and `/mcp` to the server. The first account you create becomes the administrator, exactly as in the container. Designs are stored in `./data` (git-ignored), the way the container keeps them in its `/data` volume. Set `PORT` or `DATA_DIR` to change either.

To check the production build the way the container serves it (one server, built files, no hot reload):

```bash
npm start       # builds, then serves everything on http://localhost:8080
```

`npm run app` starts only the front end, with no storage, and is not a supported way to run Sketchy.

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

* `server.js` accounts, storage, version history and the static files; `mcp.js` the MCP endpoint and `mcp-defs.js` its tools, prompts and instructions (generated from `src/features.js` and `src/sketch-schema.js`); `mcp-tools.js` the tool implementations; `src/queries.js` face and edge queries; `src/render-sw.js` the software renderer behind `render_view`; `src/assistant.js` the in-app side (live stream, Stop chip, request box)
* `src/kernel.js` the shared geometry helpers and the `rebuild` entry point (also runs in Node for MCP); `src/backend-brep.js` the kernel itself (OpenCascade via replicad), `src/featurespec.js` feature rules, `src/sketch-brep.js` sketch regions, `src/sew.js` and `src/meshtools.js` imported meshes; `src/headless.js` replays a design without the UI
* `src/main.js` the app; `src/style.css` all styling (colours are CSS variables with a generated dark theme at the end of the file)
