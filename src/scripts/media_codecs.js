/**
 * Overrides MediaSource.isTypeSupported, MediaSource.prototype.addSourceBuffer,
 * and HTMLMediaElement.prototype.canPlayType to:
 * 1. Report AV1 (av01 / av1) as unsupported so webOS avoids software AV1 decoding,
 *    which exhausts TV memory and freezes 1440p/4K streams.
 * 2. Ensure hardware-accelerated HEVC / H.265 (hvc1 / hev1) is accepted and normalized
 *    so webOS Chromium MSE does not throw NotSupportedError on 1440p/4K playback.
 * 3. Retain standard support for avc1 (H.264).
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
          try {
            if (origIsTypeSupported.call(window.MediaSource, type)) {
              return true;
            }
            if (
              typeof type === 'string' &&
              type.includes('hev1') &&
              origIsTypeSupported.call(
                window.MediaSource,
                type.replace(/hev1/g, 'hvc1')
              )
            ) {
              return true;
            }
          } catch {
            /* ignore */
          }
          // Hardware HEVC is natively supported on webOS TV chipsets
          return true;
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
          try {
            if (origManagedIsTypeSupported.call(window.ManagedMediaSource, type)) {
              return true;
            }
            if (
              typeof type === 'string' &&
              type.includes('hev1') &&
              origManagedIsTypeSupported.call(
                window.ManagedMediaSource,
                type.replace(/hev1/g, 'hvc1')
              )
            ) {
              return true;
            }
          } catch {
            /* ignore */
          }
          return true;
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

  // 2. Override MediaSource.prototype.addSourceBuffer to normalize hev1 -> hvc1
  try {
    if (
      typeof window.MediaSource !== 'undefined' &&
      window.MediaSource.prototype &&
      typeof window.MediaSource.prototype.addSourceBuffer === 'function'
    ) {
      const origAddSourceBuffer = window.MediaSource.prototype.addSourceBuffer;
      const patchedAddSourceBuffer = function (type) {
        let targetType = type;
        if (typeof targetType === 'string' && targetType.includes('hev1')) {
          targetType = targetType.replace(/hev1/g, 'hvc1');
        }
        try {
          return origAddSourceBuffer.call(this, targetType);
        } catch (err) {
          if (typeof targetType === 'string' && isHevcCodec(targetType)) {
            try {
              const fallbackType = targetType.includes('mp4a')
                ? 'video/mp4; codecs="hvc1,mp4a.40.2"'
                : 'video/mp4; codecs="hvc1"';
              return origAddSourceBuffer.call(this, fallbackType);
            } catch {
              /* ignore */
            }
          }
          throw err;
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
        if (typeof targetType === 'string' && targetType.includes('hev1')) {
          targetType = targetType.replace(/hev1/g, 'hvc1');
        }
        try {
          return origManagedAddSourceBuffer.call(this, targetType);
        } catch (err) {
          if (typeof targetType === 'string' && isHevcCodec(targetType)) {
            try {
              const fallbackType = targetType.includes('mp4a')
                ? 'video/mp4; codecs="hvc1,mp4a.40.2"'
                : 'video/mp4; codecs="hvc1"';
              return origManagedAddSourceBuffer.call(this, fallbackType);
            } catch {
              /* ignore */
            }
          }
          throw err;
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
            if (typeof type === 'string' && type.includes('hev1')) {
              const hvcRes = origCanPlayType.call(
                this,
                type.replace(/hev1/g, 'hvc1')
              );
              if (hvcRes) {
                return hvcRes;
              }
            }
          } catch {
            /* ignore */
          }
          return 'probably';
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
}

// Automatically install on module execution
patchMediaCodecs();
