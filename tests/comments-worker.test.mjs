import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const workerUrl = new URL('../preview/_worker.js', import.meta.url);
const schemaUrl = new URL('../backend/comments-schema.sql', import.meta.url);
const { createWorker } = await import(workerUrl);
const schema = await readFile(schemaUrl, 'utf8');
const NEWS = 'fsf-ashiya-2026-12-12';
const ORIGIN = 'https://chjapan.com';
const START = Date.UTC(2026, 10, 20, 12);
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/8sAAAAASUVORK5CYII=',
  'base64',
));
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...keyPair.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

// Execute the real schema and every production SQL statement using SQLite.
// Only the transport-shaped D1 interface is adapted for the local test runtime.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let bindings = [];
      return {
        bind(...values) {
          bindings = values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
          return this;
        },
        async all() {
          return { success: true, results: statement.all(...bindings) };
        },
        async first(column) {
          const row = statement.get(...bindings);
          return row ? (column ? row[column] : row) : null;
        },
        async run() {
          return { success: true, meta: { changes: Number(statement.run(...bindings).changes) } };
        },
      };
    },
  };
}

function token(overrides = {}, header = {}, signer = keyPair.privateKey) {
  const jwtHeader = { alg: 'RS256', typ: 'JWT', kid: 'test-key', ...header };
  const claims = {
    iss: 'https://chj-test.cloudflareaccess.com',
    aud: ['test-audience'],
    email: 'fujii.masashi.4@gmail.com',
    exp: START / 1000 + 3600,
    nbf: START / 1000 - 60,
    ...overrides,
  };
  const input = [jwtHeader, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), signer).toString('base64url')}`;
}

function setup() {
  const db = database();
  let timestamp = START;
  const certificateRequests = [];
  const worker = createWorker({
    now: () => timestamp,
    fetch: async (url, options) => {
      certificateRequests.push(url);
      assert.equal(url, 'https://chj-test.cloudflareaccess.com/cdn-cgi/access/certs');
      assert.equal(options.redirect, 'error');
      return Response.json({ keys: [publicJwk] });
    },
  });
  const env = {
    COMMENTS_DB: db,
    COMMENTS_RATE_LIMIT_SECRET: 'local-test-fixture-not-an-operational-secret',
    ACCESS_TEAM_DOMAIN: 'chj-test.cloudflareaccess.com',
    ACCESS_AUD: 'test-audience',
    ADMIN_EMAILS: 'fujii.masashi.4@gmail.com',
    ASSETS: { fetch: async () => new Response('static asset') },
  };
  return { worker, env, db, certificateRequests, advance: milliseconds => { timestamp += milliseconds; } };
}

function submission(fields = {}, headers = {}) {
  const form = new FormData();
  const data = { news: NEWS, name: 'Visitor', comment: 'A real comment', website: '', ...fields };
  for (const [name, value] of Object.entries(data)) {
    if (value !== undefined) form.append(name, value);
  }
  return new Request(`${ORIGIN}/api/comments`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.10', ...headers },
    body: form,
  });
}

function adminRequest(path = '/api/admin/comments', options = {}) {
  return new Request(`${ORIGIN}${path}`, {
    ...options,
    headers: { 'Cf-Access-Jwt-Assertion': token(), Origin: ORIGIN, ...options.headers },
  });
}

async function submit(fixture, fields = {}, headers = {}) {
  const response = await fixture.worker.fetch(submission(fields, headers), fixture.env);
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.status, 'pending');
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  return result.id;
}

async function moderate(fixture, id, status) {
  return fixture.worker.fetch(adminRequest(`/api/admin/comments/${id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
  }), fixture.env);
}

test('static assets still work when no backend bindings exist', async () => {
  const fixture = setup();
  const response = await fixture.worker.fetch(new Request(`${ORIGIN}/en/`), { ASSETS: fixture.env.ASSETS });
  assert.equal(await response.text(), 'static asset');
});

test('missing database and rate secret fail closed with stable errors', async () => {
  const fixture = setup();
  delete fixture.env.COMMENTS_DB;
  for (const request of [new Request(`${ORIGIN}/api/comments?news=${NEWS}`), submission()]) {
    const response = await fixture.worker.fetch(request, fixture.env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'service_unavailable' });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  fixture.env.COMMENTS_DB = fixture.db;
  delete fixture.env.COMMENTS_RATE_LIMIT_SECRET;
  assert.equal((await fixture.worker.fetch(submission(), fixture.env)).status, 503);
});

