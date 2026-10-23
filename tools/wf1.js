// WF1 ig-webhook-reply
const { Workflow, filters, columns, dataTable, code, ifNode, telegram } = require('./lib');

const NOW = '{{ new Date().toISOString() }}';

// ---------- Code node bodies (n8n Code nodes, JavaScript) ----------

const VERIFY_GET = String.raw`
// Meta verification request: GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
const q = $json.query || {};
const mode = q['hub.mode'] ?? (q.hub && q.hub.mode);
const token = q['hub.verify_token'] ?? (q.hub && q.hub.verify_token);
const challenge = q['hub.challenge'] ?? (q.hub && q.hub.challenge);
const expected = $env.IG_VERIFY_TOKEN;
const ok = !!expected && mode === 'subscribe' && token === expected && challenge !== undefined;
return { json: { ok, challenge: ok ? String(challenge) : '' } };
`;

const VERIFY_SIGNATURE = String.raw`
// HMAC-SHA256 of the raw body vs header x-hub-signature-256 ("sha256=<hex>"), constant-time compare.
// Phase 3: IG_APP_SECRET and (optionally) IG_APP_SECRET_ALT are both tried; 'matched' shows which one signs.
const crypto = require('crypto');
const first = $input.first();
const header = String((first.json.headers || {})['x-hub-signature-256'] || '');
const given = header.startsWith('sha256=') ? header.slice(7) : '';
const raw = await this.helpers.getBinaryDataBuffer(0, 'data');

const secrets = { primary: $env.IG_APP_SECRET, alt: $env.IG_APP_SECRET_ALT };
let matched = 'none';
if (/^[0-9a-f]{64}$/i.test(given)) {
  const givenBuf = Buffer.from(given, 'hex');
  for (const [label, secret] of Object.entries(secrets)) {
    if (!secret) continue;
    const expected = crypto.createHmac('sha256', secret).update(raw).digest();
    if (expected.length === givenBuf.length && crypto.timingSafeEqual(expected, givenBuf)) { matched = label; break; }
  }
}
if (matched === 'none') {
  console.log('[ig-webhook] signature check FAILED (header present: ' + (header ? 'yes' : 'no') + '); event dropped');
  return [];
}
console.log('[ig-webhook] signature ok, signed with: ' + matched);
let body;
try { body = JSON.parse(raw.toString('utf8')); } catch (e) { console.log('[ig-webhook] body is not JSON'); return []; }
return [{ json: { body, matched } }];
`;

const SPLIT_EVENTS = String.raw`
// One output item per messaging event. kind: echo | text | attachment. Everything else is dropped.
const body = $input.first().json.body || {};
if (body.object !== 'instagram') return [];
const own = String($env.IG_ACCOUNT_ID || '');

// Replace Luhn-valid 13-19 digit runs (card numbers) so they are never stored, sent to the LLM or alerted.
function luhn(d) { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; }
function redact(text) {
  let hit = false;
  const out = text.replace(/\d(?:[ -]?\d){12,18}/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) { hit = true; return '[card number removed]'; }
    return m;
  });
  return { out, hit };
}

const items = [];
for (const entry of body.entry || []) {
  for (const ev of entry.messaging || []) {
    const msg = ev.message;
    if (!msg || msg.is_deleted) continue; // read receipts, reactions, postbacks, ...
    const echo = msg.is_echo === true;
    const sender = String((ev.sender || {}).id || '');
    const recipient = String((ev.recipient || {}).id || '');
    if (!echo && own && sender === own) continue; // never process our own account as a customer
    const customer = echo ? recipient : sender;
    if (!customer) continue;
    const ts = Number(ev.timestamp) || (Number(entry.time) ? Number(entry.time) * 1000 : Date.now());
    const mid = String(msg.mid || (customer + ':' + ts));
    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    let text = typeof msg.text === 'string' ? msg.text.trim() : '';
    let sensitive = false;
    if (text) { const r = redact(text); text = r.out; sensitive = r.hit; }
    let kind;
    if (echo) kind = 'echo';
    else if (text) kind = 'text';
    else if (atts.length) kind = 'attachment';
    else continue;
    const attTypes = atts.map((a) => a.type).filter(Boolean);
    const storedText = text || (attTypes.length ? '[attachment: ' + attTypes.join(', ') + ']' : '[no text]');
    const storyReply = !!(msg.reply_to && msg.reply_to.story);
    items.push({ json: { kind, igsid: customer, mid, text: storedText, ts, sensitive, story_reply: storyReply } });
  }
}
return items;
`;

