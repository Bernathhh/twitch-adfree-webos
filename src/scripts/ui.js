/*global navigate*/
import '../lib/spatial-navigation-polyfill.js';
import {
  configAddChangeListener,
  configRead,
  configWrite,
  configGetDesc
} from '../config.js';
import '../style/ui.css';
import { APP_VERSION } from '../constants/global.constants.js';
import {
  configOptions,
  DISABLE_ANIMATIONS,
  ENABLE_AD_BLOCK,
  ENABLE_CHAT_OVERLAY,
  CHAT_POSITION,
  CHAT_OVERLAY_WIDTH,
  CHAT_OVERLAY_HEIGHT,
  CHAT_OVERLAY_FONT_SIZE,
  CHAT_OVERLAY_TRANSPARENCY,
  USE_CUSTOM_PROXY,
  PRIMARY_PROXY,
  PRIMARY_PROXY_OPTIONS,
  PROXY_SERVER_KEYS,
  ACTION_RESET_CONFIG
} from '../constants/config.constants.js';

// Constants for selectors
// Note: don't use class selectors, as they can change on every twitch deployment
const REJECT_COOKIES_SELECTOR =
  '[role="dialog"][aria-modal="true"] > div:last-child button:first-child';
const MODAL_SVG_SELECTOR = '[role="dialog"][aria-modal="true"] svg';
const contentClassificationSelector =
  'a[href*="tt_medium=content_classification"]';
/**
 * Any match implies an ad break; combined with end debounce for consecutive ads.
 *
 * Prefer stable `data-a-target` markers: the ad UI is rendered by
 * `VideoAdOverlay` / `VideoAdBanner` / `AdCountdownProgressBar`, and their
 * `data-a-target` values survive Twitch deploys (unlike hashed class names).
 *
 * - `video-ad-label` / `video-ad-countdown`: the black top ad bar (desktop player).
 * - `ad-countdown-progress-bar`: thin ad progress bar rendered instead of the
 *   black bar on TV / mobile-wrapped players (`isMobileWeb` branch). This is the
 *   "ad playing without the top bar" case that used to slip through.
 * - `ad-banner-default-text` / `player-ad-countdown`: legacy banner variants.
 * - `spectating-ad-banner`: ads shown while spectating another channel.
 * - Class selectors below are legacy fallbacks for older player builds.
 */
const AD_SIGNAL_SELECTORS = [
  '[data-a-target="video-ad-label"]',
  '[data-a-target="video-ad-countdown"]',
  '[data-a-target="ad-countdown-progress-bar"]',
  '[data-test-selector="ad-banner-default-text"]',
  '[data-a-target="player-ad-countdown"]',
  '[data-a-target="spectating-ad-banner"]',
  '.player-ad-overlay',
  '.video-player__ad--overlay',
  '.r-2dbvay'
];
/** No ad UI for this long after the last signal before restoring playback. */
const AD_END_HOLD_MS = 3000;
/** Re-apply mute / zero volume while suppressed (player often resets them mid-ad). */
const AD_REAPPLY_MS = 350;
const latestVideo = 'nav[role="navigation"] + main video';

const HOME_SELECTOR = 'a[href="/"]';
const LOGIN_SELECTOR = 'a[href="/login"]';
/** Twitch's own collapse/expand button for the chat (right column). */
const CHAT_TOGGLE_SELECTOR =
  '[data-a-target="right-column__toggle-collapse-btn"]';
const FOLLOWING_SELECTOR = 'a[href="/following"]';
const DIRECTORY_SELECTOR = 'a[href="/directory"]';
const SEARCH_SELECTOR = 'a[href="/search"]';

const LOGGED_IN_NAVIGATION_MAP = {
  49: HOME_SELECTOR, // 1 button
  50: FOLLOWING_SELECTOR, // 2 button
  51: DIRECTORY_SELECTOR, // 3 button
  52: SEARCH_SELECTOR // 4 button
};

const LOGGED_OUT_NAVIGATION_MAP = {
  49: LOGIN_SELECTOR, // 1 button
  50: HOME_SELECTOR, // 2 button
  51: DIRECTORY_SELECTOR, // 3 button
  52: SEARCH_SELECTOR // 4 button
};

import {
  ARROW_KEY_CODE,
  colorCodeMap,
  isInputFocused,
  isGreenKey,
  isYellowKey,
  isRedKey,
  isBlueKey,
  isBackKey,
  getKeyColor
} from './remote_keys.js';

export {
  ARROW_KEY_CODE,
  colorCodeMap,
  isInputFocused,
  isGreenKey,
  isYellowKey,
  isRedKey,
  isBlueKey,
  isBackKey,
  getKeyColor
};

