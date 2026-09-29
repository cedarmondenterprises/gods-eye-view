import * as Cesium from 'cesium';
import { flowBucket } from '../../data/trafficFlowStyle.js';

const DESKTOP_FLOW_LINE_CAP = 600;
const MOBILE_FLOW_LINE_CAP = 320;
const MID_FLOW_LINE_CAP = 450;
const LIVE_FLOW_WIDTH = {
  free: 3,
  slow: 4,
  jam: 5,
};
const LIVE_FLOW_ALPHA = {
  free: 0.55,
  slow: 0.68,
  jam: 0.82,
};
const BUCKET_PRIORITY = { jam: 0, slow: 1, free: 2 };

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Bound static traffic geometry according to the display/device budget. */
export function resolveLiveFlowLineCap({
  width = Infinity,
  coarsePointer = false,
  deviceMemory = Infinity,
} = {}) {
  const viewportWidth = finitePositive(width, Infinity);
  const memory = finitePositive(deviceMemory, Infinity);
  if (coarsePointer || viewportWidth <= 720 || memory <= 4)
    return MOBILE_FLOW_LINE_CAP;
  if (viewportWidth <= 1100 || memory <= 8) return MID_FLOW_LINE_CAP;
  return DESKTOP_FLOW_LINE_CAP;
}

function runtimeLiveFlowLineCap() {
  const windowRef = globalThis.window;
  const navigatorRef = globalThis.navigator;
  return resolveLiveFlowLineCap({
    width: windowRef?.innerWidth,
    coarsePointer: Boolean(
      windowRef?.matchMedia?.('(pointer: coarse)')?.matches ||
      Number(navigatorRef?.maxTouchPoints) > 0,
    ),
    deviceMemory: navigatorRef?.deviceMemory,
  });
}

function roadFlow(road) {
  return road?.source ? road.source.flow : road?.flow;
}

function roadLength(road) {
  if (Array.isArray(road?.segmentDist) && road.segmentDist.length)
    return road.segmentDist.reduce(
      (sum, value) => sum + (Number(value) || 0),
      0,
    );
  return Array.isArray(road?.waypoints) ? road.waypoints.length : 0;
}

function positionSignature(point) {
  if (!point) return '0,0,0';
  return `${Math.round(point.x || 0)},${Math.round(point.y || 0)},${Math.round(point.z || 0)}`;
}

function activeColorSignature(state) {
  return ['free', 'slow', 'jam']
    .map((bucket) => {
      const color = state._activeBucketColors?.[bucket];
      if (!color) return bucket;
      return `${bucket}:${color.red?.toFixed?.(3)},${color.green?.toFixed?.(3)},${color.blue?.toFixed?.(3)},${color.alpha?.toFixed?.(3)}`;
    })
    .join('|');
}

function candidateSignature(candidates, state) {
  const roads = candidates
    .map(({ road, bucket }) => {
      const points = road.waypoints || [];
      const first = points[0];
      const middle = points[Math.floor(points.length / 2)];
      const last = points.at(-1);
      return `${road.key || ''}:${bucket}:${points.length}:${positionSignature(first)}:${positionSignature(middle)}:${positionSignature(last)}`;
    })
    .join(';');
  return `${state._stylePreset || 'normal'}|${activeColorSignature(state)}|${roads}`;
}

export function summarizeRoads(roads) {
  const buckets = { free: 0, slow: 0, jam: 0, sim: 0 };
  let eligible = 0;
  let matched = 0;
  let closed = 0;

  for (const road of roads || []) {
    const flow = roadFlow(road);
    if (flow?.closure) {
      closed += 1;
      continue;
    }
    eligible += 1;
    if (!flow) continue;
    const bucket = flowBucket(flow.level);
    if (!bucket) continue;
    buckets[bucket] += 1;
    matched += 1;
  }

  return {
    buckets,
    eligible,
    matched,
    closed,
    coveragePct: eligible ? Math.round((matched / eligible) * 100) : 0,
  };
}

