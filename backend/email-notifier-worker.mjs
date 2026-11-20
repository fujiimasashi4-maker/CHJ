const ENDPOINT = 'https://chj-notifier.internal/notify';
const STATUS_ENDPOINT = 'https://chj-notifier.internal/status';
const RECIPIENT = 'fujii.masashi.4@gmail.com';
const SUBJECT = '【CHJ】確認待ちの投稿があります';
const TEXT = 'CHJ公式サイトに新しい投稿が届きました。\n以下の管理画面から内容をご確認ください。\n\nhttps://chjapan.com/admin/\n\nこのメールには投稿本文・写真を含めていません。';

// Syntax validation only. Cloudflare must separately verify/onboard the sender
// domain before sending is enabled; this placeholder grants no domain authority.
function validSender(value) {
  if (typeof value !== 'string' || value.length > 254) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local.length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(label =>
    label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

function json(body, status, headers = {}) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

function unavailable() {
  return json({ error: 'service_unavailable' }, 503);
}

export default {
  async fetch(request, env) {
    if (request.url === STATUS_ENDPOINT) {
      if (request.method !== 'GET') {
        return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      }
      if (request.body !== null) return json({ error: 'invalid_request' }, 400);
      // This reports local binding/sender readiness without calling the provider.
      return json({
        enabled: env?.NOTIFICATIONS_ENABLED === 'true',
        configured: typeof env?.EMAIL?.send === 'function' && validSender(env?.NOTIFICATION_FROM),
      }, 200);
    }
    if (request.url !== ENDPOINT) return json({ error: 'not_found' }, 404);
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    }
    // A service caller sends no payload. Do not read or accept private content,
    // recipient overrides, or caller-authored mail, even as an empty body stream.
    if (request.body !== null) return json({ error: 'invalid_request' }, 400);
    if (env?.NOTIFICATIONS_ENABLED !== 'true' ||
        typeof env?.EMAIL?.send !== 'function' || !validSender(env?.NOTIFICATION_FROM)) {
      return unavailable();
    }

    try {
      const result = await env.EMAIL.send({
        to: RECIPIENT,
        from: env.NOTIFICATION_FROM,
        subject: SUBJECT,
        text: TEXT,
      });
      if (typeof result?.messageId !== 'string' ||
          !/^[^\s\x00-\x1f\x7f]+$/.test(result.messageId)) return unavailable();
      // Provider acceptance does not establish arrival in the recipient inbox.
      return json({ accepted: true }, 200);
    } catch {
      // Provider diagnostics may contain private data; never return or log them.
      return unavailable();
    }
  },
};
