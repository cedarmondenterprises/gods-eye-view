import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installLiveFlowPresentation,
  resolveLiveFlowLineCap,
  summarizeRoads,
} from './liveFlowPresentation.js';

test('live road-flow summary counts matched roads without inventing vehicles', () => {
  const summary = summarizeRoads([
    { flow: { level: 0.95, closure: false } },
    { source: { flow: { level: 0.7, closure: false } } },
    { flow: { level: 0.2, closure: false } },
    { flow: null },
    { flow: { level: 0, closure: true } },
  ]);

  assert.deepEqual(summary.buckets, {
    free: 1,
    slow: 1,
    jam: 1,
    sim: 0,
  });
  assert.equal(summary.eligible, 4);
  assert.equal(summary.matched, 3);
  assert.equal(summary.closed, 1);
  assert.equal(summary.coveragePct, 75);
});

test('live flow geometry budget is smaller on touch and constrained devices', () => {
  assert.equal(resolveLiveFlowLineCap({ width: 1440, deviceMemory: 16 }), 600);
  assert.equal(resolveLiveFlowLineCap({ width: 900, deviceMemory: 8 }), 450);
  assert.equal(resolveLiveFlowLineCap({ width: 390, deviceMemory: 8 }), 320);
  assert.equal(
    resolveLiveFlowLineCap({
      width: 1440,
      coarsePointer: true,
      deviceMemory: 16,
    }),
    320,
  );
});

test('installer preserves traffic preferences and suppresses synthetic live contacts', () => {
  const state = {
    _uncoveredMode: 'sim',
    _jamViz: 'density',
    _liveMode: true,
    _roads: [{ flow: { level: 0.95, closure: false } }],
    _roadSource: 'OpenStreetMap',
    _flowError: null,
    _liveFlowLineCount: 0,
  };
  const parts = {
    rendering: {
      removeHeatLines() {},
      rebuildHeatLines() {},
      visibleRoadsForAltitude: (roads) => roads,
    },
    animation: {
      animate() {},
    },
    model: {
      recolorDotsInPlace() {},
    },
    controls: {
      methods: {
        getDetectableObjects: () => [{ id: 'VEH-0001' }],
        getStats: () => ({
          count: 999,
          loading: false,
          error: null,
          flowBuckets: { free: 0, slow: 0, jam: 0, sim: 999 },
        }),
      },
    },
  };

  installLiveFlowPresentation({
    state,
    services: { credits: {}, render: {} },
    parts,
  });

  assert.equal(state._uncoveredMode, 'sim');
  assert.equal(state._jamViz, 'density');
  assert.deepEqual(parts.controls.methods.getDetectableObjects(), []);

  const stats = parts.controls.methods.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.flowCoveragePct, 100);
  assert.equal(stats.syntheticVehiclesHidden, true);
  assert.equal(stats.staticFlow, true);
  assert.match(stats.loadingLabel, /Road flow only/);
});