/**
 * Install the fork's data-integrity traffic presentation.
 *
 * TomTom supplies road-flow conditions, not individual vehicle locations. In
 * live mode this presentation therefore suppresses synthetic VEH-* contacts
 * and moving traffic dots, and draws static road corridors from the matched
 * TomTom flow instead. Keyless mode keeps the upstream simulation unchanged.
 */
export function installLiveFlowPresentation({ state, services, parts }) {
  state._liveFlowOnly = true;
  state._liveFlowPrimitives = { free: null, slow: null, jam: null };
  state._liveFlowLineCount = 0;
  state._liveFlowLineSupported = null;
  state._liveFlowSignature = null;
  state._liveFlowLineCap = runtimeLiveFlowLineCap();

  const originalRebuildHeatLines = parts.rendering.rebuildHeatLines;
  const originalRemoveHeatLines = parts.rendering.removeHeatLines;
  const originalRecolorDots = parts.model.recolorDotsInPlace;
  const originalGetStats = parts.controls.methods.getStats;
  const originalGetDetectableObjects =
    parts.controls.methods.getDetectableObjects;

  function removeLiveFlowLines({ clearSignature = true } = {}) {
    const primitives = state._viewer?.scene?.groundPrimitives;
    if (primitives) {
      for (const bucket of ['free', 'slow', 'jam']) {
        const primitive = state._liveFlowPrimitives?.[bucket];
        if (primitive) primitives.remove(primitive);
      }
    }
    state._liveFlowPrimitives = { free: null, slow: null, jam: null };
    state._liveFlowLineCount = 0;
    if (clearSignature) state._liveFlowSignature = null;
  }

  function liveCandidates(roads) {
    const candidates = [];
    for (const road of roads || []) {
      const flow = roadFlow(road);
      if (!flow || flow.closure || !Array.isArray(road.waypoints)) continue;
      if (road.waypoints.length < 2) continue;
      const bucket = flowBucket(flow.level);
      if (!bucket) continue;
      candidates.push({ road, bucket, length: roadLength(road) });
    }
    candidates.sort((a, b) => {
      const byBucket = BUCKET_PRIORITY[a.bucket] - BUCKET_PRIORITY[b.bucket];
      return byBucket || b.length - a.length;
    });
    return candidates;
  }

  function rebuildLiveFlowLines(roads) {
    if (!state._liveMode || !state._viewer) return;
    const groundPrimitives = state._viewer.scene?.groundPrimitives;
    if (!groundPrimitives) return;

    if (state._liveFlowLineSupported === null) {
      state._liveFlowLineSupported = Cesium.GroundPolylinePrimitive.isSupported(
        state._viewer.scene,
      );
      if (!state._liveFlowLineSupported)
        console.warn(
          '[Data:Traffic] Ground polylines unsupported — live road-flow overlay disabled',
        );
    }
    if (!state._liveFlowLineSupported) return;

    const allCandidates = liveCandidates(roads);
    const lineCap = state._liveFlowLineCap || DESKTOP_FLOW_LINE_CAP;
    const candidates = allCandidates.slice(0, lineCap);
    const signature = candidateSignature(candidates, state);
    if (signature === state._liveFlowSignature) return;

    removeLiveFlowLines({ clearSignature: false });
    originalRemoveHeatLines();
    services.credits?.hideOsmCredit?.(state._viewer, 'traffic');

    const byBucket = { free: [], slow: [], jam: [] };
    for (const candidate of candidates)
      byBucket[candidate.bucket].push(candidate);

    for (const bucket of ['free', 'slow', 'jam']) {
      if (!byBucket[bucket].length) continue;
      const instances = byBucket[bucket].map(
        ({ road }) =>
          new Cesium.GeometryInstance({
            geometry: new Cesium.GroundPolylineGeometry({
              positions: road.waypoints,
              width: LIVE_FLOW_WIDTH[bucket],
            }),
          }),
      );
      const baseColor =
        state._activeBucketColors?.[bucket] ||
        {
          free: Cesium.Color.fromCssColorString('#2ecc71'),
          slow: Cesium.Color.fromCssColorString('#f0b23e'),
          jam: Cesium.Color.fromCssColorString('#e05252'),
        }[bucket];
      const primitive = groundPrimitives.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: instances,
          classificationType: Cesium.ClassificationType.BOTH,
          appearance: new Cesium.PolylineMaterialAppearance({
            material: Cesium.Material.fromType('Color', {
              color: baseColor.withAlpha(LIVE_FLOW_ALPHA[bucket]),
            }),
          }),
        }),
      );
      state._liveFlowPrimitives[bucket] = primitive;
    }

    state._liveFlowSignature = signature;
    state._liveFlowLineCount = candidates.length;
    state._heatLineCount = candidates.length;

    if (candidates.some(({ road }) => !road.directFlow))
      services.credits?.showOsmCredit?.(state._viewer, 'traffic', {
        openMapTiles: true,
      });

    if (allCandidates.length > lineCap)
      console.log(
        `[Data:Traffic] Live flow corridors capped at ${lineCap} for this device`,
      );

    services.render?.governorRequestRender?.('traffic-live-flow');
  }

  parts.rendering.removeHeatLines = function removeAllTrafficLines() {
    removeLiveFlowLines();
    originalRemoveHeatLines();
  };

  parts.rendering.rebuildHeatLines = function rebuildTrafficLines(roads) {
    if (state._liveMode && state._liveFlowOnly) rebuildLiveFlowLines(roads);
    else originalRebuildHeatLines(roads);
  };

  parts.model.recolorDotsInPlace = function recolorOrRefreshLiveFlow(label) {
    if (state._liveMode && state._liveFlowOnly) {
      const roads = parts.rendering.visibleRoadsForAltitude(
        state._roads,
        state._lastRenderAltitude,
      );
      rebuildLiveFlowLines(roads);
      return;
    }
    originalRecolorDots(label);
  };

  parts.controls.methods.getDetectableObjects = function getHonestDetectables(
    options = {},
  ) {
    if (state._liveMode && state._liveFlowOnly) return [];
    return originalGetDetectableObjects(options);
  };

  parts.controls.methods.getStats = function getLiveFlowStats() {
    const stats = originalGetStats();
    if (!state._liveMode || !state._liveFlowOnly) return stats;

    const summary = summarizeRoads(state._roads);
    stats.count = summary.matched;
    stats.flowBuckets = summary.buckets;
    stats.flowCoveragePct = summary.coveragePct;
    stats.closedRoads = summary.closed;
    stats.heatLines = state._liveFlowLineCount;
    stats.liveFlowRoads = summary.matched;
    stats.syntheticVehiclesHidden = true;
    stats.staticFlow = true;
    stats.flowLineCap = state._liveFlowLineCap;

    if (state._flowError) {
      const reason = String(state._flowError).replace(
        /^SIMULATED\s*[—-]\s*/i,
        '',
      );
      stats.error = `LIVE FLOW UNAVAILABLE — ${reason}`;
      stats.loadingLabel = stats.error;
    } else if (!stats.error) {
      const source = state._roadSource || 'OpenStreetMap';
      stats.loadingLabel = stats.loading
        ? `Syncing live TomTom flow · Roads: ${source}`
        : summary.eligible === 0
          ? `LIVE FLOW · Roads: ${source} · No roads in view`
          : summary.matched === 0
            ? `LIVE FLOW · Roads: ${source} · No TomTom flow in view`
            : `LIVE FLOW · Roads: ${source} · Coverage ${summary.coveragePct}% · Road flow only`;
    }

    return stats;
  };

  return {
    rebuildLiveFlowLines,
    removeLiveFlowLines,
    summarizeRoads,
  };
}
