// deno-lint-ignore-file no-explicit-any
/**
 * Media Sosial Sender — Supabase Edge Function API
 *
 * - Owner login (APP_PASSWORD) -> signed session token
 * - App data sync (profiles, hashtags, drafts) in Postgres
 * - OAuth: Google (YouTube), Meta (Facebook Page + Instagram), Threads
 * - Video/thumbnail upload straight to Supabase Storage via signed upload URLs
 * - /cron (called every minute by pg_cron) publishes due posts to each platform
 */
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const env = (name: string) => Deno.env.get(name) || '';

// Supabase injects SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY into Edge Functions.
// SERVICE_ROLE_KEY / ANON_KEY can be set as secrets to override (e.g. projects using the new API keys).
const serviceKey = env('SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
const anonKey = env('ANON_KEY') || env('SUPABASE_ANON_KEY');
const db = createClient(env('SUPABASE_URL'), serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const BUCKET = 'media';

const PLATFORMS = ['yt', 'fb', 'ig', 'threads'];
const PLATFORM_NAMES: Record<string, string> = { yt: 'YouTube Shorts', fb: 'Facebook', ig: 'Instagram', threads: 'Threads' };

const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';
const META_SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,business_management,instagram_basic,instagram_content_publish';
const THREADS_SCOPES = 'threads_basic,threads_content_publish';

const SESSION_TTL = 30 * 24 * 3600;
const STATE_TTL = 15 * 60;
const MEDIA_URL_TTL = 12 * 3600;
const CHECK_INTERVAL = 60 * 1000;
const MAX_WAIT = 2 * 3600 * 1000;
const MAX_ATTEMPTS = 3;
const TICK_BUDGET_MS = 100 * 1000; // stay inside the Edge Function wall-clock limit

const graphVersion = () => env('GRAPH_VERSION') || 'v23.0';
const maxUploadBytes = () => (parseInt(env('MAX_UPLOAD_MB'), 10) || 50) * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

Deno.serve(async (req: Request) => {
  try {
    return await route(req);
  } catch (err: any) {
    const status = err.httpStatus || 500;
    if (status >= 500) console.error(err);
    return json(req, { error: err.message || String(err) }, status);
  }
});

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Pathname is /api/... (function name first); strip it
  const path = (url.pathname.replace(/^\/(functions\/v1\/)?api(?=\/|$)/, '').replace(/\/+$/, '')) || '/';
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (path === '/' && method === 'GET') return json(req, { ok: true, app: 'media-sosial-sender-api' });

  // Public routes
  if (path === '/login' && method === 'POST') return login(req);
  if (path.startsWith('/oauth/callback/') && method === 'GET') return oauthCallback(path.split('/').pop() || '', url);
  if (path === '/cron' && method === 'POST') return cronTick(req);

  await requireAuth(req);

  if (path === '/me' && method === 'GET') {
    return json(req, {
      ok: true,
      maxUploadBytes: maxUploadBytes(),
      configured: {
        yt: !!(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET')),
        fb: !!(env('META_APP_ID') && env('META_APP_SECRET')),
        ig: !!(env('META_APP_ID') && env('META_APP_SECRET')),
        threads: !!(env('THREADS_APP_ID') && env('THREADS_APP_SECRET'))
      }
    });
  }

  if (path === '/state' && method === 'GET') {
    const { data, error } = await db.from('app_state').select('json, updated_at').eq('id', 'main').maybeSingle();
    if (error) throw error;
    return json(req, { state: data ? data.json : null, updatedAt: data ? data.updated_at : null });
  }
  if (path === '/state' && method === 'PUT') {
    const body = await readJson(req);
    if (!body || typeof body.state !== 'object' || !body.state) throw httpError(400, 'state diperlukan');
    if (JSON.stringify(body.state).length > 900_000) throw httpError(413, 'Data terlalu besar');
    const now = Date.now();
    must(await db.from('app_state').upsert({ id: 'main', json: body.state, updated_at: now }));
    return json(req, { ok: true, updatedAt: now });
  }

  if (path === '/connections' && method === 'GET') return listConnections(req);
  if (path === '/connections' && method === 'DELETE') return deleteConnection(req);
  if (path === '/connections/select' && method === 'POST') return selectMetaPage(req);
  if (path === '/oauth/start' && method === 'POST') return oauthStart(req);

  if (path === '/media/create' && method === 'POST') return mediaCreate(req);
  if (path === '/media/complete' && method === 'POST') return mediaComplete(req);

  if (path === '/posts' && method === 'POST') return createPost(req);
  if (path === '/posts' && method === 'GET') return listPosts(req);
  let m = path.match(/^\/posts\/([\w-]+)$/);
  if (m && method === 'DELETE') return cancelPost(req, m[1]);
  m = path.match(/^\/jobs\/([\w-]+)\/retry$/);
  if (m && method === 'POST') return retryJob(req, m[1]);

  if (path === '/run-due' && method === 'POST') return json(req, { ok: true, ...(await runDueJobs()) });

  throw httpError(404, 'Tidak dijumpai');
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function allowedOrigins() {
  return env('ALLOWED_ORIGINS').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin');
  const h: Record<string, string> = { Vary: 'Origin' };
  const list = allowedOrigins();
  if (origin && (list.includes(origin) || list.includes('*'))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, apikey, x-client-info';
    h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req) }
  });
}