test('valid submissions stay pending and reveal no private fields', async () => {
  const fixture = setup();
  const id = await submit(fixture);
  const response = await fixture.worker.fetch(new Request(`${ORIGIN}/api/comments?news=${NEWS}`), fixture.env);
  assert.deepEqual(await response.json(), { comments: [], next_cursor: null });
  const row = fixture.db.sqlite.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  assert.equal(row.status, 'pending');
  assert.notEqual(row.ip_hash, '192.0.2.10');
  assert.equal(row.ip_hash.length, 64);
  assert.equal(Object.keys(row).some(key => /ip_address|token|password/.test(key)), false);
});

test('text and image submissions validate character counts and required content', async () => {
  const invalid = [
    [{ news: 'other-news' }, 'invalid_news'],
    [{ name: '' }, 'invalid_name'],
    [{ name: '😀'.repeat(81) }, 'invalid_name'],
    [{ comment: 'x'.repeat(2001) }, 'invalid_comment'],
    [{ comment: '  ' }, 'content_required'],
    [{ news: undefined }, 'invalid_news'],
  ];
  for (const [fields, error] of invalid) {
    const fixture = setup();
    const response = await fixture.worker.fetch(submission(fields), fixture.env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
    assert.equal(fixture.db.sqlite.prepare('SELECT COUNT(*) AS count FROM comments').get().count, 0);
  }
  const fixture = setup();
  await submit(fixture, { name: '😀'.repeat(80), comment: 'x'.repeat(2000) });
  await submit(fixture, { comment: '', photo: new File([PNG], 'one.png', { type: 'image/png' }) });
});

test('honeypot submissions receive a pending-shaped response without storage', async () => {
  const fixture = setup();
  await submit(fixture, { website: 'https://spam.invalid' });
  assert.equal(fixture.db.sqlite.prepare('SELECT COUNT(*) AS count FROM comments').get().count, 0);
});

test('same-origin protection rejects forged, missing and cross-site origins', async () => {
  const fixture = setup();
  for (const origin of ['https://attacker.invalid', 'null', 'https://chjapan.com.attacker.invalid']) {
    const response = await fixture.worker.fetch(submission({}, { Origin: origin }), fixture.env);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'origin_required' });
  }
  const request = submission();
  request.headers.delete('Origin');
  assert.equal((await fixture.worker.fetch(request, fixture.env)).status, 403);
});

test('streamed request size and photo size limits are enforced', async () => {
  const fixture = setup();
  const huge = new Request(`${ORIGIN}/api/comments`, {
    method: 'POST', headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'multipart/form-data; boundary=abc' },
    body: 'x'.repeat(1_000_001),
  });
  const response = await fixture.worker.fetch(huge, fixture.env);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'payload_too_large' });
  const photo = new File([new Uint8Array(750_001)], 'large.png', { type: 'image/png' });
  const imageResponse = await fixture.worker.fetch(submission({ photo }), fixture.env);
  assert.equal(imageResponse.status, 413);
  assert.deepEqual(await imageResponse.json(), { error: 'photo_too_large' });
});