const DECODE_PROMPT = String.raw`
// Reads prompts/system.md (binary from Read node), extracts the CANNED MESSAGES json block, keeps the rest as template.
const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
const md = buf.toString('utf8');
const m = md.match(/# CANNED MESSAGES[\s\S]*?` + '```json' + String.raw`\s*([\s\S]*?)` + '```' + String.raw`/);
if (!m) throw new Error('prompts/system.md: CANNED MESSAGES json block not found');
let canned;
try { canned = JSON.parse(m[1]); } catch (e) { throw new Error('prompts/system.md: CANNED MESSAGES block is not valid JSON: ' + e.message); }
for (const k of ['disclosure', 'holding', 'attachment', 'sensitive']) {
  if (!canned[k] || !canned[k].en) throw new Error('prompts/system.md: canned.' + k + '.en missing');
}
const start = md.indexOf('# CANNED MESSAGES');
const end = md.indexOf('# KNOWLEDGE');
if (start < 0 || end < start) throw new Error('prompts/system.md: section order must be ... CANNED MESSAGES, then KNOWLEDGE');
const template = (md.slice(0, start) + md.slice(end)).replace(/<SHOP NAME>/g, canned.shop_name || 'the shop');
const shopName = canned.shop_name || 'the shop';
const fill = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v).replace(/<SHOP NAME>/g, shopName)]));
canned.disclosure = fill(canned.disclosure);

const ev = $('Split Events').item.json;
const row = $('Get Conversation').item.json || {};
const rid = $('Store Inbound').item.json.id;
const modeRow = String(($('Get Mode').item.json || {}).value || '').toLowerCase();
const mode = ['off', 'shadow', 'auto'].includes(modeRow) ? modeRow : (String($env.BOT_MODE || 'shadow').toLowerCase() === 'auto' ? 'auto' : 'shadow');
const paused = row.paused_until ? new Date(row.paused_until).toISOString() : null;
const last = row.last_customer_msg_at ? new Date(row.last_customer_msg_at).toISOString() : null;
return { json: {
  ...ev,
  msg_row_id: rid,
  mode,
  conv: {
    status: row.status || 'bot',
    paused_until: paused,
    last_customer_msg_at: last,
    disclosed: row.disclosed === true || row.disclosed === 'true',
    language: row.language || null,
  },
  canned,
  system_template: template,
} };
`;

