import test from 'node:test';
import assert from 'node:assert/strict';
import { trafficNeedsAnimation } from './lifecycle.js';

test('keyless traffic keeps the per-frame animator', () => {
  assert.equal(
    trafficNeedsAnimation({ liveMode: false, liveFlowOnly: true, dotCount: 0 }),
    true,
  );
});

test('live road-flow mode sleeps after synthetic dots are gone', () => {
  assert.equal(
    trafficNeedsAnimation({ liveMode: true, liveFlowOnly: true, dotCount: 0 }),
    false,
  );
});

test('live road-flow mode keeps rendering until old dots retire', () => {
  assert.equal(
    trafficNeedsAnimation({ liveMode: true, liveFlowOnly: true, dotCount: 12 }),
    true,
  );
});