function httpError(status: number, message: string) {
  const e: any = new Error(message);
  e.httpStatus = status;
  return e;
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw httpError(400, 'JSON tidak sah');
  }
}

function must<T extends { error: any }>(res: T): T {
  if (res.error) throw new Error(`Pangkalan data: ${res.error.message || res.error}`);
  return res;
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function requireSecret(name: string) {
  const v = env(name);
  if (!v) throw httpError(500, `Rahsia ${name} belum ditetapkan (supabase secrets set ${name}=...)`);
  return v;
}

function publicUrl() {
  const u = (env('PUBLIC_URL') || `${env('SUPABASE_URL')}/functions/v1/api`).replace(/\/+$/, '');
  if (!u.startsWith('http')) throw httpError(500, 'PUBLIC_URL tidak dapat ditentukan');
  return u;
}

const redirectUri = (provider: string) => `${publicUrl()}/oauth/callback/${provider}`;

/* ------------------------------------------------------------------ */
/* Crypto: signing, encryption                                         */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: ArrayBuffer | Uint8Array) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let hmacKeyP: Promise<CryptoKey> | null = null;
let aesKeyP: Promise<CryptoKey> | null = null;

function hmacKey() {
  if (!hmacKeyP) {
    hmacKeyP = crypto.subtle.importKey('raw', enc.encode(requireSecret('SESSION_SECRET')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }
  return hmacKeyP;
}

function aesKey() {
  if (!aesKeyP) {
    aesKeyP = crypto.subtle.digest('SHA-256', enc.encode(requireSecret('ENC_KEY')))
      .then(raw => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
  }
  return aesKeyP;
}

async function hmac(text: string) {
  return b64urlEncode(await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(text)));
}

async function signToken(payload: Record<string, unknown>, ttlSec: number) {
  const body = b64urlEncode(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })));
  return `${body}.${await hmac(body)}`;
}

async function verifyToken(token: string, expectedTyp: string): Promise<any> {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(), b64urlDecode(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload: any;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now() / 1000) return null;
  if (payload.typ !== expectedTyp) return null;
  return payload;
}

async function encrypt(text: string | null | undefined) {
  if (text == null) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(), enc.encode(String(text)));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return b64urlEncode(out);
}

async function decrypt(data: string | null | undefined) {
  if (!data) return null;
  const raw = b64urlDecode(data);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(), raw.slice(12));
  return dec.decode(pt);
}

async function safeEqual(a: string, b: string) {
  return (await hmac('pw:' + a)) === (await hmac('pw:' + b));
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

async function login(req: Request) {
  const body = await readJson(req);
  const expected = requireSecret('APP_PASSWORD');
  if (!body || typeof body.password !== 'string' || !(await safeEqual(body.password, expected))) {
    await new Promise(r => setTimeout(r, 600));
    throw httpError(401, 'Kata laluan salah');
  }
  const token = await signToken({ typ: 'session', sub: 'owner' }, SESSION_TTL);
  return json(req, { token, expiresIn: SESSION_TTL });
}

async function requireAuth(req: Request) {
  const h = req.headers.get('Authorization') || '';
  const payload = await verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '', 'session');
  if (!payload) throw httpError(401, 'Sesi tamat atau tidak sah. Sila log masuk semula.');
  return payload;
}

/* ------------------------------------------------------------------ */
/* External API helpers                                                */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  retryable: boolean;
  status: number;
  constructor(message: string, opts: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.retryable = !!opts.retryable;
    this.status = opts.status || 0;
  }
}

async function callApi(label: string, url: string, init: RequestInit = {}): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e: any) {
    throw new ApiError(`${label}: rangkaian gagal (${e.message})`, { retryable: true });
  }
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok || (data && data.error && typeof data.error === 'object')) {
    const err = data && data.error;
    const msg = (err && typeof err === 'object' && (err.error_user_msg || err.message)) ||
      (typeof err === 'string' ? `${err}${data.error_description ? ': ' + data.error_description : ''}` : '') ||
      (data && data.raw) || `HTTP ${res.status}`;
    const retryable = res.status >= 500 || res.status === 429 ||
      (err && typeof err === 'object' && (err.is_transient || [1, 2, 4, 17].includes(err.code)));
    throw new ApiError(`${label}: ${String(msg).slice(0, 400)}`, { retryable: !!retryable, status: res.status });
  }
  return data;
}

