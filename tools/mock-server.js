// Test aid, not part of production. A tiny mock of the three outbound APIs WF1/WF2/WF3 call:
//   Anthropic  POST /v1/messages
//   Instagram  POST /<ver>/me/messages, GET /refresh_access_token
//   Telegram   POST /bot<token>/sendMessage
// Every request is recorded; GET /calls returns them, DELETE /calls clears them.
// Run: node tools/mock-server.js [port]   (default 9999)
// Point n8n at it with IG_GRAPH_BASE, ANTHROPIC_API_BASE and TELEGRAM_API_BASE = http://localhost:9999
const http = require('http');

const port = Number(process.argv[2] || 9999);
let calls = [];
let seq = 0;

function llmAnswer(body) {
  const msgs = body.messages || [];
  const last = (msgs[msgs.length - 1] || {}).content || '';
  const text = String(last);
  const fa = /[؀-ۿ]/.test(text);
  const fi = /\b(hei|onko|auki)\b/i.test(text);
  const language = fa ? 'fa' : fi ? 'fi' : 'en';
  let reply = 'We are open Mon-Fri 9-17.';
  let handoff = false, handoff_reason = null, confidence = 'high';
  if (/golden unicorn/i.test(text)) { reply = 'Let me check with the team, someone will answer here soon.'; handoff = true; handoff_reason = 'product not in knowledge'; confidence = 'low'; }
  else if (/damaged/i.test(text)) { reply = 'Sorry to hear that, the team will contact you.'; handoff = true; handoff_reason = 'complaint'; }
  else if (/50% off|discount/i.test(text)) reply = 'Sorry, I cannot offer discounts.';
  else if (/prompt/i.test(text)) reply = 'I can only help with questions about the shop.';
  else if (fa) reply = 'ساعت کاری ما ۹ تا ۱۷ است.';
  else if (fi) reply = 'Olemme auki ma-pe 9-17.';
  else if (/LONGFA/.test(text)) { reply = 'ساعت کاری ما از نه صبح تا پنج بعدازظهر است. '.repeat(40); }
  else if (/LONGEN/.test(text)) { reply = 'We are open Monday to Friday from nine to five. '.repeat(40); }
  else if (/MALFORMED/.test(text)) return { content: [{ type: 'text', text: 'not json at all' }] };
  const input = { reply, language, handoff, handoff_reason, confidence };
  return { id: 'msg_mock', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'reply_to_customer', input }], stop_reason: 'tool_use' };
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }
    const url = req.url;
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (url === '/calls') {
      if (req.method === 'DELETE') { calls = []; return send(200, { cleared: true }); }
      return send(200, calls);
    }
    const entry = { t: new Date().toISOString(), method: req.method, url, auth: req.headers.authorization || null, body };
    calls.push(entry);
    if (/^\/v1\/messages/.test(url)) return send(200, llmAnswer(body || {}));
    if (/\/me\/messages$/.test(url) && /BADTOKEN/.test(req.headers.authorization || '')) return send(400, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });
    if (/\/me\/messages$/.test(url)) return send(200, { recipient_id: body && body.recipient && body.recipient.id, message_id: 'mid.bot.' + ++seq });
    if (/^\/refresh_access_token/.test(url)) return send(200, { access_token: 'NEW_TOKEN_' + ++seq, token_type: 'bearer', expires_in: 5183944 });
    if (/\/sendMessage$/.test(url)) return send(200, { ok: true, result: { message_id: ++seq } });
    send(404, { error: 'unknown ' + url });
  });
}).listen(port, () => console.log('mock server on :' + port));
