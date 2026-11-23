/**
 * Media Sosial Sender — Cloudflare Worker API
 *
 * - Log masuk pemilik (APP_PASSWORD) -> token sesi bertandatangan
 * - Segerak data aplikasi (profil, hashtag, draf) dalam D1
 * - OAuth: Google (YouTube), Meta (Facebook Page + Instagram), Threads
 * - Muat naik video/thumbnail ke R2 (multipart, sesuai untuk fail besar)
 * - Cron setiap minit: siarkan hantaran yang tiba masanya ke setiap platform
 */

const PLATFORMS = ['yt', 'fb', 'ig', 'threads'];
const PLATFORM_NAMES = { yt: 'YouTube Shorts', fb: 'Facebook', ig: 'Instagram', threads: 'Threads' };

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly'
].join(' ');
const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'business_management',
  'instagram_basic',
  'instagram_content_publish'
].join(',');
const THREADS_SCOPES = 'threads_basic,threads_content_publish';

const SESSION_TTL = 30 * 24 * 3600;     // 30 hari
const STATE_TTL = 15 * 60;              // 15 minit untuk aliran OAuth
const MEDIA_URL_TTL = 12 * 3600;        // pautan video untuk Meta sah 12 jam
const CHECK_INTERVAL = 60 * 1000;       // semak status pemprosesan IG/Threads setiap minit
const MAX_WAIT = 2 * 3600 * 1000;       // gagal jika platform masih memproses selepas 2 jam
const MAX_ATTEMPTS = 3;

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (err) {
      const status = err.httpStatus || 500;
      if (status >= 500) console.error(err);
      return json(req, env, { error: err.message || String(err) }, status);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDueJobs(env));
  }
};

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, env) });

  if (path === '/' && method === 'GET') {
    return json(req, env, { ok: true, app: 'media-sosial-sender-api' });
  }

  // Public routes
  if (path === '/api/login' && method === 'POST') return login(req, env);
  if (path.startsWith('/oauth/callback/') && method === 'GET') return oauthCallback(req, env, path.split('/').pop(), url);
  if (path.startsWith('/media/') && (method === 'GET' || method === 'HEAD')) return serveMedia(req, env, url);

  // Authenticated API
  if (!path.startsWith('/api/')) throw httpError(404, 'Tidak dijumpai');
  await requireAuth(req, env);

  if (path === '/api/me' && method === 'GET') {
    return json(req, env, {
      ok: true,
      configured: {
        yt: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
        fb: !!(env.META_APP_ID && env.META_APP_SECRET),
        ig: !!(env.META_APP_ID && env.META_APP_SECRET),
        threads: !!(env.THREADS_APP_ID && env.THREADS_APP_SECRET)
      }
    });
  }

  if (path === '/api/state' && method === 'GET') {
    const row = await env.DB.prepare('SELECT json, updated_at FROM app_state WHERE id = ?').bind('main').first();
    return json(req, env, { state: row ? JSON.parse(row.json) : null, updatedAt: row ? row.updated_at : null });
  }
  if (path === '/api/state' && method === 'PUT') {
    const body = await readJson(req);
    if (!body || typeof body.state !== 'object' || !body.state) throw httpError(400, 'state diperlukan');
    const text = JSON.stringify(body.state);
    if (text.length > 900_000) throw httpError(413, 'Data terlalu besar');
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO app_state (id, json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET json = ?2, updated_at = ?3'
    ).bind('main', text, now).run();
    return json(req, env, { ok: true, updatedAt: now });
  }

  if (path === '/api/connections' && method === 'GET') return listConnections(req, env);
  if (path === '/api/connections' && method === 'DELETE') return deleteConnection(req, env);
  if (path === '/api/connections/select' && method === 'POST') return selectMetaPage(req, env);
  if (path === '/api/oauth/start' && method === 'POST') return oauthStart(req, env);

  if (path === '/api/media/create' && method === 'POST') return mediaCreate(req, env);
  if (path === '/api/media/part' && method === 'PUT') return mediaPart(req, env, url);
  if (path === '/api/media/complete' && method === 'POST') return mediaComplete(req, env);
  if (path === '/api/media/abort' && method === 'POST') return mediaAbort(req, env);

  if (path === '/api/posts' && method === 'POST') return createPost(req, env);
  if (path === '/api/posts' && method === 'GET') return listPosts(req, env);
  let m = path.match(/^\/api\/posts\/([\w-]+)$/);
  if (m && method === 'DELETE') return cancelPost(req, env, m[1]);
  m = path.match(/^\/api\/jobs\/([\w-]+)\/retry$/);
  if (m && method === 'POST') return retryJob(req, env, m[1]);

  if (path === '/api/run-due' && method === 'POST') {
    const summary = await runDueJobs(env);
    return json(req, env, { ok: true, ...summary });
  }

  throw httpError(404, 'Tidak dijumpai');
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const h = { Vary: 'Origin' };
  const list = allowedOrigins(env);
  if (origin && (list.includes(origin) || list.includes('*'))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(req, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req, env) }
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    throw httpError(400, 'JSON tidak sah');
  }
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/* ------------------------------------------------------------------ */
/* Crypto: signing, encryption                                         */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function requireSecret(env, name) {
  if (!env[name]) throw httpError(500, `Rahsia ${name} belum ditetapkan pada Worker`);
  return env[name];
}

