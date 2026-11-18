export const ARROW_KEY_CODE = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };

export const colorCodeMap = new Map([
  [403, 'red'],
  [404, 'green'],
  [172, 'green'],
  [405, 'yellow'],
  [170, 'yellow'],
  [406, 'blue'],
  [191, 'blue']
]);

export function isInputFocused() {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  return Boolean(
    el &&
      (el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.isContentEditable)
  );
}

export function isGreenKey(evt) {
  if (!evt) return false;
  const code = evt.keyCode || evt.which;
  if (code === 404 || code === 172) return true;
  if (
    evt.key === 'ColorF1Green' ||
    evt.key === 'Green' ||
    evt.key === 'F2' ||
    evt.code === 'ColorF1Green'
  ) {
    return true;
  }
  if ((evt.key === 'g' || evt.key === 'G') && !isInputFocused()) {
    return true;
  }
  return false;
}

export function isYellowKey(evt) {
  if (!evt) return false;
  const code = evt.keyCode || evt.which;
  if (code === 405 || code === 170) return true;
  if (
    evt.key === 'ColorF2Yellow' ||
    evt.key === 'Yellow' ||
    evt.key === 'F3' ||
    evt.code === 'ColorF2Yellow'
  ) {
    return true;
  }
  if ((evt.key === 'y' || evt.key === 'Y') && !isInputFocused()) {
    return true;
  }
  return false;
}

export function isRedKey(evt) {
  if (!evt) return false;
  const code = evt.keyCode || evt.which;
  if (code === 403) return true;
  if (
    evt.key === 'ColorF0Red' ||
    evt.key === 'Red' ||
    evt.key === 'F1' ||
    evt.code === 'ColorF0Red'
  ) {
    return true;
  }
  if ((evt.key === 'r' || evt.key === 'R') && !isInputFocused()) {
    return true;
  }
  return false;
}

export function isBlueKey(evt) {
  if (!evt) return false;
  const code = evt.keyCode || evt.which;
  if (code === 406 || code === 191) return true;
  if (
    evt.key === 'ColorF3Blue' ||
    evt.key === 'Blue' ||
    evt.key === 'F4' ||
    evt.code === 'ColorF3Blue'
  ) {
    return true;
  }
  if ((evt.key === 'b' || evt.key === 'B') && !isInputFocused()) {
    return true;
  }
  return false;
}

export function isBackKey(evt) {
  if (!evt) return false;
  const code = evt.keyCode || evt.which;
  if (code === 461 || code === 27 || code === 10009) return true;
  if (
    evt.key === 'Back' ||
    evt.key === 'GoBack' ||
    evt.key === 'Escape'
  ) {
    return true;
  }
  return false;
}

/**
 * Returns the name of the color button associated with a code or null if not a color button.
 * @param {number} keyCode KeyboardEvent.keyCode property from event
 * @param {KeyboardEvent} [evt] Optional KeyboardEvent
 * @returns {string | null} Color name or null
 */
export function getKeyColor(keyCode, evt) {
  if (evt) {
    if (isGreenKey(evt)) return 'green';
    if (isYellowKey(evt)) return 'yellow';
    if (isRedKey(evt)) return 'red';
    if (isBlueKey(evt)) return 'blue';
  }
  if (colorCodeMap.has(keyCode)) {
    return colorCodeMap.get(keyCode);
  }

  return null;
}