const GATE = String.raw`
const ctx = $json;
const now = Date.now();
const conv = ctx.conv;
const out = { ...ctx, route: 'llm', direct_type: null };

// switched off from the admin dashboard
if (ctx.mode === 'off') { out.route = 'stop'; return { json: out }; }

// Ali (or an earlier handoff) owns this thread
if (conv.status === 'human' && conv.paused_until && new Date(conv.paused_until).getTime() > now) {
  out.route = 'stop';
  return { json: out };
}

// 24-hour messaging window: nothing may be sent for a customer message older than 24 h
if (conv.last_customer_msg_at && now - new Date(conv.last_customer_msg_at).getTime() > 24 * 3600 * 1000) {
  out.route = 'stop';
  return { json: out };
}

const text = String(ctx.text || '');
const scriptLang = /[؀-ۿ]/.test(text) ? 'fa' : null;
const fiHint = /[äöå]|\b(ihminen|moi|hei|kiitos|onko|auki|paljonko)\b/i.test(text) ? 'fi' : null;
out.lang_guess = scriptLang || conv.language || fiHint || 'en';

if (ctx.kind === 'attachment') { out.route = 'direct'; out.direct_type = 'attachment'; out.handoff_reason = 'Customer sent an attachment the bot cannot read'; return { json: out }; }
if (ctx.sensitive) { out.route = 'direct'; out.direct_type = 'sensitive'; out.handoff_reason = 'Customer shared a card number in the DM'; return { json: out }; }

// obvious request for a person (short messages only; longer ones go to the LLM, which has the same rule)
const keywords = (ctx.canned.human_keywords || []).map((k) => String(k).toLowerCase());
const lower = text.toLowerCase();
const esc = (s) => s.replace(/[.*+?^${'$'}{}()|[\]\\]/g, '\\$&');
if (lower.length <= 80 && keywords.some((k) => new RegExp('(^|[^\\p{L}\\p{N}])' + esc(k) + '([^\\p{L}\\p{N}]|$)', 'u').test(lower))) {
  out.route = 'direct'; out.direct_type = 'human'; out.handoff_reason = 'Customer asked for a person';
}
return { json: out };
`;

const DIRECT_DECISION = String.raw`
const ctx = $json;
const lang = ['en', 'fi', 'fa'].includes(ctx.lang_guess) ? ctx.lang_guess : 'en';
const table = ctx.direct_type === 'attachment' ? ctx.canned.attachment : ctx.direct_type === 'sensitive' ? ctx.canned.sensitive : ctx.canned.holding;
return { json: { ...ctx, decision: {
  reply: table[lang] || table.en,
  language: lang,
  handoff: true,
  handoff_reason: ctx.handoff_reason,
  confidence: 'high',
} } };
`;

const DEBOUNCE_CHECK = String.raw`
// Runs once for all items. Input: rows of the messages table for every customer in this run.
const rows = $input.all().map((i) => i.json).filter((r) => r && r.igsid);
const histN = Math.max(1, parseInt($env.HISTORY_TURNS || '10', 10));
const out = [];
for (const wait of $('Debounce Wait').all()) {
  const ctx = wait.json;
  const mine = rows.filter((r) => String(r.igsid) === String(ctx.igsid)).sort((a, b) => a.id - b.id);
  // a newer inbound message exists: that execution answers all of them
  if (mine.some((r) => r.direction === 'in' && r.id > ctx.msg_row_id)) continue;
  const lastOut = mine.filter((r) => r.direction === 'out' && r.id < ctx.msg_row_id).map((r) => r.id).pop() || 0;
  const turn = mine.filter((r) => r.direction === 'in' && r.id > lastOut && r.id <= ctx.msg_row_id);
  // already answered by an earlier run (a bot reply is stored after our own row)
  if (mine.some((r) => r.direction === 'out' && r.sender === 'bot' && r.id > ctx.msg_row_id)) continue;
  const recent = mine.filter((r) => r.id <= ctx.msg_row_id).slice(-histN);
  const history = [];
  for (const r of recent) {
    const role = r.direction === 'in' ? 'user' : 'assistant';
    const text = String(r.text || '');
    if (!text) continue;
    if (history.length && history[history.length - 1].role === role) history[history.length - 1].content += '\n' + text;
    else history.push({ role, content: text });
  }
  while (history.length && history[0].role !== 'user') history.shift();
  out.push({ json: { ...ctx, turn_text: turn.map((r) => r.text).join('\n'), history } });
}
return out;
`;

const DECODE_SHOP = String.raw`
const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
const ctx = $('Debounce Check').item.json;
return { json: { ...ctx, shop_md: buf.toString('utf8') } };
`;