function form(params: Record<string, unknown>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v));
  return body;
}

function postForm(label: string, url: string, params: Record<string, unknown>) {
  return callApi(label, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params)
  });
}

const graphBase = () => `https://graph.facebook.com/${graphVersion()}`;

/* ------------------------------------------------------------------ */
/* Connections & OAuth                                                 */
/* ------------------------------------------------------------------ */

function providerFor(platform: string) {
  if (platform === 'yt') return 'google';
  if (platform === 'fb' || platform === 'ig') return 'meta';
  if (platform === 'threads') return 'threads';
  throw httpError(400, 'Platform tidak sah');
}

function validReturnUrl(returnUrl: string) {
  let u: URL;
  try {
    u = new URL(returnUrl);
  } catch {
    throw httpError(400, 'returnUrl tidak sah');
  }
  const list = allowedOrigins();
  if (!list.includes(u.origin) && !(list.includes('*') && u.protocol === 'https:')) {
    throw httpError(400, `Asal ${u.origin} tiada dalam ALLOWED_ORIGINS`);
  }
  u.hash = '';
  return u.toString();
}

async function oauthStart(req: Request) {
  const body = await readJson(req);
  const platform = body && body.platform;
  const profileId = String((body && body.profileId) || '');
  if (!PLATFORMS.includes(platform)) throw httpError(400, 'Platform tidak sah');
  if (!profileId || profileId.length > 100) throw httpError(400, 'profileId diperlukan');
  const returnUrl = validReturnUrl(body.returnUrl);
  const provider = providerFor(platform);
  const state = await signToken({ typ: 'oauth', platform, profileId, returnUrl, nonce: crypto.randomUUID() }, STATE_TTL);

  let url: string;
  if (provider === 'google') {
    url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: requireSecret('GOOGLE_CLIENT_ID'),
      redirect_uri: redirectUri('google'),
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      state
    });
  } else if (provider === 'meta') {
    url = `https://www.facebook.com/${graphVersion()}/dialog/oauth?` + new URLSearchParams({
      client_id: requireSecret('META_APP_ID'),
      redirect_uri: redirectUri('meta'),
      response_type: 'code',
      scope: META_SCOPES,
      state
    });
  } else {
    url = 'https://threads.net/oauth/authorize?' + new URLSearchParams({
      client_id: requireSecret('THREADS_APP_ID'),
      redirect_uri: redirectUri('threads'),
      response_type: 'code',
      scope: THREADS_SCOPES,
      state
    });
  }
  return json(req, { url });
}

function backTo(returnUrl: string, params: Record<string, string>) {
  return new Response(null, { status: 302, headers: { Location: `${returnUrl}#${new URLSearchParams(params)}` } });
}

