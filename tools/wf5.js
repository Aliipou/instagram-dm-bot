// WF5 admin-dashboard: a one-page control panel for the shop owner, served by n8n itself.
//   GET  /webhook/admin?key=<ADMIN_KEY>   the page (tools/admin.html)
//   POST /webhook/admin-api               JSON actions: status, set_mode, resume, get_shop, save_shop
const fs = require('fs');
const path = require('path');
const { Workflow, filters, columns, dataTable, code, ifNode } = require('./lib');

const HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
const NOW = '{{ new Date().toISOString() }}';

const SERVE_PAGE = `
const key = String($env.ADMIN_KEY || '');
const given = String(($json.query || {}).key || '');
const ok = key.length >= 12 && given === key;
const page = ${JSON.stringify(HTML)};
const setup = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;padding:24px"><h2>Dashboard is locked</h2><p>' + (key.length < 12 ? 'Set ADMIN_KEY (at least 12 characters) in .env and restart n8n.' : 'Open the link with your key: <code>/webhook/admin?key=YOUR_KEY</code>') + '</p></body>';
return { json: { ok, html: ok ? page : setup } };
`;

const PARSE = String.raw`
const key = String($env.ADMIN_KEY || '');
const b = $json.body || {};
const ok = key.length >= 12 && typeof b.key === 'string' && b.key === key;
const action = ['status', 'set_mode', 'resume', 'get_shop', 'save_shop'].includes(b.action) ? b.action : 'none';
const out = { ok, action };
if (action === 'set_mode') { out.mode = ['off', 'shadow', 'auto'].includes(b.mode) ? b.mode : null; if (!out.mode) out.ok = false; }
if (action === 'resume') { out.igsid = String(b.igsid || ''); if (!out.igsid) out.ok = false; }
if (action === 'save_shop') { out.text = typeof b.text === 'string' ? b.text : ''; }
return { json: out };
`;

const BUILD_STATUS = String.raw`
const now = Date.now();
const convs = $('Get Conversations').all().map((i) => i.json).filter((r) => r && r.igsid);
const msgs = $('Get Messages').all().map((i) => i.json).filter((r) => r && r.igsid);
const cfg = Object.fromEntries($('Get Config').all().map((i) => i.json).filter((r) => r && r.key).map((r) => [r.key, r.value]));

const modeRow = String(cfg.bot_mode || '').toLowerCase();
const mode = ['off', 'shadow', 'auto'].includes(modeRow) ? modeRow : (String($env.BOT_MODE || 'shadow').toLowerCase() === 'auto' ? 'auto' : 'shadow');

const exp = cfg.ig_token_expires_at ? new Date(cfg.ig_token_expires_at).getTime() : NaN;
const token = { daysLeft: Number.isFinite(exp) ? (exp - now) / 86400000 : null };

const t = (v) => (v ? new Date(v).toISOString() : null);
const byUser = {};
for (const m of msgs) (byUser[m.igsid] ||= []).push(m);
const view = (c, n) => ({
  igsid: c.igsid,
  short: String(c.igsid).slice(-4),
  status: c.status || 'bot',
  pausedUntil: t(c.paused_until),
  lastCustomerAt: t(c.last_customer_msg_at),
  updatedAt: t(c.updated_at) || t(c.last_customer_msg_at),
  messages: (byUser[c.igsid] || [])
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .slice(-n)
    .map((m) => ({ sender: m.sender, text: String(m.text || '').slice(0, 600), at: t(m.created_at) })),
});

const waiting = convs
  .filter((c) => c.status === 'human' && c.paused_until && new Date(c.paused_until).getTime() > now)
  .map((c) => view(c, 3))
  .sort((a, b) => new Date(b.lastCustomerAt || 0) - new Date(a.lastCustomerAt || 0));
const recent = convs
  .map((c) => view(c, 8))
  .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
  .slice(0, 15);

const day = now - 86400000;
const last24 = msgs.filter((m) => m.created_at && new Date(m.created_at).getTime() > day);
const stats = {
  inbound: last24.filter((m) => m.sender === 'customer').length,
  bot: last24.filter((m) => m.sender === 'bot').length,
  owner: last24.filter((m) => m.sender === 'owner').length,
};
return { json: { mode, token, waiting, recent, stats } };
`;