const BUILD_LLM = String.raw`
const ctx = $json;
const system = ctx.system_template.replace('<<KNOWLEDGE>>', ctx.shop_md.trim());
const schema = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Text to send to the customer' },
    language: { type: 'string', description: 'ISO 639-1 code of the language of the reply' },
    handoff: { type: 'boolean' },
    handoff_reason: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['reply', 'language', 'handoff', 'handoff_reason', 'confidence'],
};
const llm_request = {
  model: $env.LLM_MODEL || 'claude-haiku-5-5',
  max_tokens: 700,
  system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
  messages: ctx.history,
  tools: [{ name: 'reply_to_customer', description: 'Send the reply to the customer and report handoff status.', input_schema: schema }],
  tool_choice: { type: 'tool', name: 'reply_to_customer' },
};
return { json: { ...ctx, llm_request } };
`;

const PARSE_LLM = String.raw`
// $json = Anthropic response (or an error item). Context comes from Build LLM Request.
const ctx = $('Build LLM Request').item.json;
const resp = $json || {};
let d = null;
const block = Array.isArray(resp.content) ? resp.content.find((b) => b.type === 'tool_use' && b.name === 'reply_to_customer') : null;
if (block && block.input) d = block.input;
else if (Array.isArray(resp.content)) { // tolerate plain-text JSON
  const t = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { d = JSON.parse(m[0]); } catch (e) { d = null; } }
}
const valid = d && typeof d.reply === 'string' && d.reply.trim().length > 0 && typeof d.handoff === 'boolean'
  && ['high', 'medium', 'low'].includes(d.confidence) && typeof d.language === 'string';
const base = { ...ctx };
delete base.llm_request; // not needed after the call

if (!valid) {
  if ($runIndex === 0) return { json: { ...base, llm_request: ctx.llm_request, retry: true } }; // retry once
  const lang = ['en', 'fi', 'fa'].includes(ctx.lang_guess) ? ctx.lang_guess : 'en';
  return { json: { ...base, retry: false, decision: {
    reply: ctx.canned.holding[lang] || ctx.canned.holding.en, language: lang, handoff: true,
    handoff_reason: 'LLM output unusable after retry' + (resp.error ? ': ' + String((resp.error.message || resp.error)).slice(0, 200) : ''),
    confidence: 'low' } } };
}
let lang = String(d.language || '').toLowerCase().slice(0, 2);
if (!/^[a-z]{2}$/.test(lang)) lang = 'en';
let decision = { reply: d.reply.trim(), language: lang, handoff: d.handoff, handoff_reason: d.handoff ? (d.handoff_reason || 'handoff requested') : null, confidence: d.confidence };
if (d.confidence === 'low') {
  const l = ['en', 'fi', 'fa'].includes(lang) ? lang : 'en';
  decision = { ...decision, reply: ctx.canned.holding[l] || ctx.canned.holding.en, handoff: true, handoff_reason: (d.handoff_reason || 'low confidence') + ' (confidence: low)' };
}
return { json: { ...base, retry: false, decision } };
`;

const COMPOSE = String.raw`
const ctx = $json;
const d = ctx.decision;
const now = Date.now();
const mode = ctx.mode === 'auto' ? 'auto' : 'shadow';
const last = ctx.conv.last_customer_msg_at ? new Date(ctx.conv.last_customer_msg_at).getTime() : now;
const blocked = now - last > 24 * 3600 * 1000; // 24-hour messaging window

const lang = ['en', 'fi', 'fa'].includes(d.language) ? d.language : 'en';
let full = d.reply;
if (!ctx.conv.disclosed) full = (ctx.canned.disclosure[lang] || ctx.canned.disclosure.en) + '\n\n' + d.reply;

// Instagram limit: 1000 UTF-8 bytes per message
function splitBytes(s, max) {
  const out = []; let rest = s.trim();
  while (Buffer.byteLength(rest, 'utf8') > max) {
    let bytes = 0, cut = 0, lastBreak = -1;
    for (const ch of Array.from(rest)) {
      const b = Buffer.byteLength(ch, 'utf8');
      if (bytes + b > max) break;
      bytes += b; cut += ch.length;
      if (/\s/.test(ch)) lastBreak = cut;
    }
    if (lastBreak > cut * 0.5) cut = lastBreak;
    out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
const chunks = splitBytes(full, 1000);
const hours = Math.max(0, parseFloat($env.OWNER_PAUSE_HOURS || '12'));
const paused_until = new Date(now + hours * 3600 * 1000).toISOString();

const customer = String(ctx.turn_text || ctx.text || '').slice(0, 700);
const shadow_msg = '[SHADOW] Customer ' + ctx.igsid + ':\n' + customer + '\n\nDraft reply' + (blocked ? ' (NOT sendable: 24h window closed)' : '') + ':\n' + full
  + (d.handoff ? '\n\nHANDOFF: ' + d.handoff_reason : '');
const handoff_msg = 'HANDOFF needed (' + mode + ' mode)\nCustomer ' + ctx.igsid + '\nReason: ' + d.handoff_reason + '\nCustomer said:\n' + customer
  + '\n\nBot reply: ' + (mode === 'auto' && !blocked ? 'sent' : 'not sent') + '\nThe bot is paused for this customer for ' + hours + ' h.';
return { json: { ...ctx, mode, blocked, chunks, language: lang, paused_until, shadow_msg, handoff_msg,
  send_auto: mode === 'auto' && !blocked && chunks.length > 0, send_shadow: mode === 'shadow' && !blocked, do_handoff: d.handoff === true } };
`;