// Global variables
let configOptionKeys = null;

// Function to apply/remove chat overlay styles
function applyChatOverlay(enable) {
  const styleClass = 'with-chat-overlay';
  let existingStyle = document.getElementsByClassName(styleClass);

  if (enable && existingStyle.length === 0) {
    document.body.classList.add(styleClass);
    applyChatPosition();
  } else if (!enable && existingStyle.length > 0) {
    document.body.classList.remove(styleClass);
    document.body.classList.remove('chat-left');
  }
}

// Function to apply chat position (left or right)
function applyChatPosition() {
  const pos = String(configRead(CHAT_POSITION));
  // Reset classes
  document.body.classList.remove('chat-left', 'chat-top', 'chat-bottom');

  const positions = configOptions[CHAT_POSITION].options;
  const [vertical, horizontal] = (() => {
    const posIndex = positions.indexOf(pos);
    const verticals = ['top', 'top', 'bottom', 'bottom'];
    const horizontals = ['left', 'right', 'left', 'right'];
    return [verticals[posIndex] || 'bottom', horizontals[posIndex] || 'right'];
  })();

  if (horizontal === 'left') {
    document.body.classList.add('chat-left');
  }
  if (vertical === 'top') {
    document.body.classList.add('chat-top');
  } else {
    document.body.classList.add('chat-bottom');
  }
}

// Function to apply chat sizing variables
function applyChatSizing() {
  const widthPx = Number(configRead(CHAT_OVERLAY_WIDTH));
  const heightVh = Number(configRead(CHAT_OVERLAY_HEIGHT));
  const fontPx = Number(configRead(CHAT_OVERLAY_FONT_SIZE));
  const transparency = Number(configRead(CHAT_OVERLAY_TRANSPARENCY));

  if (!Number.isNaN(widthPx)) {
    document.body.style.setProperty('--taf-chat-width', String(widthPx));
  }
  if (!Number.isNaN(heightVh)) {
    document.body.style.setProperty('--taf-chat-height', String(heightVh));
  }
  if (!Number.isNaN(fontPx)) {
    document.body.style.setProperty('--taf-chat-font-size', String(fontPx));
  }
  if (!Number.isNaN(transparency)) {
    // Convert 0-100 to 0.0-1.0 for CSS opacity
    const opacity = transparency / 100;
    document.body.style.setProperty('--taf-chat-transparency', String(opacity));
  }
}

export function cycleNextProxy() {
  const current = String(
    configRead(PRIMARY_PROXY) || PRIMARY_PROXY_OPTIONS[0]
  );
  const idx = PRIMARY_PROXY_OPTIONS.indexOf(current);
  const nextIdx =
    idx === -1 ? 0 : (idx + 1) % PRIMARY_PROXY_OPTIONS.length;
  const nextProxy = PRIMARY_PROXY_OPTIONS[nextIdx];

  configWrite(PRIMARY_PROXY, nextProxy);
  configWrite(USE_CUSTOM_PROXY, true);

  const valueSpans = document.querySelectorAll('.taf-proxy-value-span');
  valueSpans.forEach((span) => {
    span.textContent = nextProxy;
  });

  showNotification(`Прокси переключен: ${nextProxy}`, 3000, 'info');
  return nextProxy;
}

export function reloadTwitchStream() {
  const videos = getPlayerVideos(true);
  let handled = false;
  videos.forEach((video) => {
    try {
      if (video.buffered && video.buffered.length > 0) {
        const end = video.buffered.end(video.buffered.length - 1);
        video.currentTime = Math.max(0, end - 0.5);
      } else if (video.currentTime > 0) {
        video.currentTime = Math.max(0, video.currentTime + 0.1);
      }
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          /* ignore */
        });
      }
      handled = true;
    } catch {
      /* ignore */
    }
  });

  const playBtn = document.querySelector(
    'button[data-a-target="player-play-pause-button"]'
  );
  if (playBtn) {
    const label = (playBtn.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('play') || label.includes('воспроизведение')) {
      playBtn.click();
      handled = true;
    }
  }

  showNotification(
    handled ? 'Разморозка видео / перезапуск...' : 'Видео не найдено',
    2500,
    'info'
  );
  return handled;
}

