import * as Cesium from 'cesium';
import {
  GEO_PROGRESS_NOTIFY_INTERVAL_MS,
  GEO_PROGRESS_NOTIFY_BATCH_LIMIT,
  GEO_TRACKING_BATCH_SIZE,
  GEO_TRACKING_BATCH_DELAY_MS,
  GEO_LOAD_BATCH_SIZE,
  GEO_LOAD_BATCH_DELAY_MS,
} from './policy.js';

/**
 * Mobile browsers do not need to eagerly ground every camera in a worldwide
 * catalog. The closest records are refined first and any camera selected later
 * still takes the normal explicit activation-time geometry pass.
 */
export function cctvEagerGeometryLimit({
  width = Infinity,
  coarsePointer = false,
  touchPoints = 0,
  deviceMemory = Infinity,
  hardwareConcurrency = Infinity,
} = {}) {
  const viewportWidth = Number.isFinite(Number(width))
    ? Number(width)
    : Infinity;
  const touches = Number.isFinite(Number(touchPoints))
    ? Number(touchPoints)
    : 0;
  const memory = Number.isFinite(Number(deviceMemory))
    ? Number(deviceMemory)
    : Infinity;
  const cores = Number.isFinite(Number(hardwareConcurrency))
    ? Number(hardwareConcurrency)
    : Infinity;
  const mobile = Boolean(coarsePointer) || touches > 0 || viewportWidth <= 720;
  if (!mobile) return Infinity;
  return memory <= 4 || cores <= 4 ? 160 : 320;
}

function runtimeCctvGeometryLimit() {
  if (typeof window === 'undefined') return Infinity;
  const nav = window.navigator || globalThis.navigator || {};
  let coarsePointer = false;
  try {
    coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches === true;
  } catch {
    coarsePointer = false;
  }
  return cctvEagerGeometryLimit({
    width: window.innerWidth,
    coarsePointer,
    touchPoints: nav.maxTouchPoints,
    deviceMemory: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
  });
}