test('photo magic and MIME reject SVG, HTML, type mismatch and empty files', async () => {
  for (const [bytes, name, type] of [
    ['<svg onload="alert(1)"></svg>', 'x.svg', 'image/svg+xml'],
    ['<html>hello</html>', 'x.png', 'image/png'],
    [PNG, 'x.jpg', 'image/jpeg'],
    ['', 'empty.png', 'image/png'],
  ]) {
    const fixture = setup();
    const response = await fixture.worker.fetch(submission({ photo: new File([bytes], name, { type }) }), fixture.env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_photo' });
  }
});

test('JPEG and WebP uploads preserve bytes and server-selected image MIME', async () => {
  const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCSiiivYPnj/9k=';
  const webp = 'UklGRjYAAABXRUJQVlA4ICoAAACwAQCdASoBAAEAAUAmJaACdLoABdQAANpv6rk7E+OH/ylfuy9JOjwAAAA=';
  for (const [encoded, type] of [[jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    const fixture = setup();
    const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'));
    const id = await submit(fixture, { comment: '', photo: new File([bytes], 'photo', { type }) });
    await moderate(fixture, id, 'approved');
    const response = await fixture.worker.fetch(new Request(`${ORIGIN}/api/photos/${id}`), fixture.env);
    assert.equal(response.headers.get('Content-Type'), type);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
});

test('multipart duplicate fields and non-file photos are rejected', async () => {
  const fixture = setup();
  const request = submission();
  const form = await request.formData();
  form.append('comment', 'duplicate');
  const duplicate = new Request(request.url, { method: 'POST', headers: { Origin: ORIGIN }, body: form });
  assert.equal((await fixture.worker.fetch(duplicate, fixture.env)).status, 400);
  assert.equal((await fixture.worker.fetch(submission({ photo: 'not-a-file' }), fixture.env)).status, 400);
});

test('valid Access RS256 token authorizes moderation and the admin photo route', async () => {
  const fixture = setup();
  const id = await submit(fixture, { photo: new File([PNG], 'one.png', { type: 'image/png' }) });
  assert.equal((await fixture.worker.fetch(new Request(`${ORIGIN}/api/photos/${id}`), fixture.env)).status, 404);
  const adminList = await fixture.worker.fetch(adminRequest(), fixture.env);
  assert.equal(adminList.status, 200);
  const list = await adminList.json();
  assert.deepEqual(list.comments.map(row => row.status), ['pending']);
  assert.equal(list.comments[0].photo_url, `/api/admin/photos/${id}`);
  assert.equal('ip_hash' in list.comments[0], false);
  assert.equal('photo' in list.comments[0], false);
  const adminPhoto = await fixture.worker.fetch(adminRequest(`/api/admin/photos/${id}`), fixture.env);
  assert.equal(adminPhoto.status, 200);
  assert.equal(adminPhoto.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await adminPhoto.arrayBuffer()), PNG);
  assert.deepEqual(await (await moderate(fixture, id, 'approved')).json(), { id, status: 'approved' });
  const publicList = await fixture.worker.fetch(new Request(`${ORIGIN}/api/comments?news=${NEWS}`), fixture.env);
  assert.deepEqual(await publicList.json(), {
    comments: [{ id, name: 'Visitor', comment: 'A real comment', created_at: new Date(START).toISOString(), photo_url: `/api/photos/${id}` }],
    next_cursor: null,
  });
  const photo = await fixture.worker.fetch(new Request(`${ORIGIN}/api/photos/${id}`), fixture.env);
  assert.equal(photo.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(photo.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(photo.headers.get('Cache-Control'), 'no-store');
  assert.equal(fixture.certificateRequests.length, 1);
  await moderate(fixture, id, 'rejected');
  assert.equal((await fixture.worker.fetch(new Request(`${ORIGIN}/api/photos/${id}`), fixture.env)).status, 404);
  assert.deepEqual((await (await fixture.worker.fetch(new Request(`${ORIGIN}/api/comments?news=${NEWS}`), fixture.env)).json()).comments, []);
});

test('forged Access headers cannot replace a verified JWT', async () => {
  const fixture = setup();
  const response = await fixture.worker.fetch(new Request(`${ORIGIN}/api/admin/comments`, {
    headers: { 'Cf-Access-Authenticated-User-Email': 'fujii.masashi.4@gmail.com', 'X-Email': 'fujii.masashi.4@gmail.com' },
  }), fixture.env);
  assert.equal(response.status, 403);
  assert.equal(fixture.certificateRequests.length, 0);
});

test('bad signatures, algorithms, key IDs, issuer, audience, time and email fail closed', async () => {
  const invalidTokens = [
    token({}, {}, otherKeyPair.privateKey), token({}, { alg: 'HS256' }), token({}, { alg: 'none' }),
    token({}, { kid: 'other-key' }), token({ iss: 'https://attacker.invalid' }),
    token({ aud: ['other-audience'] }), token({ exp: START / 1000 }),
    token({ nbf: START / 1000 + 60 }), token({ email: 'attacker@example.com' }),
    token({ email: undefined }), token({ nbf: undefined }), token({ exp: '9999999999' }),
    'not-a-jwt',
  ];
  for (const assertion of invalidTokens) {
    const fixture = setup();
    const response = await fixture.worker.fetch(adminRequest('/api/admin/comments', {
      headers: { 'Cf-Access-Jwt-Assertion': assertion },
    }), fixture.env);
    assert.equal(response.status, 403, assertion.slice(0, 30));
    assert.deepEqual(await response.json(), { error: 'forbidden' });
  }
});

test('admin configuration and certificate service failures deny access', async () => {
  for (const variable of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAILS']) {
    const fixture = setup();
    delete fixture.env[variable];
    assert.equal((await fixture.worker.fetch(adminRequest(), fixture.env)).status, 403);
  }
  const fixture = setup();
  fixture.env.ACCESS_TEAM_DOMAIN = 'attacker.invalid';
  assert.equal((await fixture.worker.fetch(adminRequest(), fixture.env)).status, 403);
  assert.equal(fixture.certificateRequests.length, 0);
  const worker = createWorker({ now: () => START, fetch: async () => { throw new Error('offline'); } });
  assert.equal((await worker.fetch(adminRequest(), setup().env)).status, 403);
});

test('admin mutation needs same-origin, valid status and an existing record', async () => {
  const fixture = setup();
  const id = await submit(fixture);
  const crossSite = adminRequest(`/api/admin/comments/${id}`, {
    method: 'POST', headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, body: '{"status":"approved"}',
  });
  assert.equal((await fixture.worker.fetch(crossSite, fixture.env)).status, 403);
  const invalid = await moderate(fixture, id, 'pending');
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'invalid_status' });
  assert.equal((await moderate(fixture, '00000000-0000-4000-8000-000000000000', 'approved')).status, 404);
});

test('pagination is stable and hides pending rows without returning over 50 comments', async () => {
  const fixture = setup();
  const ids = [];
  for (let index = 0; index < 3; index++) ids.push(await submit(fixture, { comment: `Comment ${index}` }));
  for (const id of ids) await moderate(fixture, id, 'approved');
  const first = await (await fixture.worker.fetch(new Request(`${ORIGIN}/api/comments?news=${NEWS}&limit=2`), fixture.env)).json();
  assert.equal(first.comments.length, 2);
  assert.equal(typeof first.next_cursor, 'string');
  const second = await (await fixture.worker.fetch(new Request(`${ORIGIN}/api/comments?news=${NEWS}&limit=2&cursor=${first.next_cursor}`), fixture.env)).json();
  assert.equal(second.comments.length, 1);
  assert.equal(second.next_cursor, null);
  assert.equal(new Set([...first.comments, ...second.comments].map(row => row.id)).size, 3);
  for (const query of ['limit=51', 'limit=-1', 'limit=abc', 'cursor=malformed', 'cursor=e30']) {
    assert.equal((await fixture.worker.fetch(new Request(`${ORIGIN}/api/comments?news=${NEWS}&${query}`), fixture.env)).status, 400);
  }
});

test('three submissions in ten minutes and ten in a rolling day are atomic limits', async () => {
  const fixture = setup();
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => fixture.worker.fetch(submission(), fixture.env)));
  assert.equal(concurrent.filter(response => response.status === 202).length, 3);
  assert.equal(concurrent.filter(response => response.status === 429).length, 9);
  assert.equal(concurrent.find(response => response.status === 429).headers.get('Retry-After'), '600');
  for (let index = 0; index < 7; index++) {
    fixture.advance(11 * 60_000);
    await submit(fixture);
  }
  fixture.advance(11 * 60_000);
  assert.equal((await fixture.worker.fetch(submission(), fixture.env)).status, 429);
  await submit(fixture, {}, { 'CF-Connecting-IP': '2001:db8::2' });
  fixture.advance(24 * 60 * 60_000);
  await submit(fixture);
  assert.equal(fixture.db.sqlite.prepare('SELECT COUNT(*) AS count FROM comments WHERE ip_hash IS NOT NULL').get().count, 1);
});

test('missing Cloudflare client IP and database errors produce no partial success', async () => {
  const fixture = setup();
  const request = submission();
  request.headers.delete('CF-Connecting-IP');
  request.headers.set('X-Forwarded-For', '192.0.2.1');
  assert.equal((await fixture.worker.fetch(request, fixture.env)).status, 503);
  fixture.env.COMMENTS_DB = { prepare() { throw new Error('sensitive database details'); } };
  const response = await fixture.worker.fetch(new Request(`${ORIGIN}/api/comments?news=${NEWS}`), fixture.env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'service_unavailable' });
});

