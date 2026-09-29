import { observeTrafficSurface } from './surface.js';
import * as Cesium from 'cesium';
import { TRAFFIC_TIMING_ENABLED } from './policy.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../data/cameraSensitivity.js';

/**
 * Live TomTom road-flow mode has no synthetic moving vehicles, so once the
 * old dot population is gone there is no per-frame traffic work left to do.
 * Keyless/simulated traffic keeps the shipped continuous animator unchanged.
 */
export function trafficNeedsAnimation({
  liveMode = false,
  liveFlowOnly = false,
  dotCount = 0,
} = {}) {
  return !liveMode || !liveFlowOnly || dotCount > 0;
}

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const { resetFlowTileCache } = source;

  function stopTrafficAnimation() {
    layerState._preRenderRemover?.();
    layerState._preRenderRemover = null;
    releaseContinuousRender('traffic');
    layerState._viewer?.scene?.requestRender?.();
  }

  function startTrafficAnimation(viewer = layerState._viewer) {
    if (!viewer || layerState._preRenderRemover) return;
    holdContinuousRender('traffic');
    layerState._lastAnimTime = 0;
    const animateOrSleep = () => {
      if (
        !trafficNeedsAnimation({
          liveMode: layerState._liveMode,
          liveFlowOnly: layerState._liveFlowOnly,
          dotCount: layerState._dots.length,
        })
      ) {
        stopTrafficAnimation();
        return;
      }
      parts.animation.animate();
    };
    layerState._preRenderRemover =
      viewer.scene.preRender.addEventListener(animateOrSleep);
  }

  const methods = {
    /**
     * One-time initialisation. Creates the PointPrimitiveCollection and adds it
     * to the scene (hidden). The collection is never removed and re-added — only
     * toggled via `.show` to avoid destroy-on-remove errors.
     *
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    init(viewer) {
      layerState._viewer = viewer;
      layerState._pointCollection = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      viewer.scene.primitives.add(layerState._pointCollection);
      layerState._pointCollection.show = false;
      layerState._dots = [];
      layerState._roads = [];
      layerState._count = 0;
      layerState._lastUpdate = null;
      layerState._lastBounds = null;
      layerState._fetching = false;
      layerState._loadGeneration = 0;
      layerState._densityScale = 1.0;
      layerState._speedScale = 1.0;
      layerState._lastViewCenter = null;
      layerState._flowRoads = null;
      layerState._flowError = null;
      if (TRAFFIC_TIMING_ENABLED) {
        layerState._trafficTimingCurrentAnchor = null;
        layerState._trafficTimingSequence = 0;
        layerState._trafficTimingTracesCreated = 0;
        layerState._trafficTimingDroppedTraces = 0;
      }

      if (typeof window !== 'undefined') {
        layerState._stylePreset =
          document?.documentElement?.dataset?.gevStyle || 'normal';
        if (!layerState._styleListenerBound) {
          window.addEventListener('gev:style-change', (e) =>
            parts.style.setStylePreset(e?.detail?.style),
          );
          layerState._styleListenerBound = true;
        }
      }
      parts.style.refreshBucketColors();
      console.log('[Data:Traffic] Initialized');
    },

    /** Enable the traffic layer and subscribe to camera/animation work. */
    enable(viewer) {
      if (layerState._enabled) return;
      layerState._enabled = true;
      layerState._surfaceFrameRemover = observeTrafficSurface(viewer.scene);
      if (layerState._roadMode !== 'tomtom') source.prefetch?.();
      layerState._pointCollection.show = true;
      startTrafficAnimation(viewer);

      if (TRAFFIC_TIMING_ENABLED) {
        parts.timing.clearTrafficTimingEntries();
        layerState._trafficTimingCurrentAnchor = null;
        layerState._trafficTimingPostRenderRemovers = new Set();
        layerState._trafficTimingMoveEndRemover =
          viewer.camera.moveEnd.addEventListener(
            parts.timing.markTrafficTimingMoveEnd,
          );
      }

      viewer.camera.changed.addEventListener(parts.viewport.onCameraChanged);
      layerState._arrivalRemover = viewer.camera.moveEnd.addEventListener(() =>
        parts.viewport.onCameraChanged({ immediate: true }),
      );
      claimCameraSensitivity(viewer.camera, 'traffic', 0.05);
      parts.viewport.onCameraChanged({ immediate: true });

      clearInterval(layerState._enableKickTimer);
      layerState._enableKickTimer = setInterval(() => {
        if (
          !layerState._enabled ||
          layerState._lastUpdate ||
          layerState._roadRetryStopped ||
          layerState._retryAttempts >= 3
        ) {
          clearInterval(layerState._enableKickTimer);
          layerState._enableKickTimer = null;
          return;
        }
        if (!layerState._fetching && !layerState._retryTimer)
          parts.viewport.onCameraChanged();
      }, 1500);
    },

    /** Disable the traffic layer and release all render/camera ownership. */
    disable(viewer) {
      layerState._enabled = false;
      services.credits?.hideOsmCredit?.(layerState._viewer, 'traffic');
      stopTrafficAnimation();
      clearTimeout(layerState._fetchTimeout);
      clearInterval(layerState._enableKickTimer);
      layerState._enableKickTimer = null;
      clearTimeout(layerState._retryTimer);
      layerState._retryTimer = null;
      layerState._retryDelayMs = 1500;
      parts.ingestion.cancelActiveFetch();
      layerState._loadGeneration++;
      layerState._fetching = false;
      layerState._flowPending = 0;
      layerState._roadError = null;
      parts.animation.clearDots();
      parts.rendering.removeHeatLines();
      layerState._lastBounds = null;
      layerState._lastViewCenter = null;
      layerState._flowError = null;

      layerState._surfaceFrameRemover?.();
      layerState._surfaceFrameRemover = null;
      if (TRAFFIC_TIMING_ENABLED) {
        layerState._trafficTimingMoveEndRemover?.();
        layerState._trafficTimingMoveEndRemover = null;
        for (const remove of layerState._trafficTimingPostRenderRemovers || [])
          remove();
        layerState._trafficTimingPostRenderRemovers = null;
        layerState._trafficTimingCurrentAnchor = null;
      }

      viewer.camera.changed.removeEventListener(parts.viewport.onCameraChanged);
      layerState._arrivalRemover?.();
      layerState._arrivalRemover = null;
      releaseCameraSensitivity(viewer.camera, 'traffic');
      if (layerState._pointCollection) layerState._pointCollection.show = false;
    },

    /** Permanently tear down the layer. */
    destroy(viewer) {
      this.disable(viewer);
      if (layerState._pointCollection) {
        viewer.scene.primitives.remove(layerState._pointCollection);
        layerState._pointCollection = null;
      }
      layerState._tileCache.clear();
      resetFlowTileCache();
      layerState._count = 0;
      layerState._lastUpdate = null;
    },
  };

  return { methods };
}
