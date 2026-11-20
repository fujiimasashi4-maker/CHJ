import assert from 'node:assert/strict';
import test from 'node:test';

const { default: worker } = await import('../backend/email-notifier-worker.mjs');
const ENDPOINT = 'https://chj-notifier.internal/notify';
const STATUS_ENDPOINT = 'https://chj-notifier.internal/status';

function setup(sendResult = { messageId: 'local-fixture-message-id' }) {
  const sent = [];
  const env = {
    NOTIFICATIONS_ENABLED: 'true',
    NOTIFICATION_FROM: 'notifications@chjapan.com',
    EMAIL: {
      async send(message) {
        sent.push(message);
        return sendResult;
      },
    },
  };
  return { sent, env };
}

function request(options = {}, url = ENDPOINT) {
  return new Request(url, { method: 'POST', ...options });
}

for (const [name, overrides, expected] of [
  ['enabled and configured', {}, { enabled: true, configured: true }],
  ['disabled but configured', { NOTIFICATIONS_ENABLED: 'false' }, { enabled: false, configured: true }],
  ['boolean enable flag', { NOTIFICATIONS_ENABLED: true }, { enabled: false, configured: true }],
  ['missing email binding', { EMAIL: undefined }, { enabled: true, configured: false }],
  ['non-callable email binding', { EMAIL: { send: 'not callable' } }, { enabled: true, configured: false }],
  ['missing sender', { NOTIFICATION_FROM: undefined }, { enabled: true, configured: false }],
  ['invalid sender', { NOTIFICATION_FROM: 'not a mailbox' }, { enabled: true, configured: false }],
]) {
  test(`status reports ${name} without sending or exposing configuration values`, async () => {
    const { sent, env } = setup();
    Object.assign(env, overrides);
    const response = await worker.fetch(new Request(STATUS_ENDPOINT), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(sent.length, 0);
  });
}

test('status remains readable when no environment is supplied', async () => {
  const response = await worker.fetch(new Request(STATUS_ENDPOINT));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false, configured: false });
});

test('status never probes the provider by sending mail', async () => {
  const { env } = setup();
  let sends = 0;
  env.EMAIL.send = async () => { sends++; throw new Error('not a health probe'); };
  const response = await worker.fetch(new Request(STATUS_ENDPOINT), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true, configured: true });
  assert.equal(sends, 0);
});