test('idempotent concurrent retries return one receipt and consume one submission', async () => {
  const fixture = setup();
  const requestId = crypto.randomUUID();
  const responses = await Promise.all(Array.from({ length: 8 }, () => fixture.worker.fetch(submission({ request_id: requestId }), fixture.env)));
  assert.equal(responses.every(response => response.status === 202), true);
  const receipts = await Promise.all(responses.map(response => response.json()));
  assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 1);
  assert.equal(fixture.db.sqlite.prepare('SELECT COUNT(*) AS count FROM comments').get().count, 1);
  await moderate(fixture, receipts[0].id, 'approved');
  assert.equal(await submit(fixture, { request_id: requestId }), receipts[0].id);
  await submit(fixture);
  await submit(fixture);
  assert.equal(await submit(fixture, { request_id: requestId }), receipts[0].id);
  assert.equal((await fixture.worker.fetch(submission(), fixture.env)).status, 429);
});

test('receipt keys cannot disclose another IP or replace earlier content', async () => {
  const fixture = setup();
  const requestId = crypto.randomUUID();
  await submit(fixture, { request_id: requestId });
  for (const [fields, headers] of [
    [{ request_id: requestId, comment: 'edited' }, {}],
    [{ request_id: requestId }, { 'CF-Connecting-IP': '192.0.2.11' }],
    [{ request_id: requestId, photo: new File([PNG], 'one.png', { type: 'image/png' }) }, {}],
  ]) {
    const response = await fixture.worker.fetch(submission(fields, headers), fixture.env);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'request_conflict' });
  }
  const invalid = await fixture.worker.fetch(submission({ request_id: 'anything' }), fixture.env);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'invalid_request_id' });
});

