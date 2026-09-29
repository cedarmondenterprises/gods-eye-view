const MOBILE_VIEWPORT_MAX_PX = 900;

function finitePositive(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Resolve a conservative rendering/work budget from runtime capabilities.
 * Pure so mobile detection stays deterministic in tests and never depends on
 * user-agent strings.
 */
export function resolveMobilePerformanceProfile({
  viewportWidth = Infinity,
  coarsePointer = false,
  touchPoints = 0,
  deviceMemory = null,
  hardwareConcurrency = null,
  force = 'auto',
} = {}) {
  const width = finitePositive(viewportWidth) ?? Infinity;
  const touches = finitePositive(touchPoints) ?? 0;
  const memory = finitePositive(deviceMemory);
  const cores = finitePositive(hardwareConcurrency);
  const forcedMobile = force === 'mobile';
  const forcedDesktop = force === 'desktop';
  const touchRuntime = coarsePointer === true || touches > 0;
  const mobile = forcedMobile || (!forcedDesktop && touchRuntime && width <= MOBILE_VIEWPORT_MAX_PX);
  const constrained =
    mobile &&
    ((memory !== null && memory <= 4) || (cores !== null && cores <= 4));

  if (!mobile) {
    return Object.freeze({
      tier: 'desktop',
      mobile: false,
      constrained: false,
      targetFrameRate: 60,
      msaaSamples: 4,
      resolutionScale: 1,
      globeMaximumScreenSpaceError: 2,
      cctvGeometryLimit: Infinity,
    });
  }

  return Object.freeze({
    tier: constrained ? 'mobile-low' : 'mobile',
    mobile: true,
    constrained,
    targetFrameRate: 30,
    msaaSamples: 1,
    resolutionScale: constrained ? 0.75 : 0.85,
    globeMaximumScreenSpaceError: constrained ? 4 : 3,
    // Only refine the nearest camera geometry eagerly. A camera selected later
    // still gets an immediate real geometry/ground refresh in selection.js.
    cctvGeometryLimit: constrained ? 160 : 320,
  });
}

/** Read the current browser once at the point work is scheduled. */
export function currentMobilePerformanceProfile() {
  if (typeof window === 'undefined') return resolveMobilePerformanceProfile();

  let force = 'auto';
  try {
    const requested = new URLSearchParams(window.location?.search || '').get('perf');
    if (requested === 'mobile' || requested === 'desktop') force = requested;
  } catch {
    // Ignore malformed/non-browser locations and keep automatic selection.
  }

  let coarsePointer = false;
  try {
    coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches === true;
  } catch {
    coarsePointer = false;
  }

  const nav = window.navigator || globalThis.navigator || {};
  return resolveMobilePerformanceProfile({
    viewportWidth: window.innerWidth,
    coarsePointer,
    touchPoints: nav.maxTouchPoints,
    deviceMemory: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
    force,
  });
}
