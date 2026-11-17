/**
 * Overrides MediaSource.isTypeSupported and HTMLMediaElement.prototype.canPlayType
 * to report that AV1 (av01 / av1) is unsupported on webOS.
 *
 * This prevents webOS from attempting software AV1 decoding on 1440p/4K streams,
 * which exhausts TV memory and freezes the system.
 *
 * Standard browser support is retained for hvc1 / hev1 (HEVC) and avc1 (H.264).
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
  return lower.includes('av01') || lower.includes('av1');
}

export function patchMediaCodecs() {
  if (typeof window === 'undefined') {
    return;
  }

  // 1. Override MediaSource.isTypeSupported
  if (
    typeof window.MediaSource !== 'undefined' &&
    typeof window.MediaSource.isTypeSupported === 'function'
  ) {
    const origIsTypeSupported = window.MediaSource.isTypeSupported;
    window.MediaSource.isTypeSupported = function (type) {
      if (isAv1Codec(type)) {
        return false;
      }
      return origIsTypeSupported.call(this || window.MediaSource, type);
    };
  }

  // Also patch ManagedMediaSource if present in newer webOS WebEngine runtimes
  if (
    typeof window.ManagedMediaSource !== 'undefined' &&
    typeof window.ManagedMediaSource.isTypeSupported === 'function'
  ) {
    const origManagedIsTypeSupported =
      window.ManagedMediaSource.isTypeSupported;
    window.ManagedMediaSource.isTypeSupported = function (type) {
      if (isAv1Codec(type)) {
        return false;
      }
      return origManagedIsTypeSupported.call(
        this || window.ManagedMediaSource,
        type
      );
    };
  }

  // 2. Override HTMLMediaElement.prototype.canPlayType
  if (
    typeof window.HTMLMediaElement !== 'undefined' &&
    window.HTMLMediaElement.prototype &&
    typeof window.HTMLMediaElement.prototype.canPlayType === 'function'
  ) {
    const origCanPlayType = window.HTMLMediaElement.prototype.canPlayType;
    window.HTMLMediaElement.prototype.canPlayType = function (type) {
      if (isAv1Codec(type)) {
        return '';
      }
      return origCanPlayType.call(this, type);
    };
  }
}

// Automatically install on module execution
patchMediaCodecs();