test('the public page limit really caps 120 approved rows at 50 per request', async () => {
  const fixture = setup();
  const insert = fixture.db.sqlite.prepare("INSERT INTO comments (id,news,name,comment,status,created_at) VALUES (?,?,?,?,'approved',?)");
  for (let index = 0; index < 120; index++) insert.run(crypto.randomUUID(), NEWS, 'Visitor', `Comment ${index}`, START + index);
  const response = await fixture.worker.fetch(new Request(`${ORIGIN}/api/comments?news=${NEWS}&limit=50`), fixture.env);
  const first = await response.json();
  assert.equal(first.comments.length, 50);
  assert.equal(first.comments[0].comment, 'Comment 119');
  const next = await (await fixture.worker.fetch(new Request(`${ORIGIN}/api/comments?news=${NEWS}&limit=50&cursor=${first.next_cursor}`), fixture.env)).json();
  assert.equal(next.comments.length, 50);
  assert.equal(next.comments[0].comment, 'Comment 69');
});

test('rotated Access keys are refreshed only from the configured certificate URL', async () => {
  const fixture = setup();
  let timestamp = START;
  let fetchCount = 0;
  const rotatedJwk = { ...otherKeyPair.publicKey.export({ format: 'jwk' }), kid: 'rotated', alg: 'RS256' };
  const worker = createWorker({
    now: () => timestamp,
    fetch: async url => {
      assert.equal(url, 'https://chj-test.cloudflareaccess.com/cdn-cgi/access/certs');
      fetchCount++;
      return Response.json({ keys: fetchCount === 1 ? [publicJwk] : [publicJwk, rotatedJwk] });
    },
  });
  assert.equal((await worker.fetch(adminRequest(), fixture.env)).status, 200);
  timestamp += 61_000;
  const assertion = token({}, { kid: 'rotated', jku: 'https://attacker.invalid/certs' }, otherKeyPair.privateKey);
  assert.equal((await worker.fetch(adminRequest('/api/admin/comments', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }), fixture.env)).status, 200);
  assert.equal(fetchCount, 2);
});