export function resetToStableQuality() {
  try {
    const gearBtn = document.querySelector(
      'button[data-a-target="player-settings-button"]'
    );
    if (gearBtn) {
      gearBtn.click();
      setTimeout(() => {
        const qualityItem = document.querySelector(
          '[data-a-target="player-settings-menu-item-quality"]'
        );
        if (qualityItem) {
          qualityItem.click();
          setTimeout(() => {
            const radioItems = Array.from(
              document.querySelectorAll('input[name="player-quality-setting"]')
            );
            const targetRadio = radioItems.find((r) => {
              const label = r.closest('label');
              const text = label ? label.textContent : '';
              return (
                text.includes('1080p') ||
                text.includes('Auto') ||
                text.includes('Авто')
              );
            });
            if (targetRadio) {
              targetRadio.click();
              showNotification(
                'Качество переключено на 1080p / Авто',
                3000,
                'info'
              );
            }
            if (gearBtn) gearBtn.click();
          }, 120);
        } else if (gearBtn) {
          gearBtn.click();
        }
      }, 120);
      return true;
    }
  } catch {
    /* ignore */
  }
  reloadTwitchStream();
  showNotification('Сброс видеопотока...', 2500, 'info');
  return false;
}

if (typeof window !== 'undefined') {
  window.taf_resetToStableQuality = resetToStableQuality;
  window.taf_reloadStream = reloadTwitchStream;
}

function createConfigCheckbox(key) {
  const elmInput = document.createElement('input');
  const isBoolean = typeof configOptions[key].default === 'boolean';
  const isString = typeof configOptions[key].default === 'string';
  const options = configOptions[key].options;

  if (isBoolean) {
    elmInput.type = 'checkbox';
    elmInput.checked = configRead(key);
  } else if (isString && !options) {
    elmInput.type = 'text';
    elmInput.classList.add('taf-text-input');
    // Ensure value is set even if configRead is not ready yet
    const value = configRead(key);
    elmInput.value = value || configOptions[key].default || '';
  } else {
    elmInput.type = 'hidden';
  }

  /** @type {(evt: Event) => void} */
  const changeHandler = (evt) => {
    if (isBoolean) {
      configWrite(key, evt.target.checked);
    } else if (isString) {
      configWrite(key, evt.target.value);
    }
  };

  elmInput.addEventListener('change', changeHandler);

  let valueSpan = null;
  configAddChangeListener(key, (evt) => {
    if (isBoolean) {
      elmInput.checked = evt.detail.newValue;
    } else if (isString) {
      elmInput.value = String(evt.detail.newValue);
    } else if (valueSpan) {
      valueSpan.textContent = String(evt.detail.newValue);
    }
  });

  // Special handling for the proxy server fields (full-width text inputs)
  if (PROXY_SERVER_KEYS.includes(key)) {
    const container = document.createElement('div');
    container.classList.add('taf-config-item', 'taf-proxy-server-item');

    const label = document.createElement('label');
    label.classList.add('taf-config-label');
    label.textContent = configGetDesc(key);

    elmInput.classList.remove('taf-text-input');
    elmInput.classList.add('taf-fullwidth-input');
    elmInput.tabIndex = 0;

    container.appendChild(label);
    container.appendChild(elmInput);
    return container;
  }

  const elmLabel = document.createElement('label');
  if (key === PRIMARY_PROXY) {
    elmLabel.classList.add('taf-proxy-server-item');
  }
  elmLabel.appendChild(elmInput);
  // Use non-breaking space (U+00A0)
  elmLabel.appendChild(document.createTextNode('\u00A0' + configGetDesc(key)));

  if (key === ACTION_RESET_CONFIG) {
    // Action button: Reset configuration
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.classList.add('taf-reset-config-btn');
    actionBtn.textContent = '▶ Execute';
    actionBtn.addEventListener('click', () => {
      Object.keys(configOptions).forEach((k) => {
        const def = configOptions[k].default;
        if (def !== null) {
          configWrite(k, def);
        }
      });
      showNotification('Configuration restored to defaults', 4000, 'info');
    });
    actionBtn.tabIndex = 0;

    const btnContainer = document.createElement('span');
    btnContainer.classList.add('taf-number-arrows');
    btnContainer.appendChild(document.createTextNode(' '));
    btnContainer.appendChild(actionBtn);
    elmLabel.appendChild(btnContainer);
  } else if ((!isBoolean && !isString) || options) {
    // Arrow buttons and value display for numeric settings
    const container = document.createElement('span');
    container.classList.add('taf-number-arrows');

    const decBtn = document.createElement('button');
    decBtn.type = 'button';
    decBtn.textContent = '◀';
    const incBtn = document.createElement('button');
    incBtn.type = 'button';
    incBtn.textContent = '▶';
    valueSpan = document.createElement('span');
    valueSpan.classList.add('taf-number-value');
    if (key === PRIMARY_PROXY) {
      valueSpan.classList.add('taf-proxy-value-span');
    }
    valueSpan.textContent = String(configRead(key));

    const getDelta = () => {
      switch (key) {
        case CHAT_OVERLAY_WIDTH:
          return 10; // fine adjustments via arrows
        case CHAT_OVERLAY_HEIGHT:
          return 5;
        case CHAT_OVERLAY_FONT_SIZE:
          return 1;
        case CHAT_OVERLAY_TRANSPARENCY:
          return 5;
        default:
          return 1;
      }
    };

    const cycleOption = (dir) => {
      const current = String(configRead(key));
      const idx = options.indexOf(current);
      const nextIdx =
        (idx + (dir === 'next' ? 1 : -1) + options.length) % options.length;
      const next = options[nextIdx];
      configWrite(key, next);
      valueSpan.textContent = next;
    };

    if (options) {
      valueSpan.textContent = String(configRead(key));
      decBtn.addEventListener('click', () => cycleOption('prev'));
      incBtn.addEventListener('click', () => cycleOption('next'));
    } else {
      decBtn.addEventListener('click', () => {
        const current = Number(configRead(key));
        const next = Math.max(0, current - getDelta());
        configWrite(key, next);
      });
      incBtn.addEventListener('click', () => {
        const current = Number(configRead(key));
        let next = current + getDelta();
        // Cap transparency at 100%
        if (key === CHAT_OVERLAY_TRANSPARENCY) {
          next = Math.min(100, next);
        }
        configWrite(key, next);
      });
    }

    // Make focusable for remote navigation
    decBtn.tabIndex = 0;
    incBtn.tabIndex = 0;

    container.appendChild(document.createTextNode(' '));
    container.appendChild(decBtn);
    container.appendChild(document.createTextNode(' '));
    container.appendChild(valueSpan);
    container.appendChild(document.createTextNode(' '));
    container.appendChild(incBtn);
    elmLabel.appendChild(container);
  }

  return elmLabel;
}

