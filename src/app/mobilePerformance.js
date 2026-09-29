const finitePositive = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

/**
 * Pick a conservative Cesium render profile from browser capability hints.
 * Cesium already uses browser-recommended CSS-pixel resolution by default, so
 * mobile resolutionScale stays close to 1 rather than compensating for DPR.
 * The profile only changes rendering cost; it never changes data sources.
 */
export function chooseViewerPerformanceProfile({
  width = Infinity,
  coarsePointer = false,
  deviceMemory = Infinity,
  hardwareConcurrency = Infinity,
} = {}) {
  const viewportWidth = finitePositive(width, Infinity);
  const memory = finitePositive(deviceMemory, Infinity);
  const cores = finitePositive(hardwareConcurrency, Infinity);
  const mobile = Boolean(coarsePointer) || viewportWidth <= 900;
  const constrained = mobile && (memory <= 4 || cores <= 4);

  if (!mobile) {
    return {
      name: 'desktop',
      mobile: false,
      constrained: false,
      targetFrameRate: 60,
      msaaSamples: 4,
      resolutionScale: 1,
    };
  }

  return {
    name: constrained ? 'mobile-lite' : 'mobile',
    mobile: true,
    constrained,
    targetFrameRate: constrained ? 30 : 45,
    msaaSamples: constrained ? 1 : 2,
    resolutionScale: constrained ? 0.7 : 0.85,
  };
}

/** Read optional browser hints without making them hard requirements. */
export function detectViewerPerformanceProfile({
  windowRef = globalThis.window,
  navigatorRef = globalThis.navigator,
} = {}) {
  const coarsePointer = Boolean(
    windowRef?.matchMedia?.('(pointer: coarse)')?.matches ||
    Number(navigatorRef?.maxTouchPoints) > 0,
  );
  return chooseViewerPerformanceProfile({
    width: windowRef?.innerWidth,
    coarsePointer,
    deviceMemory: navigatorRef?.deviceMemory,
    hardwareConcurrency: navigatorRef?.hardwareConcurrency,
  });
}
