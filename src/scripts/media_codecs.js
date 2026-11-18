/**
 * Overrides MediaSource.isTypeSupported, MediaSource.prototype.addSourceBuffer,
 * SourceBuffer.prototype.appendBuffer, and HTMLMediaElement.prototype.canPlayType to:
 * 1. Report AV1 (av01 / av1) as unsupported so webOS avoids software AV1 decoding,
 *    which exhausts TV memory and freezes 1440p/4K streams.
 * 2. Handle hardware-accelerated HEVC / H.265 (hvc1 / hev1) by testing real browser
 *    support across FourCC variants (hev1 <-> hvc1) and profile levels.
 * 3. Prune old SourceBuffer segments to prevent TV buffer bloat / OOM freezes on 1440p/4K.
 * 4. Run an automatic stall detection watchdog that kicks playback when frozen on a frame/buffer gap.
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
 * Checks whether HEVC is supported by trying original isTypeSupported with
 * hev1 <-> hvc1 normalization and standard profile strings.
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
      const swapped = type.includes('hev1')
        ? type.replace(/hev1/g, 'hvc1')
        : type.replace(/hvc1/g, 'hev1');
      if (origFn.call(context, swapped)) {
        return true;
      }
      const baseType = type.includes('mp4a')
        ? 'video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"'
        : 'video/mp4; codecs="hvc1.1.6.L93.B0"';
      if (origFn.call(context, baseType)) {
        return true;
      }
      if (origFn.call(context, 'video/mp4; codecs="hvc1"')) {
        return true;
      }
      if (origFn.call(context, 'video/mp4; codecs="hevc"')) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Automatically detects video playback stalls (frozen frame / buffer gap)
 * and attempts a micro-seek / live-edge jump to unstick playback.
 */
export function initStallWatchdog() {
  if (typeof window === 'undefined') return;

  let lastTime = -1;
  let stallDuration = 0;

  const timer = setInterval(() => {
    try {
      const video = document.querySelector('video');
      if (!video || video.paused || video.ended) {
        lastTime = -1;
        stallDuration = 0;
        return;
      }

      const cur = video.currentTime;
      if (cur > 0 && Math.abs(cur - lastTime) < 0.05) {
        stallDuration++;
        // If stalled for 3 consecutive seconds:
        if (stallDuration >= 3) {
          console.warn('[TAF] Video stall detected at ' + cur.toFixed(2) + 's, attempting recovery...');
          let jumpedHole = false;
          if (video.buffered && video.buffered.length > 0) {
            for (let i = 0; i < video.buffered.length; i++) {
              const bStart = video.buffered.start(i);
              if (bStart > cur && bStart - cur < 3) {
                video.currentTime = bStart + 0.05;
                const p = video.play();
                if (p && p.catch) p.catch(() => {});
                jumpedHole = true;
                break;
              }
            }
          }
          if (!jumpedHole) {
            video.currentTime = cur + 0.1;
            const p = video.play();
            if (p && p.catch) p.catch(() => {});
          }
          stallDuration = 0;
        }
      } else {
        lastTime = cur;
        stallDuration = 0;
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
            // Try swapping hev1 <-> hvc1
            const swapped = targetType.includes('hev1')
              ? targetType.replace(/hev1/g, 'hvc1')
              : targetType.replace(/hvc1/g, 'hev1');
            try {
              return origAddSourceBuffer.call(this, swapped);
            } catch {
              /* ignore */
            }

            // Try standard profiles
            const fallbacks = [
              targetType.includes('mp4a')
                ? 'video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"'
                : 'video/mp4; codecs="hvc1.1.6.L93.B0"',
              targetType.includes('mp4a')
                ? 'video/mp4; codecs="hvc1,mp4a.40.2"'
                : 'video/mp4; codecs="hvc1"',
              'video/mp4; codecs="hev1"',
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
            const swapped = targetType.includes('hev1')
              ? targetType.replace(/hev1/g, 'hvc1')
              : targetType.replace(/hvc1/g, 'hev1');
            try {
              return origManagedAddSourceBuffer.call(this, swapped);
            } catch {
              /* ignore */
            }
            const fallbacks = [
              targetType.includes('mp4a')
                ? 'video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"'
                : 'video/mp4; codecs="hvc1.1.6.L93.B0"',
              targetType.includes('mp4a')
                ? 'video/mp4; codecs="hvc1,mp4a.40.2"'
                : 'video/mp4; codecs="hvc1"',
              'video/mp4; codecs="hev1"',
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

  // 3. Hook SourceBuffer.prototype.appendBuffer to evict old back-buffer and prevent TV OOM
  try {
    if (
      typeof window.SourceBuffer !== 'undefined' &&
      window.SourceBuffer.prototype &&
      typeof window.SourceBuffer.prototype.appendBuffer === 'function'
    ) {
      const origAppend = window.SourceBuffer.prototype.appendBuffer;
      window.SourceBuffer.prototype.appendBuffer = function (data) {
        try {
          if (!this.updating && this.buffered && this.buffered.length > 0) {
            const video = document.querySelector('video');
            if (video && video.currentTime > 0) {
              const start = this.buffered.start(0);
              // If back-buffer is larger than 15s, remove older data to prevent TV OOM
              if (video.currentTime - start > 15) {
                this.remove(start, video.currentTime - 8);
              }
            }
          }
        } catch {
          /* ignore */
        }
        return origAppend.call(this, data);
      };
    }
  } catch (err) {
    console.warn('[TAF] Failed to patch SourceBuffer.prototype.appendBuffer', err);
  }

  // 4. Override HTMLMediaElement.prototype.canPlayType
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
            if (typeof type === 'string' && type.includes('hev1')) {
              const hvcRes = origCanPlayType.call(
                this,
                type.replace(/hev1/g, 'hvc1')
              );
              if (hvcRes) {
                return hvcRes;
              }
            }
            const baseRes = origCanPlayType.call(this, 'video/mp4; codecs="hvc1"');
            if (baseRes) {
              return baseRes;
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

  // 5. Initialize the playback stall watchdog
  initStallWatchdog();
}

// Automatically install on module execution
patchMediaCodecs();
