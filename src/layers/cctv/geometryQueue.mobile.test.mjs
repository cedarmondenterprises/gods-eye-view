import test from 'node:test';
import assert from 'node:assert/strict';
import { cctvEagerGeometryLimit } from './geometryQueue.js';

test('desktop keeps the complete CCTV geometry catalog', () => {
  assert.equal(
    cctvEagerGeometryLimit({
      width: 1440,
      coarsePointer: false,
      touchPoints: 0,
      deviceMemory: 16,
      hardwareConcurrency: 12,
    }),
    Infinity,
  );
});

test('mobile bounds eager CCTV geometry work', () => {
  assert.equal(
    cctvEagerGeometryLimit({
      width: 420,
      coarsePointer: true,
      touchPoints: 5,
      deviceMemory: 8,
      hardwareConcurrency: 8,
    }),
    320,
  );
});

test('constrained mobile uses the smaller CCTV geometry budget', () => {
  assert.equal(
    cctvEagerGeometryLimit({
      width: 420,
      coarsePointer: true,
      touchPoints: 5,
      deviceMemory: 4,
      hardwareConcurrency: 4,
    }),
    160,
  );
});