const DECODE_SHOP = String.raw`
const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
return { json: { text: buf.toString('utf8') } };
`;

const PREPARE_SHOP = String.raw`
const text = String($('Parse Request').item.json.text || '');
if (text.trim().length < 20) return { json: { ok: false, error: 'The shop info is empty or too short. Nothing was saved.' } };
if (Buffer.byteLength(text, 'utf8') > 100000) return { json: { ok: false, error: 'The text is too long (over 100 KB). Nothing was saved.' } };
const bin = await this.helpers.prepareBinaryData(Buffer.from(text, 'utf8'), 'shop.md', 'text/markdown');
return { json: { ok: true }, binary: { data: bin } };
`;

const HTML_HEADERS = { entries: [
  { name: 'Content-Type', value: 'text/html; charset=utf-8' },
  { name: 'Referrer-Policy', value: 'no-referrer' },
  { name: 'X-Frame-Options', value: 'DENY' },
  { name: 'Cache-Control', value: 'no-store' },
] };
const JSON_HEADERS = { entries: [
  { name: 'Content-Type', value: 'application/json; charset=utf-8' },
  { name: 'Cache-Control', value: 'no-store' },
] };

function wf5() {
  const wf = new Workflow('igdmWf5Admin01', 'wf5-admin-dashboard', { errorWorkflow: 'igdmWf3ErrorAlert' });
  const json = (name, pos, body, code_ = 200) =>
    wf.add(name, 'n8n-nodes-base.respondToWebhook', 1.1, pos, {
      respondWith: 'text', responseBody: body, options: { responseCode: code_, responseHeaders: JSON_HEADERS },
    });

  // ---- page
  wf.add('Webhook Page', 'n8n-nodes-base.webhook', 2, [0, 0], {
    httpMethod: 'GET', path: 'admin', responseMode: 'responseNode', options: {},
  }, { webhookId: 'a1c0f2b4-5555-4a6e-9c01-0000000000a5' });
  code(wf, 'Serve Page', [220, 0], SERVE_PAGE);
  ifNode(wf, 'Key OK?', [440, 0], '$json.ok === true');
  wf.add('Respond Page', 'n8n-nodes-base.respondToWebhook', 1.1, [660, -80], {
    respondWith: 'text', responseBody: '={{ $json.html }}', options: { responseCode: 200, responseHeaders: HTML_HEADERS },
  });
  wf.add('Respond Locked', 'n8n-nodes-base.respondToWebhook', 1.1, [660, 80], {
    respondWith: 'text', responseBody: '={{ $json.html }}', options: { responseCode: 401, responseHeaders: HTML_HEADERS },
  });
  wf.chain('Webhook Page', 'Serve Page', 'Key OK?');
  wf.connect('Key OK?', 'Respond Page', 0);
  wf.connect('Key OK?', 'Respond Locked', 1);

  // ---- api
  wf.add('Webhook API', 'n8n-nodes-base.webhook', 2, [0, 400], {
    httpMethod: 'POST', path: 'admin-api', responseMode: 'responseNode', options: {},
  }, { webhookId: 'a1c0f2b4-6666-4a6e-9c01-0000000000a6' });
  code(wf, 'Parse Request', [220, 400], PARSE);
  ifNode(wf, 'Authorized?', [440, 400], "$json.ok === true && $json.action !== 'none'");
  json('Respond Unauthorized', [660, 560], '={{ JSON.stringify({ ok: false, error: "unauthorized" }) }}', 401);
  wf.add('Route Action', 'n8n-nodes-base.switch', 3.2, [660, 380], {
    rules: {
      values: ['status', 'set_mode', 'resume', 'get_shop', 'save_shop'].map((v, i) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{ id: `act-${i}`, leftValue: '={{ $json.action }}', rightValue: v, operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        renameOutput: true, outputKey: v,
      })),
    },
    options: { fallbackOutput: 'none' },
  });
  wf.chain('Webhook API', 'Parse Request', 'Authorized?');
  wf.connect('Authorized?', 'Route Action', 0);
  wf.connect('Authorized?', 'Respond Unauthorized', 1);

  // status
  dataTable(wf, 'Get Conversations', [900, 100], 'conversations', 'get', { returnAll: true }, { alwaysOutputData: true, executeOnce: true });
  dataTable(wf, 'Get Messages', [1120, 100], 'messages', 'get', { returnAll: true }, { alwaysOutputData: true, executeOnce: true });
  dataTable(wf, 'Get Config', [1340, 100], 'config', 'get', { returnAll: true }, { alwaysOutputData: true, executeOnce: true });
  code(wf, 'Build Status', [1560, 100], BUILD_STATUS, 'runOnceForAllItems');
  json('Respond Status', [1780, 100], '={{ JSON.stringify($json) }}');
  wf.connect('Route Action', 'Get Conversations', 0);
  wf.chain('Get Conversations', 'Get Messages', 'Get Config', 'Build Status', 'Respond Status');

  // set_mode
  dataTable(wf, 'Save Mode', [900, 260], 'config', 'upsert', {
    ...filters([['key', 'eq', 'bot_mode']]),
    ...columns({ key: 'bot_mode', value: '={{ $json.mode }}', updated_at: `=${NOW}` }),
  });
  json('Respond Mode', [1120, 260], '={{ JSON.stringify({ ok: true }) }}');
  wf.connect('Route Action', 'Save Mode', 1);
  wf.chain('Save Mode', 'Respond Mode');

  // resume
  dataTable(wf, 'Resume Customer', [900, 420], 'conversations', 'update', {
    ...filters([['igsid', 'eq', '={{ $json.igsid }}']]),
    ...columns({ status: 'bot', updated_at: `=${NOW}` }),
  }, { alwaysOutputData: true });
  json('Respond Resume', [1120, 420], '={{ JSON.stringify({ ok: true }) }}');
  wf.connect('Route Action', 'Resume Customer', 2);
  wf.chain('Resume Customer', 'Respond Resume');

  // get_shop
  wf.add('Read Shop', 'n8n-nodes-base.readWriteFile', 1, [900, 580], {
    operation: 'read', fileSelector: '/data/knowledge/shop.md', options: { dataPropertyName: 'data' },
  });
  code(wf, 'Decode Shop Text', [1120, 580], DECODE_SHOP);
  json('Respond Shop', [1340, 580], '={{ JSON.stringify({ text: $json.text }) }}');
  wf.connect('Route Action', 'Read Shop', 3);
  wf.chain('Read Shop', 'Decode Shop Text', 'Respond Shop');

  // save_shop
  code(wf, 'Prepare Shop', [900, 740], PREPARE_SHOP);
  ifNode(wf, 'Shop Valid?', [1120, 740], '$json.ok === true');
  wf.add('Write Shop', 'n8n-nodes-base.readWriteFile', 1, [1340, 680], {
    operation: 'write', fileName: '/data/knowledge/shop.md', dataPropertyName: 'data', options: { append: false },
  });
  json('Respond Saved', [1560, 680], '={{ JSON.stringify({ ok: true }) }}');
  json('Respond Shop Invalid', [1340, 840], '={{ JSON.stringify({ ok: false, error: $json.error }) }}');
  wf.connect('Route Action', 'Prepare Shop', 4);
  wf.chain('Prepare Shop', 'Shop Valid?');
  wf.connect('Shop Valid?', 'Write Shop', 0);
  wf.connect('Shop Valid?', 'Respond Shop Invalid', 1);
  wf.chain('Write Shop', 'Respond Saved');

  return wf;
}

module.exports = { wf5 };
