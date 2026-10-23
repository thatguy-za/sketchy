# Running Sketchy on the internet

Sketchy is built to be self-hosted. The container serves plain HTTP, so **put it behind a reverse proxy that provides HTTPS** before exposing it. Never publish port 8080 to the internet directly.

## Minimum setup

1. **HTTPS reverse proxy.** Caddy is the shortest route (it gets certificates by itself):

   ```
   sketchy.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

   A Cloudflare Tunnel or Traefik works too. The proxy should pass `X-Forwarded-Proto` and the client address (`X-Forwarded-For` or `CF-Connecting-IP`). Caddy and Cloudflare do.
2. **Only the proxy reaches the container.** Bind the port to the loopback address in `docker-compose.yml`: `"127.0.0.1:8080:8080"`.
3. **Create the first account straight away.** On a fresh install whoever opens the page first becomes the administrator, so open it and sign up yourself before you share the address or publish the port. (If you prefer, create it from the command line instead: `docker exec sketchy node server.js create-user NAME --admin`.)
4. **Set `PUBLIC_URL`** to the address people type (`PUBLIC_URL=https://sketchy.example.com`). The server then answers only to that name and to localhost, which stops DNS-rebinding and forged-Host tricks. Without it, a public-looking name (anything like `sketchy.example.com`) is refused with status 421, while IP addresses, `localhost`, `.local` names and one-word names such as `nas` still work.
5. **Keep sign-up closed** (the default) unless you want strangers to have accounts.
6. **Update regularly:** `docker compose pull && docker compose up -d`.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `TRUST_PROXY` | trust private addresses | Set `false` if the container port is reachable directly. Forwarded addresses are then ignored, so a client can't pretend to be someone else to dodge limits. Leave it unset behind a proxy, or every visitor looks like the proxy. |
| `MAX_CACHE_MB` | `128` | Largest saved kernel cache the server keeps for one design (a gzip file the app writes next to a slow design so that opening it does not rebuild it from nothing). `0` keeps none. It counts toward the storage limit and is removed first when space runs short. |
| `BIN_DAYS` | `30` | How many days a deleted design waits in the recycle bin before it is removed for good. `0` turns the bin off (deleting is permanent). The bin counts toward the account's storage limit and is emptied first when a save would go over it. |
| `MAX_DESIGN_MB` | `64` | Largest single design (or draft) the server accepts. `0` turns the limit off. |
| `USER_QUOTA_MB` | `2048` | Starting value for the default storage per account (`0` = no limit). Admins change the default, and each person's own limit, under Server settings → Users. |
| `SESSION_DAYS` | `30` | How long a sign-in lasts without use (it renews whenever you open the app). |
| `SESSION_MAX_DAYS` | `90` | The longest any sign-in can last, however often it is used. |
| `MAX_SESSIONS_PER_USER` | `10` | Devices one person can be signed in on at once. The one unused longest is signed out. |
| `AUTH_ATTEMPTS_PER_15MIN` | `20` | Sign-in, sign-up, password and code attempts one address may make in 15 minutes. |
| `ALLOWED_HOSTS` | none | Extra host names the server answers to, comma-separated, without ports (for example a second domain or a LAN name when `PUBLIC_URL` is set). `*` switches the host check off. |
| `MAX_FEATURES` | `2000` | Most features one saved design may have. Also `MAX_PARAMS` (1000), `MAX_ARRAY_LENGTH` (100000 entries in one list), `MAX_NESTING` (24 levels), `MAX_PATTERN_COUNT` (10000 copies, rows, columns or turns) and `MAX_IMPORT_TRIANGLES` (2000000 across a design's imported meshes). `0` turns a limit off. |
| `BREACH_CHECK` | `false` | Starting value for "Refuse passwords found in known data breaches" (admins change it in Server settings, Security). |
| `IDLE_MINUTES` | `0` | Starting value for signing people out after this many minutes without use (`0` = never). Admins change it in Server settings, Security. |
| `PUBLIC_URL` | from the request | The public address (`https://sketchy.example.com`) that the sign-in metadata for assistants advertises. Set it if a proxy changes the host name. |
| `MCP_ALLOWED_ORIGINS` | none | Comma-separated browser origins (or `*`) allowed to call `/mcp` from a web page. By default no web page may; command-line and desktop assistants are unaffected. |
| `MCP_RATE_PER_MIN` | `60` | Calls per minute for one AI assistant token (one person's tokens together get twice this). |
| `MCP_WORKERS` | `2` | Worker threads that rebuild designs for assistants. |
| `MCP_TIMEOUT_SECONDS` | `20` | A request that runs longer is stopped. A design too heavy to build in one request is not lost work: the build is saved as it goes (see the saved kernel cache in REFERENCE.md), so the next attempt carries on from there. Only a single step longer than the limit (sewing a very large mesh, one huge boolean) needs this raised. |
| `MCP_WORKER_MEMORY_MB` | `512` | JavaScript memory a worker may use before it is stopped. The modelling kernel's WebAssembly memory is outside this limit; the time limit bounds it. |
| `ALLOW_MCP` | `true` | Whether AI assistants can connect. Admins can also switch this in Server settings. |

## What the server does for you

- Passwords are stored as salted scrypt hashes; sessions are random 256-bit tokens, stored only as hashes, in `HttpOnly`, `SameSite=Strict` cookies (`Secure` behind HTTPS).
- Repeated wrong passwords lock the address and the username out for a while (Server settings). Registration, sign-in and password changes are also rate limited per address, and so is every API and MCP request.
- **Two-step sign-in (optional, per person).** Anyone can turn on authenticator-app codes under Account → Security; they get 8 one-time recovery codes. A code works once, and wrong codes count toward the lock-out. Admins can switch it off for someone who lost their phone (Server settings → Users, or `docker exec sketchy node server.js reset-totp NAME`). The shared key is stored in `users.json`, so protect the `/data` volume.
- Passwords must be at least 8 characters and not obvious (for example `password` or the username).
- Changing a password signs out every other device. Admins can also **refuse passwords that appear in known data breaches** (Server settings, Security). That asks the Have I Been Pwned range service, sending only the first five characters of the password's SHA-1 hash, never the password; if the service is unreachable the password is accepted. It is off by default because a private server may have no internet access.
- **Idle sign-out (optional).** An admin can set a number of minutes after which a device that has not been used is signed out. It applies to browsers, not to connected AI assistants.
- **The server checks the Host of every request** against `PUBLIC_URL` and `ALLOWED_HOSTS`, plus localhost, so another website cannot reach it under a name it controls (DNS rebinding) and forged host names cannot end up in the addresses it advertises.
- **Saved designs are checked for structure, not just size.** The server refuses a design with too many features, absurd pattern counts, lists or nesting beyond the limits above, reserved keys such as `__proto__`, or an imported mesh whose data does not match its triangle count. The same check runs before an assistant is handed a design from disk, because assistants replay designs in workers.
- State-changing requests need a custom header, so other websites can't drive your session.
- A strict Content-Security-Policy allows scripts and styles from the server's own files only (no inline scripts, no `style` attributes or tags), forbids framing, and sends no referrer. This limits the damage if a malicious design file ever puts markup on the page.
- **AI assistants (MCP).** Tokens belong to one account, are shown once, and only their hash is kept. They are accepted only in the `Authorization` header, never in the address (addresses end up in logs and history). Assistants with a connector screen (Claude, ChatGPT) sign in with OAuth 2.1: dynamic registration for public clients only, authorization code with mandatory PKCE (S256), single-use codes that expire in 5 minutes, redirect addresses matched exactly against the registered ones, access tokens that last an hour, and refresh tokens that rotate (an old one used again ends the connection). Design names are checked before any file is touched, and every tool argument is validated against its schema with limits on size, nesting and field names.
- **Heavy designs can't stall the server.** Everything an assistant asks that rebuilds a design runs in a worker thread with a time and memory limit; a runaway rebuild is stopped and its worker replaced, and each person can have only a few running at once.
- **Misbehaving tokens are paused.** A token that keeps exceeding its rate limit, or keeps sending work that times out or runs out of memory, is paused after five strikes in ten minutes. Its owner sees "paused" under Account, then AI assistants, and can resume or revoke it.
- **Sessions.** Sign-ins last 30 days of inactivity and never more than 90 days. Each person sees their signed-in devices under Account, then Security, and can sign any of them out. Over HTTPS the cookie uses the `__Host-` prefix, so a sibling subdomain or insecure page can't plant it.
- Security events are written to the container log, one line each (`login_failed`, `registered`, `password_changed`, `mcp_auth_failed`, `rate_limited`...), so tools like fail2ban or Loki can act on them: `docker logs sketchy`.

## Things to know

- **A lock-out can be used against you.** Anyone who knows a username can lock that account for a few minutes by guessing wrong passwords. Admins can clear lock-outs in Server settings. This is the price of stopping password guessing that comes from many addresses.
- **Connecting an assistant means approving it.** Claude and ChatGPT register themselves (OAuth with PKCE) and send you to an approval page in Sketchy; anyone can register a client name, so the page shows the address you will be sent back to. Only approve a request you just started. Revoke connections and tokens you no longer use.
- **Two-step sign-in can't be made mandatory yet**, and there is no single sign-on. If you need either, put an authenticating proxy (Authelia, Cloudflare Access, Tailscale) in front. AI assistant tokens skip the second step by design.
- **Back up the `/data` volume.** It holds every design, account and token.

## Hardening the container further (optional, not covered by the project's tests)

```yaml
services:
  sketchy:
    security_opt: ["no-new-privileges:true"]
    read_only: true
    tmpfs: ["/tmp"]
```

## Reporting a problem

Open a private security advisory on the repository. Please don't post exploit details in a public issue.
