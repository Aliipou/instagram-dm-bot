// Generates workflows/*.json. Run: node tools/build-workflows.js
// The JSON files are the deliverable; this script exists so they can be regenerated and reviewed as code.
const fs = require('fs');
const path = require('path');
const { build: wf1 } = require('./wf1');
const { wf2, wf3, wf4 } = require('./wf234');
const { wf5 } = require('./wf5');

const out = path.join(__dirname, '..', 'workflows');
fs.mkdirSync(out, { recursive: true });
const files = {
  'wf1-ig-webhook-reply.json': wf1(),
  'wf2-token-refresh.json': wf2(),
  'wf3-error-alert.json': wf3(),
  'wf4-retention-cleanup.json': wf4(),
  'wf5-admin-dashboard.json': wf5(),
};
for (const [name, wf] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), JSON.stringify(wf.toJSON(), null, 2) + '\n');
  console.log('wrote', name, wf.nodes.length, 'nodes');
}