function createOptionsPanel() {
  const elmContainer = document.createElement('div');
  elmContainer.classList.add('taf-ui-container');
  elmContainer.style.display = 'none';
  elmContainer.setAttribute('tabindex', '0');
  elmContainer.setAttribute('role', 'dialog');
  elmContainer.setAttribute('aria-modal', 'true');
  elmContainer.setAttribute('aria-label', 'Twitch AdFree Settings');

  elmContainer.addEventListener(
    'keydown',
    (evt) => {
      if (isGreenKey(evt) || isBackKey(evt)) {
        evt.preventDefault();
        evt.stopPropagation();
        showOptionsPanel(false);
        return;
      }

      if (evt.keyCode in ARROW_KEY_CODE) {
        const direction = ARROW_KEY_CODE[evt.keyCode];
        const active = document.activeElement;

        // If inside an arrow-adjusted config row:
        const arrowContainer = active
          ? active.closest('.taf-number-arrows')
          : null;
        if (arrowContainer) {
          const decBtn = arrowContainer.querySelector('button:first-of-type');
          const incBtn = arrowContainer.querySelector('button:last-of-type');
          if (direction === 'left' && decBtn) {
            decBtn.click();
            decBtn.focus();
            evt.preventDefault();
            evt.stopPropagation();
            return;
          }
          if (direction === 'right' && incBtn) {
            incBtn.click();
            incBtn.focus();
            evt.preventDefault();
            evt.stopPropagation();
            return;
          }
        }

        // If inside quick actions bar:
        const quickBar = active ? active.closest('.taf-quick-actions') : null;
        if (quickBar && (direction === 'left' || direction === 'right')) {
          const qButtons = Array.from(quickBar.querySelectorAll('button'));
          const qIdx = qButtons.indexOf(active);
          if (qIdx !== -1) {
            const nextQIdx =
              direction === 'right'
                ? (qIdx + 1) % qButtons.length
                : (qIdx - 1 + qButtons.length) % qButtons.length;
            qButtons[nextQIdx].focus();
            evt.preventDefault();
            evt.stopPropagation();
            return;
          }
        }

        // Standard linear/row navigation with Up / Down (or Left / Right outside special cases)
        const focusables = Array.from(
          elmContainer.querySelectorAll(
            'button, input[type="checkbox"], input[type="text"]'
          )
        ).filter((el) => el.offsetParent !== null && !el.disabled);

        if (focusables.length === 0) return;

        const currentIndex = focusables.indexOf(active);
        let nextIndex = currentIndex;

        if (['down', 'right'].includes(direction)) {
          nextIndex =
            currentIndex === -1 ? 0 : (currentIndex + 1) % focusables.length;
        } else if (['up', 'left'].includes(direction)) {
          nextIndex =
            currentIndex === -1
              ? focusables.length - 1
              : (currentIndex - 1 + focusables.length) % focusables.length;
        }

        const nextEl = focusables[nextIndex];
        if (nextEl) {
          nextEl.focus();
          if (typeof nextEl.scrollIntoView === 'function') {
            nextEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        }
        evt.preventDefault();
        evt.stopPropagation();
      } else if (evt.keyCode === 13) {
        // Enter / OK button on remote
        if (
          document.activeElement &&
          typeof document.activeElement.click === 'function'
        ) {
          document.activeElement.click();
        }
        evt.preventDefault();
        evt.stopPropagation();
      }
    },
    true
  );

  // Header section
  const header = document.createElement('header');
  const elmHeading = document.createElement('h1');
  elmHeading.textContent = 'Twitch AdFree Settings';
  header.appendChild(elmHeading);

  const elmSubtitle = document.createElement('p');
  elmSubtitle.textContent =
    'Press [GREEN] or [BACK] to close; use D-pad to navigate';
  elmSubtitle.classList.add('taf-subtitle');
  elmContainer.appendChild(header);
  elmContainer.appendChild(elmSubtitle);

  // Quick Actions Bar
  const quickActions = document.createElement('div');
  quickActions.classList.add('taf-quick-actions');

  const unfreezeBtn = document.createElement('button');
  unfreezeBtn.type = 'button';
  unfreezeBtn.classList.add('taf-action-btn');
  unfreezeBtn.textContent = '🔄 Разморозить видео';
  unfreezeBtn.title = 'Сбросить буфер и возобновить воспроизведение (кнопка Red)';
  unfreezeBtn.addEventListener('click', () => {
    reloadTwitchStream();
  });

  const resetQualBtn = document.createElement('button');
  resetQualBtn.type = 'button';
  resetQualBtn.classList.add('taf-action-btn');
  resetQualBtn.textContent = '⚡ 1080p / Авто';
  resetQualBtn.title = 'Сбросить качество на стабильное 1080p или Авто при зависаниях';
  resetQualBtn.addEventListener('click', () => {
    resetToStableQuality();
  });

  const proxyBtn = document.createElement('button');
  proxyBtn.type = 'button';
  proxyBtn.classList.add('taf-action-btn');
  proxyBtn.textContent = '🛡️ Сменить прокси';
  proxyBtn.title = 'Быстро переключить прокси-сервер (кнопка Blue)';
  proxyBtn.addEventListener('click', () => {
    cycleNextProxy();
  });

  const chatBtn = document.createElement('button');
  chatBtn.type = 'button';
  chatBtn.classList.add('taf-action-btn');
  chatBtn.textContent = '💬 Чат (Yellow)';
  chatBtn.title = 'Показать / скрыть чат (кнопка Yellow)';
  chatBtn.addEventListener('click', () => {
    toggleTwitchChat();
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.classList.add('taf-action-btn', 'taf-btn-close');
  closeBtn.textContent = '❌ Закрыть';
  closeBtn.title = 'Закрыть меню настроек (Green / Back)';
  closeBtn.addEventListener('click', () => {
    showOptionsPanel(false);
  });

  quickActions.appendChild(unfreezeBtn);
  quickActions.appendChild(resetQualBtn);
  quickActions.appendChild(proxyBtn);
  quickActions.appendChild(chatBtn);
  quickActions.appendChild(closeBtn);

  elmContainer.appendChild(quickActions);

  // Options list
  const optionsList = document.createElement('div');
  optionsList.classList.add('taf-options-list');

  if (!configOptionKeys) {
    configOptionKeys = Object.keys(configOptions);
  }

  configOptionKeys.forEach((option) => {
    const checkboxContainer = createConfigCheckbox(option);
    const checkboxInput = checkboxContainer.querySelector('input');
    if (checkboxInput) {
      checkboxInput.tabIndex = 0; // Make checkbox focusable
    }
    optionsList.appendChild(checkboxContainer);
  });

  // Proxy server URLs are only relevant while "Use proxy servers" is enabled
  const proxyServerItems = optionsList.querySelectorAll(
    '.taf-proxy-server-item'
  );
  const updateProxyServerVisibility = () => {
    const proxyEnabled = Boolean(configRead(USE_CUSTOM_PROXY));
    proxyServerItems.forEach((item) => {
      item.classList.toggle('taf-hidden', !proxyEnabled);
    });
  };
  configAddChangeListener(USE_CUSTOM_PROXY, updateProxyServerVisibility);
  updateProxyServerVisibility();

  elmContainer.appendChild(optionsList);

  // Footer
  const footer = document.createElement('footer');
  footer.classList.add('taf-footer');
  const versionInfo = document.createElement('p');
  versionInfo.innerHTML = `v${APP_VERSION} &mdash; <a href="https://github.com/adamff-dev" target="_blank" rel="noopener noreferrer">
  <img src="https://github.githubassets.com/favicons/favicon.png" alt="github.com" class="github-icon">adamff-dev
</a>`;
  footer.appendChild(versionInfo);
  elmContainer.appendChild(footer);

  return elmContainer;
}

export const optionsPanel = createOptionsPanel();
const attachOptionsPanel = () => {
  const root = document.body || document.documentElement;
  if (root && optionsPanel && !optionsPanel.parentNode) {
    root.appendChild(optionsPanel);
  }
};
if (document.body || document.documentElement) {
  attachOptionsPanel();
} else {
  document.addEventListener('DOMContentLoaded', attachOptionsPanel, {
    once: true
  });
}

let optionsPanelVisible = false;

/**
 * Show or hide the options panel.
 * @param {boolean} [visible=true] Whether to show the options panel.
 */
export function showOptionsPanel(visible) {
  visible ??= true;

  if (visible && !optionsPanelVisible) {
    optionsPanel.style.display = 'flex';
    const firstFocusable = optionsPanel.querySelector(
      'button, input[type="checkbox"], input[type="text"]'
    );
    if (firstFocusable) {
      firstFocusable.focus();
    } else {
      optionsPanel.focus();
    }
    optionsPanelVisible = true;
  } else if (!visible && optionsPanelVisible) {
    optionsPanel.style.display = 'none';
    optionsPanel.blur();
    optionsPanelVisible = false;
  }
}

window.taf_showOptionsPanel = showOptionsPanel;

/**
 * Toggles chat visibility by clicking Twitch's own collapse/expand button,
 * so the real chat state is toggled (rather than just hiding the chat element).
 */
export function toggleTwitchChat() {
  const toggleButton = document.querySelector(CHAT_TOGGLE_SELECTOR);
  if (toggleButton) {
    toggleButton.click();
  }
}

function handleNumberButtonsClick(keyCode) {
  const buttonSelector = document.querySelector(LOGIN_SELECTOR)
    ? LOGGED_OUT_NAVIGATION_MAP[keyCode]
    : LOGGED_IN_NAVIGATION_MAP[keyCode];
  const buttonElement = document.querySelector(buttonSelector);
  if (buttonElement) {
    buttonElement.click();
  }
}

const eventHandler = (evt) => {
  if (optionsPanelVisible) {
    if (isBackKey(evt) || isGreenKey(evt)) {
      evt.preventDefault();
      evt.stopPropagation();
      if (evt.type === 'keydown') {
        showOptionsPanel(false);
      }
      return false;
    }
    return true;
  }

  // Red button: instant emergency video unfreeze / buffer reload
  if (isRedKey(evt)) {
    evt.preventDefault();
    evt.stopPropagation();
    if (evt.type === 'keydown') {
      reloadTwitchStream();
    }
    return false;
  }

  // Blue button: instant proxy server cycle
  if (isBlueKey(evt)) {
    evt.preventDefault();
    evt.stopPropagation();
    if (evt.type === 'keydown') {
      cycleNextProxy();
    }
    return false;
  }

  if (
    !isInputFocused() &&
    Object.keys(LOGGED_IN_NAVIGATION_MAP).includes(String(evt.keyCode))
  ) {
    handleNumberButtonsClick(evt.keyCode);
    evt.preventDefault();
    evt.stopPropagation();
    return false;
  }

  if (isGreenKey(evt)) {
    evt.preventDefault();
    evt.stopPropagation();

    if (evt.type === 'keydown') {
      showOptionsPanel(!optionsPanelVisible);
    }
    return false;
  }

  if (isYellowKey(evt)) {
    evt.preventDefault();
    evt.stopPropagation();

    if (evt.type === 'keydown') {
      toggleTwitchChat();
    }
    return false;
  }
  return true;
};

export function showNotification(text, time = 7000, type = 'success') {
  const attachRoot = document.body || document.documentElement;
  if (!attachRoot) {
    return;
  }

  let container = document.querySelector('.taf-notification-container');
  if (!container) {
    const c = document.createElement('div');
    c.classList.add('taf-notification-container');
    attachRoot.appendChild(c);
    container = c;
  }

  const elm = document.createElement('div');
  const elmInner = document.createElement('div');
  elmInner.innerHTML = text;
  elmInner.classList.add('message');
  elmInner.classList.add('message-hidden');
  elmInner.classList.add(`message-${type}`);
  elm.appendChild(elmInner);
  container.appendChild(elm);

  setTimeout(() => {
    elmInner.classList.remove('message-hidden');
  }, 100);
  setTimeout(() => {
    elmInner.classList.add('message-hidden');
    setTimeout(() => {
      elm.remove();
    }, 1000);
  }, time);
}

/**
 * Initializes the removal of CSS transition animations based on a configuration setting.
 * Appends a <style> element to the document head to disable transitions globally when enabled.
 * Listens for changes to the DISABLE_ANIMATIONS config and updates the style accordingly.
 */
function initRemoveAnimations() {
  const style = document.createElement('style');
  document.head.appendChild(style);

  const setHidden = (hide) => {
    style.textContent = hide ? '* { transition: none !important; }' : '';
  };

  setHidden(configRead(DISABLE_ANIMATIONS));

  configAddChangeListener(DISABLE_ANIMATIONS, (evt) => {
    setHidden(evt.detail.newValue);
  });
}

function adBreakSignalsPresent() {
  for (const sel of AD_SIGNAL_SELECTORS) {
    try {
      if (document.querySelector(sel)) return true;
    } catch {
      /* invalid selector in a future deploy */
    }
  }
  const videoPlayer = document.querySelector('[data-a-target="video-player"]');
  if (
    videoPlayer &&
    videoPlayer.querySelector('[data-a-target="banner-ad-container"]')
  ) {
    return true;
  }
  return false;
}

/**
 * Videos under the player (or main). With includeSmall, every descendant <video>
 * is returned — needed during ad suppression because Twitch swaps elements and
 * new tags often report 0×0 until layout settles (they were skipped by the size filter).
 */
function getPlayerVideos(includeSmall = false) {
  const root =
    document.querySelector('[data-a-target="video-player"]') ||
    document.querySelector('main');
  const list = root
    ? Array.from(root.querySelectorAll('video'))
    : Array.from(document.querySelectorAll('video'));
  if (includeSmall) return list;
  return list.filter((v) => {
    const r = v.getBoundingClientRect();
    return r.width > 80 && r.height > 45;
  });
}

function handleAdsAndConsentModals() {
  const preAdByVideo = new WeakMap();
  const suppressedVideos = new Set();
  let suppressPlayback = false;
  let endHoldTimer = null;
  let reapplyTimer = null;
  let evalScheduled = false;

  function clearEndHoldTimer() {
    if (endHoldTimer) {
      clearTimeout(endHoldTimer);
      endHoldTimer = null;
    }
  }

  function clearReapplyTimer() {
    if (reapplyTimer) {
      clearInterval(reapplyTimer);
      reapplyTimer = null;
    }
  }

  function rememberPreAdOnce(video) {
    if (!preAdByVideo.has(video)) {
      preAdByVideo.set(video, {
        muted: video.muted,
        volume: video.volume,
        display: video.style.display || ''
      });
    }
  }

  function applyAdSuppressionToAll() {
    const videos = getPlayerVideos(true);
    for (const v of videos) {
      rememberPreAdOnce(v);
      v.muted = true;
      v.volume = 0;
      v.style.display = 'none';
      suppressedVideos.add(v);
    }
  }

  function restoreAllSuppressed() {
    clearReapplyTimer();
    for (const v of suppressedVideos) {
      const s = preAdByVideo.get(v);
      if (s) {
        v.muted = s.muted;
        v.volume = s.volume;
        v.style.display = s.display;
      }
      preAdByVideo.delete(v);
    }
    suppressedVideos.clear();
  }

  function startReapplyLoop() {
    if (reapplyTimer) return;
    reapplyTimer = setInterval(() => {
      if (suppressPlayback) applyAdSuppressionToAll();
    }, AD_REAPPLY_MS);
  }

  function evaluateAdSuppression() {
    const enableAdBlock = configRead(ENABLE_AD_BLOCK);
    if (!enableAdBlock) {
      clearEndHoldTimer();
      if (suppressPlayback) {
        suppressPlayback = false;
        restoreAllSuppressed();
      }
      return;
    }

    const signals = adBreakSignalsPresent();

    if (signals) {
      clearEndHoldTimer();
      const wasOff = !suppressPlayback;
      suppressPlayback = true;
      applyAdSuppressionToAll();
      startReapplyLoop();
      if (wasOff) {
        showNotification('Ads muted and hidden');
      }
      return;
    }

    if (!suppressPlayback) return;

    if (!endHoldTimer) {
      endHoldTimer = setTimeout(() => {
        endHoldTimer = null;
        suppressPlayback = false;
        restoreAllSuppressed();
      }, AD_END_HOLD_MS);
    }
    applyAdSuppressionToAll();
    startReapplyLoop();
  }

  function scheduleEval() {
    if (evalScheduled) return;
    evalScheduled = true;
    requestAnimationFrame(() => {
      evalScheduled = false;
      evaluateAdSuppression();
    });
  }

  /** Player swaps <video> nodes mid-ad; these fire when the new element loads or unmutes. */
  function onVideoAdLifecycle(e) {
    if (!suppressPlayback) return;
    if (e.target instanceof HTMLVideoElement) applyAdSuppressionToAll();
  }

  for (const evtName of [
    'playing',
    'volumechange',
    'loadedmetadata',
    'loadeddata',
    'emptied'
  ]) {
    document.addEventListener(evtName, onVideoAdLifecycle, true);
  }

  configAddChangeListener(ENABLE_AD_BLOCK, () => {
    scheduleEval();
  });

  const observer = new MutationObserver(() => {
    scheduleEval();

    // Auto-reject cookies if the modal is present
    const rejectCookiesButton = document.querySelector(REJECT_COOKIES_SELECTOR);
    const modalSvg = document.querySelector(MODAL_SVG_SELECTOR);
    if (rejectCookiesButton && modalSvg) {
      rejectCookiesButton.click();
      showNotification('Cookie consent rejected automatically');
    }

    // Auto-accept adult content if the modal is present
    const acceptAdultContentButton = document.querySelector(
      contentClassificationSelector
    );
    if (
      acceptAdultContentButton &&
      acceptAdultContentButton.previousElementSibling
    ) {
      acceptAdultContentButton.previousElementSibling.click();
      showNotification('Mature content warning dismissed automatically');
    }

    // Remove the channel home latest video preview to improve performance and prevent potential crashes
    // (This is a known Twitch bug)
    const posterElement = document.querySelector(latestVideo);
    if (posterElement) {
      posterElement.remove();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  scheduleEval();
}

function initKeyListeners() {
  document.addEventListener('keydown', eventHandler, true);
  document.addEventListener('keypress', eventHandler, true);
  document.addEventListener('keyup', eventHandler, true);
}

function initChatOverlay() {
  // Apply initial state
  applyChatOverlay(configRead(ENABLE_CHAT_OVERLAY));
  if (configRead(ENABLE_CHAT_OVERLAY)) {
    applyChatSizing();
  }

  // Listen for changes
  configAddChangeListener(ENABLE_CHAT_OVERLAY, (evt) => {
    applyChatOverlay(evt.detail.newValue);
  });

  // Listen for chat position changes
  configAddChangeListener(CHAT_POSITION, () => {
    if (configRead(ENABLE_CHAT_OVERLAY)) {
      applyChatPosition();
    }
  });

  // Listen for chat sizing changes
  const sizingKeys = [
    CHAT_OVERLAY_WIDTH,
    CHAT_OVERLAY_HEIGHT,
    CHAT_OVERLAY_FONT_SIZE,
    CHAT_OVERLAY_TRANSPARENCY
  ];
  sizingKeys.forEach((k) => {
    configAddChangeListener(k, () => {
      if (configRead(ENABLE_CHAT_OVERLAY)) {
        applyChatSizing();
      }
    });
  });
}

function init() {
  handleAdsAndConsentModals();
  initRemoveAnimations();
  initKeyListeners();
  initChatOverlay();

  showNotification('Press [GREEN] button to open configuration', 5000, 'info');
}

/**
 * Twitch / webOS can inject bundled scripts before <body> exists. Prior code
 * called MutationObserver.observe(document.body) synchronously during init(),
 * which throws and skips all UI setup (including notifications).
 */
function scheduleUIInit() {
  let ran = false;
  const tryRun = () => {
    if (ran || !document.body) return;
    ran = true;
    init();
  };

  tryRun();

  document.addEventListener('DOMContentLoaded', tryRun, { once: true });

  let frames = 0;
  function tick() {
    tryRun();
    if (ran || ++frames >= 300) {
      if (!ran) {
        console.warn(
          '[twitch-adfree] UI init deferred: document.body did not appear in time'
        );
      }
      return;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

scheduleUIInit();
