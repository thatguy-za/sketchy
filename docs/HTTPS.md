# Make Sketchy reachable over HTTPS

You only need this if you want a **web-based assistant such as ChatGPT** to use Sketchy's MCP server. Those assistants call your server from their own servers, so Sketchy must be reachable from the internet at a public `https://` address.

Not needed for:
* Using Sketchy yourself in a browser on your own network.
* Claude Code or Claude Desktop running on the same machine or network. They can use `http://localhost:8080/mcp`.

Sketchy itself only speaks plain HTTP, so you put a small proxy in front of it. Pick one of the two options below.

| | Option 1: Caddy | Option 2: Cloudflare Tunnel |
|---|---|---|
| Best for | A server with a public IP | A home network behind a router |
| You need | A domain name, and ports 80 and 443 forwarded to the machine | A free Cloudflare account with a domain on it |
| Certificates | Free, automatic (Let's Encrypt) | Handled by Cloudflare |

Before you start, close sign-ups once your users exist (`ALLOW_REGISTRATION: "false"`), use strong passwords, and treat MCP tokens like passwords. Your Sketchy will be public.

## Option 1: Caddy

[Caddy](https://caddyserver.com) fetches and renews a certificate for your domain by itself.

1. Point a DNS record for your domain (for example `sketchy.example.com`) at your server's public IP, and forward ports **80** and **443** to it.
2. In your Sketchy folder, create a file called `.env`:

   ```
   DOMAIN=sketchy.example.com
   ```

3. Replace your `docker-compose.yml` with this (the only changes are the new `caddy` service, and Sketchy no longer publishes port 8080 itself):

   ```yaml
   services:
     sketchy:
       image: ghcr.io/thatguy-za/sketchy:latest
       container_name: sketchy
       restart: unless-stopped
       environment:
         ALLOW_REGISTRATION: "true"   # set to "false" once your users have signed up
       volumes:
         - sketchy-data:/data

     caddy:
       image: caddy:2
       restart: unless-stopped
       ports:
         - "80:80"
         - "443:443"
       command: caddy reverse-proxy --from ${DOMAIN} --to sketchy:8080
       volumes:
         - caddy-data:/data
         - caddy-config:/config

   volumes:
     sketchy-data:
     caddy-data:
     caddy-config:
   ```

4. Run `docker compose up -d`, then open `https://sketchy.example.com`.

Your MCP address is now `https://sketchy.example.com/mcp`.

## Option 2: Cloudflare Tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) makes an outbound connection from your machine to Cloudflare, so you do **not** open any ports or need a public IP.

1. In the Cloudflare dashboard go to **Zero Trust → Networks → Tunnels → Create a tunnel**, choose **Cloudflared**, and copy the **token** it shows you.
2. Add a **public hostname** to the tunnel: for example `sketchy.example.com`, with service type **HTTP** and URL `sketchy:8080`.
3. In your Sketchy folder, create a file called `.env`:

   ```
   TUNNEL_TOKEN=paste-your-token-here
   ```

4. Replace your `docker-compose.yml` with this (the only change is the new `cloudflared` service):

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

     cloudflared:
       image: cloudflare/cloudflared:latest
       restart: unless-stopped
       command: tunnel --no-autoupdate run
       environment:
         TUNNEL_TOKEN: ${TUNNEL_TOKEN}

   volumes:
     sketchy-data:
   ```

5. Run `docker compose up -d`, then open `https://sketchy.example.com`.

Your MCP address is now `https://sketchy.example.com/mcp`. To lock Sketchy to the tunnel only, remove the `ports:` section from the `sketchy` service.

**Just trying it out?** Skip steps 1 to 3 and change the `cloudflared` command to `tunnel --no-autoupdate --url http://sketchy:8080`. Run `docker compose logs cloudflared` and look for a temporary `https://....trycloudflare.com` address. It changes each time the container restarts, so don't use it long term.

## Connect your assistant

Once you can open Sketchy over `https`, click your initial (top right) → **Account** → **AI assistants**. The server URL shown there is now your public address. Create a token and copy the snippet for your assistant. For ChatGPT, use the URL-only form (`https://sketchy.example.com/mcp/<token>`).
