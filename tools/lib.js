// Small helpers for generating n8n workflow JSON. Used only by tools/build-workflows.js.
const crypto = require('crypto');

const uid = (seed) => {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

class Workflow {
  constructor(id, name, settings = {}) {
    this.id = id;
    this.name = name;
    this.nodes = [];
    this.connections = {};
    this.settings = { executionOrder: 'v1', ...settings };
  }

  add(name, type, typeVersion, position, parameters = {}, extra = {}) {
    if (this.nodes.some((n) => n.name === name)) throw new Error(`duplicate node ${name}`);
    this.nodes.push({
      parameters,
      id: uid(`${this.id}:${name}`),
      name,
      type,
      typeVersion,
      position,
      ...extra,
    });
    return name;
  }

  // connect(from, to) or connect(from, to, outputIndex)
  connect(from, to, output = 0) {
    const c = (this.connections[from] ||= { main: [] });
    while (c.main.length <= output) c.main.push([]);
    c.main[output].push({ node: to, type: 'main', index: 0 });
  }

  chain(...names) {
    for (let i = 0; i < names.length - 1; i++) this.connect(names[i], names[i + 1]);
  }

  toJSON() {
    const names = new Set(this.nodes.map((n) => n.name));
    for (const [from, c] of Object.entries(this.connections)) {
      if (!names.has(from)) throw new Error(`connection from unknown node ${from}`);
      for (const outs of c.main) for (const t of outs) if (!names.has(t.node)) throw new Error(`connection to unknown node ${t.node}`);
    }
    return {
      id: this.id,
      name: this.name,
      nodes: this.nodes,
      connections: this.connections,
      settings: this.settings,
      pinData: {},
      meta: { templateCredsSetupCompleted: true },
    };
  }
}

// n8n resolves a table "by name" with a substring match (take 1), so 'messages' can hit 'processed_messages'.
// Every table therefore gets a distinctive prefix in which no name is a substring of another.
const TABLE_PREFIX = 'igdm_';
const table = (name) => ({ __rl: true, mode: 'name', value: TABLE_PREFIX + name });

const filters = (conds) => ({
  matchType: 'allConditions',
  filters: { conditions: conds.map(([keyName, condition, keyValue]) => ({ keyName, condition, keyValue })) },
});

const columns = (value) => ({
  columns: {
    mappingMode: 'defineBelow',
    value,
    matchingColumns: [],
    schema: [],
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  },
});

const dataTable = (wf, name, pos, tableName, operation, params = {}, extra = {}) =>
  wf.add(name, 'n8n-nodes-base.dataTable', 1.1, pos, { operation, dataTableId: table(tableName), ...params }, extra);

const code = (wf, name, pos, jsCode, mode = 'runOnceForEachItem', extra = {}) =>
  wf.add(name, 'n8n-nodes-base.code', 2, pos, { mode, jsCode }, extra);

// IF node (v2.2) with a single boolean expression
const ifNode = (wf, name, pos, expr) =>
  wf.add(name, 'n8n-nodes-base.if', 2.2, pos, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: uid(`${wf.id}:${name}:cond`),
          leftValue: `={{ ${expr} }}`,
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    options: {},
  });

const telegram = (wf, name, pos, textExpr, extra = {}) =>
  wf.add(
    name,
    'n8n-nodes-base.httpRequest',
    4.2,
    pos,
    {
      method: 'POST',
      url: "={{ ($env.TELEGRAM_API_BASE || 'https://api.telegram.org') }}/bot{{ $env.TELEGRAM_BOT_TOKEN }}/sendMessage",
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({ chat_id: $env.TELEGRAM_CHAT_ID, text: String(${textExpr}).slice(0, 3900) }) }}`,
      options: { timeout: 15000 },
    },
    extra,
  );

module.exports = { TABLE_PREFIX, Workflow, uid, table, filters, columns, dataTable, code, ifNode, telegram };
