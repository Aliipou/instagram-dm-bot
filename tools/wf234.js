// WF2 token-refresh, WF3 error-alert, WF4 retention-cleanup
const { Workflow, filters, columns, dataTable, code, ifNode, telegram } = require('./lib');

const NOW = '{{ new Date().toISOString() }}';

const EVALUATE_TOKEN = String.raw`
const rows = $input.all().map((i) => i.json).filter((r) => r && r.key);
const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
if (!cfg.ig_access_token) throw new Error("config Data Table has no 'ig_access_token' row (see docs/meta-setup.md step 6)");
const now = Date.now();
const exp = cfg.ig_token_expires_at ? new Date(cfg.ig_token_expires_at).getTime() : NaN;
const daysLeft = Number.isFinite(exp) ? (exp - now) / 86400000 : null;
// A token must be at least 24 h old to be refreshed; a fresh 60-day token has > 59 days left.
const tooYoung = daysLeft !== null && daysLeft > 59;
return [{ json: { token: cfg.ig_access_token, daysLeft, needsRefresh: !tooYoung,
  expiringSoon: daysLeft !== null && daysLeft < 7,
  alert: 'Instagram token expires in ' + (daysLeft === null ? 'an unknown time' : daysLeft.toFixed(1) + ' days') + '. WF2 is refreshing it; if you keep seeing this, renew it manually (docs/meta-setup.md).' } }];
`;

const PREPARE_ROWS = String.raw`
const r = $input.first().json;
if (!r.access_token || !r.expires_in) throw new Error('refresh_access_token returned no token: ' + JSON.stringify(r).slice(0, 300));
const exp = new Date(Date.now() + Number(r.expires_in) * 1000).toISOString();
const now = new Date().toISOString();
return [
  { json: { key: 'ig_access_token', value: r.access_token, updated_at: now } },
  { json: { key: 'ig_token_expires_at', value: exp, updated_at: now } },
];
`;

const FORMAT_ERROR = String.raw`
const e = $input.first().json;
const ex = e.execution || {};
const wfn = (e.workflow || {}).name || 'unknown workflow';
const node = ex.lastNodeExecuted || 'unknown node';
const msg = (ex.error || {}).message || 'no message';
const base = ($env.WEBHOOK_URL || '').replace(/\/$/, '');
const link = base && ex.id ? base + '/workflow/' + (e.workflow || {}).id + '/executions/' + ex.id : '(no link)';
return { json: { text: 'n8n ERROR in ' + wfn + '\nNode: ' + node + '\nError: ' + String(msg).slice(0, 800) + '\nExecution: ' + link } };
`;

function wf2() {
  const wf = new Workflow('igdmWf2TokenRefr1', 'wf2-token-refresh', { errorWorkflow: 'igdmWf3ErrorAlert' });
  wf.add('Weekly', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], {
    rule: { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 4, triggerAtMinute: 0 }] },
  });
  dataTable(wf, 'Read Config', [220, 0], 'config', 'get', { returnAll: true }, { alwaysOutputData: true });
  code(wf, 'Evaluate Token', [440, 0], EVALUATE_TOKEN, 'runOnceForAllItems');
  ifNode(wf, 'Needs Refresh?', [660, -80], '$json.needsRefresh === true');
  wf.add('Refresh Token', 'n8n-nodes-base.httpRequest', 4.2, [880, -80], {
    method: 'GET', url: '={{ $env.IG_GRAPH_BASE }}/refresh_access_token',
    sendQuery: true,
    queryParameters: { parameters: [
      { name: 'grant_type', value: 'ig_refresh_token' },
      { name: 'access_token', value: '={{ $json.token }}' },
    ] },
    options: { timeout: 20000 },
  }, { retryOnFail: true, maxTries: 2, waitBetweenTries: 5000 });
  code(wf, 'Prepare Config Rows', [1100, -80], PREPARE_ROWS, 'runOnceForAllItems');
  dataTable(wf, 'Save Config', [1320, -80], 'config', 'upsert', {
    ...filters([['key', 'eq', '={{ $json.key }}']]),
    ...columns({ key: '={{ $json.key }}', value: '={{ $json.value }}', updated_at: '={{ $json.updated_at }}' }),
  });
  ifNode(wf, 'Expiring Soon?', [660, 120], '$json.expiringSoon === true');
  telegram(wf, 'Telegram Token Warning', [880, 120], '$json.alert');
  wf.chain('Weekly', 'Read Config', 'Evaluate Token');
  wf.connect('Evaluate Token', 'Needs Refresh?');
  wf.connect('Needs Refresh?', 'Refresh Token', 0);
  wf.chain('Refresh Token', 'Prepare Config Rows', 'Save Config');
  wf.connect('Evaluate Token', 'Expiring Soon?');
  wf.connect('Expiring Soon?', 'Telegram Token Warning', 0);
  return wf;
}

function wf3() {
  const wf = new Workflow('igdmWf3ErrorAlert', 'wf3-error-alert');
  wf.add('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 0], {});
  code(wf, 'Format Error', [220, 0], FORMAT_ERROR, 'runOnceForAllItems');
  telegram(wf, 'Telegram Error Alert', [440, 0], '$json.text');
  wf.chain('Error Trigger', 'Format Error', 'Telegram Error Alert');
  return wf;
}

function wf4() {
  const wf = new Workflow('igdmWf4Retention01', 'wf4-retention-cleanup', { errorWorkflow: 'igdmWf3ErrorAlert' });
  wf.add('Daily', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], {
    rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 3, triggerAtMinute: 30 }] },
  });
  const cutoff = '={{ new Date(Date.now() - Math.max(1, Number($env.RETENTION_DAYS || 30)) * 86400000).toISOString() }}';
  dataTable(wf, 'Delete Old Messages', [220, 0], 'messages', 'deleteRows', filters([['created_at', 'lt', cutoff]]), { alwaysOutputData: true, executeOnce: true });
  dataTable(wf, 'Delete Old Processed', [440, 0], 'processed_messages', 'deleteRows', filters([['received_at', 'lt', cutoff]]), { alwaysOutputData: true, executeOnce: true });
  dataTable(wf, 'Resume Bot After Pause', [660, 0], 'conversations', 'update', {
    ...filters([['status', 'eq', 'human'], ['paused_until', 'lt', `=${NOW}`]]),
    ...columns({ status: 'bot', updated_at: `=${NOW}` }),
  }, { alwaysOutputData: true, executeOnce: true });
  wf.chain('Daily', 'Delete Old Messages', 'Delete Old Processed', 'Resume Bot After Pause');
  return wf;
}

module.exports = { wf2, wf3, wf4 };