const keyCache = new Map();

async function hmacKey(env) {
  const secret = requireSecret(env, 'SESSION_SECRET');
  const cacheKey = 'h:' + secret;
  if (!keyCache.has(cacheKey)) {
    keyCache.set(cacheKey, await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
  return keyCache.get(cacheKey);
}

async function aesKey(env) {
  const secret = requireSecret(env, 'ENC_KEY');
  const cacheKey = 'a:' + secret;
  if (!keyCache.has(cacheKey)) {
    const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret));
    keyCache.set(cacheKey, await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
  }
  return keyCache.get(cacheKey);
}

async function hmac(env, text) {
  return b64urlEncode(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(text)));
}

async function signToken(env, payload, ttlSec) {
  const body = b64urlEncode(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })));
  return `${body}.${await hmac(env, body)}`;
}

async function verifyToken(env, token, expectedTyp) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), b64urlDecode(sig), enc.encode(body));
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now() / 1000) return null;
  if (expectedTyp && payload.typ !== expectedTyp) return null;
  return payload;
}

async function encrypt(env, text) {
  if (text == null) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(String(text)));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return b64urlEncode(out);
}

async function decrypt(env, data) {
  if (!data) return null;
  const raw = b64urlDecode(data);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(env), raw.slice(12));
  return dec.decode(pt);
}

async function safeEqual(env, a, b) {
  // Compare HMACs so timing does not leak the password
  return (await hmac(env, 'pw:' + a)) === (await hmac(env, 'pw:' + b));
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

async function login(req, env) {
  const body = await readJson(req);
  const expected = requireSecret(env, 'APP_PASSWORD');
  if (!body || typeof body.password !== 'string' || !(await safeEqual(env, body.password, expected))) {
    await new Promise(r => setTimeout(r, 600));
    throw httpError(401, 'Kata laluan salah');
  }
  const token = await signToken(env, { typ: 'session', sub: 'owner' }, SESSION_TTL);
  return json(req, env, { token, expiresIn: SESSION_TTL });
}

async function requireAuth(req, env) {
  const h = req.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const payload = await verifyToken(env, token, 'session');
  if (!payload) throw httpError(401, 'Sesi tamat atau tidak sah. Sila log masuk semula.');
  return payload;
}

/* ------------------------------------------------------------------ */
/* External API helpers                                                */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

async function callApi(label, url, init = {}) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new ApiError(`${label}: rangkaian gagal (${e.message})`, { retryable: true });
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok || (data && data.error && typeof data.error === 'object')) {
    const err = data && data.error;
    const msg = (err && (err.error_user_msg || err.message)) || (typeof err === 'string' ? `${err}${data.error_description ? ': ' + data.error_description : ''}` : '') || (data && data.raw) || `HTTP ${res.status}`;
    const retryable = res.status >= 500 || res.status === 429 || (err && (err.is_transient || err.code === 2 || err.code === 4 || err.code === 17));
    throw new ApiError(`${label}: ${String(msg).slice(0, 400)}`, { retryable: !!retryable, status: res.status });
  }
  return data;
}

function form(params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v));
  return body;
}

function postForm(label, url, params) {
  return callApi(label, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params)
  });
}

function graphBase(env) {
  return `https://graph.facebook.com/${env.GRAPH_VERSION || 'v23.0'}`;
}