for (const method of ['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
  test(`rejects ${method} at the read-only status endpoint`, async () => {
    const { sent, env } = setup();
    const response = await worker.fetch(request({ method }, STATUS_ENDPOINT), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET');
    assert.equal(sent.length, 0);
  });
}

test('status rejects any supplied body without reading private content', async () => {
  const { sent, env } = setup();
  const statusRequest = new Request(STATUS_ENDPOINT);
  // Fetch normally disallows GET bodies; keep the handler defensive as well.
  Object.defineProperty(statusRequest, 'body', {
    value: new Blob(['private comment/photo']).stream(),
  });
  const response = await worker.fetch(statusRequest, env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_request' });
  assert.equal(statusRequest.body.locked, false);
  assert.equal(sent.length, 0);
});

for (const url of [
  'https://public.example/status',
  'http://chj-notifier.internal/status',
  'https://chj-notifier.internal/status/',
  'https://chj-notifier.internal/status?private=comment',
  'https://chj-notifier.internal/status#photo',
]) {
  test(`rejects a status target other than the exact internal URL: ${url}`, async () => {
    const { sent, env } = setup();
    const response = await worker.fetch(new Request(url), env);
    assert.equal(response.status, 404);
    assert.equal(sent.length, 0);
  });
}

test('sends only the fixed notification and reports transport acceptance', async () => {
  const { sent, env } = setup();
  env.NOTIFICATION_TO = 'attacker@example.net';
  const response = await worker.fetch(request({
    headers: {
      'X-Notification-To': 'attacker@example.net',
      'X-Comment': 'private comment must not be sent',
    },
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(sent, [{
    to: 'fujii.masashi.4@gmail.com',
    from: 'notifications@chjapan.com',
    subject: '【CHJ】確認待ちの投稿があります',
    text: 'CHJ公式サイトに新しい投稿が届きました。\n以下の管理画面から内容をご確認ください。\n\nhttps://chjapan.com/admin/\n\nこのメールには投稿本文・写真を含めていません。',
  }]);
});

test('allows a syntactically valid configured sender without assuming its onboarded domain', async () => {
  const { sent, env } = setup();
  env.NOTIFICATION_FROM = 'site-alerts+comments@mail.example.org';
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.equal(sent[0].from, 'site-alerts+comments@mail.example.org');
});

for (const url of [
  'https://public.example/notify',
  'https://chj-notifier.internal/other',
  'https://chj-notifier.internal/notify/',
  'http://chj-notifier.internal/notify',
  'https://chj-notifier.internal:8443/notify',
  'https://chj-notifier.internal/notify?to=attacker@example.net',
  'https://chj-notifier.internal/notify#comment',
]) {
  test(`rejects a target other than the exact internal endpoint: ${url}`, async () => {
    const { sent, env } = setup();
    const response = await worker.fetch(request({}, url), env);
    assert.equal(response.status, 404);
    assert.equal(sent.length, 0);
  });
}

for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
  test(`rejects ${method} at the notification endpoint`, async () => {
    const { sent, env } = setup();
    const response = await worker.fetch(request({ method }), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
    assert.equal(sent.length, 0);
  });
}

for (const body of ['', ' ', JSON.stringify({
  to: 'attacker@example.net', comment: 'private comment', photo: 'private photo data',
})]) {
  test(`rejects every supplied body, including private fields (${body.length} bytes)`, async () => {
    const { sent, env } = setup();
    const response = await worker.fetch(request({ body }), env);
    assert.equal(response.status, 400);
    assert.equal(sent.length, 0);
  });
}

for (const enabled of [undefined, false, true, 'false', 'TRUE', ' true ']) {
  test(`requires the exact explicit enable string (${String(enabled)})`, async () => {
    const { sent, env } = setup();
    env.NOTIFICATIONS_ENABLED = enabled;
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'service_unavailable' });
    assert.equal(sent.length, 0);
  });
}

for (const sender of [
  undefined, '', 'notifications', 'notifications@localhost', ' notifications@chjapan.com',
  'notifications@chjapan.com ', 'CHJ <notifications@chjapan.com>',
  'a@chjapan.com\r\nBcc: attacker@example.net', 'a..b@chjapan.com',
  'a@-example.com', 'a@example-.com', 'a@example..com',
  `${'a'.repeat(65)}@example.com`,
]) {
  test(`rejects an absent or unsafe sender (${JSON.stringify(sender)})`, async () => {
    const { sent, env } = setup();
    env.NOTIFICATION_FROM = sender;
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'service_unavailable' });
    assert.equal(sent.length, 0);
  });
}

for (const binding of [undefined, {}, { send: 'not callable' }]) {
  test(`fails safely when the email binding is missing or invalid (${JSON.stringify(binding)})`, async () => {
    const { env } = setup();
    env.EMAIL = binding;
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  });
}

test('does not expose provider errors or log their private details', async t => {
  const { env } = setup();
  const logs = ['log', 'warn', 'error'].map(method => t.mock.method(console, method, () => {}));
  env.EMAIL.send = async () => { throw new Error('SMTP private diagnostic details'); };
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"service_unavailable"}');
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

for (const result of [undefined, null, {}, { messageId: 123 }, { messageId: '' },
  { messageId: ' ' }, { messageId: 'id\r\nprivate' }]) {
  test(`does not claim acceptance without a valid provider message ID (${JSON.stringify(result)})`, async () => {
    const { env } = setup(null);
    env.EMAIL.send = async () => result;
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  });
}
