import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isLivePlaylistUrl,
  enforceSupportedCodecs,
  buildProxiedUrl,
  getProxyServers,
  getRawAuthToken,
  patchManifest,
  installUsherXhrPatch
} from '../src/scripts/patch_usher_xhr.js';
import {
  isAv1Codec,
  isHevcCodec,
  cleanHevcCodec,
  checkHevcSupported,
  patchMediaCodecs
} from '../src/scripts/media_codecs.js';
import {
  isInputFocused,
  isGreenKey,
  isYellowKey,
  isRedKey,
  isBlueKey,
  isBackKey,
  getKeyColor
} from '../src/scripts/remote_keys.js';
import {
  configOptions,
  LOAD_EMOTES,
  ENABLE_CHAT_OVERLAY,
  USE_CUSTOM_PROXY
} from '../src/constants/config.constants.js';
import { configWrite } from '../src/config.js';

test('isLivePlaylistUrl matches live usher HLS endpoints and ignores others', () => {
  assert.equal(
    isLivePlaylistUrl(
      'https://usher.ttvnw.net/api/v2/channel/hls/teststreamer.m3u8?token=123'
    ),
    true
  );
  assert.equal(
    isLivePlaylistUrl(
      'https://usher.ttvnw.net/api/channel/hls/teststreamer.m3u8?token=123'
    ),
    true
  );
  assert.equal(
    isLivePlaylistUrl('//usher.ttvnw.net/api/v2/channel/hls/teststreamer.m3u8'),
    true
  );
  assert.equal(
    isLivePlaylistUrl('https://usher.ttvnw.net/vod/987654321.m3u8'),
    false
  );
  assert.equal(isLivePlaylistUrl('https://gql.twitch.tv/gql'), false);
  assert.equal(isLivePlaylistUrl(null), false);
});

test('enforceSupportedCodecs forces h265,h264 and strips av1 while preserving query params', () => {
  const originalWithAv1 =
    'https://usher.ttvnw.net/api/v2/channel/hls/streamer.m3u8?allow_source=true&supported_codecs=av1,h265,h264&sig=abcdef&token=%7B%22user_id%22%3A1%7D';
  const result1 = enforceSupportedCodecs(originalWithAv1);

  assert.match(result1, /supported_codecs=h265,h264/);
  assert.equal(result1.includes('av1'), false);
  assert.equal(result1.includes('sig=abcdef'), true);
  assert.equal(result1.includes('allow_source=true'), true);

  const originalWithoutCodecs =
    'https://usher.ttvnw.net/api/channel/hls/streamer.m3u8?sig=12345';
  const result2 = enforceSupportedCodecs(originalWithoutCodecs);
  assert.match(result2, /supported_codecs=h265,h264/);
  assert.equal(result2.includes('sig=12345'), true);
});