function publicUrl(env) {
  const u = String(env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (!u || u.includes('GANTI')) throw httpError(500, 'PUBLIC_URL belum ditetapkan dalam wrangler.toml');
  return u;
}

function redirectUri(env, provider) {
  return `${publicUrl(env)}/oauth/callback/${provider}`;
}

/* ------------------------------------------------------------------ */
/* Connections & OAuth                                                 */
/* ------------------------------------------------------------------ */

function providerFor(platform) {
  if (platform === 'yt') return 'google';
  if (platform === 'fb' || platform === 'ig') return 'meta';
  if (platform === 'threads') return 'threads';
  throw httpError(400, 'Platform tidak sah');
}

function validReturnUrl(env, returnUrl) {
  let u;
  try {
    u = new URL(returnUrl);
  } catch {
    throw httpError(400, 'returnUrl tidak sah');
  }
  const list = allowedOrigins(env);
  if (!list.includes(u.origin) && !(list.includes('*') && u.protocol === 'https:')) {
    throw httpError(400, `Asal ${u.origin} tiada dalam ALLOWED_ORIGINS`);
  }
  u.hash = '';
  return u.toString();
}

async function oauthStart(req, env) {
  const body = await readJson(req);
  const platform = body && body.platform;
  const profileId = body && String(body.profileId || '');
  if (!PLATFORMS.includes(platform)) throw httpError(400, 'Platform tidak sah');
  if (!profileId || profileId.length > 100) throw httpError(400, 'profileId diperlukan');
  const returnUrl = validReturnUrl(env, body.returnUrl);
  const provider = providerFor(platform);
  const state = await signToken(env, { typ: 'oauth', platform, profileId, returnUrl, nonce: crypto.randomUUID() }, STATE_TTL);

  let url;
  if (provider === 'google') {
    const q = new URLSearchParams({
      client_id: requireSecret(env, 'GOOGLE_CLIENT_ID'),
      redirect_uri: redirectUri(env, 'google'),
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      state
    });
    url = `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  } else if (provider === 'meta') {
    const q = new URLSearchParams({
      client_id: requireSecret(env, 'META_APP_ID'),
      redirect_uri: redirectUri(env, 'meta'),
      response_type: 'code',
      scope: META_SCOPES,
      state
    });
    url = `https://www.facebook.com/${env.GRAPH_VERSION || 'v23.0'}/dialog/oauth?${q}`;
  } else {
    const q = new URLSearchParams({
      client_id: requireSecret(env, 'THREADS_APP_ID'),
      redirect_uri: redirectUri(env, 'threads'),
      response_type: 'code',
      scope: THREADS_SCOPES,
      state
    });
    url = `https://threads.net/oauth/authorize?${q}`;
  }
  return json(req, env, { url });
}

function backTo(returnUrl, params) {
  const hash = new URLSearchParams(params).toString();
  return Response.redirect(`${returnUrl}#${hash}`, 302);
}

async function oauthCallback(req, env, provider, url) {
  const state = await verifyToken(env, url.searchParams.get('state') || '', 'oauth');
  if (!state) return new Response('Pautan log masuk tamat tempoh. Sila cuba sambung semula dari aplikasi.', { status: 400 });
  const { platform, profileId, returnUrl } = state;
  if (providerFor(platform) !== provider) return new Response('Penyedia tidak sepadan', { status: 400 });

  const errParam = url.searchParams.get('error_description') || url.searchParams.get('error_message') || url.searchParams.get('error');
  if (errParam) return backTo(returnUrl, { cloud_error: `${PLATFORM_NAMES[platform]}: ${errParam}`, platform });
  const code = url.searchParams.get('code');
  if (!code) return backTo(returnUrl, { cloud_error: 'Tiada kod kebenaran diterima', platform });

  try {
    let extra = {};
    if (provider === 'google') await finishGoogle(env, profileId, code);
    else if (provider === 'meta') extra = await finishMeta(env, profileId, platform, code);
    else await finishThreads(env, profileId, code);
    return backTo(returnUrl, { cloud: 'connected', platform, ...extra });
  } catch (e) {
    console.error(e);
    return backTo(returnUrl, { cloud_error: e.message || String(e), platform });
  }
}

async function saveConnection(env, profileId, platform, data) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO connections (profile_id, platform, status, account_id, account_name, token_enc, refresh_enc, expires_at, extra_enc, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(profile_id, platform) DO UPDATE SET
       status = ?3, account_id = ?4, account_name = ?5, token_enc = ?6,
       refresh_enc = COALESCE(?7, connections.refresh_enc), expires_at = ?8, extra_enc = ?9, updated_at = ?10`
  ).bind(
    profileId,
    platform,
    data.status || 'connected',
    data.accountId || null,
    data.accountName || null,
    await encrypt(env, data.token),
    data.refresh ? await encrypt(env, data.refresh) : null,
    data.expiresAt || null,
    data.extra ? await encrypt(env, JSON.stringify(data.extra)) : null,
    now
  ).run();
}

async function getConnection(env, profileId, platform) {
  const row = await env.DB.prepare('SELECT * FROM connections WHERE profile_id = ? AND platform = ?').bind(profileId, platform).first();
  if (!row) return null;
  return {
    ...row,
    token: await decrypt(env, row.token_enc),
    refresh: await decrypt(env, row.refresh_enc),
    extra: row.extra_enc ? JSON.parse(await decrypt(env, row.extra_enc)) : null
  };
}

async function finishGoogle(env, profileId, code) {
  const tok = await postForm('Google', 'https://oauth2.googleapis.com/token', {
    code,
    client_id: requireSecret(env, 'GOOGLE_CLIENT_ID'),
    client_secret: requireSecret(env, 'GOOGLE_CLIENT_SECRET'),
    redirect_uri: redirectUri(env, 'google'),
    grant_type: 'authorization_code'
  });
  const ch = await callApi('YouTube', 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${tok.access_token}` }
  });
  const item = ch.items && ch.items[0];
  if (!item) throw new Error('Akaun Google ini tiada saluran YouTube.');
  await saveConnection(env, profileId, 'yt', {
    accountId: item.id,
    accountName: item.snippet.customUrl || item.snippet.title,
    token: tok.access_token,
    refresh: tok.refresh_token || null,
    expiresAt: Date.now() + (tok.expires_in || 3600) * 1000
  });
}