export function createGeometryQueue({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Stops the staggered geometry-load queue and optionally clears progress
   * counters (kept when pausing mid-flight is not needed — we always clear).
   * @param {boolean} [clearProgress=true]
   */

  function stopGeometryLoadQueue(clearProgress = true) {
    if (layerState._geoQueueTimer) {
      clearTimeout(layerState._geoQueueTimer);
      layerState._geoQueueTimer = 0;
    }
    layerState._geoQueue = [];
    layerState._geoProgressNotifier = null;
    if (clearProgress) {
      layerState._geoLoading = false;
      layerState._geoLoadTotal = 0;
      layerState._geoLoadDone = 0;
    }
  }

  /**
   * Creates the notification coalescer used by a staggered geometry drain.
   * Progress emits after roughly 300 ms or ten batches, whichever comes first;
   * finish always emits once even when the last progress tick just fired.
   *
   * @param {Function} notify Notification callback.
   * @param {Object} [options={}] Testable timing options.
   * @param {() => number} [options.now] Monotonic clock returning milliseconds.
   * @param {number} [options.intervalMs] Maximum progress-notification cadence.
   * @param {number} [options.batchLimit] Maximum batches between progress ticks.
   * @returns {{ progress: () => boolean, finish: () => void }} Drain notifier.
   */

  function createGeometryProgressNotifier(notify, options = {}) {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const intervalMs = Number.isFinite(options.intervalMs)
      ? Math.max(0, options.intervalMs)
      : GEO_PROGRESS_NOTIFY_INTERVAL_MS;
    const batchLimit = Number.isFinite(options.batchLimit)
      ? Math.max(1, Math.floor(options.batchLimit))
      : GEO_PROGRESS_NOTIFY_BATCH_LIMIT;
    let lastNotifyAt = now();
    let batchesSinceNotify = 0;

    return {
      progress() {
        batchesSinceNotify += 1;
        const current = now();
        if (
          current - lastNotifyAt < intervalMs &&
          batchesSinceNotify < batchLimit
        ) {
          return false;
        }
        batchesSinceNotify = 0;
        lastNotifyAt = current;
        notify?.();
        return true;
      },
      finish() {
        batchesSinceNotify = 0;
        lastNotifyAt = now();
        notify?.();
      },
    };
  }

  /**
   * Processes one geometry-queue batch and routes progress/completion through
   * the callbacks shared by production and the unit drain harness.
   *
   * @param {Object} options Batch inputs.
   * @param {Object[]} options.queue Mutable record queue.
   * @param {number} options.batchSize Maximum records to visit.
   * @param {(record: Object) => void} options.visit Per-record geometry work.
   * @param {() => void} options.progress Coalesced progress publication.
   * @param {() => void} options.complete Unconditional completion publication.
   * @returns {boolean} True when more records remain.
   */

  function processCctvGeometryQueueBatch({
    queue,
    batchSize,
    visit,
    progress,
    complete,
  }) {
    const safeQueue = Array.isArray(queue) ? queue : [];
    const take = Number.isFinite(batchSize)
      ? Math.max(1, Math.floor(batchSize))
      : 1;
    const batch = safeQueue.splice(0, take);
    for (const record of batch) visit?.(record);
    if (safeQueue.length) {
      progress?.();
      return true;
    }
    complete?.();
    return false;
  }

  /**
   * Selects per-batch geometry-drain pacing from current camera ownership.
   * Called for every batch so releasing tracking immediately restores normal
   * throughput without restarting the queue.
   */

  function cctvGeometryDrainPacing({
    trackedEntity = null,
    cockpitActive = false,
  } = {}) {
    if (trackedEntity || cockpitActive) {
      return {
        batchSize: GEO_TRACKING_BATCH_SIZE,
        delayMs: GEO_TRACKING_BATCH_DELAY_MS,
      };
    }
    return { batchSize: GEO_LOAD_BATCH_SIZE, delayMs: GEO_LOAD_BATCH_DELAY_MS };
  }

  function processCctvGeometryDrainBatch({
    queue,
    readOwnership,
    visit,
    progress,
    complete,
  }) {
    const pacing = cctvGeometryDrainPacing(readOwnership?.() || {});
    const hasMore = processCctvGeometryQueueBatch({
      queue,
      batchSize: pacing.batchSize,
      visit,
      progress,
      complete,
    });
    return { hasMore, ...pacing };
  }

  function prioritizeActiveCctvGeometryRecord(queue, activeRecord) {
    if (!Array.isArray(queue) || !activeRecord) return false;
    const index = queue.indexOf(activeRecord);
    if (index <= 0) return false;
    queue.splice(index, 1);
    queue.unshift(activeRecord);
    return true;
  }

  /** Rank records active-first and then nearest to the current camera. */
  function rankedGeometryRecords(records) {
    const unique = [...new Set(Array.isArray(records) ? records : [])].filter(
      Boolean,
    );
    if (!unique.length) return [];
    const active = parts.selection.getActiveRecord();
    const carto = layerState._viewer?.camera?.positionCartographic;
    const refLat = carto
      ? Cesium.Math.toDegrees(carto.latitude)
      : (active?.camera?.lat ?? 0);
    const refLon = carto
      ? Cesium.Math.toDegrees(carto.longitude)
      : (active?.camera?.lon ?? 0);
    const pending = unique
      .filter((record) => record !== active)
      .map((record) => ({
        record,
        distKm: parts.model.haversineKm(
          refLat,
          refLon,
          record.camera.lat,
          record.camera.lon,
        ),
      }))
      .sort((a, b) => a.distKm - b.distKm)
      .map((entry) => entry.record);
    const ordered = active && unique.includes(active) ? [active, ...pending] : pending;
    const limit = runtimeCctvGeometryLimit();
    if (!Number.isFinite(limit) || ordered.length <= limit) return ordered;
    layerState._geoDeferredCount = Math.max(
      layerState._geoDeferredCount || 0,
      ordered.length - limit,
    );
    return ordered.slice(0, limit);
  }

  function processGeometryBatch() {
    layerState._geoQueueTimer = 0;
    if (!layerState._viewer) {
      stopGeometryLoadQueue();
      return;
    }
    prioritizeActiveCctvGeometryRecord(
      layerState._geoQueue,
      parts.selection.getActiveRecord(),
    );
    const batchResult = processCctvGeometryDrainBatch({
      queue: layerState._geoQueue,
      readOwnership: () => ({
        trackedEntity: layerState._viewer.trackedEntity,
        cockpitActive:
          typeof document !== 'undefined' &&
          document.body?.classList.contains('cockpit-mode'),
      }),
      visit: (record) => {
        try {
          parts.geometry.updateRecordGeometry(record);
        } catch (err) {
          console.warn(
            '[Data:CCTV] geometry refresh error:',
            err?.message || err,
          );
        }
        if (
          layerState._geoLoading &&
          layerState._geoLoadDone < layerState._geoLoadTotal
        ) {
          layerState._geoLoadDone += 1;
        }
      },
      progress: () => layerState._geoProgressNotifier?.progress(),
      complete: () => {
        const wasInitialLoad = layerState._geoLoading;
        layerState._geoLoading = false;
        if (wasInitialLoad) {
          layerState._geoLoadDone = layerState._geoLoadTotal;
          if (layerState._enabled) {
            parts.rendering.refreshCoverageStyles();
            parts.cards.refreshAmbientCards();
          }
        }
        layerState._geoProgressNotifier?.finish();
        layerState._geoProgressNotifier = null;
      },
    });
    if (batchResult.hasMore) {
      layerState._geoQueueTimer = setTimeout(
        processGeometryBatch,
        batchResult.delayMs,
      );
    }
  }

  /**
   * Appends a bounded, nearest-first record set to the geometry queue. The
   * one-shot tiles-ready completion pass uses this too, so it cannot undo the
   * mobile eager-work cap by re-queueing the entire worldwide catalog.
   */
  function enqueueGeometryRefresh(records) {
    for (const record of rankedGeometryRecords(records)) {
      if (!layerState._geoQueue.includes(record)) layerState._geoQueue.push(record);
    }
    if (!layerState._geoQueueTimer && layerState._geoQueue.length) {
      layerState._geoProgressNotifier = createGeometryProgressNotifier(
        parts.presentation.notifyListeners,
      );
      layerState._geoQueueTimer = setTimeout(processGeometryBatch, 0);
    }
  }

  /**
   * Starts the initial staggered load. Desktop keeps the complete catalog;
   * mobile eagerly refines only the nearest bounded set. Cameras outside that
   * set remain selectable and are refined immediately on explicit activation.
   */
  function startGeometryLoadQueue() {
    stopGeometryLoadQueue();
    layerState._tilesReadyReenqueued = false;
    layerState._geoDeferredCount = 0;
    if (!layerState._records.length) return;
    layerState._geoQueue = rankedGeometryRecords(layerState._records);
    layerState._geoLoadTotal = layerState._geoQueue.length;
    layerState._geoLoadDone = 0;
    layerState._geoLoading = layerState._geoQueue.length > 0;
    if (!layerState._geoLoading) return;
    layerState._geoProgressNotifier = createGeometryProgressNotifier(
      parts.presentation.notifyListeners,
    );
    layerState._geoQueueTimer = setTimeout(processGeometryBatch, 0);
  }

  return {
    stopGeometryLoadQueue,
    createGeometryProgressNotifier,
    processCctvGeometryQueueBatch,
    cctvGeometryDrainPacing,
    processCctvGeometryDrainBatch,
    prioritizeActiveCctvGeometryRecord,
    processGeometryBatch,
    enqueueGeometryRefresh,
    startGeometryLoadQueue,
  };
}
