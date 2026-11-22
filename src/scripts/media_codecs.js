/**
 * Overrides MediaSource.isTypeSupported, MediaSource.prototype.addSourceBuffer,
 * and HTMLMediaElement.prototype.canPlayType to:
 * 1. Report AV1 (av01 / av1) as unsupported so webOS avoids software AV1 decoding,
 *    which exhausts TV memory and freezes 1440p/4K streams.
 * 2. Handle hardware-accelerated HEVC / H.265 (hvc1 / hev1) by testing real browser
 *    support across FourCC variants (hev1 <-> hvc1) and baseline universal L93.B0.
 * 3. Normalize high-level AVC (H.264 Level 5.0+ e.g. avc1.640033) to Level 4.2
 *    (avc1.64002a) so webOS MSE does not reject the source buffer.
 * 4. Intercept window.Hls / Hls.DefaultConfig to enforce Smart TV memory-safe
 *    buffer limits (maxBufferLength: 10s, maxBufferSize: 15MB, backBufferLength: 5s,
 *    liveBackBufferLength: 5s), preventing webOS OOM freezes and unresponsive remote keys.
 * 5. Run an automatic stall detection watchdog that safely recovers playback or
 *    automatically drops back to stable 1080p / Auto if a stream locks up.
 */

/**
 * Smart TV optimized HLS buffer configuration.
 * Constrains forward buffer to 10-15s / 15MB and purges past played buffer after 5s.
 * This prevents webOS WebEngine memory starvation and UI lockups on 1440p60.
 */
export const TV_HLS_CONFIG_OVERRIDES = {
  maxBufferLength: 10,
  maxMaxBufferLength: 15,
  maxBufferSize: 15 * 1024 * 1024,
  backBufferLength: 5,
  liveBackBufferLength: 5,
  frontBufferFlushThreshold: 20,
  highBufferWatchdogPeriod: 2,
  nudgeOffset: 0.1,
  nudgeMaxRetry: 5,
  lowLatencyMode: false
};

/**
 * Checks whether a codec / mime-type string specifies AV1.
 * Matches av01 (standard MP4 AV1 identifier) and av1 (generic / WebM).
 * Does not match avc1 (H.264).
 *
 * @param {unknown} type
 * @returns {boolean}
 */
export function isAv1Codec(type) {
  if (typeof type !== 'string') {
    return false;
  }
  const lower = type.toLowerCase();
  return lower.includes('av01') || (lower.includes('av1') && !lower.includes('avc1'));
}

/**
 * Checks whether a codec / mime-type string specifies HEVC (H.265).
 * Matches hvc1 and hev1 FourCC identifiers.
 *
 * @param {unknown} type
 * @returns {boolean}
 */
export function isHevcCodec(type) {
  if (typeof type !== 'string') {
    return false;
  }
  const lower = type.toLowerCase();
  return lower.includes('hev1') || lower.includes('hvc1');
}

/**
 * Cleans non-standard HEVC codec strings by trimming extra constraint tokens
 * (e.g., Twitch Enhanced Broadcasting outputs hev1.1.6.L150.90.0.0.0.0.0).
 * Standard Chromium / webOS parsers accept up to 5 dot-separated components.
 *
 * @param {string} type
 * @returns {string}
 */
export function cleanHevcCodec(type) {
  if (typeof type !== 'string') {
    return type;
  }
  return type.replace(
    /(hev1|hvc1)\.([1-9]\d*)\.([\da-fA-F]+)\.([LH]\d+)\.([\da-fA-F]+)(?:\.[\da-fA-F]+)+/g,
    '$1.$2.$3.$4.$5'
  );
}

/**
 * Checks whether HEVC is supported by trying original isTypeSupported with
 * RFC 6381 normalization, hev1 <-> hvc1 FourCC swapping, and baseline L93.B0 check.
 *
 * @param {Function} origFn
 * @param {unknown} context
 * @param {unknown} type
 * @returns {boolean}
 */