async function finishMeta(env, profileId, platform, code) {
  const g = graphBase(env);
  const appId = requireSecret(env, 'META_APP_ID');
  const secret = requireSecret(env, 'META_APP_SECRET');
  const short = await callApi('Meta', `${g}/oauth/access_token?${new URLSearchParams({
    client_id: appId, client_secret: secret, redirect_uri: redirectUri(env, 'meta'), code
  })}`);
  const long = await callApi('Meta', `${g}/oauth/access_token?${new URLSearchParams({
    grant_type: 'fb_exchange_token', client_id: appId, client_secret: secret, fb_exchange_token: short.access_token
  })}`);
  const pages = await callApi('Facebook', `${g}/me/accounts?${new URLSearchParams({
    fields: 'id,name,access_token,instagram_business_account{id,username}',
    limit: '100',
    access_token: long.access_token
  })}`);
  const options = (pages.data || []).map(p => ({
    id: p.id,
    name: p.name,
    token: p.access_token,
    igId: p.instagram_business_account ? p.instagram_business_account.id : null,
    igUsername: p.instagram_business_account ? p.instagram_business_account.username : null
  }));
  if (options.length === 0) {
    throw new Error('Tiada Facebook Page ditemui. Instagram & Facebook memerlukan Page (dan IG Business/Creator yang dipautkan).');
  }
  if (options.length === 1) {
    const igLinked = await applyMetaOption(env, profileId, options[0]);
    if (platform === 'ig' && !igLinked) return { cloud_warn: `Page "${options[0].name}" tiada akaun Instagram Business/Creator dipautkan.` };
    return {};
  }
  // Several pages: user picks one in the app
  await saveConnection(env, profileId, 'fb', {
    status: 'select',
    accountName: null,
    token: null,
    extra: { options }
  });
  return { cloud_select: '1' };
}

async function applyMetaOption(env, profileId, opt) {
  await saveConnection(env, profileId, 'fb', { accountId: opt.id, accountName: opt.name, token: opt.token });
  if (opt.igId) {
    await saveConnection(env, profileId, 'ig', {
      accountId: opt.igId,
      accountName: opt.igUsername ? `@${opt.igUsername}` : opt.name,
      token: opt.token,
      extra: { pageId: opt.id }
    });
    return true;
  }
  return false;
}

async function selectMetaPage(req, env) {
  const body = await readJson(req);
  const profileId = String((body && body.profileId) || '');
  const conn = await getConnection(env, profileId, 'fb');
  if (!conn || conn.status !== 'select' || !conn.extra) throw httpError(400, 'Tiada pilihan Page untuk profil ini');
  const opt = conn.extra.options.find(o => o.id === String(body.optionId));
  if (!opt) throw httpError(400, 'Page tidak sah');
  const igLinked = await applyMetaOption(env, profileId, opt);
  return json(req, env, { ok: true, igLinked });
}

async function finishThreads(env, profileId, code) {
  const appId = requireSecret(env, 'THREADS_APP_ID');
  const secret = requireSecret(env, 'THREADS_APP_SECRET');
  const short = await postForm('Threads', 'https://graph.threads.net/oauth/access_token', {
    client_id: appId,
    client_secret: secret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(env, 'threads'),
    code
  });
  const long = await callApi('Threads', `https://graph.threads.net/access_token?${new URLSearchParams({
    grant_type: 'th_exchange_token', client_secret: secret, access_token: short.access_token
  })}`);
  const me = await callApi('Threads', `https://graph.threads.net/v1.0/me?${new URLSearchParams({
    fields: 'id,username', access_token: long.access_token
  })}`);
  await saveConnection(env, profileId, 'threads', {
    accountId: me.id,
    accountName: me.username ? `@${me.username}` : me.id,
    token: long.access_token,
    expiresAt: Date.now() + (long.expires_in || 60 * 24 * 3600) * 1000
  });
}

async function listConnections(req, env) {
  const { results } = await env.DB.prepare('SELECT * FROM connections').all();
  const out = [];
  for (const row of results) {
    const item = {
      profileId: row.profile_id,
      platform: row.platform,
      status: row.status,
      accountId: row.account_id,
      accountName: row.account_name,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at
    };
    if (row.status === 'select' && row.extra_enc) {
      const extra = JSON.parse(await decrypt(env, row.extra_enc));
      item.options = extra.options.map(o => ({ id: o.id, name: o.name, igUsername: o.igUsername }));
    }
    out.push(item);
  }
  return json(req, env, { connections: out });
}

async function deleteConnection(req, env) {
  const body = await readJson(req);
  const profileId = String((body && body.profileId) || '');
  const platform = body && body.platform;
  if (!PLATFORMS.includes(platform)) throw httpError(400, 'Platform tidak sah');
  await env.DB.prepare('DELETE FROM connections WHERE profile_id = ? AND platform = ?').bind(profileId, platform).run();
  await env.DB.prepare(
    `UPDATE jobs SET status = 'cancelled', error = 'Akaun diputuskan', updated_at = ?3
     WHERE profile_id = ?1 AND platform = ?2 AND status IN ('pending', 'waiting')`
  ).bind(profileId, platform, Date.now()).run();
  return json(req, env, { ok: true });
}

/* ------------------------------------------------------------------ */
/* Media (R2)                                                          */
/* ------------------------------------------------------------------ */

function safeName(name) {
  return String(name || 'fail').normalize('NFKD').replace(/[^\w.\-]+/g, '_').slice(-80) || 'fail';
}

async function mediaCreate(req, env) {
  const body = await readJson(req);
  const kind = body && body.kind === 'thumb' ? 'thumb' : 'video';
  const type = String((body && body.type) || '');
  if (kind === 'video' && !type.startsWith('video/')) throw httpError(400, 'Jenis fail video tidak sah');
  if (kind === 'thumb' && !type.startsWith('image/')) throw httpError(400, 'Jenis fail imej tidak sah');
  const key = `${kind}/${crypto.randomUUID()}-${safeName(body.name)}`;
  const mpu = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: type } });
  return json(req, env, { key: mpu.key, uploadId: mpu.uploadId });
}

