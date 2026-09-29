import assert from 'node:assert/strict';
import test from 'node:test';
import * as alertManager from '../src/alertManager.js';

test('ALERT_CONDITIONS is exported via ESM namespace import', () => {
  assert.ok(alertManager.ALERT_CONDITIONS);
  assert.equal(alertManager.ALERT_CONDITIONS.INDEXER_DOWN, 'INDEXER_DOWN');
  assert.equal(alertManager.ALERT_CONDITIONS.REORG_DETECTED, 'REORG_DETECTED');
});
