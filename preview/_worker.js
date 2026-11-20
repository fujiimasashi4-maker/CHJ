const NEWS_ID = 'fsf-ashiya-2026-12-12';
const MAX_BODY_BYTES = 1_000_000;
const MAX_PHOTO_BYTES = 750_000;
const TEN_MINUTES = 600_000;
const ONE_DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const API_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class ApiError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.headers = headers;
  }
}

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { ...API_HEADERS, ...headers } });
}

function requireOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) {
    throw new ApiError(403, 'origin_required');
  }
}

function requireDatabase(env) {
  if (!env.COMMENTS_DB || typeof env.COMMENTS_DB.prepare !== 'function') {
    throw new ApiError(503, 'service_unavailable');
  }
  // Reading from the primary also makes moderation withdrawals visible on
  // deployments where D1 read replication has been enabled separately.
  return typeof env.COMMENTS_DB.withSession === 'function'
    ? env.COMMENTS_DB.withSession('first-primary')
    : env.COMMENTS_DB;
}

async function readBody(request, maximum = MAX_BODY_BYTES) {
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximum)) {
    throw new ApiError(413, 'payload_too_large');
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new ApiError(413, 'payload_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid base64url');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function hexadecimal(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function digest(bytes) {
  return hexadecimal(await crypto.subtle.digest('SHA-256', bytes));
}

async function clientHash(request, secret) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || !/^[0-9a-f:.]{3,45}$/i.test(ip)) throw new ApiError(503, 'service_unavailable');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hexadecimal(await crypto.subtle.sign('HMAC', key, encoder.encode(ip)));
}

function photoMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'image/jpeg';
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length >= 33 && pngSignature.every((byte, index) => bytes[index] === byte)
      && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR'
      && String.fromCharCode(...bytes.subarray(-8, -4)) === 'IEND') return 'image/png';
  if (bytes.length >= 20 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
      && ['VP8 ', 'VP8L', 'VP8X'].includes(String.fromCharCode(...bytes.subarray(12, 16)))
      && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 === bytes.length) {
    return 'image/webp';
  }
  return null;
}

async function parseSubmission(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new ApiError(400, 'invalid_form');
  let form;
  try {
    const bytes = await readBody(request);
    form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_form');
  }
  const allowed = new Set(['news', 'name', 'comment', 'photo', 'website', 'request_id']);
  for (const key of form.keys()) {
    if (!allowed.has(key) || form.getAll(key).length !== 1) throw new ApiError(400, 'invalid_form');
  }
  const stringField = (key, code) => {
    const value = form.get(key);
    if (value !== null && typeof value !== 'string') throw new ApiError(400, code);
    return (value || '').trim();
  };
  const news = stringField('news', 'invalid_news');
  const name = stringField('name', 'invalid_name');
  const comment = stringField('comment', 'invalid_comment');
  const website = stringField('website', 'invalid_form');
  const requestId = stringField('request_id', 'invalid_request_id');
  if (news !== NEWS_ID) throw new ApiError(400, 'invalid_news');
  if (!name || Array.from(name).length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new ApiError(400, 'invalid_name');
  if (Array.from(comment).length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(comment)) {
    throw new ApiError(400, 'invalid_comment');
  }
  if (requestId && !UUID.test(requestId)) throw new ApiError(400, 'invalid_request_id');
  let photo = null;
  let mime = null;
  const file = form.get('photo');
  if (file !== null) {
    if (typeof file !== 'object' || typeof file.arrayBuffer !== 'function' || file.size === 0) {
      throw new ApiError(400, 'invalid_photo');
    }
    if (file.size > MAX_PHOTO_BYTES) throw new ApiError(413, 'photo_too_large');
    photo = new Uint8Array(await file.arrayBuffer());
    mime = photoMime(photo);
    if (!mime || file.type !== mime) throw new ApiError(400, 'invalid_photo');
  }
  if (!comment && !photo) throw new ApiError(400, 'content_required');
  return { news, name, comment, photo, mime, website, requestId: requestId ? requestId.toLowerCase() : null };
}

async function createComment(request, env, now) {
  const database = requireDatabase(env);
  const secret = env.COMMENTS_RATE_LIMIT_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) throw new ApiError(503, 'service_unavailable');
  const data = await parseSubmission(request);
  const id = crypto.randomUUID();
  if (data.website) return json({ id, status: 'pending' }, 202);
  const ipHash = await clientHash(request, secret);
  const photoHash = data.photo ? await digest(data.photo) : null;
  const payloadHash = data.requestId
    ? await digest(encoder.encode(JSON.stringify([data.news, data.name, data.comment, photoHash])))
    : null;
  const timestamp = now();
  // Erase the pseudonymous identifier after its rolling rate-limit window.
  await database.prepare('UPDATE comments SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at <= ?1')
    .bind(timestamp - ONE_DAY).run();
  const previousRequest = async () => {
    if (!data.requestId) return null;
    const previous = await database.prepare('SELECT id, news, ip_hash, payload_hash FROM comments WHERE request_id = ?1')
      .bind(data.requestId).first();
    if (previous && (previous.news !== data.news || previous.ip_hash !== ipHash || previous.payload_hash !== payloadHash)) {
      throw new ApiError(409, 'request_conflict');
    }
    return previous;
  };
  const previous = await previousRequest();
  if (previous) return json({ id: previous.id, status: 'pending' }, 202);
  // One statement performs both rolling-window checks and the insert. Separate
  // SELECT/INSERT statements would allow concurrent requests to exceed limits.
  const result = await database.prepare(`
    INSERT INTO comments (id, news, name, comment, photo, photo_mime, status, created_at, ip_hash, request_id, payload_hash)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?10
    WHERE (SELECT COUNT(*) FROM comments WHERE ip_hash = ?8 AND created_at > ?11) < 10
      AND (SELECT COUNT(*) FROM comments WHERE ip_hash = ?8 AND created_at > ?12) < 3
    ON CONFLICT(request_id) DO NOTHING
  `).bind(id, data.news, data.name, data.comment, data.photo ? data.photo.buffer : null, data.mime,
    timestamp, ipHash, data.requestId, payloadHash, timestamp - ONE_DAY, timestamp - TEN_MINUTES).run();
  if (result.meta.changes === 0) {
    const retried = await previousRequest();
    if (retried) return json({ id: retried.id, status: 'pending' }, 202);
    throw new ApiError(429, 'rate_limited', { 'Retry-After': '600' });
  }
  return json({ id, status: 'pending' }, 202);
}