function checkMediaKey(key) {
  if (typeof key !== 'string' || !/^(video|thumb)\/[\w.\-]+$/.test(key)) throw httpError(400, 'Kunci media tidak sah');
  return key;
}

async function mediaPart(req, env, url) {
  const key = checkMediaKey(url.searchParams.get('key'));
  const uploadId = url.searchParams.get('uploadId');
  const partNumber = parseInt(url.searchParams.get('part'), 10);
  if (!uploadId || !(partNumber >= 1 && partNumber <= 10000)) throw httpError(400, 'Parameter bahagian tidak sah');
  if (!req.body) throw httpError(400, 'Badan permintaan kosong');
  const mpu = env.MEDIA.resumeMultipartUpload(key, uploadId);
  const part = await mpu.uploadPart(partNumber, req.body);
  return json(req, env, { partNumber: part.partNumber, etag: part.etag });
}

async function mediaComplete(req, env) {
  const body = await readJson(req);
  const key = checkMediaKey(body && body.key);
  if (!body.uploadId || !Array.isArray(body.parts) || body.parts.length === 0) throw httpError(400, 'Senarai bahagian diperlukan');
  const mpu = env.MEDIA.resumeMultipartUpload(key, body.uploadId);
  const obj = await mpu.complete(body.parts.map(p => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })));
  return json(req, env, { key: obj.key, size: obj.size });
}

async function mediaAbort(req, env) {
  const body = await readJson(req);
  const key = checkMediaKey(body && body.key);
  try {
    await env.MEDIA.resumeMultipartUpload(key, String(body.uploadId)).abort();
  } catch {}
  return json(req, env, { ok: true });
}

async function signedMediaUrl(env, key) {
  const exp = Math.floor(Date.now() / 1000) + MEDIA_URL_TTL;
  const sig = await hmac(env, `media:${key}:${exp}`);
  return `${publicUrl(env)}/media/${key}?exp=${exp}&sig=${sig}`;
}

async function serveMedia(req, env, url) {
  const key = decodeURIComponent(url.pathname.slice('/media/'.length));
  const exp = parseInt(url.searchParams.get('exp'), 10);
  const sig = url.searchParams.get('sig') || '';
  if (!/^(video|thumb)\/[\w.\-]+$/.test(key) || !(exp > Date.now() / 1000) || sig !== (await hmac(env, `media:${key}:${exp}`))) {
    return new Response('Forbidden', { status: 403 });
  }
  const rangeHeader = req.headers.get('Range');
  const obj = await env.MEDIA.get(key, rangeHeader ? { range: req.headers } : undefined);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, max-age=3600');
  let status = 200;
  if (rangeHeader && obj.range) {
    let offset = obj.range.offset;
    let length = obj.range.length;
    if (obj.range.suffix !== undefined) {
      length = Math.min(obj.range.suffix, obj.size);
      offset = obj.size - length;
    }
    offset = offset || 0;
    if (length === undefined) length = obj.size - offset;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('Content-Length', String(length));
    status = 206;
  } else {
    headers.set('Content-Length', String(obj.size));
  }
  return new Response(req.method === 'HEAD' ? null : obj.body, { status, headers });
}

/* ------------------------------------------------------------------ */
/* Posts & jobs                                                        */
/* ------------------------------------------------------------------ */