test('buildProxiedUrl creates ReYohoho proxy format with hide_audio_only and auth params', () => {
  const usherUrl =
    'https://usher.ttvnw.net/api/v2/channel/hls/streamer.m3u8?allow_source=true&supported_codecs=h265,h264&sig=xyz';

  const proxied4 = buildProxiedUrl(
    'https://proxy4.rte.net.ru/',
    usherUrl,
    'streamer'
  );
  assert.match(proxied4, /^https:\/\/proxy4\.rte\.net\.ru\/https:\/\/usher\.ttvnw\.net\//);
  assert.match(proxied4, /supported_codecs=h265,h264/);
  assert.match(proxied4, /hide_audio_only=true/);

  const proxied7 = buildProxiedUrl(
    'https://proxy7.rte.net.ru/',
    usherUrl,
    'streamer'
  );
  assert.match(proxied7, /^https:\/\/proxy7\.rte\.net\.ru\/https:\/\/usher\.ttvnw\.net\//);
  assert.match(proxied7, /hide_audio_only=true/);
});

test('getProxyServers defaults to proxy4 with fallback to proxy7', () => {
  const servers = getProxyServers();
  assert.ok(servers.length >= 2);
  assert.equal(servers[0], 'https://proxy4.rte.net.ru/');
  assert.equal(servers[1], 'https://proxy7.rte.net.ru/');
});

test('getRawAuthToken safely extracts auth token from environment', () => {
  assert.equal(typeof getRawAuthToken(), 'string');
});

test('isAv1Codec correctly detects AV1 and does not match AVC1/HEVC', () => {
  assert.equal(isAv1Codec('video/mp4; codecs="av01.0.08M.10"'), true);
  assert.equal(
    isAv1Codec('video/mp4; codecs="av01.2.19M.10.0.100.09.16.09.0"'),
    true
  );
  assert.equal(isAv1Codec('video/webm; codecs="av1"'), true);
  assert.equal(isAv1Codec('av01'), true);
  assert.equal(isAv1Codec('av1'), true);

  // Must NOT match AVC (H.264)
  assert.equal(isAv1Codec('video/mp4; codecs="avc1.64002a"'), false);
  assert.equal(isAv1Codec('video/mp4; codecs="avc1.4d401f, mp4a.40.2"'), false);

  // Must NOT match HEVC (H.265)
  assert.equal(isAv1Codec('video/mp4; codecs="hev1.1.6.L93.B0"'), false);
  assert.equal(isAv1Codec('video/mp4; codecs="hvc1.1.6.L93.B0"'), false);

  // Must NOT match other audio/video
  assert.equal(isAv1Codec('audio/mp4; codecs="mp4a.40.2"'), false);
  assert.equal(isAv1Codec(null), false);
  assert.equal(isAv1Codec(undefined), false);
});

test('isHevcCodec correctly detects HEVC (hev1 / hvc1)', () => {
  assert.equal(isHevcCodec('video/mp4; codecs="hev1.1.6.L93.B0"'), true);
  assert.equal(isHevcCodec('video/mp4; codecs="hvc1.1.6.L93.B0"'), true);
  assert.equal(isHevcCodec('video/mp4; codecs="hvc1"'), true);
  assert.equal(isHevcCodec('video/mp4; codecs="hev1"'), true);
  assert.equal(isHevcCodec('video/mp4; codecs="avc1.64002a"'), false);
  assert.equal(isHevcCodec('video/mp4; codecs="av01.0.13M.08"'), false);
});

test('cleanHevcCodec trims non-standard trailing constraint tokens', () => {
  assert.equal(
    cleanHevcCodec('video/mp4; codecs="hev1.1.6.L150.90.0.0.0.0.0,mp4a.40.2"'),
    'video/mp4; codecs="hev1.1.6.L150.90,mp4a.40.2"'
  );
  assert.equal(
    cleanHevcCodec('video/mp4; codecs="hvc1.1.6.L150.90.0.0.0.0.0"'),
    'video/mp4; codecs="hvc1.1.6.L150.90"'
  );
  assert.equal(
    cleanHevcCodec('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    'video/mp4; codecs="hvc1.1.6.L93.B0"'
  );
});

test('checkHevcSupported normalizes syntax and tests swapped FourCCs without spoofing levels', () => {
  const origFn = (type) => type === 'video/mp4; codecs="hvc1.1.6.L150.90"';

  assert.equal(
    checkHevcSupported(
      origFn,
      null,
      'video/mp4; codecs="hev1.1.6.L150.90.0.0.0.0.0"'
    ),
    true
  );
  assert.equal(
    checkHevcSupported(origFn, null, 'video/mp4; codecs="hev1.1.6.L180.90"'),
    false
  );
});

test('patchManifest removes AV1 variants and cleans/normalizes hev1 to hvc1', () => {
  const inputManifest = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="1440p60_av1",NAME="1440p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=8745502,RESOLUTION=2560x1440,CODECS="av01.0.13M.08,mp4a.40.2",VIDEO="1440p60_av1",FRAME-RATE=60.000
https://euc12.playlist.ttvnw.net/v1/playlist/av1.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="1440p60_hevc",NAME="1440p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=8745502,RESOLUTION=2560x1440,CODECS="hev1.1.6.L150.90.0.0.0.0.0,mp4a.40.2",VIDEO="1440p60_hevc",FRAME-RATE=60.000
https://euc12.playlist.ttvnw.net/v1/playlist/hevc.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="1080p60",NAME="1080p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="1080p60",FRAME-RATE=60.000
https://euc12.playlist.ttvnw.net/v1/playlist/1080p.m3u8`;

  const patched = patchManifest(inputManifest);

  // AV1 stream and media must be completely gone
  assert.equal(patched.includes('av01'), false);
  assert.equal(patched.includes('1440p60_av1'), false);
  assert.equal(patched.includes('av1.m3u8'), false);

  // HEVC must be cleaned and normalized to hvc1
  assert.equal(patched.includes('hev1'), false);
  assert.match(patched, /CODECS="hvc1\.1\.6\.L150\.90,mp4a\.40\.2"/);
  assert.equal(patched.includes('1440p60_hevc'), true);
  assert.equal(patched.includes('hevc.m3u8'), true);

  // AVC1 1080p must remain intact
  assert.match(patched, /CODECS="avc1\.64002A,mp4a\.40\.2"/);
  assert.equal(patched.includes('1080p.m3u8'), true);
});

test('patchMediaCodecs overrides MediaSource.isTypeSupported, addSourceBuffer and canPlayType', () => {
  const originalMediaSource = globalThis.window?.MediaSource;
  const originalHTMLMediaElement = globalThis.window?.HTMLMediaElement;

  class FakeMediaSource {
    static isTypeSupported(type) {
      if (type.includes('avc1') || type.includes('hvc1')) {
        return true;
      }
      return false;
    }
  }

  FakeMediaSource.prototype.addSourceBuffer = function (type) {
    if (type.includes('hev1')) {
      throw new Error('NotSupportedError: hev1 is unsupported');
    }
    return { type };
  };

  class FakeHTMLMediaElement {
    canPlayType(type) {
      if (type.includes('avc1') || type.includes('hvc1')) {
        return 'probably';
      }
      return '';
    }
  }

  if (!globalThis.window) {
    globalThis.window = /** @type {any} */ ({});
  }
  globalThis.window.MediaSource = FakeMediaSource;
  globalThis.window.HTMLMediaElement = FakeHTMLMediaElement;

  patchMediaCodecs();

  // AV1 codecs must return false / ""
  assert.equal(
    globalThis.window.MediaSource.isTypeSupported(
      'video/mp4; codecs="av01.0.08M.10"'
    ),
    false
  );
  assert.equal(
    globalThis.window.MediaSource.isTypeSupported('video/webm; codecs="av1"'),
    false
  );

  const mediaEl = new FakeHTMLMediaElement();
  assert.equal(mediaEl.canPlayType('video/mp4; codecs="av01.0.08M.10"'), '');
  assert.equal(mediaEl.canPlayType('video/webm; codecs="av1"'), '');

  // HEVC support: both hvc1 and hev1 return true for isTypeSupported
  assert.equal(
    globalThis.window.MediaSource.isTypeSupported(
      'video/mp4; codecs="hev1.1.6.L93.B0"'
    ),
    true
  );
  assert.equal(
    globalThis.window.MediaSource.isTypeSupported(
      'video/mp4; codecs="hvc1.1.6.L93.B0"'
    ),
    true
  );
  assert.equal(
    globalThis.window.MediaSource.isTypeSupported(
      'video/mp4; codecs="avc1.64002a"'
    ),
    true
  );

  // addSourceBuffer normalizes hev1 -> hvc1 so it succeeds without throwing
  const msInstance = new FakeMediaSource();
  const sb = msInstance.addSourceBuffer('video/mp4; codecs="hev1.1.6.L93.B0"');
  assert.equal(sb.type, 'video/mp4; codecs="hvc1.1.6.L93.B0"');

  assert.equal(
    mediaEl.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"'),
    'probably'
  );
  assert.equal(
    mediaEl.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    'probably'
  );
  assert.equal(
    mediaEl.canPlayType('video/mp4; codecs="avc1.64002a"'),
    'probably'
  );

  // Restore
  if (originalMediaSource) {
    globalThis.window.MediaSource = originalMediaSource;
  }
  if (originalHTMLMediaElement) {
    globalThis.window.HTMLMediaElement = originalHTMLMediaElement;
  }
});

class FakeXHR {
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  send() {}
  dispatchEvent() {}
}

test('XHR and fetch proxying intercepts usher requests and falls back to proxy7 on failure', async () => {
  const requestedUrls = [];

  const fakeFetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    requestedUrls.push(url);

    // Fail proxy4 to trigger fallback
    if (url.startsWith('https://proxy4.rte.net.ru/')) {
      return new Response('Proxy4 Gateway Timeout', { status: 504 });
    }

    // proxy7 succeeds
    if (url.startsWith('https://proxy7.rte.net.ru/')) {
      return new Response(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="hev1.1.6.L93.B0"\nstream.m3u8',
        {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
        }
      );
    }

    return new Response('OK', { status: 200 });
  };

  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;

  globalThis.window = /** @type {any} */ ({
    location: { href: 'https://lg.tv.twitch.tv/' },
    XMLHttpRequest: FakeXHR,
    fetch: fakeFetch
  });
  globalThis.fetch = fakeFetch;

  installUsherXhrPatch();

  configWrite(USE_CUSTOM_PROXY, true);
  requestedUrls.length = 0;
  const res = await globalThis.window.fetch(
    'https://usher.ttvnw.net/api/v2/channel/hls/testch.m3u8?supported_codecs=av1,h264'
  );

  assert.equal(res.status, 200);
  assert.equal(requestedUrls.length, 2);

  // Returned manifest must have hev1 normalized to hvc1
  const bodyText = await res.text();
  assert.match(bodyText, /CODECS="hvc1\.1\.6\.L93\.B0"/);

  configWrite(USE_CUSTOM_PROXY, false);

  // Restore
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
});

test('direct usher fetch is used when USE_CUSTOM_PROXY is false (default)', async () => {
  const requestedUrls = [];
  const fakeFetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    requestedUrls.push(url);
    return new Response(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS="hev1.1.6.L150.90.0.0.0.0.0"\nstream.m3u8',
      {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
      }
    );
  };

  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;

  globalThis.window = /** @type {any} */ ({
    location: { href: 'https://lg.tv.twitch.tv/' },
    XMLHttpRequest: FakeXHR,
    fetch: fakeFetch
  });
  globalThis.fetch = fakeFetch;

  installUsherXhrPatch();

  requestedUrls.length = 0;
  const res = await globalThis.window.fetch(
    'https://usher.ttvnw.net/api/v2/channel/hls/directtest.m3u8'
  );

  assert.equal(res.status, 200);
  assert.equal(requestedUrls.length, 1);
  assert.equal(
    requestedUrls[0],
    'https://usher.ttvnw.net/api/v2/channel/hls/directtest.m3u8?supported_codecs=h265,h264'
  );

  const text = await res.text();
  assert.match(text, /CODECS="hvc1\.1\.6\.L150\.90"/);

  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
});

test('isGreenKey detects all webOS green button variations and keyboard fallbacks', () => {
  assert.equal(isGreenKey(null), false);
  assert.equal(isGreenKey(undefined), false);

  // webOS remote key codes
  assert.equal(isGreenKey({ keyCode: 404 }), true);
  assert.equal(isGreenKey({ keyCode: 172 }), true);
  assert.equal(isGreenKey({ which: 404 }), true);
  assert.equal(isGreenKey({ which: 172 }), true);

  // webOS and modern DOM event keys
  assert.equal(isGreenKey({ key: 'ColorF1Green' }), true);
  assert.equal(isGreenKey({ key: 'Green' }), true);
  assert.equal(isGreenKey({ code: 'ColorF1Green' }), true);
  assert.equal(isGreenKey({ key: 'F2' }), true);

  // Keyboard shortcut 'g'/'G' when no input is focused
  assert.equal(isGreenKey({ key: 'g' }), true);
  assert.equal(isGreenKey({ key: 'G' }), true);

  // Non-green keys
  assert.equal(isGreenKey({ keyCode: 403 }), false); // Red
  assert.equal(isGreenKey({ keyCode: 405 }), false); // Yellow
  assert.equal(isGreenKey({ keyCode: 461 }), false); // Back
  assert.equal(isGreenKey({ key: 'Enter' }), false);
});

test('isYellowKey, isRedKey, isBlueKey detect their respective remote color buttons', () => {
  // Yellow
  assert.equal(isYellowKey({ keyCode: 405 }), true);
  assert.equal(isYellowKey({ keyCode: 170 }), true);
  assert.equal(isYellowKey({ key: 'ColorF2Yellow' }), true);
  assert.equal(isYellowKey({ key: 'Yellow' }), true);
  assert.equal(isYellowKey({ key: 'F3' }), true);
  assert.equal(isYellowKey({ key: 'y' }), true);
  assert.equal(isYellowKey({ keyCode: 404 }), false);

  // Red
  assert.equal(isRedKey({ keyCode: 403 }), true);
  assert.equal(isRedKey({ key: 'ColorF0Red' }), true);
  assert.equal(isRedKey({ key: 'Red' }), true);
  assert.equal(isRedKey({ key: 'F1' }), true);
  assert.equal(isRedKey({ keyCode: 405 }), false);

  // Blue
  assert.equal(isBlueKey({ keyCode: 406 }), true);
  assert.equal(isBlueKey({ keyCode: 191 }), true);
  assert.equal(isBlueKey({ key: 'ColorF3Blue' }), true);
  assert.equal(isBlueKey({ key: 'Blue' }), true);
  assert.equal(isBlueKey({ key: 'F4' }), true);
  assert.equal(isBlueKey({ keyCode: 404 }), false);
});

test('isBackKey detects webOS Back button and escape variations', () => {
  assert.equal(isBackKey({ keyCode: 461 }), true);
  assert.equal(isBackKey({ keyCode: 27 }), true);
  assert.equal(isBackKey({ keyCode: 10009 }), true);
  assert.equal(isBackKey({ key: 'Back' }), true);
  assert.equal(isBackKey({ key: 'GoBack' }), true);
  assert.equal(isBackKey({ key: 'Escape' }), true);

  assert.equal(isBackKey({ keyCode: 13 }), false);
  assert.equal(isBackKey({ keyCode: 404 }), false);
  assert.equal(isBackKey(null), false);
});

test('getKeyColor correctly resolves color name from code and event', () => {
  assert.equal(getKeyColor(404), 'green');
  assert.equal(getKeyColor(172), 'green');
  assert.equal(getKeyColor(403), 'red');
  assert.equal(getKeyColor(405), 'yellow');
  assert.equal(getKeyColor(170), 'yellow');
  assert.equal(getKeyColor(406), 'blue');
  assert.equal(getKeyColor(191), 'blue');

  assert.equal(getKeyColor(0, { key: 'ColorF1Green' }), 'green');
  assert.equal(getKeyColor(0, { key: 'ColorF2Yellow' }), 'yellow');
  assert.equal(getKeyColor(0, { key: 'ColorF0Red' }), 'red');
  assert.equal(getKeyColor(0, { key: 'ColorF3Blue' }), 'blue');

  assert.equal(getKeyColor(999), null);
  assert.equal(getKeyColor(13), null);
});

test('isInputFocused correctly detects focused text inputs', () => {
  // When no document is present in Node
  assert.equal(isInputFocused(), false);

  // With a mock document
  const origDoc = globalThis.document;
  globalThis.document = /** @type {any} */ ({
    activeElement: { tagName: 'INPUT' }
  });
  assert.equal(isInputFocused(), true);

  globalThis.document.activeElement = { tagName: 'TEXTAREA' };
  assert.equal(isInputFocused(), true);

  globalThis.document.activeElement = { tagName: 'DIV', isContentEditable: true };
  assert.equal(isInputFocused(), true);

  globalThis.document.activeElement = { tagName: 'BUTTON' };
  assert.equal(isInputFocused(), false);

  globalThis.document.activeElement = null;
  assert.equal(isInputFocused(), false);

  globalThis.document = origDoc;
});

test('LOAD_EMOTES, ENABLE_CHAT_OVERLAY and USE_CUSTOM_PROXY default to false', () => {
  assert.equal(configOptions[LOAD_EMOTES].default, false);
  assert.equal(configOptions[ENABLE_CHAT_OVERLAY].default, false);
  assert.equal(configOptions[USE_CUSTOM_PROXY].default, false);
});