async function oauthCallback(provider: string, url: URL) {
  const state = await verifyToken(url.searchParams.get('state') || '', 'oauth');
  if (!state) {
    return new Response('Pautan log masuk tamat tempoh. Sila cuba sambung semula dari aplikasi.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const { platform, profileId, returnUrl } = state;
  if (providerFor(platform) !== provider) return new Response('Penyedia tidak sepadan', { status: 400 });

  const errParam = url.searchParams.get('error_description') || url.searchParams.get('error_message') || url.searchParams.get('error');
  if (errParam) return backTo(returnUrl, { cloud_error: `${PLATFORM_NAMES[platform]}: ${errParam}`, platform });
  const code = url.searchParams.get('code');
  if (!code) return backTo(returnUrl, { cloud_error: 'Tiada kod kebenaran diterima', platform });

  try {
    let extra: Record<string, string> = {};
    if (provider === 'google') await finishGoogle(profileId, code);
    else if (provider === 'meta') extra = await finishMeta(profileId, platform, code);
    else await finishThreads(profileId, code);
    return backTo(returnUrl, { cloud: 'connected', platform, ...extra });
  } catch (e: any) {
    console.error(e);
    return backTo(returnUrl, { cloud_error: e.message || String(e), platform });
  }
}

async function saveConnection(profileId: string, platform: string, data: any) {
  const row: Record<string, unknown> = {
    profile_id: profileId,
    platform,
    status: data.status || 'connected',
    account_id: data.accountId || null,
    account_name: data.accountName || null,
    token_enc: await encrypt(data.token),
    expires_at: data.expiresAt || null,
    extra_enc: data.extra ? await encrypt(JSON.stringify(data.extra)) : null,
    updated_at: Date.now()
  };
  // Keep the existing refresh token when the provider does not send a new one
  if (data.refresh) row.refresh_enc = await encrypt(data.refresh);
  must(await db.from('connections').upsert(row, { onConflict: 'profile_id,platform' }));
}

async function getConnection(profileId: string, platform: string): Promise<any> {
  const { data: row, error } = await db.from('connections').select('*').eq('profile_id', profileId).eq('platform', platform).maybeSingle();
  if (error) throw error;
  if (!row) return null;
  return {
    ...row,
    token: await decrypt(row.token_enc),
    refresh: await decrypt(row.refresh_enc),
    extra: row.extra_enc ? JSON.parse((await decrypt(row.extra_enc)) || 'null') : null
  };
}

async function updateToken(conn: any, token: string, expiresAt: number) {
  must(await db.from('connections')
    .update({ token_enc: await encrypt(token), expires_at: expiresAt, updated_at: Date.now() })
    .eq('profile_id', conn.profile_id).eq('platform', conn.platform));
}

async function finishGoogle(profileId: string, code: string) {
  const tok = await postForm('Google', 'https://oauth2.googleapis.com/token', {
    code,
    client_id: requireSecret('GOOGLE_CLIENT_ID'),
    client_secret: requireSecret('GOOGLE_CLIENT_SECRET'),
    redirect_uri: redirectUri('google'),
    grant_type: 'authorization_code'
  });
  const ch = await callApi('YouTube', 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${tok.access_token}` }
  });
  const item = ch.items && ch.items[0];
  if (!item) throw new Error('Akaun Google ini tiada saluran YouTube.');
  await saveConnection(profileId, 'yt', {
    accountId: item.id,
    accountName: item.snippet.customUrl || item.snippet.title,
    token: tok.access_token,
    refresh: tok.refresh_token || null,
    expiresAt: Date.now() + (tok.expires_in || 3600) * 1000
  });
}

async function finishMeta(profileId: string, platform: string, code: string): Promise<Record<string, string>> {
  const g = graphBase();
  const appId = requireSecret('META_APP_ID');
  const secret = requireSecret('META_APP_SECRET');
  const short = await callApi('Meta', `${g}/oauth/access_token?` + new URLSearchParams({
    client_id: appId, client_secret: secret, redirect_uri: redirectUri('meta'), code
  }));
  const long = await callApi('Meta', `${g}/oauth/access_token?` + new URLSearchParams({
    grant_type: 'fb_exchange_token', client_id: appId, client_secret: secret, fb_exchange_token: short.access_token
  }));
  const pages = await callApi('Facebook', `${g}/me/accounts?` + new URLSearchParams({
    fields: 'id,name,access_token,instagram_business_account{id,username}',
    limit: '100',
    access_token: long.access_token
  }));
  const options = (pages.data || []).map((p: any) => ({
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
    const igLinked = await applyMetaOption(profileId, options[0]);
    if (platform === 'ig' && !igLinked) return { cloud_warn: `Page "${options[0].name}" tiada akaun Instagram Business/Creator dipautkan.` };
    return {};
  }
  await saveConnection(profileId, 'fb', { status: 'select', token: null, extra: { options } });
  return { cloud_select: '1' };
}

async function applyMetaOption(profileId: string, opt: any) {
  await saveConnection(profileId, 'fb', { accountId: opt.id, accountName: opt.name, token: opt.token });
  if (opt.igId) {
    await saveConnection(profileId, 'ig', {
      accountId: opt.igId,
      accountName: opt.igUsername ? `@${opt.igUsername}` : opt.name,
      token: opt.token,
      extra: { pageId: opt.id }
    });
    return true;
  }
  return false;
}

async function selectMetaPage(req: Request) {
  const body = await readJson(req);
  const profileId = String((body && body.profileId) || '');
  const conn = await getConnection(profileId, 'fb');
  if (!conn || conn.status !== 'select' || !conn.extra) throw httpError(400, 'Tiada pilihan Page untuk profil ini');
  const opt = conn.extra.options.find((o: any) => o.id === String(body.optionId));
  if (!opt) throw httpError(400, 'Page tidak sah');
  const igLinked = await applyMetaOption(profileId, opt);
  return json(req, { ok: true, igLinked });
}

async function finishThreads(profileId: string, code: string) {
  const appId = requireSecret('THREADS_APP_ID');
  const secret = requireSecret('THREADS_APP_SECRET');
  const short = await postForm('Threads', 'https://graph.threads.net/oauth/access_token', {
    client_id: appId,
    client_secret: secret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri('threads'),
    code
  });
  const long = await callApi('Threads', 'https://graph.threads.net/access_token?' + new URLSearchParams({
    grant_type: 'th_exchange_token', client_secret: secret, access_token: short.access_token
  }));
  const me = await callApi('Threads', 'https://graph.threads.net/v1.0/me?' + new URLSearchParams({
    fields: 'id,username', access_token: long.access_token
  }));
  await saveConnection(profileId, 'threads', {
    accountId: me.id,
    accountName: me.username ? `@${me.username}` : me.id,
    token: long.access_token,
    expiresAt: Date.now() + (long.expires_in || 60 * 24 * 3600) * 1000
  });
}

async function listConnections(req: Request) {
  const { data, error } = await db.from('connections').select('*');
  if (error) throw error;
  const out = [];
  for (const row of data || []) {
    const item: any = {
      profileId: row.profile_id,
      platform: row.platform,
      status: row.status,
      accountId: row.account_id,
      accountName: row.account_name,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at
    };
    if (row.status === 'select' && row.extra_enc) {
      const extra = JSON.parse((await decrypt(row.extra_enc)) || '{"options":[]}');
      item.options = extra.options.map((o: any) => ({ id: o.id, name: o.name, igUsername: o.igUsername }));
    }
    out.push(item);
  }
  return json(req, { connections: out });
}

async function deleteConnection(req: Request) {
  const body = await readJson(req);
  const profileId = String((body && body.profileId) || '');
  const platform = body && body.platform;
  if (!PLATFORMS.includes(platform)) throw httpError(400, 'Platform tidak sah');
  must(await db.from('connections').delete().eq('profile_id', profileId).eq('platform', platform));
  must(await db.from('jobs')
    .update({ status: 'cancelled', error: 'Akaun diputuskan', updated_at: Date.now() })
    .eq('profile_id', profileId).eq('platform', platform).in('status', ['pending', 'waiting']));
  return json(req, { ok: true });
}

/* ------------------------------------------------------------------ */
/* Media (Supabase Storage)                                            */
/* ------------------------------------------------------------------ */

function safeName(name: string) {
  return String(name || 'fail').normalize('NFKD').replace(/[^\w.\-]+/g, '_').slice(-80) || 'fail';
}

function checkMediaKey(key: unknown) {
  if (typeof key !== 'string' || !/^(video|thumb)\/[\w.\-]+$/.test(key)) throw httpError(400, 'Kunci media tidak sah');
  return key;
}

async function mediaCreate(req: Request) {
  const body = await readJson(req);
  const kind = body && body.kind === 'thumb' ? 'thumb' : 'video';
  const type = String((body && body.type) || '');
  const size = Number(body && body.size) || 0;
  if (kind === 'video' && !type.startsWith('video/')) throw httpError(400, 'Jenis fail video tidak sah');
  if (kind === 'thumb' && !type.startsWith('image/')) throw httpError(400, 'Jenis fail imej tidak sah');
  if (size > maxUploadBytes()) {
    throw httpError(413, `Fail terlalu besar (${(size / 1048576).toFixed(1)} MB). Had semasa: ${Math.round(maxUploadBytes() / 1048576)} MB.`);
  }
  const key = `${kind}/${crypto.randomUUID()}-${safeName(body.name)}`;
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(key);
  if (error) throw new Error(`Storan: ${error.message}`);
  return json(req, { key, uploadUrl: data.signedUrl, apikey: anonKey });
}

async function mediaInfo(key: string): Promise<{ size: number; type: string } | null> {
  const slash = key.indexOf('/');
  const { data, error } = await db.storage.from(BUCKET).list(key.slice(0, slash), { search: key.slice(slash + 1), limit: 5 });
  if (error) throw new Error(`Storan: ${error.message}`);
  const f = (data || []).find((x: any) => x.name === key.slice(slash + 1));
  if (!f) return null;
  return { size: Number(f.metadata && f.metadata.size) || 0, type: (f.metadata && f.metadata.mimetype) || '' };
}

async function mediaComplete(req: Request) {
  const body = await readJson(req);
  const key = checkMediaKey(body && body.key);
  const info = await mediaInfo(key);
  if (!info) throw httpError(400, 'Fail belum dimuat naik');
  return json(req, { key, size: info.size });
}

async function signedMediaUrl(key: string) {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(key, MEDIA_URL_TTL);
  if (error) throw new ApiError(`Storan: ${error.message}`, { retryable: true });
  return data.signedUrl;
}

async function downloadMedia(key: string): Promise<Blob> {
  const { data, error } = await db.storage.from(BUCKET).download(key);
  if (error || !data) throw new ApiError('Fail video tiada dalam storan');
  return data;
}

/* ------------------------------------------------------------------ */
/* Posts & jobs                                                        */
/* ------------------------------------------------------------------ */

async function createPost(req: Request) {
  const b = await readJson(req);
  const profileId = String((b && b.profileId) || '');
  if (!profileId) throw httpError(400, 'profileId diperlukan');
  const mediaKey = checkMediaKey(b.media && b.media.key);
  const info = await mediaInfo(mediaKey);
  if (!info) throw httpError(400, 'Fail video belum dimuat naik');
  const thumbKey = b.thumbKey ? checkMediaKey(b.thumbKey) : null;

  const targets = Array.isArray(b.targets) ? b.targets : [];
  if (targets.length === 0) throw httpError(400, 'Tiada platform dipilih');
  const { data: conns, error } = await db.from('connections').select('platform, status').eq('profile_id', profileId);
  if (error) throw error;
  for (const t of targets) {
    if (!PLATFORMS.includes(t.platform)) throw httpError(400, 'Platform tidak sah');
    if (!Number.isFinite(t.runAt)) throw httpError(400, 'Masa jadual tidak sah');
    if (!(conns || []).some((c: any) => c.platform === t.platform && c.status === 'connected')) {
      throw httpError(400, `${PLATFORM_NAMES[t.platform]} belum disambung untuk profil ini`);
    }
  }

  const now = Date.now();
  const postId = newId('post');
  must(await db.from('posts').insert({
    id: postId,
    profile_id: profileId,
    profile_name: String(b.profileName || '').slice(0, 100),
    title: String(b.title || '').slice(0, 300),
    caption: String(b.caption || '').slice(0, 5000),
    aspect: b.aspectRatio === '16:9' ? '16:9' : '9:16',
    quality: String(b.quality || '1080p').slice(0, 10),
    media_key: mediaKey,
    media_name: String(b.media.name || '').slice(0, 200),
    media_size: info.size,
    media_type: info.type || 'video/mp4',
    thumb_key: thumbKey,
    created_at: now
  }));
  const jobs = await db.from('jobs').insert(targets.map((t: any) => ({
    id: newId('job'),
    post_id: postId,
    profile_id: profileId,
    platform: t.platform,
    run_at: Math.round(t.runAt),
    status: 'pending',
    updated_at: now
  })));
  if (jobs.error) {
    await db.from('posts').delete().eq('id', postId);
    throw new Error(`Pangkalan data: ${jobs.error.message}`);
  }
  return json(req, { ok: true, postId });
}

async function listPosts(req: Request) {
  const { data, error } = await db.from('posts').select('*, jobs(*)').order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return json(req, {
    posts: (data || []).map((p: any) => ({
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
      jobs: (p.jobs || []).sort((a: any, b: any) => a.run_at - b.run_at).map((j: any) => ({
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

async function cancelPost(req: Request, postId: string) {
  must(await db.from('jobs').update({ status: 'cancelled', updated_at: Date.now() }).eq('post_id', postId).in('status', ['pending', 'waiting']));
  await cleanupMedia(postId);
  return json(req, { ok: true });
}

async function retryJob(req: Request, jobId: string) {
  const { data: job, error } = await db.from('jobs').select('*, posts(media_deleted)').eq('id', jobId).maybeSingle();
  if (error) throw error;
  if (!job) throw httpError(404, 'Tugasan tidak dijumpai');
  if (job.status !== 'failed' && job.status !== 'cancelled') throw httpError(400, 'Hanya tugasan gagal/dibatalkan boleh dicuba semula');
  if (job.posts && job.posts.media_deleted) throw httpError(400, 'Fail video sudah dipadam daripada storan. Sila jadualkan semula.');
  const now = Date.now();
  must(await db.from('jobs').update({
    status: 'pending', run_at: now, attempts: 0, error: null, container_id: null, next_check_at: null, updated_at: now
  }).eq('id', jobId));
  return json(req, { ok: true });
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

async function cronTick(req: Request) {
  const secret = requireSecret('CRON_SECRET');
  if ((req.headers.get('x-cron-secret') || '') !== secret) return new Response('Forbidden', { status: 403 });
  const work = runDueJobs().catch(e => console.error('cron tick failed:', e));
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime && EdgeRuntime.waitUntil) {
    EdgeRuntime.waitUntil(work);
    return new Response(JSON.stringify({ ok: true, started: true }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  }
  await work;
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function runDueJobs() {
  const started = Date.now();
  const now = started;

  // Recover jobs stuck in "processing" (e.g. function stopped mid-upload)
  const stale = now - 20 * 60 * 1000;
  must(await db.from('jobs').update({ status: 'pending', updated_at: now }).eq('status', 'processing').lt('updated_at', stale).is('container_id', null));
  must(await db.from('jobs').update({ status: 'waiting', next_check_at: now, updated_at: now }).eq('status', 'processing').lt('updated_at', stale).not('container_id', 'is', null));

  const { data: due, error } = await db.from('jobs').select('*')
    .or(`and(status.eq.pending,run_at.lte.${now}),and(status.eq.waiting,next_check_at.lte.${now})`)
    .order('run_at', { ascending: true })
    .limit(4);
  if (error) throw error;

  let processed = 0;
  for (const job of due || []) {
    if (Date.now() - started > TICK_BUDGET_MS) break; // leave the rest for the next minute
    const { data: claimed } = await db.from('jobs')
      .update({ status: 'processing', updated_at: Date.now() })
      .eq('id', job.id).eq('status', job.status).select('id');
    if (!claimed || claimed.length === 0) continue;
    processed++;
    await processJob(job);
  }

  // Tidy media of finished posts
  const { data: open } = await db.from('posts').select('id').eq('media_deleted', false).order('created_at', { ascending: true }).limit(20);
  for (const p of open || []) await cleanupMedia(p.id);

  return { processed };
}

async function processJob(job: any) {
  const now = Date.now();
  try {
    const { data: post } = await db.from('posts').select('*').eq('id', job.post_id).maybeSingle();
    if (!post) throw new ApiError('Hantaran tidak dijumpai');
    if (post.media_deleted) throw new ApiError('Fail video sudah dipadam daripada storan');
    const conn = await getConnection(job.profile_id, job.platform);
    if (!conn || conn.status !== 'connected') throw new ApiError(`${PLATFORM_NAMES[job.platform]} belum disambung`);

    const publisher: Record<string, (job: any, post: any, conn: any) => Promise<any>> = {
      yt: publishYouTube, fb: publishFacebook, ig: publishInstagram, threads: publishThreads
    };
    const r = await publisher[job.platform](job, post, conn);

    if (r.status === 'waiting') {
      must(await db.from('jobs').update({
        status: 'waiting', container_id: r.containerId, next_check_at: now + CHECK_INTERVAL, error: null, updated_at: Date.now()
      }).eq('id', job.id));
    } else {
      must(await db.from('jobs').update({
        status: 'published', result_id: r.resultId || null, result_url: r.resultUrl || null, error: null, updated_at: Date.now()
      }).eq('id', job.id));
    }
  } catch (e: any) {
    const attempts = (job.attempts || 0) + 1;
    const retry = e.retryable && attempts < MAX_ATTEMPTS;
    console.error(`job ${job.id} (${job.platform}) failed:`, e.message);
    const next = now + attempts * 5 * 60 * 1000;
    await db.from('jobs').update({
      status: retry ? (job.container_id ? 'waiting' : 'pending') : 'failed',
      attempts,
      error: String(e.message || e).slice(0, 500),
      run_at: retry && !job.container_id ? next : job.run_at,
      next_check_at: retry ? next : job.next_check_at,
      updated_at: Date.now()
    }).eq('id', job.id);
  }
}

async function cleanupMedia(postId: string) {
  const { data: post } = await db.from('posts').select('*, jobs(status, updated_at)').eq('id', postId).maybeSingle();
  if (!post || post.media_deleted) return;
  const jobs = post.jobs || [];
  if (jobs.some((j: any) => ['pending', 'processing', 'waiting'].includes(j.status))) return;
  // Keep media 3 days after a failure so it can be retried
  const lastFail = Math.max(0, ...jobs.filter((j: any) => j.status === 'failed').map((j: any) => j.updated_at));
  if (lastFail > Date.now() - 3 * 24 * 3600 * 1000) return;
  const keys = [post.media_key, post.thumb_key].filter(Boolean);
  if (keys.length) await db.storage.from(BUCKET).remove(keys);
  await db.from('posts').update({ media_deleted: true }).eq('id', postId);
}

function fullCaption(post: any, limit: number) {
  const text = [post.title, post.caption].map(s => String(s || '').trim()).filter(Boolean).join('\n\n');
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

const waitedTooLong = (job: any) => job.run_at && Date.now() - job.run_at > MAX_WAIT;

/* ---------------- YouTube ---------------- */

async function googleAccessToken(conn: any) {
  if (conn.token && conn.expires_at && conn.expires_at > Date.now() + 120 * 1000) return conn.token;
  if (!conn.refresh) throw new ApiError('YouTube: tiada refresh token. Sila sambung semula akaun YouTube.');
  let tok: any;
  try {
    tok = await postForm('Google', 'https://oauth2.googleapis.com/token', {
      client_id: requireSecret('GOOGLE_CLIENT_ID'),
      client_secret: requireSecret('GOOGLE_CLIENT_SECRET'),
      refresh_token: conn.refresh,
      grant_type: 'refresh_token'
    });
  } catch (e: any) {
    if (!e.retryable) e.message += ' — sila sambung semula akaun YouTube.';
    throw e;
  }
  await updateToken(conn, tok.access_token, Date.now() + (tok.expires_in || 3600) * 1000);
  return tok.access_token;
}

async function publishYouTube(_job: any, post: any, conn: any) {
  const accessToken = await googleAccessToken(conn);
  const video = await downloadMedia(post.media_key);
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

  let init: Response;
  try {
    init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(video.size),
        'X-Upload-Content-Type': type
      },
      body: JSON.stringify(meta)
    });
  } catch (e: any) {
    throw new ApiError(`YouTube: rangkaian gagal (${e.message})`, { retryable: true });
  }
  if (!init.ok) {
    const t = await init.text();
    let msg = t;
    try { msg = JSON.parse(t).error.message; } catch { /* keep raw */ }
    throw new ApiError(`YouTube: ${String(msg).slice(0, 400)}`, { retryable: init.status >= 500 || init.status === 429, status: init.status });
  }
  const uploadUrl = init.headers.get('Location');
  if (!uploadUrl) throw new ApiError('YouTube: tiada URL muat naik diterima', { retryable: true });
  const uploaded = await callApi('YouTube', uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: video });

  if (post.thumb_key) {
    try {
      const thumb = await downloadMedia(post.thumb_key);
      await callApi('YouTube thumbnail', `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${uploaded.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': thumb.type || 'image/jpeg' },
        body: thumb
      });
    } catch (e: any) {
      console.warn('Thumbnail not set:', e.message); // needs a verified channel; not fatal
    }
  }

  return {
    status: 'published',
    resultId: uploaded.id,
    resultUrl: post.aspect === '9:16' ? `https://www.youtube.com/shorts/${uploaded.id}` : `https://youtu.be/${uploaded.id}`
  };
}

