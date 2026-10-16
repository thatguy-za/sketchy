# Sketchy

**A lightweight, self-hosted 3D design app that is familiar to Fusion 360 users.**

Sketchy is focused on 3D design and 3D printing: sketches with constraints, a parametric timeline, named parameters, patterns, sweeps and lofts, version history, and an MCP server so AI assistants can build for you. It runs in your browser, saves to a machine you control, and is free and open source. It leaves out simulation, CAM, rendering and the rest of a full CAD suite to stay small and fast.

## Self hosting

You only need [Docker](https://docs.docker.com/get-started/get-docker/).

**1.** Create a folder with a file called `docker-compose.yml`:

```yaml
services:
  sketchy:
    image: ghcr.io/thatguy-za/sketchy:latest
    container_name: sketchy
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      ALLOW_REGISTRATION: "true"   # set to "false" once your users have signed up
    volumes:
      - sketchy-data:/data

volumes:
  sketchy-data:
```

**2.** Run `docker compose up -d`.

**3.** Open <http://localhost:8080> and create an account. The first account becomes the administrator.

* Update with `docker compose pull && docker compose up -d`. Your designs live in the `sketchy-data` volume and survive updates.
* Works on Intel/AMD and ARM (Raspberry Pi 4/5, Apple silicon). Other people on your network can use it too and only see their own designs.
* Sketchy serves plain HTTP, so put it behind HTTPS if you expose it to the internet. [Here's how](docs/HTTPS.md).
* Forgot your password? An administrator can reset it under your initial (top right) → *Server settings*, or run `docker exec -it sketchy node server.js reset-password YOUR_USERNAME`.
* Image pull denied? It is published privately for now: `echo TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin`, using a token with `read:packages`.

## Features

* **Modelling:** extrude, revolve, sweep, loft, coil, rib, hole, thread, fillet, chamfer, shell, press/pull, scale, split, combine, mirror and patterns (linear, circular, along a path, on a face)
* **Sketching:** lines, rectangles, circles, ellipses, slots, polygons, arcs, text, SVG and DXF import, dimensions and constraints
* **Parametric:** timeline you can edit, roll back and suppress; named parameters and expressions
* **3D printing:** STL import with automatic repair; STL, 3MF, OBJ and STEP export; build-volume overlay; volume and mass; section view
* **Assemblies:** joints, drive sliders, interference check
* **Accounts:** several users per server, version history you can restore, drafts that follow you between devices, tabs, dark mode
* **AI:** model from Claude, ChatGPT or any MCP assistant (below)

## Bring 3D modelling into your LLM

Connect Claude, ChatGPT or any MCP-capable assistant to Sketchy through our built-in MCP server, then describe what you want ("a 60×30×8 mm bracket with two 10 mm holes") and let it build the model in your account. It can create designs, add and edit features, set parameters, check the result and export an STL, and every change is saved as a version you can roll back.

1. Click your initial (top right) → **Account** → **AI assistants** → **Create token**.
2. Copy the setup snippet for your assistant and paste it in.

Web assistants like ChatGPT need Sketchy at a public `https` address: [set up HTTPS](docs/HTTPS.md) with Caddy or a Cloudflare Tunnel in a few minutes. See the [reference](docs/REFERENCE.md#ai-assistants-mcp) for the full tool list.

## Licence

Sketchy is released under the **[MIT licence](LICENSE)**. In plain terms, you can use it for free for personal or commercial work, change it, share it and self-host it for other people, as long as you keep the copyright and licence notice with it. It comes with no warranty.

**Your designs are yours.** Models you create, and the files you export, belong to you. Sketchy places no claim or restriction on them.

**Built on open-source software**, each under its own licence:

| Component | Used for | Licence |
|---|---|---|
| [manifold-3d](https://github.com/elalish/manifold) | The modelling kernel (booleans and solids) | Apache-2.0 |
| [three.js](https://threejs.org) | 3D display | MIT |
| [opentype.js](https://opentype.js.org) | Turning text into sketch outlines | MIT |
| [Roboto](https://fonts.google.com/specimen/Roboto) (via Fontsource) | The text tool's font | SIL Open Font Licence 1.1 |

If you redistribute Sketchy, keep these notices. Contributions are welcome and are accepted under the same MIT licence.
