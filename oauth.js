// OAuth 2.1 for the MCP endpoint, so assistants that offer "Add custom connector" (Claude, ChatGPT) can connect the normal way:
// they discover this server from /mcp, register themselves, send the person here to sign in and approve, and receive a token.
//   /.well-known/oauth-protected-resource   what /mcp is protected by
//   /.well-known/oauth-authorization-server where to register, authorize and get tokens
//   POST /oauth/register                    dynamic client registration (public clients only)
//   /oauth/authorize                        the approval page (served by the app; it calls /api/oauth/*)
//   POST /oauth/token                       code + PKCE (S256) -> access token and refresh token; refresh token -> new pair
// An approved connection is an ordinary MCP token (listed under Account, revocable, rate limited, pausable), marked as an app.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const ACCESS_MS = 60 * 60e3;          // access tokens last an hour; the app refreshes them
const REFRESH_MS = 30 * 24 * 3600e3;  // refresh tokens last 30 days of use
const CODE_MS = 5 * 60e3;
const MAX_CLIENTS = 1000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const redirectOk = (u) => {
  try { const x = new URL(u); return u.length <= 400 && !x.hash && (x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname))); } catch { return false; }
};
const cleanName = (n) => String(n || 'An assistant').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || 'An assistant';

export async function createOAuth(d) {
  // d: { dataDir, mcpTokens, saveMcp, users, send, readBody, readJSONBody, rate, log, sha, clientIp, isHttps, publicUrl }
  const file = `${d.dataDir}/oauth-clients.json`;
  let clients = Object.assign(Object.create(null), JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}')));
  const save = async () => { await fs.writeFile(file + '.tmp', JSON.stringify(clients), { mode: 0o600 }); await fs.rename(file + '.tmp', file); };
  const codes = new Map(); // sha(code) -> { client, user, redirect, challenge, exp }

  const base = (req) => d.publicUrl || `${d.isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
  const oerr = (res, status, error, description) => { res.setHeader('cache-control', 'no-store'); return d.send(res, status, { error, error_description: description }); };
  const parseForm = async (req) => {
    const raw = (await d.readBody(req, 16384)).toString();
    if ((req.headers['content-type'] || '').includes('json')) return JSON.parse(raw);
    return Object.fromEntries(new URLSearchParams(raw));
  };

  /** Metadata and registration/token endpoints (no sign-in cookie involved). Returns true when it handled the request. */
  async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') {
      res.setHeader('access-control-allow-origin', '*');
      d.send(res, 200, { resource: base(req) + '/mcp', authorization_servers: [base(req)], bearer_methods_supported: ['header'], resource_name: 'Sketchy' });
      return true;
    }
    if (p === '/.well-known/oauth-authorization-server') {
      const b = base(req);
      res.setHeader('access-control-allow-origin', '*');
      d.send(res, 200, { issuer: b, authorization_endpoint: b + '/oauth/authorize', token_endpoint: b + '/oauth/token', registration_endpoint: b + '/oauth/register',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'] });
      return true;
    }
    if (p === '/oauth/register') {
      if (req.method !== 'POST') { d.send(res, 405, {}); return true; }
      const ip = d.clientIp(req);
      if (d.rate('oauthreg:' + ip, 20, 3600e3)) { oerr(res, 429, 'temporarily_unavailable', 'Too many registrations. Try again later.'); return true; }
      let b; try { b = await parseForm(req); } catch { oerr(res, 400, 'invalid_client_metadata', 'Send JSON.'); return true; }
      const uris = Array.isArray(b?.redirect_uris) ? b.redirect_uris : [];
      if (!uris.length || uris.length > 5 || !uris.every((u) => typeof u === 'string' && redirectOk(u))) { oerr(res, 400, 'invalid_redirect_uri', 'redirect_uris must be 1 to 5 https addresses (or http on localhost).'); return true; }
      const id = 'skc_' + b64u(crypto.randomBytes(18));
      clients[id] = { name: cleanName(b.client_name), redirectUris: uris, created: Date.now() };
      const ids = Object.keys(clients);
      if (ids.length > MAX_CLIENTS) for (const k of ids.sort((a, c) => clients[a].created - clients[c].created).slice(0, ids.length - MAX_CLIENTS)) delete clients[k];
      await save();
      d.log('oauth_client_registered', ip, `name=${JSON.stringify(clients[id].name)}`);
      res.setHeader('cache-control', 'no-store');
      d.send(res, 201, { client_id: id, client_name: clients[id].name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', client_id_issued_at: Math.floor(clients[id].created / 1000) });
      return true;
    }
    if (p === '/oauth/token') {
      if (req.method !== 'POST') { d.send(res, 405, {}); return true; }
      const ip = d.clientIp(req);
      if (d.rate('oauthtok:' + ip, 60, 60e3)) { oerr(res, 429, 'temporarily_unavailable', 'Too many requests.'); return true; }
      let b; try { b = await parseForm(req); } catch { oerr(res, 400, 'invalid_request', 'Could not read the request.'); return true; }
      if (b.grant_type === 'authorization_code') await exchangeCode(req, res, b, ip);
      else if (b.grant_type === 'refresh_token') await refresh(res, b, ip);
      else oerr(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
      return true;
    }
    return false;
  }

  const issue = (ent, res) => {
    const access = 'skm_' + b64u(crypto.randomBytes(32)), refreshTok = 'skr_' + b64u(crypto.randomBytes(32));
    ent.prevRefreshHash = ent.oauth.refreshHash; // kept so a refresh token used twice (a sign it leaked) is noticed
    ent.hash = d.sha(access); ent.oauth.refreshHash = d.sha(refreshTok); ent.oauth.accessExp = Date.now() + ACCESS_MS; ent.oauth.refreshExp = Date.now() + REFRESH_MS;
    res.setHeader('cache-control', 'no-store'); res.setHeader('pragma', 'no-cache');
    d.send(res, 200, { access_token: access, token_type: 'Bearer', expires_in: ACCESS_MS / 1000, refresh_token: refreshTok, scope: 'mcp' });
  };

  async function exchangeCode(req, res, b, ip) {
    const rec = codes.get(d.sha(String(b.code || '')));
    codes.delete(d.sha(String(b.code || ''))); // a code works once, whatever happens next
    if (!rec || rec.exp < Date.now()) return oerr(res, 400, 'invalid_grant', 'The code is invalid or expired.');
    if (b.client_id !== rec.client || b.redirect_uri !== rec.redirect) return oerr(res, 400, 'invalid_grant', 'The client or redirect address does not match.');
    const challenge = b64u(crypto.createHash('sha256').update(String(b.code_verifier || '')).digest());
    if (!b.code_verifier || String(b.code_verifier).length < 43 || String(b.code_verifier).length > 128 || challenge !== rec.challenge) return oerr(res, 400, 'invalid_grant', 'The PKCE verifier is wrong.');
    if (!d.users[rec.user]) return oerr(res, 400, 'invalid_grant', 'That account no longer exists.');
    const id = crypto.randomUUID();
    const ent = d.mcpTokens[id] = { hash: '', user: rec.user, name: `${clients[rec.client]?.name || 'App'} (connected app)`, created: Date.now(), lastUsed: 0, oauth: { clientId: rec.client, refreshHash: '', accessExp: 0, refreshExp: 0 } };
    issue(ent, res);
    await d.saveMcp();
    d.log('oauth_connected', ip, `user=${rec.user} client=${JSON.stringify(ent.name)}`);
  }

  async function refresh(res, b, ip) {
    const h = d.sha(String(b.refresh_token || ''));
    const id = Object.keys(d.mcpTokens).find((k) => d.mcpTokens[k].oauth && (d.mcpTokens[k].oauth.refreshHash === h || d.mcpTokens[k].prevRefreshHash === h));
    const ent = id && d.mcpTokens[id];
    if (!ent) return oerr(res, 400, 'invalid_grant', 'The refresh token is invalid.');
    if (ent.oauth.refreshHash !== h) { // an old refresh token came back: someone kept a copy. End the whole connection.
      delete d.mcpTokens[id]; await d.saveMcp(); d.log('oauth_refresh_reuse', ip, `user=${ent.user}`);
      return oerr(res, 400, 'invalid_grant', 'The refresh token was already used. Connect again.');
    }
    if (ent.oauth.refreshExp < Date.now() || !d.users[ent.user]) { delete d.mcpTokens[id]; await d.saveMcp(); return oerr(res, 400, 'invalid_grant', 'The connection expired. Connect again.'); }
    if (b.client_id && b.client_id !== ent.oauth.clientId) return oerr(res, 400, 'invalid_grant', 'The client does not match.');
    issue(ent, res);
    await d.saveMcp();
  }

  /** The two calls the approval page makes (signed in, with the CSRF header). Returns the JSON to send, or null for "not mine". */
  async function api(req, res, url, user) {
    const p = url.pathname;
    if (p === '/api/oauth/client' && req.method === 'GET') {
      const c = clients[url.searchParams.get('client_id') || ''];
      const uri = url.searchParams.get('redirect_uri') || '';
      if (!c || !c.redirectUris.includes(uri)) return d.send(res, 400, { error: 'This connection request is not valid. Start again from the assistant.' }), true;
      return d.send(res, 200, { name: c.name, host: new URL(uri).host }), true;
    }
    if (p === '/api/oauth/approve' && req.method === 'POST') {
      const b = await d.readJSONBody(req, 4096);
      const c = clients[b?.client_id || ''];
      if (!c || !c.redirectUris.includes(b.redirect_uri) || !b.code_challenge || b.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(b.code_challenge)) return d.send(res, 400, { error: 'This connection request is not valid. Start again from the assistant.' }), true;
      const target = new URL(b.redirect_uri);
      if (b.deny) target.searchParams.set('error', 'access_denied');
      else {
        const code = b64u(crypto.randomBytes(32));
        for (const [k, v] of codes) if (v.exp < Date.now()) codes.delete(k);
        if (codes.size > 5000) codes.clear();
        codes.set(d.sha(code), { client: b.client_id, user, redirect: b.redirect_uri, challenge: b.code_challenge, exp: Date.now() + CODE_MS });
        target.searchParams.set('code', code);
      }
      if (typeof b.state === 'string' && b.state.length <= 500) target.searchParams.set('state', b.state);
      d.log(b.deny ? 'oauth_denied' : 'oauth_approved', d.clientIp(req), `user=${user} client=${JSON.stringify(c.name)}`);
      return d.send(res, 200, { redirect: target.toString() }), true;
    }
    return false;
  }

  /** Is this bearer token one made by OAuth that has run out? (An expired app token is refused so the app refreshes it.) */
  const expired = (ent) => !!ent.oauth && ent.oauth.accessExp < Date.now();
  return { handle, api, expired, base };
}