/* ---------------- Facebook Page ---------------- */

async function publishFacebook(_job: any, post: any, conn: any) {
  const res = await postForm('Facebook', `https://graph-video.facebook.com/${graphVersion()}/${conn.account_id}/videos`, {
    file_url: await signedMediaUrl(post.media_key),
    title: String(post.title || '').slice(0, 250) || undefined,
    description: String(post.caption || '').slice(0, 5000),
    access_token: conn.token
  });
  return { status: 'published', resultId: res.id, resultUrl: `https://www.facebook.com/${conn.account_id}/videos/${res.id}` };
}

/* ---------------- Instagram Reels ---------------- */

async function publishInstagram(job: any, post: any, conn: any) {
  const g = graphBase();
  const igId = conn.account_id;

  if (!job.container_id) {
    const params: Record<string, unknown> = {
      media_type: 'REELS',
      video_url: await signedMediaUrl(post.media_key),
      caption: fullCaption(post, 2200),
      share_to_feed: 'true',
      access_token: conn.token
    };
    if (post.thumb_key) params.cover_url = await signedMediaUrl(post.thumb_key);
    const c = await postForm('Instagram', `${g}/${igId}/media`, params);
    return { status: 'waiting', containerId: c.id };
  }

  const st = await callApi('Instagram', `${g}/${job.container_id}?` + new URLSearchParams({ fields: 'status_code,status', access_token: conn.token }));
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
    const info = await callApi('Instagram', `${g}/${pub.id}?` + new URLSearchParams({ fields: 'permalink', access_token: conn.token }));
    link = info.permalink || null;
  } catch { /* link is optional */ }
  return { status: 'published', resultId: pub.id, resultUrl: link };
}