function pagination(url) {
  const limitValue = url.searchParams.get('limit') || '20';
  if (!/^\d+$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 50) throw new ApiError(400, 'invalid_limit');
  let timestamp = Number.MAX_SAFE_INTEGER;
  let id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null) {
    try {
      if (cursor.length > 200) throw new Error('Cursor too large');
      const value = JSON.parse(decoder.decode(decodeBase64url(cursor)));
      if (!Array.isArray(value) || value.length !== 2 || !Number.isSafeInteger(value[0]) || value[0] < 0 || !UUID.test(value[1])) {
        throw new Error('Invalid cursor');
      }
      [timestamp, id] = value;
    } catch {
      throw new ApiError(400, 'invalid_cursor');
    }
  }
  return { limit: Number(limitValue), timestamp, id };
}

async function listComments(request, env, admin = false) {
  const database = requireDatabase(env);
  const url = new URL(request.url);
  if ((!admin && url.searchParams.get('news') !== NEWS_ID)
      || (url.searchParams.has('news') && url.searchParams.get('news') !== NEWS_ID)) throw new ApiError(400, 'invalid_news');
  const status = admin ? (url.searchParams.get('status') || 'pending') : 'approved';
  if (!['pending', 'approved', 'rejected'].includes(status)) throw new ApiError(400, 'invalid_status');
  const { limit, timestamp, id } = pagination(url);
  const result = await database.prepare(`
    SELECT id, name, comment, created_at, status, photo_mime
    FROM comments WHERE news = ?1 AND status = ?2
      AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))
    ORDER BY created_at DESC, id DESC LIMIT ?5
  `).bind(NEWS_ID, status, timestamp, id, limit).all();
  const comments = result.results.map(row => {
    const item = { id: row.id, name: row.name, comment: row.comment, created_at: new Date(row.created_at).toISOString() };
    if (row.photo_mime) item.photo_url = `${admin ? '/api/admin/photos/' : '/api/photos/'}${row.id}`;
    if (admin) item.status = row.status;
    return item;
  });
  let nextCursor = null;
  if (result.results.length === limit) {
    const last = result.results.at(-1);
    const more = await database.prepare(`
      SELECT id FROM comments WHERE news = ?1 AND status = ?2
        AND (created_at < ?3 OR (created_at = ?3 AND id < ?4)) LIMIT 1
    `).bind(NEWS_ID, status, last.created_at, last.id).first();
    if (more) nextCursor = base64url(encoder.encode(JSON.stringify([last.created_at, last.id])));
  }
  return json({ comments, next_cursor: nextCursor });
}