// Expand Chunks returns several items per input, so it runs in "all items" mode.
const EXPAND_CHUNKS_ALL = String.raw`
const out = [];
const rows = $input.all();
const plans = $('Compose').all();
rows.forEach((r, i) => {
  const plan = plans[i] ? plans[i].json : plans[0].json;
  const token = (r.json || {}).value;
  if (!token) throw new Error("config Data Table has no 'ig_access_token' row (see docs/meta-setup.md step 6)");
  plan.chunks.forEach((text, k) => out.push({ json: { token, igsid: plan.igsid, text, part: k + 1, parts: plan.chunks.length, language: plan.language } }));
});
return out;
`;

const SEND_ERROR_TEXT = String.raw`
const e = $json.error || $json;
const msg = typeof e === 'string' ? e : String(e.message || e.description || JSON.stringify(e));
const tokenProblem = /code\W{0,8}190\b|OAuthException|access token/i.test(msg);
const rate = /code\W{0,8}(4|17|32|613)\b|rate limit|429/i.test(msg);
const head = tokenProblem ? 'INSTAGRAM TOKEN INVALID OR EXPIRED (code 190). Replies are NOT being sent. Renew it: docs/meta-setup.md.'
  : rate ? 'Instagram rate limit hit while sending a reply (retried, still failing).' : 'Instagram send failed.';
return { json: { alert: head + '\nCustomer ' + $('Expand Chunks').item.json.igsid + '\n' + msg.slice(0, 800) } };
`;

const ECHO_PREPARE = String.raw`
const hours = Math.max(0, parseFloat($env.OWNER_PAUSE_HOURS || '12'));
const ev = $('Split Events').item.json;
return { json: { ...ev, paused_until: new Date(Date.now() + hours * 3600 * 1000).toISOString() } };
`;

// ---------- workflow ----------