async function createPost(req, env) {
  const b = await readJson(req);
  const profileId = String((b && b.profileId) || '');
  if (!profileId) throw httpError(400, 'profileId diperlukan');
  const mediaKey = checkMediaKey(b.media && b.media.key);
  const head = await env.MEDIA.head(mediaKey);
  if (!head) throw httpError(400, 'Fail video belum dimuat naik');
  const thumbKey = b.thumbKey ? checkMediaKey(b.thumbKey) : null;

  const targets = Array.isArray(b.targets) ? b.targets : [];
  if (targets.length === 0) throw httpError(400, 'Tiada platform dipilih');
  for (const t of targets) {
    if (!PLATFORMS.includes(t.platform)) throw httpError(400, 'Platform tidak sah');
    if (!Number.isFinite(t.runAt)) throw httpError(400, 'Masa jadual tidak sah');
    const conn = await env.DB.prepare('SELECT status FROM connections WHERE profile_id = ? AND platform = ?').bind(profileId, t.platform).first();
    if (!conn || conn.status !== 'connected') throw httpError(400, `${PLATFORM_NAMES[t.platform]} belum disambung untuk profil ini`);
  }

  const now = Date.now();
  const postId = newId('post');
  const stmts = [
    env.DB.prepare(
      `INSERT INTO posts (id, profile_id, profile_name, title, caption, aspect, quality, media_key, media_name, media_size, media_type, thumb_key, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    ).bind(
      postId, profileId, String(b.profileName || '').slice(0, 100),
      String(b.title || '').slice(0, 300), String(b.caption || '').slice(0, 5000),
      b.aspectRatio === '16:9' ? '16:9' : '9:16', String(b.quality || '1080p').slice(0, 10),
      mediaKey, String(b.media.name || '').slice(0, 200), head.size,
      (head.httpMetadata && head.httpMetadata.contentType) || 'video/mp4', thumbKey, now
    )
  ];
  for (const t of targets) {
    stmts.push(env.DB.prepare(
      `INSERT INTO jobs (id, post_id, profile_id, platform, run_at, status, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)`
    ).bind(newId('job'), postId, profileId, t.platform, Math.round(t.runAt), now));
  }
  await env.DB.batch(stmts);
  return json(req, env, { ok: true, postId });
}

async function listPosts(req, env) {
  const { results: posts } = await env.DB.prepare('SELECT * FROM posts ORDER BY created_at DESC LIMIT 50').all();
  if (posts.length === 0) return json(req, env, { posts: [] });
  const ids = posts.map(p => p.id);
  const { results: jobs } = await env.DB.prepare(
    `SELECT * FROM jobs WHERE post_id IN (${ids.map(() => '?').join(',')}) ORDER BY run_at ASC`
  ).bind(...ids).all();
  return json(req, env, {
    posts: posts.map(p => ({
      id: p.id,
      profileId: p.profile_id,
      profileName: p.profile_name,
      title: p.title,
      caption: p.caption,
      aspectRatio: p.aspect,
      quality: p.quality,
      mediaName: p.media_name,
      mediaSize: p.media_size,
      mediaDeleted: !!p.media_deleted,
      createdAt: p.created_at,
      jobs: jobs.filter(j => j.post_id === p.id).map(j => ({
        id: j.id,
        platform: j.platform,
        runAt: j.run_at,
        status: j.status,
        attempts: j.attempts,
        resultUrl: j.result_url,
        error: j.error,
        updatedAt: j.updated_at
      }))
    }))
  });
}

async function cancelPost(req, env, postId) {
  await env.DB.prepare(
    `UPDATE jobs SET status = 'cancelled', updated_at = ?2 WHERE post_id = ?1 AND status IN ('pending', 'waiting')`
  ).bind(postId, Date.now()).run();
  await cleanupMedia(env, postId);
  return json(req, env, { ok: true });
}

async function retryJob(req, env, jobId) {
  const job = await env.DB.prepare('SELECT j.*, p.media_deleted FROM jobs j JOIN posts p ON p.id = j.post_id WHERE j.id = ?').bind(jobId).first();
  if (!job) throw httpError(404, 'Tugasan tidak dijumpai');
  if (job.status !== 'failed' && job.status !== 'cancelled') throw httpError(400, 'Hanya tugasan gagal/dibatalkan boleh dicuba semula');
  if (job.media_deleted) throw httpError(400, 'Fail video sudah dipadam daripada storan. Sila jadualkan semula.');
  await env.DB.prepare(
    `UPDATE jobs SET status = 'pending', run_at = ?2, attempts = 0, error = NULL, container_id = NULL, next_check_at = NULL, updated_at = ?2 WHERE id = ?1`
  ).bind(jobId, Date.now()).run();
  return json(req, env, { ok: true });
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

async function runDueJobs(env) {
  const now = Date.now();
  // Recover jobs stuck in "processing" (e.g. Worker restarted mid-upload)
  await env.DB.prepare(
    `UPDATE jobs SET status = CASE WHEN container_id IS NULL THEN 'pending' ELSE 'waiting' END, next_check_at = ?1, updated_at = ?1
     WHERE status = 'processing' AND updated_at < ?2`
  ).bind(now, now - 20 * 60 * 1000).run();

  const { results } = await env.DB.prepare(
    `SELECT * FROM jobs WHERE (status = 'pending' AND run_at <= ?1) OR (status = 'waiting' AND next_check_at <= ?1)
     ORDER BY run_at ASC LIMIT 4`
  ).bind(now).all();

  let processed = 0;
  for (const job of results) {
    const claim = await env.DB.prepare(
      `UPDATE jobs SET status = 'processing', updated_at = ?1 WHERE id = ?2 AND status = ?3`
    ).bind(Date.now(), job.id, job.status).run();
    if (!claim.meta || !claim.meta.changes) continue;
    processed++;
    await processJob(env, job);
  }

  // Tidy finished posts' media
  const { results: done } = await env.DB.prepare(
    `SELECT p.id FROM posts p WHERE p.media_deleted = 0
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.post_id = p.id AND j.status IN ('pending', 'processing', 'waiting'))
     LIMIT 10`
  ).all();
  for (const row of done) await cleanupMedia(env, row.id);

  return { processed };
}

async function processJob(env, job) {
  const now = Date.now();
  try {
    const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(job.post_id).first();
    if (!post) throw new ApiError('Hantaran tidak dijumpai');
    if (post.media_deleted) throw new ApiError('Fail video sudah dipadam daripada storan');
    const conn = await getConnection(env, job.profile_id, job.platform);
    if (!conn || conn.status !== 'connected') throw new ApiError(`${PLATFORM_NAMES[job.platform]} belum disambung`);

    const publisher = { yt: publishYouTube, fb: publishFacebook, ig: publishInstagram, threads: publishThreads }[job.platform];
    const r = await publisher(env, job, post, conn);

    if (r.status === 'waiting') {
      await env.DB.prepare(
        `UPDATE jobs SET status = 'waiting', container_id = ?2, next_check_at = ?3, error = NULL, updated_at = ?4 WHERE id = ?1`
      ).bind(job.id, r.containerId, now + CHECK_INTERVAL, Date.now()).run();
    } else {
      await env.DB.prepare(
        `UPDATE jobs SET status = 'published', result_id = ?2, result_url = ?3, error = NULL, updated_at = ?4 WHERE id = ?1`
      ).bind(job.id, r.resultId || null, r.resultUrl || null, Date.now()).run();
    }
  } catch (e) {
    const attempts = (job.attempts || 0) + 1;
    const retry = e.retryable && attempts < MAX_ATTEMPTS;
    console.error(`job ${job.id} (${job.platform}) failed:`, e.message);
    await env.DB.prepare(
      `UPDATE jobs SET status = ?2, attempts = ?3, error = ?4, run_at = ?5, next_check_at = ?5, updated_at = ?6 WHERE id = ?1`
    ).bind(
      job.id,
      retry ? (job.container_id ? 'waiting' : 'pending') : 'failed',
      attempts,
      String(e.message || e).slice(0, 500),
      retry ? now + attempts * 5 * 60 * 1000 : job.run_at,
      Date.now()
    ).run();
  }
}

async function cleanupMedia(env, postId) {
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
  if (!post || post.media_deleted) return;
  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE post_id = ? AND status IN ('pending', 'processing', 'waiting')`
  ).bind(postId).first();
  if (active && active.n > 0) return;
  // Keep media 3 days after a failure so it can be retried
  const failed = await env.DB.prepare(
    `SELECT MAX(updated_at) AS t FROM jobs WHERE post_id = ? AND status = 'failed'`
  ).bind(postId).first();
  if (failed && failed.t && failed.t > Date.now() - 3 * 24 * 3600 * 1000) return;
  const keys = [post.media_key, post.thumb_key].filter(Boolean);
  if (keys.length) await env.MEDIA.delete(keys);
  await env.DB.prepare('UPDATE posts SET media_deleted = 1 WHERE id = ?').bind(postId).run();
}

