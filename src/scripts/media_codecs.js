/**
 * Overrides MediaSource.isTypeSupported, MediaSource.prototype.addSourceBuffer,
 * and HTMLMediaElement.prototype.canPlayType to:
 * 1. Report AV1 (av01 / av1) as unsupported so webOS avoids software AV1 decoding,
 *    which exhausts TV memory and freezes 1440p/4K streams.
 * 2. Handle hardware-accelerated HEVC / H.265 (hvc1 / hev1) by testing real browser
 *    support across FourCC variants (hev1 <-> hvc1) and standardizing RFC 6381 syntax.
 * 3. Never spoof unsupported profile levels (e.g. L93 fallback for L150) so the TV
 *    hardware is not forced into resolutions it cannot decode.
 * 4. Run an automatic stall detection watchdog that safely recovers playback or
 *    automatically drops back to stable 1080p / Auto if a high-res stream locks up.
 */

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
 * RFC 6381 normalization and hev1 <-> hvc1 FourCC swapping.
 * Never falls back to a lower level (such as L93) when a higher level is queried,
 * ensuring the TV hardware decoder is not forced into unsupported resolutions.
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
      // If webOS MSE rejects Level 5.0+ (L150/L153) due to Chromium level table,
      // check with normalized Level 4.1 (L123) or generic hvc1:
      const normalized = swapped.replace(
        /(hvc1\.[1-9]\d*\.[\da-fA-F]+\.)[LH](?:15\d|16\d|17\d|18\d)(\.[\da-fA-F]+)?/g,
        '$1L123$2'
      );
      if (normalized !== swapped && origFn.call(context, normalized)) {
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
 * No-op retained for backwards compatibility.
 * External buffer eviction via sb.remove() interferes with hls.js internal queue
 * causing InvalidStateError and video freezes on webOS.
 *
 * @param {unknown} sb
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
          if (typeof targetType === 'string' && isHevcCodec(targetType)) {
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

            const normalized = swapped.replace(
              /(hvc1\.[1-9]\d*\.[\da-fA-F]+\.)[LH](?:15\d|16\d|17\d|18\d)(\.[\da-fA-F]+)?/g,
              '$1L123$2'
            );
            if (normalized !== swapped) {
              try {
                return origAddSourceBuffer.call(this, normalized);
              } catch {
                /* ignore */
              }
            }

            const fallbacks = [
              targetType.includes('mp4a')
                ? 'video/mp4; codecs="hvc1,mp4a.40.2"'
                : 'video/mp4; codecs="hvc1"',
              targetType.includes('mp4a')
                ? 'video/mp4; codecs="hvc1.1.6.L120.90,mp4a.40.2"'
                : 'video/mp4; codecs="hvc1.1.6.L120.90"',
              targetType.includes('mp4a')
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
          if (typeof targetType === 'string' && isHevcCodec(targetType)) {
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

            const normalized = swapped.replace(
              /(hvc1\.[1-9]\d*\.[\da-fA-F]+\.)[LH](?:15\d|16\d|17\d|18\d)(\.[\da-fA-F]+)?/g,
              '$1L123$2'
            );
            if (normalized !== swapped) {
              try {
                return origManagedAddSourceBuffer.call(this, normalized);
              } catch {
                /* ignore */
              }
            }

            const fallbacks = [
              targetType.includes('mp4a')
                ? 'video/mp4; codecs="hvc1,mp4a.40.2"'
                : 'video/mp4; codecs="hvc1"',
              targetType.includes('mp4a')
                ? 'video/mp4; codecs="hvc1.1.6.L120.90,mp4a.40.2"'
                : 'video/mp4; codecs="hvc1.1.6.L120.90"',
              targetType.includes('mp4a')
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

              const normalized = swapped.replace(
                /(hvc1\.[1-9]\d*\.[\da-fA-F]+\.)L(?:15\d|16\d|17\d|18\d)(\.[\da-fA-F]+)?/g,
                '$1L123$2'
              );
              if (normalized !== swapped) {
                const normRes = origCanPlayType.call(this, normalized);
                if (normRes) return normRes;
              }
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
