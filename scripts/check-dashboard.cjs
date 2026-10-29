#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboard = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dashboards', 'guestbook.json'), 'utf8'));
assert.equal(dashboard.uid, 'guestbook-overview');
assert(dashboard.panels.length >= 5);
const ids = new Set();
for (const panel of dashboard.panels) {
  assert(!ids.has(panel.id), `Duplicate panel ID: ${panel.id}`);
  ids.add(panel.id);
  assert(panel.title && panel.gridPos && panel.datasource?.uid === 'prometheus');
  assert(panel.targets?.every(t => typeof t.expr === 'string' && t.expr.length > 0));
}
const expressions = dashboard.panels.flatMap(p => p.targets.map(t => t.expr)).join('\n');
for (const metric of ['probe_success', 'probe_duration_seconds', 'redis_commands_processed_total', 'container_cpu_usage_seconds_total', 'container_memory_working_set_bytes']) {
  assert(expressions.includes(metric), `Missing metric: ${metric}`);
}
console.log(`Dashboard OK: ${dashboard.panels.length} panels and all required monitoring metrics present.`);
