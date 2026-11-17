import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isLivePlaylistUrl,
  enforceSupportedCodecs,
  buildProxiedUrl,
  getProxyServers,
  installUsherXhrPatch
} from '../src/scripts/patch_usher_xhr.js';
import { isAv1Codec, patchMediaCodecs } from '../src/scripts/media_codecs.js';

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

test('buildProxiedUrl creates ReYohoho proxy format keeping full URL and query params', () => {
  const usherUrl =
    'https://usher.ttvnw.net/api/v2/channel/hls/streamer.m3u8?allow_source=true&supported_codecs=h265,h264&sig=xyz';

  const proxied4 = buildProxiedUrl(
    'https://proxy4.rte.net.ru/',
    usherUrl,
    'streamer'
  );
  assert.equal(
    proxied4,
    'https://proxy4.rte.net.ru/https://usher.ttvnw.net/api/v2/channel/hls/streamer.m3u8?allow_source=true&supported_codecs=h265,h264&sig=xyz'
  );

  const proxied7 = buildProxiedUrl(
    'https://proxy7.rte.net.ru/',
    usherUrl,
    'streamer'
  );
  assert.equal(
    proxied7,
    'https://proxy7.rte.net.ru/https://usher.ttvnw.net/api/v2/channel/hls/streamer.m3u8?allow_source=true&supported_codecs=h265,h264&sig=xyz'
  );
});

test('getProxyServers defaults to proxy4 with fallback to proxy7', () => {
  const servers = getProxyServers();
  assert.ok(servers.length >= 2);
  assert.equal(servers[0], 'https://proxy4.rte.net.ru/');
  assert.equal(servers[1], 'https://proxy7.rte.net.ru/');
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

test('patchMediaCodecs overrides MediaSource.isTypeSupported and canPlayType', () => {
  // Mock window.MediaSource and HTMLMediaElement for node test environment
  const originalMediaSource = globalThis.window?.MediaSource;
  const originalHTMLMediaElement = globalThis.window?.HTMLMediaElement;

  class FakeMediaSource {
    static isTypeSupported(type) {
      if (
        type.includes('avc1') ||
        type.includes('hev1') ||
        type.includes('hvc1')
      ) {
        return true;
      }
      return false;
    }
  }

  class FakeHTMLMediaElement {
    canPlayType(type) {
      if (
        type.includes('avc1') ||
        type.includes('hev1') ||
        type.includes('hvc1')
      ) {
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

  // Standard support for hvc1 / hev1 / avc1
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
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nstream.m3u8',
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

  class FakeXHR {
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    send() {}
    dispatchEvent() {}
  }

  globalThis.window = /** @type {any} */ ({
    location: { href: 'https://lg.tv.twitch.tv/' },
    XMLHttpRequest: FakeXHR,
    fetch: fakeFetch
  });
  globalThis.fetch = fakeFetch;

  installUsherXhrPatch();

  // Test fetch interceptor
  requestedUrls.length = 0;
  const res = await globalThis.window.fetch(
    'https://usher.ttvnw.net/api/v2/channel/hls/testch.m3u8?supported_codecs=av1,h264'
  );

  assert.equal(res.status, 200);
  assert.equal(requestedUrls.length, 2);
  // First tried proxy4 with enforced codecs
  assert.equal(
    requestedUrls[0],
    'https://proxy4.rte.net.ru/https://usher.ttvnw.net/api/v2/channel/hls/testch.m3u8?supported_codecs=h265,h264'
  );
  // Fallback tried proxy7 with enforced codecs
  assert.equal(
    requestedUrls[1],
    'https://proxy7.rte.net.ru/https://usher.ttvnw.net/api/v2/channel/hls/testch.m3u8?supported_codecs=h265,h264'
  );

  // Restore
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
});
