import {
  ACTIVE_FRAME_REFRESH_MS,
  FRAME_ENDPOINT,
  MEDIA_ENDPOINT,
} from './sourcePolicy.js';

function safeNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function frameUrlFor(camera, refreshMs = ACTIVE_FRAME_REFRESH_MS) {
  const cadenceMs = Math.max(
    1000,
    safeNumber(refreshMs, ACTIVE_FRAME_REFRESH_MS),
  );
  const tick = Math.floor(Date.now() / cadenceMs);
  const params = new URLSearchParams({
    label: camera.name,
    city: camera.city,
    lat: camera.lat.toFixed(6),
    lon: camera.lon.toFixed(6),
    heading: String(Math.round(camera.headingDeg)),
    fov: String(Math.round(camera.fovDeg)),
    pitch: String(Math.round(camera.pitchDeg || -10)),
    ts: String(tick),
  });
  return `${FRAME_ENDPOINT}/${encodeURIComponent(camera.id)}?${params.toString()}`;
}

function mediaUrlFor(camera) {
  return `${MEDIA_ENDPOINT}/${encodeURIComponent(camera.id)}?ts=${Math.floor(Date.now() / 15000)}`;
}

/** Pick a smaller camera registry for mobile without changing provider data. */
export function cctvCatalogLimit({
  width = globalThis.window?.innerWidth,
  coarsePointer = Boolean(
    globalThis.window?.matchMedia?.('(pointer: coarse)')?.matches ||
      Number(globalThis.navigator?.maxTouchPoints) > 0,
  ),
  deviceMemory = globalThis.navigator?.deviceMemory,
} = {}) {
  const viewportWidth = Number(width);
  const memory = Number(deviceMemory);
  const mobile =
    coarsePointer || (Number.isFinite(viewportWidth) && viewportWidth <= 900);
  if (!mobile) return null;
  return Number.isFinite(memory) && memory > 0 && memory <= 4 ? 600 : 900;
}

export function cctvCatalogPath(options) {
  const max = cctvCatalogLimit(options);
  return max ? `/api/cctv/sources?max=${max}` : '/api/cctv/sources';
}

/** Supply catalog/health records and the existing registered camera URL families. */
export function createCctvSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function read(path, key, { signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl(path, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Camera source HTTP ' + response.status);
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.[key]))
      throw new Error('Malformed camera ' + key + ' snapshot');
    return payload;
  }
  return {
    async getCatalog(options) {
      const max = cctvCatalogLimit();
      const payload = await read(cctvCatalogPath(), 'sources', options);
      // Older servers ignore the `max` query parameter. Slice client-side too
      // so a phone never constructs thousands of billboard/geometry records.
      if (max && payload.sources.length > max)
        payload.sources = payload.sources.slice(0, max);
      return payload;
    },
    getHealth(options) {
      return read('/api/cctv/health', 'cameras', options);
    },
    getFrameUrl: frameUrlFor,
    getMediaUrl: mediaUrlFor,
  };
}