function fullCaption(post, limit) {
  const parts = [post.title, post.caption].map(s => String(s || '').trim()).filter(Boolean);
  const text = parts.join('\n\n');
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

function waitedTooLong(job) {
  return job.run_at && Date.now() - job.run_at > MAX_WAIT;
}

/* ---------------- YouTube ---------------- */

async function googleAccessToken(env, conn) {
  if (conn.token && conn.expires_at && conn.expires_at > Date.now() + 120 * 1000) return conn.token;
  if (!conn.refresh) throw new ApiError('YouTube: tiada refresh token. Sila sambung semula akaun YouTube.');
  let tok;
  try {
    tok = await postForm('Google', 'https://oauth2.googleapis.com/token', {
      client_id: requireSecret(env, 'GOOGLE_CLIENT_ID'),
      client_secret: requireSecret(env, 'GOOGLE_CLIENT_SECRET'),
      refresh_token: conn.refresh,
      grant_type: 'refresh_token'
    });
  } catch (e) {
    if (!e.retryable) e.message += ' — sila sambung semula akaun YouTube.';
    throw e;
  }
  await env.DB.prepare('UPDATE connections SET token_enc = ?3, expires_at = ?4, updated_at = ?5 WHERE profile_id = ?1 AND platform = ?2')
    .bind(conn.profile_id, conn.platform, await encrypt(env, tok.access_token), Date.now() + (tok.expires_in || 3600) * 1000, Date.now()).run();
  return tok.access_token;
}

async function publishYouTube(env, job, post, conn) {
  const accessToken = await googleAccessToken(env, conn);
  const obj = await env.MEDIA.get(post.media_key);
  if (!obj) throw new ApiError('Fail video tiada dalam storan');
  const type = post.media_type || 'video/mp4';

  let description = String(post.caption || '');
  if (post.aspect === '9:16' && !/#shorts\b/i.test(description)) description = `${description}\n\n#Shorts`.trim();
  const meta = {
    snippet: {
      title: (String(post.title || '').trim() || String(post.caption || '').trim().split('\n')[0] || 'Video').slice(0, 100),
      description: description.slice(0, 5000),
      categoryId: '22'
    },
    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
  };

  let init;
  try {
    init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(obj.size),
        'X-Upload-Content-Type': type
      },
      body: JSON.stringify(meta)
    });
  } catch (e) {
    throw new ApiError(`YouTube: rangkaian gagal (${e.message})`, { retryable: true });
  }
  if (!init.ok) {
    const t = await init.text();
    let msg = t;
    try { msg = JSON.parse(t).error.message; } catch {}
    throw new ApiError(`YouTube: ${String(msg).slice(0, 400)}`, { retryable: init.status >= 500 || init.status === 429, status: init.status });
  }
  const uploadUrl = init.headers.get('Location');
  if (!uploadUrl) throw new ApiError('YouTube: tiada URL muat naik diterima', { retryable: true });

  const { readable, writable } = new FixedLengthStream(obj.size);
  obj.body.pipeTo(writable).catch(() => {});
  const video = await callApi('YouTube', uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: readable });

  if (post.thumb_key) {
    const thumb = await env.MEDIA.get(post.thumb_key);
    if (thumb) {
      try {
        await callApi('YouTube thumbnail', `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${video.id}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': (thumb.httpMetadata && thumb.httpMetadata.contentType) || 'image/jpeg'
          },
          body: await thumb.arrayBuffer()
        });
      } catch (e) {
        console.warn('Thumbnail not set:', e.message); // needs a verified channel; not fatal
      }
    }
  }

  return {
    status: 'published',
    resultId: video.id,
    resultUrl: post.aspect === '9:16' ? `https://www.youtube.com/shorts/${video.id}` : `https://youtu.be/${video.id}`
  };
}

/* ---------------- Facebook Page ---------------- */

async function publishFacebook(env, job, post, conn) {
  const res = await postForm('Facebook', `https://graph-video.facebook.com/${env.GRAPH_VERSION || 'v23.0'}/${conn.account_id}/videos`, {
    file_url: await signedMediaUrl(env, post.media_key),
    title: String(post.title || '').slice(0, 250) || undefined,
    description: String(post.caption || '').slice(0, 5000),
    access_token: conn.token
  });
  return { status: 'published', resultId: res.id, resultUrl: `https://www.facebook.com/${conn.account_id}/videos/${res.id}` };
}

/* ---------------- Instagram Reels ---------------- */

async function publishInstagram(env, job, post, conn) {
  const g = graphBase(env);
  const igId = conn.account_id;

  if (!job.container_id) {
    const params = {
      media_type: 'REELS',
      video_url: await signedMediaUrl(env, post.media_key),
      caption: fullCaption(post, 2200),
      share_to_feed: 'true',
      access_token: conn.token
    };
    if (post.thumb_key) params.cover_url = await signedMediaUrl(env, post.thumb_key);
    const c = await postForm('Instagram', `${g}/${igId}/media`, params);
    return { status: 'waiting', containerId: c.id };
  }

  const st = await callApi('Instagram', `${g}/${job.container_id}?${new URLSearchParams({ fields: 'status_code,status', access_token: conn.token })}`);
  if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
    throw new ApiError(`Instagram: pemprosesan video gagal (${st.status || st.status_code})`);
  }
  if (st.status_code !== 'FINISHED') {
    if (waitedTooLong(job)) throw new ApiError('Instagram: video masih diproses terlalu lama');
    return { status: 'waiting', containerId: job.container_id };
  }
  const pub = await postForm('Instagram', `${g}/${igId}/media_publish`, { creation_id: job.container_id, access_token: conn.token });
  let link = null;
  try {
    const info = await callApi('Instagram', `${g}/${pub.id}?${new URLSearchParams({ fields: 'permalink', access_token: conn.token })}`);
    link = info.permalink || null;
  } catch {}
  return { status: 'published', resultId: pub.id, resultUrl: link };
}

/* ---------------- Threads ---------------- */

async function threadsToken(env, conn) {
  // Long-lived Threads tokens last 60 days; refresh when under 7 days remain
  if (conn.expires_at && conn.expires_at < Date.now() + 7 * 24 * 3600 * 1000) {
    try {
      const r = await callApi('Threads', `https://graph.threads.net/refresh_access_token?${new URLSearchParams({
        grant_type: 'th_refresh_token', access_token: conn.token
      })}`);
      await env.DB.prepare('UPDATE connections SET token_enc = ?3, expires_at = ?4, updated_at = ?5 WHERE profile_id = ?1 AND platform = ?2')
        .bind(conn.profile_id, conn.platform, await encrypt(env, r.access_token), Date.now() + (r.expires_in || 60 * 24 * 3600) * 1000, Date.now()).run();
      return r.access_token;
    } catch (e) {
      if (conn.expires_at < Date.now()) throw new ApiError('Threads: token tamat tempoh. Sila sambung semula akaun Threads.');
    }
  }
  return conn.token;
}

async function publishThreads(env, job, post, conn) {
  const token = await threadsToken(env, conn);
  const base = 'https://graph.threads.net/v1.0';

  if (!job.container_id) {
    const c = await postForm('Threads', `${base}/${conn.account_id}/threads`, {
      media_type: 'VIDEO',
      video_url: await signedMediaUrl(env, post.media_key),
      text: fullCaption(post, 500),
      access_token: token
    });
    return { status: 'waiting', containerId: c.id };
  }

  const st = await callApi('Threads', `${base}/${job.container_id}?${new URLSearchParams({ fields: 'status,error_message', access_token: token })}`);
  if (st.status === 'ERROR' || st.status === 'EXPIRED') {
    throw new ApiError(`Threads: pemprosesan video gagal (${st.error_message || st.status})`);
  }
  if (st.status !== 'FINISHED' && st.status !== 'PUBLISHED') {
    if (waitedTooLong(job)) throw new ApiError('Threads: video masih diproses terlalu lama');
    return { status: 'waiting', containerId: job.container_id };
  }
  const pub = await postForm('Threads', `${base}/${conn.account_id}/threads_publish`, { creation_id: job.container_id, access_token: token });
  let link = null;
  try {
    const info = await callApi('Threads', `${base}/${pub.id}?${new URLSearchParams({ fields: 'permalink', access_token: token })}`);
    link = info.permalink || null;
  } catch {}
  return { status: 'published', resultId: pub.id, resultUrl: link };
}
