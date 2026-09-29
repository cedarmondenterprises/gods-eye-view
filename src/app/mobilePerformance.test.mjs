import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseViewerPerformanceProfile } from './mobilePerformance.js';

test('desktop keeps the full quality viewer profile', () => {
  assert.deepEqual(
    chooseViewerPerformanceProfile({
      width: 1440,
      coarsePointer: false,
      deviceMemory: 16,
      hardwareConcurrency: 12,
    }),
    {
      name: 'desktop',
      mobile: false,
      constrained: false,
      targetFrameRate: 60,
      msaaSamples: 4,
      resolutionScale: 1,
    },
  );
});

test('phone profile lowers frame rate, MSAA and render resolution modestly', () => {
  const profile = chooseViewerPerformanceProfile({
    width: 412,
    coarsePointer: true,
    deviceMemory: 8,
    hardwareConcurrency: 8,
  });
  assert.equal(profile.name, 'mobile');
  assert.equal(profile.targetFrameRate, 45);
  assert.equal(profile.msaaSamples, 2);
  assert.equal(profile.resolutionScale, 0.85);
});

test('constrained phone selects the battery-friendly profile', () => {
  const profile = chooseViewerPerformanceProfile({
    width: 360,
    coarsePointer: true,
    deviceMemory: 4,
    hardwareConcurrency: 4,
  });
  assert.equal(profile.name, 'mobile-lite');
  assert.equal(profile.targetFrameRate, 30);
  assert.equal(profile.msaaSamples, 1);
  assert.equal(profile.resolutionScale, 0.7);
});