function build() {
  const wf = new Workflow('igdmWf1Webhook01', 'wf1-ig-webhook-reply', { errorWorkflow: 'igdmWf3ErrorAlert' });

  // GET: Meta verification
  wf.add('Webhook GET', 'n8n-nodes-base.webhook', 2, [0, 0], {
    httpMethod: 'GET', path: 'ig', responseMode: 'responseNode', options: {},
  }, { webhookId: 'a1c0f2b4-1111-4a6e-9c01-0000000000a1' });
  code(wf, 'Check Verify Token', [220, 0], VERIFY_GET);
  ifNode(wf, 'Verified?', [440, 0], '$json.ok === true');
  wf.add('Respond Challenge', 'n8n-nodes-base.respondToWebhook', 1.1, [660, -80], {
    respondWith: 'text', responseBody: '={{ $json.challenge }}', options: { responseCode: 200 },
  });
  wf.add('Respond 403', 'n8n-nodes-base.respondToWebhook', 1.1, [660, 80], {
    respondWith: 'text', responseBody: 'forbidden', options: { responseCode: 403 },
  });
  wf.chain('Webhook GET', 'Check Verify Token', 'Verified?');
  wf.connect('Verified?', 'Respond Challenge', 0);
  wf.connect('Verified?', 'Respond 403', 1);

  // POST: events. Respond 200 immediately (Meta retries slow deliveries).
  wf.add('Webhook POST', 'n8n-nodes-base.webhook', 2, [0, 400], {
    httpMethod: 'POST', path: 'ig', responseMode: 'onReceived', responseCode: 200, options: { rawBody: true },
  }, { webhookId: 'a1c0f2b4-2222-4a6e-9c01-0000000000a2' });
  code(wf, 'Verify Signature', [220, 400], VERIFY_SIGNATURE, 'runOnceForAllItems');
  code(wf, 'Split Events', [440, 400], SPLIT_EVENTS, 'runOnceForAllItems');
  ifNode(wf, 'Is Echo?', [660, 400], "$json.kind === 'echo'");
  wf.chain('Webhook POST', 'Verify Signature', 'Split Events', 'Is Echo?');

  // Customer message branch (false output of Is Echo?)
  dataTable(wf, 'Dedupe', [900, 560], 'processed_messages', 'rowNotExists', filters([['mid', 'eq', '={{ $json.mid }}']]));
  dataTable(wf, 'Mark Processed', [1120, 560], 'processed_messages', 'insert',
    columns({ mid: "={{ $('Split Events').item.json.mid }}", received_at: `=${NOW}` }));
  dataTable(wf, 'Upsert Conversation', [1340, 560], 'conversations', 'upsert',
    {
      ...filters([['igsid', 'eq', "={{ $('Split Events').item.json.igsid }}"]]),
      ...columns({
        igsid: "={{ $('Split Events').item.json.igsid }}",
        last_customer_msg_at: "={{ new Date($('Split Events').item.json.ts).toISOString() }}",
        updated_at: `=${NOW}`,
      }),
    });
  dataTable(wf, 'Store Inbound', [1560, 560], 'messages', 'insert',
    columns({
      igsid: "={{ $('Split Events').item.json.igsid }}", direction: 'in', sender: 'customer',
      text: "={{ $('Split Events').item.json.text }}", mid: "={{ $('Split Events').item.json.mid }}", created_at: `=${NOW}`,
    }));
  dataTable(wf, 'Get Conversation', [1780, 560], 'conversations', 'get',
    { ...filters([['igsid', 'eq', "={{ $('Split Events').item.json.igsid }}"]]), limit: 1 }, { alwaysOutputData: true });
  dataTable(wf, 'Get Mode', [1890, 560], 'config', 'get', { ...filters([['key', 'eq', 'bot_mode']]), limit: 1 }, { alwaysOutputData: true });
  wf.add('Read system.md', 'n8n-nodes-base.readWriteFile', 1, [2000, 560], {
    operation: 'read', fileSelector: '/data/prompts/system.md', options: { dataPropertyName: 'data' },
  });
  code(wf, 'Decode Prompt', [2220, 560], DECODE_PROMPT);
  code(wf, 'Gate', [2440, 560], GATE);
  wf.add('Route', 'n8n-nodes-base.switch', 3.2, [2660, 560], {
    rules: {
      values: ['direct', 'llm'].map((v, i) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{ id: `route-${i}`, leftValue: '={{ $json.route }}', rightValue: v, operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        renameOutput: true, outputKey: v,
      })),
    },
    options: { fallbackOutput: 'none' },
  });
  wf.connect('Is Echo?', 'Dedupe', 1);
  wf.chain('Dedupe', 'Mark Processed', 'Upsert Conversation', 'Store Inbound', 'Get Conversation', 'Get Mode', 'Read system.md', 'Decode Prompt', 'Gate', 'Route');

  // direct handoff (human request, attachment, card number): no LLM
  code(wf, 'Direct Decision', [2900, 440], DIRECT_DECISION);
  wf.connect('Route', 'Direct Decision', 0);

  // LLM path
  wf.add('Debounce Wait', 'n8n-nodes-base.wait', 1.1, [2900, 700], {
    resume: 'timeInterval', amount: '={{ Math.max(0, Number($env.DEBOUNCE_SECONDS || 6)) }}', unit: 'seconds',
  }, { webhookId: 'a1c0f2b4-3333-4a6e-9c01-0000000000a3' });
  dataTable(wf, 'Get History', [3120, 700], 'messages', 'get',
    { ...filters([['igsid', 'eq', '={{ $json.igsid }}']]), returnAll: true }, { alwaysOutputData: true });
  code(wf, 'Debounce Check', [3340, 700], DEBOUNCE_CHECK, 'runOnceForAllItems');
  wf.add('Read shop.md', 'n8n-nodes-base.readWriteFile', 1, [3560, 700], {
    operation: 'read', fileSelector: '/data/knowledge/shop.md', options: { dataPropertyName: 'data' },
  });
  code(wf, 'Decode Shop', [3780, 700], DECODE_SHOP);
  code(wf, 'Build LLM Request', [4000, 700], BUILD_LLM);
  wf.add('Call LLM', 'n8n-nodes-base.httpRequest', 4.2, [4220, 700], {
    method: 'POST',
    url: "={{ ($env.ANTHROPIC_API_BASE || 'https://api.anthropic.com') }}/v1/messages",
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'x-api-key', value: '={{ $env.ANTHROPIC_API_KEY }}' },
      { name: 'anthropic-version', value: '2023-06-01' },
      { name: 'content-type', value: 'application/json' },
    ] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.llm_request) }}',
    options: { timeout: 45000 },
  }, { onError: 'continueRegularOutput' });
  code(wf, 'Parse LLM', [4440, 700], PARSE_LLM);
  ifNode(wf, 'Retry?', [4660, 700], '$json.retry === true');
  wf.connect('Route', 'Debounce Wait', 1);
  wf.chain('Debounce Wait', 'Get History', 'Debounce Check', 'Read shop.md', 'Decode Shop', 'Build LLM Request', 'Call LLM', 'Parse LLM', 'Retry?');
  wf.connect('Retry?', 'Call LLM', 0); // loop: one retry

  // Compose + deliver
  code(wf, 'Compose', [4900, 560], COMPOSE);
  wf.connect('Direct Decision', 'Compose');
  wf.connect('Retry?', 'Compose', 1);

  // auto: send via Instagram API
  ifNode(wf, 'Send Auto?', [5140, 360], '$json.send_auto === true');
  dataTable(wf, 'Get Token', [5360, 360], 'config', 'get', { ...filters([['key', 'eq', 'ig_access_token']]), limit: 1 }, { alwaysOutputData: true });
  code(wf, 'Expand Chunks', [5580, 360], EXPAND_CHUNKS_ALL, 'runOnceForAllItems');
  wf.add('Send IG Message', 'n8n-nodes-base.httpRequest', 4.2, [5800, 360], {
    method: 'POST',
    url: "={{ $env.IG_GRAPH_BASE }}/{{ $env.IG_GRAPH_VERSION }}/me/messages",
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'Authorization', value: '=Bearer {{ $json.token }}' },
      { name: 'Content-Type', value: 'application/json' },
    ] },
    sendBody: true, specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ recipient: { id: $json.igsid }, message: { text: $json.text } }) }}',
    options: { timeout: 20000, batching: { batch: { batchSize: 1, batchInterval: 500 } } },
  }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' });
  dataTable(wf, 'Store Bot Message', [6020, 280], 'messages', 'insert',
    columns({
      igsid: "={{ $('Expand Chunks').item.json.igsid }}", direction: 'out', sender: 'bot',
      text: "={{ $('Expand Chunks').item.json.text }}", mid: '={{ $json.message_id }}', created_at: `=${NOW}`,
    }));
  dataTable(wf, 'Mark Disclosed', [6240, 280], 'conversations', 'update',
    {
      ...filters([['igsid', 'eq', "={{ $('Expand Chunks').item.json.igsid }}"]]),
      ...columns({ disclosed: true, language: "={{ $('Expand Chunks').item.json.language }}", updated_at: `=${NOW}` }),
    });
  code(wf, 'Format Send Error', [6020, 460], SEND_ERROR_TEXT);
  telegram(wf, 'Telegram Send Error', [6240, 460], '$json.alert');
  wf.connect('Compose', 'Send Auto?');
  wf.connect('Send Auto?', 'Get Token', 0);
  wf.chain('Get Token', 'Expand Chunks', 'Send IG Message');
  wf.connect('Send IG Message', 'Store Bot Message', 0);
  wf.connect('Send IG Message', 'Format Send Error', 1);
  wf.connect('Store Bot Message', 'Mark Disclosed');
  wf.connect('Format Send Error', 'Telegram Send Error');

  // shadow: draft to Telegram, nothing sent
  ifNode(wf, 'Send Shadow?', [5140, 640], '$json.send_shadow === true');
  telegram(wf, 'Telegram Shadow Draft', [5360, 640], '$json.shadow_msg');
  wf.connect('Compose', 'Send Shadow?');
  wf.connect('Send Shadow?', 'Telegram Shadow Draft', 0);

  // handoff: pause the bot for this customer + alert Ali
  ifNode(wf, 'Handoff?', [5140, 900], '$json.do_handoff === true');
  dataTable(wf, 'Set Handoff', [5360, 900], 'conversations', 'update',
    {
      ...filters([['igsid', 'eq', '={{ $json.igsid }}']]),
      ...columns({ status: 'human', paused_until: '={{ $json.paused_until }}', language: '={{ $json.language }}', updated_at: `=${NOW}` }),
    });
  telegram(wf, 'Telegram Handoff Alert', [5580, 900], "$('Compose').item.json.handoff_msg");
  wf.connect('Compose', 'Handoff?');
  wf.connect('Handoff?', 'Set Handoff', 0);
  wf.chain('Set Handoff', 'Telegram Handoff Alert');

  // echo branch: owner takeover detection (true output of Is Echo?)
  wf.add('Echo Wait', 'n8n-nodes-base.wait', 1.1, [900, 240], {
    resume: 'timeInterval', amount: 5, unit: 'seconds',
  }, { webhookId: 'a1c0f2b4-4444-4a6e-9c01-0000000000a4' });
  code(wf, 'Echo Prepare', [1120, 240], ECHO_PREPARE);
  dataTable(wf, 'Typed By Owner?', [1340, 240], 'messages', 'rowNotExists', filters([['mid', 'eq', '={{ $json.mid }}']]));
  dataTable(wf, 'Pause For Owner', [1560, 240], 'conversations', 'upsert',
    {
      ...filters([['igsid', 'eq', "={{ $('Echo Prepare').item.json.igsid }}"]]),
      ...columns({ igsid: "={{ $('Echo Prepare').item.json.igsid }}", status: 'human', paused_until: "={{ $('Echo Prepare').item.json.paused_until }}", updated_at: `=${NOW}` }),
    });
  dataTable(wf, 'Store Owner Message', [1780, 240], 'messages', 'insert',
    columns({
      igsid: "={{ $('Echo Prepare').item.json.igsid }}", direction: 'out', sender: 'owner',
      text: "={{ $('Echo Prepare').item.json.text }}", mid: "={{ $('Echo Prepare').item.json.mid }}", created_at: `=${NOW}`,
    }));
  wf.connect('Is Echo?', 'Echo Wait', 0);
  wf.chain('Echo Wait', 'Echo Prepare', 'Typed By Owner?', 'Pause For Owner', 'Store Owner Message');

  return wf;
}

module.exports = { build };