/* ---------------- Threads ---------------- */

async function threadsToken(conn: any) {
  // Long-lived Threads tokens last 60 days; refresh when under 7 days remain
  if (conn.expires_at && conn.expires_at < Date.now() + 7 * 24 * 3600 * 1000) {
    try {
      const r = await callApi('Threads', 'https://graph.threads.net/refresh_access_token?' + new URLSearchParams({
        grant_type: 'th_refresh_token', access_token: conn.token
      }));
      await updateToken(conn, r.access_token, Date.now() + (r.expires_in || 60 * 24 * 3600) * 1000);
      return r.access_token;
    } catch {
      if (conn.expires_at < Date.now()) throw new ApiError('Threads: token tamat tempoh. Sila sambung semula akaun Threads.');
    }
  }
  return conn.token;
}

async function publishThreads(job: any, post: any, conn: any) {
  const token = await threadsToken(conn);
  const base = 'https://graph.threads.net/v1.0';

  if (!job.container_id) {
    const c = await postForm('Threads', `${base}/${conn.account_id}/threads`, {
      media_type: 'VIDEO',
      video_url: await signedMediaUrl(post.media_key),
      text: fullCaption(post, 500),
      access_token: token
    });
    return { status: 'waiting', containerId: c.id };
  }

  const st = await callApi('Threads', `${base}/${job.container_id}?` + new URLSearchParams({ fields: 'status,error_message', access_token: token }));
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
    const info = await callApi('Threads', `${base}/${pub.id}?` + new URLSearchParams({ fields: 'permalink', access_token: token }));
    link = info.permalink || null;
  } catch { /* link is optional */ }
  return { status: 'published', resultId: pub.id, resultUrl: link };
}