async function getPhoto(id, env, admin = false) {
  if (!UUID.test(id)) throw new ApiError(404, 'not_found');
  const database = requireDatabase(env);
  const sql = admin
    ? 'SELECT photo, photo_mime FROM comments WHERE id = ?1 AND news = ?2 AND photo IS NOT NULL'
    : "SELECT photo, photo_mime FROM comments WHERE id = ?1 AND news = ?2 AND status = 'approved' AND photo IS NOT NULL";
  const row = await database.prepare(sql).bind(id.toLowerCase(), NEWS_ID).first();
  if (!row || !['image/jpeg', 'image/png', 'image/webp'].includes(row.photo_mime)) throw new ApiError(404, 'not_found');
  return new Response(new Uint8Array(row.photo), {
    headers: {
      ...API_HEADERS,
      'Content-Type': row.photo_mime,
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

async function moderateComment(request, id, env, now) {
  if (!UUID.test(id)) throw new ApiError(404, 'not_found');
  const database = requireDatabase(env);
  let body;
  try {
    if ((request.headers.get('Content-Type') || '').split(';')[0].trim() !== 'application/json') throw new Error('Invalid type');
    body = JSON.parse(decoder.decode(await readBody(request, 4096)));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json');
  }
  if (!body || typeof body !== 'object' || !['approved', 'rejected'].includes(body.status)) throw new ApiError(400, 'invalid_status');
  const result = await database.prepare('UPDATE comments SET status = ?1, moderated_at = ?2 WHERE id = ?3 AND news = ?4')
    .bind(body.status, now(), id.toLowerCase(), NEWS_ID).run();
  if (result.meta.changes === 0) throw new ApiError(404, 'not_found');
  return json({ id: id.toLowerCase(), status: body.status });
}

function accessConfiguration(env) {
  if (typeof env.ACCESS_TEAM_DOMAIN !== 'string' || typeof env.ACCESS_AUD !== 'string' || typeof env.ADMIN_EMAILS !== 'string') return null;
  const team = env.ACCESS_TEAM_DOMAIN.trim().replace(/^https:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(team)) return null;
  const audience = env.ACCESS_AUD.trim();
  const emails = env.ADMIN_EMAILS.split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  if (!audience || !emails.length) return null;
  return { issuer: `https://${team}`, audience, emails };
}

export function createWorker({ fetch: fetchCertificates = globalThis.fetch, now = Date.now } = {}) {
  const certificateCache = new Map();

  async function authorize(request, env) {
    try {
      const configuration = accessConfiguration(env);
      const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!configuration || !assertion || assertion.length > 16_384) throw new Error('No authorization');
      const segments = assertion.split('.');
      if (segments.length !== 3) throw new Error('Invalid token');
      const header = JSON.parse(decoder.decode(decodeBase64url(segments[0])));
      const claims = JSON.parse(decoder.decode(decodeBase64url(segments[1])));
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 200 || header.crit) {
        throw new Error('Invalid header');
      }
      const seconds = now() / 1000;
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== configuration.issuer || !audiences.includes(configuration.audience)
          || !Number.isFinite(claims.exp) || claims.exp <= seconds
          || !Number.isFinite(claims.nbf) || claims.nbf > seconds
          || typeof claims.email !== 'string' || !configuration.emails.includes(claims.email.toLowerCase())) {
        throw new Error('Invalid claims');
      }
      let cached = certificateCache.get(configuration.issuer);
      const stale = !cached || now() - cached.fetchedAt > 300_000;
      const unknownKey = cached && !cached.keys.some(key => key.kid === header.kid) && now() - cached.fetchedAt > 60_000;
      if (stale || unknownKey) {
        const response = await fetchCertificates(`${configuration.issuer}/cdn-cgi/access/certs`, {
          redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('No certificates');
        const certificates = JSON.parse(decoder.decode(await readBody(response, 65_536)));
        if (!Array.isArray(certificates.keys) || certificates.keys.length > 16) throw new Error('Invalid certificates');
        cached = { keys: certificates.keys, fetchedAt: now() };
        certificateCache.set(configuration.issuer, cached);
      }
      const jwk = cached.keys.find(key => key.kid === header.kid && key.kty === 'RSA'
        && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
      if (!jwk || decodeBase64url(jwk.n).length < 256) throw new Error('Unknown key');
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeBase64url(segments[2]), encoder.encode(`${segments[0]}.${segments[1]}`));
      if (!valid) throw new Error('Invalid signature');
    } catch {
      throw new ApiError(403, 'forbidden');
    }
  }

  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      if (pathname !== '/api' && !pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      try {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) requireOrigin(request);
        if (pathname === '/api/comments') {
          if (request.method === 'GET') return await listComments(request, env);
          if (request.method === 'POST') return await createComment(request, env, now);
          throw new ApiError(405, 'method_not_allowed', { Allow: 'GET, POST' });
        }
        const photo = pathname.match(/^\/api\/photos\/([^/]+)$/);
        if (photo) {
          if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed', { Allow: 'GET' });
          return await getPhoto(photo[1], env);
        }
        if (pathname.startsWith('/api/admin/')) {
          await authorize(request, env);
          if (pathname === '/api/admin/comments' && request.method === 'GET') return await listComments(request, env, true);
          const adminPhoto = pathname.match(/^\/api\/admin\/photos\/([^/]+)$/);
          if (adminPhoto && request.method === 'GET') return await getPhoto(adminPhoto[1], env, true);
          const comment = pathname.match(/^\/api\/admin\/comments\/([^/]+)$/);
          if (comment && request.method === 'POST') return await moderateComment(request, comment[1], env, now);
          if (pathname === '/api/admin/comments' || adminPhoto || comment) throw new ApiError(405, 'method_not_allowed');
        }
        throw new ApiError(404, 'not_found');
      } catch (error) {
        if (error instanceof ApiError) return json({ error: error.message }, error.status, error.headers);
        // Database details, request bodies and authentication values never enter
        // logs or error responses. An unavailable backend cannot publish data.
        return json({ error: 'service_unavailable' }, 503);
      }
    },
  };
}

export default createWorker();