export function checkHevcSupported(origFn, context, type) {
  if (typeof origFn !== 'function') return false;
  try {
    if (origFn.call(context, type)) {
      return true;
    }
    if (typeof type === 'string') {
      const cleaned = cleanHevcCodec(type);
      if (cleaned !== type && origFn.call(context, cleaned)) {
        return true;
      }
      const swapped = cleaned.includes('hev1')
        ? cleaned.replace(/hev1/g, 'hvc1')
        : cleaned.replace(/hvc1/g, 'hev1');
      if (origFn.call(context, swapped)) {
        return true;
      }
      // Baseline universal L93.B0 supported across all webOS MSE implementations:
      const l93 = swapped.replace(
        /(hvc1|hev1)(?:\.[^",]+)?/g,
        'hvc1.1.6.L93.B0'
      );
      if (origFn.call(context, l93)) {
        return true;
      }
      if (origFn.call(context, 'video/mp4; codecs="hvc1.1.6.L93.B0"')) {
        return true;
      }
      if (origFn.call(context, 'video/mp4; codecs="hvc1"')) {
        return true;
      }
      if (origFn.call(context, 'video/mp4; codecs="hev1"')) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Applies TV-safe memory constraints to an Hls constructor and its DefaultConfig.
 * Wraps constructor so any userConfig passed by Twitch player also receives limits.
 *
 * @param {any} HlsCtor
 * @returns {any}
 */
export function applyTvHlsConfig(HlsCtor) {
  if (!HlsCtor || typeof HlsCtor !== 'function') return HlsCtor;

  try {
    if (HlsCtor.DefaultConfig && typeof HlsCtor.DefaultConfig === 'object') {
      Object.assign(HlsCtor.DefaultConfig, TV_HLS_CONFIG_OVERRIDES);
    }
  } catch {
    /* ignore */
  }

  if (HlsCtor._tafPatched) {
    return HlsCtor;
  }

  const origHls = HlsCtor;
  const PatchedHls = function (userConfig) {
    const mergedConfig = Object.assign({}, userConfig, TV_HLS_CONFIG_OVERRIDES);
    return new origHls(mergedConfig);
  };

  Object.setPrototypeOf(PatchedHls, origHls);
  PatchedHls.prototype = origHls.prototype;
  PatchedHls._tafPatched = true;

  try {
    Object.defineProperty(PatchedHls, 'DefaultConfig', {
      get() {
        return origHls.DefaultConfig;
      },
      set(val) {
        if (val && typeof val === 'object') {
          Object.assign(val, TV_HLS_CONFIG_OVERRIDES);
        }
        origHls.DefaultConfig = val;
      },
      configurable: true
    });
  } catch {
    /* ignore */
  }

  return PatchedHls;
}

/**
 * Intercepts window.Hls so whenever the player bundle defines or uses Hls,
 * the Smart TV buffer limits are active.
 */
export function patchHlsConstructor() {
  if (typeof window === 'undefined') return;

  let currentHls = window.Hls;
  if (currentHls) {
    currentHls = applyTvHlsConfig(currentHls);
    try {
      window.Hls = currentHls;
    } catch {
      /* ignore */
    }
  }

  try {
    Object.defineProperty(window, 'Hls', {
      get() {
        return currentHls;
      },
      set(newHls) {
        currentHls = applyTvHlsConfig(newHls);
      },
      configurable: true,
      enumerable: true
    });
  } catch (err) {
    console.warn('[TAF] Could not defineProperty on window.Hls', err);
  }
}

/**
 * No-op retained for backwards compatibility.
 * Buffer eviction is managed natively by hls.js via backBufferLength.
 *
 * @param {unknown} _sb
 */
export function attachBufferEviction(_sb) {
  // Deliberately no-op: hls.js manages its own buffer lifecycle
}

/**
 * Automatically detects video playback stalls (frozen frame / decoder lock)
 * and attempts a gentle resume or auto-fallback to stable quality (1080p / Auto).
 */
export function initStallWatchdog() {
  if (typeof window === 'undefined') return;

  let lastTime = -1;
  let stallDuration = 0;
  let recoveryAttempts = 0;

  const timer = setInterval(() => {
    try {
      const video = document.querySelector('video');
      if (!video || video.paused || video.ended) {
        lastTime = -1;
        stallDuration = 0;
        recoveryAttempts = 0;
        return;
      }

      // If video is actively loading network data (readyState < 3 and networkState == 2),
      // it is legitimate buffering: do not interfere.
      if (video.readyState < 3 && video.networkState === 2) {
        return;
      }

      const cur = video.currentTime;
      if (cur > 0 && Math.abs(cur - lastTime) < 0.05) {
        stallDuration++;

        // After 4 seconds of stall: attempt gentle play without mutating currentTime
        if (stallDuration === 4) {
          const p = video.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }

        // After 8 seconds of unrecoverable freeze (e.g. 1440p decoder failure):
        // Automatically switch back to stable quality to unblock TV and remote controls!
        if (stallDuration >= 8) {
          stallDuration = 0;
          recoveryAttempts++;
          if (recoveryAttempts <= 2) {
            console.warn(
              '[TAF] Critical stall: auto-switching to stable quality (1080p / Auto)...'
            );
            if (typeof window.taf_resetToStableQuality === 'function') {
              window.taf_resetToStableQuality();
            } else if (typeof window.taf_reloadStream === 'function') {
              window.taf_reloadStream();
            }
          }
        }
      } else {
        lastTime = cur;
        stallDuration = 0;
        recoveryAttempts = 0;
      }
    } catch {
      /* ignore */
    }
  }, 1000);

  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

export function patchMediaCodecs() {
  if (typeof window === 'undefined') {
    return;
  }

  // Intercept window.Hls to enforce Smart TV safe buffer constraints
  patchHlsConstructor();

  // 1. Override MediaSource.isTypeSupported
  try {
    if (
      typeof window.MediaSource !== 'undefined' &&
      typeof window.MediaSource.isTypeSupported === 'function'
    ) {
      const origIsTypeSupported = window.MediaSource.isTypeSupported;
      const patchedIsTypeSupported = function (type) {
        if (isAv1Codec(type)) {
          return false;
        }
        if (isHevcCodec(type)) {
          return checkHevcSupported(origIsTypeSupported, window.MediaSource, type);
        }
        if (typeof type === 'string' && type.includes('avc1')) {
          if (origIsTypeSupported.call(window.MediaSource, type)) {
            return true;
          }
          const normAvc = type.replace(
            /(avc1\.[0-9a-fA-F]{4})3[0-9a-fA-F]/g,
            '$12a'
          );
          if (normAvc !== type && origIsTypeSupported.call(window.MediaSource, normAvc)) {
            return true;
          }
        }
        return origIsTypeSupported.call(window.MediaSource, type);
      };
      try {
        Object.defineProperty(window.MediaSource, 'isTypeSupported', {
          value: patchedIsTypeSupported,
          writable: true,
          configurable: true
        });
      } catch {
        window.MediaSource.isTypeSupported = patchedIsTypeSupported;
      }
    }
  } catch (err) {
    console.warn('[TAF] Failed to patch MediaSource.isTypeSupported', err);
  }

  // Also patch ManagedMediaSource if present in newer webOS WebEngine runtimes
  try {
    if (
      typeof window.ManagedMediaSource !== 'undefined' &&
      typeof window.ManagedMediaSource.isTypeSupported === 'function'
    ) {
      const origManagedIsTypeSupported =
        window.ManagedMediaSource.isTypeSupported;
      const patchedManaged = function (type) {
        if (isAv1Codec(type)) {
          return false;
        }
        if (isHevcCodec(type)) {
          return checkHevcSupported(
            origManagedIsTypeSupported,
            window.ManagedMediaSource,
            type
          );
        }
        if (typeof type === 'string' && type.includes('avc1')) {
          if (origManagedIsTypeSupported.call(window.ManagedMediaSource, type)) {
            return true;
          }
          const normAvc = type.replace(
            /(avc1\.[0-9a-fA-F]{4})3[0-9a-fA-F]/g,
            '$12a'
          );
          if (
            normAvc !== type &&
            origManagedIsTypeSupported.call(window.ManagedMediaSource, normAvc)
          ) {
            return true;
          }
        }
        return origManagedIsTypeSupported.call(
          window.ManagedMediaSource,
          type
        );
      };
      try {
        Object.defineProperty(window.ManagedMediaSource, 'isTypeSupported', {
          value: patchedManaged,
          writable: true,
          configurable: true
        });
      } catch {
        window.ManagedMediaSource.isTypeSupported = patchedManaged;
      }
    }
  } catch (err) {
    console.warn('[TAF] Failed to patch ManagedMediaSource', err);
  }

  // 2. Override MediaSource.prototype.addSourceBuffer
  try {
    if (
      typeof window.MediaSource !== 'undefined' &&
      window.MediaSource.prototype &&
      typeof window.MediaSource.prototype.addSourceBuffer === 'function'
    ) {
      const origAddSourceBuffer = window.MediaSource.prototype.addSourceBuffer;
      const patchedAddSourceBuffer = function (type) {
        let targetType = type;
        try {
          return origAddSourceBuffer.call(this, targetType);
        } catch (err1) {
          if (typeof targetType === 'string') {
            if (isHevcCodec(targetType)) {
              const hasAudio = targetType.includes('mp4a');
              const cleaned = cleanHevcCodec(targetType);
              if (cleaned !== targetType) {
                try {
                  return origAddSourceBuffer.call(this, cleaned);
                } catch {
                  /* ignore */
                }
              }
              const swapped = cleaned.includes('hev1')
                ? cleaned.replace(/hev1/g, 'hvc1')
                : cleaned.replace(/hvc1/g, 'hev1');
              try {
                return origAddSourceBuffer.call(this, swapped);
              } catch {
                /* ignore */
              }

              const l93 = swapped.replace(
                /(hvc1|hev1)(?:\.[^",]+)?/g,
                'hvc1.1.6.L93.B0'
              );
              try {
                return origAddSourceBuffer.call(this, l93);
              } catch {
                /* ignore */
              }

              const fallbacks = [
                hasAudio
                  ? 'video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"'
                  : 'video/mp4; codecs="hvc1.1.6.L93.B0"',
                hasAudio
                  ? 'video/mp4; codecs="hvc1,mp4a.40.2"'
                  : 'video/mp4; codecs="hvc1"',
                hasAudio
                  ? 'video/mp4; codecs="hev1,mp4a.40.2"'
                  : 'video/mp4; codecs="hev1"',
                'video/mp4; codecs="hevc"'
              ];
              for (const fb of fallbacks) {
                try {
                  return origAddSourceBuffer.call(this, fb);
                } catch {
                  /* ignore */
                }
              }
            }

            if (targetType.includes('avc1')) {
              const normAvc = targetType.replace(
                /(avc1\.[0-9a-fA-F]{4})3[0-9a-fA-F]/g,
                '$12a'
              );
              if (normAvc !== targetType) {
                try {
                  return origAddSourceBuffer.call(this, normAvc);
                } catch {
                  /* ignore */
                }
              }
              const avcFallbacks = [
                'video/mp4; codecs="avc1.64002a,mp4a.40.2"',
                'video/mp4; codecs="avc1.4d002a,mp4a.40.2"',
                'video/mp4; codecs="avc1.42e01e,mp4a.40.2"'
              ];
              for (const fb of avcFallbacks) {
                try {
                  return origAddSourceBuffer.call(this, fb);
                } catch {
                  /* ignore */
                }
              }
            }
          }
          throw err1;
        }
      };
      try {
        Object.defineProperty(
          window.MediaSource.prototype,
          'addSourceBuffer',
          {
            value: patchedAddSourceBuffer,
            writable: true,
            configurable: true
          }
        );
      } catch {
        window.MediaSource.prototype.addSourceBuffer = patchedAddSourceBuffer;
      }
    }
  } catch (err) {
    console.warn('[TAF] Failed to patch MediaSource.prototype.addSourceBuffer', err);
  }

  // Also patch ManagedMediaSource.prototype.addSourceBuffer if present
  try {
    if (
      typeof window.ManagedMediaSource !== 'undefined' &&
      window.ManagedMediaSource.prototype &&
      typeof window.ManagedMediaSource.prototype.addSourceBuffer === 'function'
    ) {
      const origManagedAddSourceBuffer =
        window.ManagedMediaSource.prototype.addSourceBuffer;
      const patchedManagedAddSourceBuffer = function (type) {
        let targetType = type;
        try {
          return origManagedAddSourceBuffer.call(this, targetType);
        } catch (err1) {
          if (typeof targetType === 'string') {
            if (isHevcCodec(targetType)) {
              const hasAudio = targetType.includes('mp4a');
              const cleaned = cleanHevcCodec(targetType);
              if (cleaned !== targetType) {
                try {
                  return origManagedAddSourceBuffer.call(this, cleaned);
                } catch {
                  /* ignore */
                }
              }
              const swapped = cleaned.includes('hev1')
                ? cleaned.replace(/hev1/g, 'hvc1')
                : cleaned.replace(/hvc1/g, 'hev1');
              try {
                return origManagedAddSourceBuffer.call(this, swapped);
              } catch {
                /* ignore */
              }

              const l93 = swapped.replace(
                /(hvc1|hev1)(?:\.[^",]+)?/g,
                'hvc1.1.6.L93.B0'
              );
              try {
                return origManagedAddSourceBuffer.call(this, l93);
              } catch {
                /* ignore */
              }

              const fallbacks = [
                hasAudio
                  ? 'video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"'
                  : 'video/mp4; codecs="hvc1.1.6.L93.B0"',
                hasAudio
                  ? 'video/mp4; codecs="hvc1,mp4a.40.2"'
                  : 'video/mp4; codecs="hvc1"',
                hasAudio
                  ? 'video/mp4; codecs="hev1,mp4a.40.2"'
                  : 'video/mp4; codecs="hev1"',
                'video/mp4; codecs="hevc"'
              ];
              for (const fb of fallbacks) {
                try {
                  return origManagedAddSourceBuffer.call(this, fb);
                } catch {
                  /* ignore */
                }
              }
            }

            if (targetType.includes('avc1')) {
              const normAvc = targetType.replace(
                /(avc1\.[0-9a-fA-F]{4})3[0-9a-fA-F]/g,
                '$12a'
              );
              if (normAvc !== targetType) {
                try {
                  return origManagedAddSourceBuffer.call(this, normAvc);
                } catch {
                  /* ignore */
                }
              }
              const avcFallbacks = [
                'video/mp4; codecs="avc1.64002a,mp4a.40.2"',
                'video/mp4; codecs="avc1.4d002a,mp4a.40.2"',
                'video/mp4; codecs="avc1.42e01e,mp4a.40.2"'
              ];
              for (const fb of avcFallbacks) {
                try {
                  return origManagedAddSourceBuffer.call(this, fb);
                } catch {
                  /* ignore */
                }
              }
            }
          }
          throw err1;
        }
      };
      try {
        Object.defineProperty(
          window.ManagedMediaSource.prototype,
          'addSourceBuffer',
          {
            value: patchedManagedAddSourceBuffer,
            writable: true,
            configurable: true
          }
        );
      } catch {
        window.ManagedMediaSource.prototype.addSourceBuffer =
          patchedManagedAddSourceBuffer;
      }
    }
  } catch (err) {
    console.warn('[TAF] Failed to patch ManagedMediaSource.prototype.addSourceBuffer', err);
  }

  // 3. Override HTMLMediaElement.prototype.canPlayType
  try {
    if (
      typeof window.HTMLMediaElement !== 'undefined' &&
      window.HTMLMediaElement.prototype &&
      typeof window.HTMLMediaElement.prototype.canPlayType === 'function'
    ) {
      const origCanPlayType = window.HTMLMediaElement.prototype.canPlayType;
      const patchedCanPlayType = function (type) {
        if (isAv1Codec(type)) {
          return '';
        }
        if (isHevcCodec(type)) {
          try {
            const res = origCanPlayType.call(this, type);
            if (res) {
              return res;
            }
            if (typeof type === 'string') {
              const cleaned = cleanHevcCodec(type);
              if (cleaned !== type) {
                const cleanRes = origCanPlayType.call(this, cleaned);
                if (cleanRes) return cleanRes;
              }
              const swapped = cleaned.includes('hev1')
                ? cleaned.replace(/hev1/g, 'hvc1')
                : cleaned.replace(/hvc1/g, 'hev1');
              const swappedRes = origCanPlayType.call(this, swapped);
              if (swappedRes) return swappedRes;

              const l93 = swapped.replace(
                /(hvc1|hev1)(?:\.[^",]+)?/g,
                'hvc1.1.6.L93.B0'
              );
              const l93Res = origCanPlayType.call(this, l93);
              if (l93Res) return l93Res;

              const genRes = origCanPlayType.call(
                this,
                'video/mp4; codecs="hvc1"'
              );
              if (genRes) return genRes;
            }
          } catch {
            /* ignore */
          }
          return '';
        }
        if (typeof type === 'string' && type.includes('avc1')) {
          try {
            const res = origCanPlayType.call(this, type);
            if (res) return res;
            const normAvc = type.replace(
              /(avc1\.[0-9a-fA-F]{4})3[0-9a-fA-F]/g,
              '$12a'
            );
            if (normAvc !== type) {
              const normRes = origCanPlayType.call(this, normAvc);
              if (normRes) return normRes;
            }
          } catch {
            /* ignore */
          }
        }
        return origCanPlayType.call(this, type);
      };
      try {
        Object.defineProperty(window.HTMLMediaElement.prototype, 'canPlayType', {
          value: patchedCanPlayType,
          writable: true,
          configurable: true
        });
      } catch {
        window.HTMLMediaElement.prototype.canPlayType = patchedCanPlayType;
      }
    }
  } catch (err) {
    console.warn(
      '[TAF] Failed to patch HTMLMediaElement.prototype.canPlayType',
      err
    );
  }

  // 4. Initialize the playback stall watchdog
  initStallWatchdog();
}

// Automatically install on module execution
patchMediaCodecs();
