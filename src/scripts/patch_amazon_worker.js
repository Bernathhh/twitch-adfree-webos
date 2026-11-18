// Source: https://github.com/besuper/TwitchNoSub
/* global useProxy, proxyServers, authToken */

function isAv1Codec(type) {
  if (typeof type !== 'string') {
    return false;
  }
  const lower = type.toLowerCase();
  return lower.includes('av01') || (lower.includes('av1') && !lower.includes('avc1'));
}

function isHevcCodec(type) {
  if (typeof type !== 'string') {
    return false;
  }
  const lower = type.toLowerCase();
  return lower.includes('hev1') || lower.includes('hvc1');
}

function cleanHevcCodec(type) {
  if (typeof type !== 'string') {
    return type;
  }
  return type.replace(
    /(hev1|hvc1)\.([1-9]\d*)\.([\da-fA-F]+)\.([LH]\d+)\.([\da-fA-F]+)(?:\.[\da-fA-F]+)+/g,
    '$1.$2.$3.$4.$5'
  );
}

// Disable AV1 on MediaSource and ensure HEVC is supported if worker supports it
if (
  typeof self !== 'undefined' &&
  self.MediaSource &&
  typeof self.MediaSource.isTypeSupported === 'function'
) {
  const origIsTypeSupported = self.MediaSource.isTypeSupported;
  self.MediaSource.isTypeSupported = function (type) {
    if (isAv1Codec(type)) {
      return false;
    }
    if (isHevcCodec(type)) {
      try {
        if (origIsTypeSupported.call(self.MediaSource, type)) {
          return true;
        }
        if (typeof type === 'string') {
          const cleaned = cleanHevcCodec(type);
          if (cleaned !== type && origIsTypeSupported.call(self.MediaSource, cleaned)) {
            return true;
          }
          const swapped = cleaned.includes('hev1')
            ? cleaned.replace(/hev1/g, 'hvc1')
            : cleaned.replace(/hvc1/g, 'hev1');
          if (origIsTypeSupported.call(self.MediaSource, swapped)) {
            return true;
          }
          const normalized = swapped.replace(
            /(hvc1\.[1-9]\d*\.[\da-fA-F]+\.)L(?:15\d|16\d|17\d|18\d)(\.[\da-fA-F]+)?/g,
            '$1L123$2'
          );
          if (
            normalized !== swapped &&
            origIsTypeSupported.call(self.MediaSource, normalized)
          ) {
            return true;
          }
          if (origIsTypeSupported.call(self.MediaSource, 'video/mp4; codecs="hvc1"')) {
            return true;
          }
        }
      } catch {
        /* ignore */
      }
      return false;
    }
    return origIsTypeSupported.call(this || self.MediaSource, type);
  };
}

// Override MediaSource.prototype.addSourceBuffer to handle HEVC fallbacks
if (
  typeof self !== 'undefined' &&
  self.MediaSource &&
  self.MediaSource.prototype &&
  typeof self.MediaSource.prototype.addSourceBuffer === 'function'
) {
  const origAddSourceBuffer = self.MediaSource.prototype.addSourceBuffer;
  self.MediaSource.prototype.addSourceBuffer = function (type) {
    let targetType = type;
    try {
      return origAddSourceBuffer.call(this, targetType);
    } catch (err) {
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
          /(hvc1\.[1-9]\d*\.[\da-fA-F]+\.)L(?:15\d|16\d|17\d|18\d)(\.[\da-fA-F]+)?/g,
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
      throw err;
    }
  };
}

let resolutions = {
  '160p30': {
    res: '284x160',
    bandwidth: 290738,
    fps: 30
  },
  '360p30': {
    res: '640x360',
    bandwidth: 742051,
    fps: 30
  },
  '480p30': {
    res: '854x480',
    bandwidth: 1469111,
    fps: 30
  },
  '720p60': {
    res: '1280x720',
    bandwidth: 3430584,
    fps: 60
  },
  '1080p30': {
    res: '1920x1080',
    bandwidth: 5145876,
    fps: 30
  },
  '1080p60': {
    res: '1920x1080',
    bandwidth: 8438581,
    fps: 60
  },
  chunked: {
    res: '1920x1080',
    bandwidth: 5145876,
    fps: 30
  }
};

async function fetchTwitchDataGQL(vodID) {
  const resp = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    body: JSON.stringify({
      query:
        'query { video(id: "' +
        vodID +
        '") { broadcastType, createdAt, seekPreviewsURL, owner { login }, playbackAccessToken(params: {platform: "web", playerType: "site"}) { authorization { isForbidden } } }}'
    }),
    headers: {
      'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }
  });

  return resp.json();
}

function createServingID() {
  const w = '0123456789abcdefghijklmnopqrstuvwxyz'.split('');
  let id = '';

  for (let i = 0; i < 32; i++) {
    id += w[Math.floor(Math.random() * w.length)];
  }

  return id;
}

async function isValidQuality(url) {
  const response = await fetch(url);

  if (response.ok) {
    const data = await response.text();

    if (data.includes('.ts')) {
      // ts files should still use the h264
      return { codec: 'avc1.4D001E' };
    }

    if (data.includes('.mp4')) {
      // mp4 file use h265, but sometimes h264
      const mp4Request = await fetch(
        url.replace('index-dvr.m3u8', 'init-0.mp4')
      );

      if (mp4Request.ok) {
        const content = await mp4Request.text();

        return {
          codec: content.includes('hev1') ? 'hev1.1.6.L93.B0' : 'avc1.4D001E'
        };
      }

      return { codec: 'hev1.1.6.L93.B0' };
    }
  }

  return null;
}

/**
 * Merges the original request query string into `target`, keeping any query
 * parameters the target already defines.
 *
 * @param {string} target Rewritten URL (may already contain a query string).
 * @param {string} originalUrl Original Twitch playlist request URL.
 * @returns {string} Target with the missing original query parameters added.
 */
function mergeOriginalQuery(target, originalUrl) {
  const originalQuery = new URL(originalUrl).search.replace(/^\?/, '');
  if (originalQuery === '') {
    return target;
  }

  const hashAt = target.indexOf('#');
  const hash = hashAt === -1 ? '' : target.slice(hashAt);
  const withoutHash = hashAt === -1 ? target : target.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  const base = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const templateQuery = queryAt === -1 ? '' : withoutHash.slice(queryAt + 1);

  const presentKeys = new Set(
    templateQuery
      .split('&')
      .filter(Boolean)
      .map((param) => param.split('=')[0])
  );

  const carried = originalQuery
    .split('&')
    .filter(Boolean)
    .filter((param) => !presentKeys.has(param.split('=')[0]));

  const mergedQuery = [
    ...templateQuery.split('&').filter(Boolean),
    ...carried
  ].join('&');

  return (mergedQuery === '' ? base : `${base}?${mergedQuery}`) + hash;
}

/**
 * Builds the final HLS URL for one configured proxy server.
 *
 * A server can be either:
 *   - a URL-prefix proxy (the default), e.g. `https://proxy4.rte.net.ru/`: the
 *     full original URL (query string included) is appended after the base;
 *   - a template using `$url` / `{url}` (full original URL) or `$channel` /
 *     `{channel}` (channel login).
 *
 * Twitch's access token/signature travel in the request query string. For
 * templates the missing original query parameters are merged in unless the
 * template already carries them (or uses a `$url` placeholder). Without this a
 * pass-through proxy receives an unauthenticated request and usher replies with
 * HTTP 403, which made the proxy appear to "do nothing".
 *
 * @param {string} server Configured proxy server (prefix base or template).
 * @param {string} originalUrl Original Twitch playlist request URL.
 * @param {string} channel Channel login extracted from the original URL.
 * @returns {string} URL to request instead of the original one.
 */
function patchManifest(manifest) {
  if (typeof manifest !== 'string') {
    return manifest;
  }

  // 1. Clean non-standard HEVC codec strings (trim extra .0.0.0.0.0 tokens)
  let cleaned = cleanHevcCodec(manifest);

  // 2. Normalize hev1 -> hvc1 for webOS Chromium MSE compatibility
  cleaned = cleaned.replace(/hev1/g, 'hvc1');

  // 3. Normalize Level 5.0+ (L150/L153) to Level 4.1 (L123) for webOS MSE compatibility
  // WebOS Chromium caps supported HEVC levels at Level 4.1 in its MSE table;
  // the TV hardware decoder natively handles 1440p60/4K60 once SourceBuffer is opened.
  cleaned = cleaned.replace(
    /(hvc1\.[1-9]\d*\.[\da-fA-F]+\.)L(?:15\d|16\d|17\d|18\d)(\.[\da-fA-F]+)?/g,
    '$1L123$2'
  );

  // 4. Strip any AV1 variants (av01 / av1) to avoid software decoding / freezing
  if (cleaned.includes('av01') || cleaned.includes('av1')) {
    const lines = cleaned.split(/\r?\n/);
    const filteredLines = [];
    const removedGroupIds = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const isAv1 =
          /CODECS="[^"]*(?:av01|av1)[^"]*"/i.test(line) &&
          !/CODECS="[^"]*avc1[^"]*"/i.test(line);

        if (isAv1) {
          const videoMatch = line.match(/VIDEO="([^"]+)"/);
          if (videoMatch && videoMatch[1]) {
            removedGroupIds.add(videoMatch[1]);
          }
          if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
            i++;
          }
          continue;
        }
      }

      filteredLines.push(line);
    }

    if (removedGroupIds.size > 0) {
      cleaned = filteredLines
        .filter((line) => {
          if (line.startsWith('#EXT-X-MEDIA:TYPE=VIDEO')) {
            const groupMatch = line.match(/GROUP-ID="([^"]+)"/);
            if (groupMatch && removedGroupIds.has(groupMatch[1])) {
              return false;
            }
          }
          return true;
        })
        .join('\n');
    } else {
      cleaned = filteredLines.join('\n');
    }
  }

  return cleaned;
}

function buildProxiedUrl(server, originalUrl, channel) {
  const trimmed = server.trim();
  let result;

  if (trimmed.includes('$url') || trimmed.includes('{url}')) {
    result = trimmed
      .split('$url')
      .join(originalUrl)
      .split('{url}')
      .join(originalUrl);
  } else if (trimmed.includes('$channel') || trimmed.includes('{channel}')) {
    const target = trimmed
      .split('$channel')
      .join(channel)
      .split('{channel}')
      .join(channel);
    result = mergeOriginalQuery(target, originalUrl);
  } else if (!trimmed.includes('.m3u8')) {
    result = trimmed.endsWith('/')
      ? trimmed + originalUrl
      : `${trimmed}/${originalUrl}`;
  } else {
    result = mergeOriginalQuery(trimmed, originalUrl);
  }

  if (result.includes('rte.net.ru')) {
    if (typeof authToken === 'string' && authToken && !result.includes('auth=')) {
      const sep = result.includes('?') ? '&' : '?';
      result = `${result}${sep}auth=${encodeURIComponent(authToken)}`;
    }
    if (!result.includes('hide_audio_only=')) {
      const sep = result.includes('?') ? '&' : '?';
      result = `${result}${sep}hide_audio_only=true`;
    }
  }

  return result;
}

const oldFetch = self.fetch;

self.fetch = async function (input, opt) {
  let url;
  if (input instanceof Request) {
    url = input.url;
  } else if (typeof input === 'string' || input instanceof String) {
    url = input.toString();
  } else {
    // Fallback to oldFetch
    return oldFetch(input, opt);
  }

  // Fix relative URL for Worker context
  if (url.startsWith('/')) {
    url = self.origin ? `${self.origin}${url}` : `${location.origin}${url}`;

    // Reconstruct Request if needed
    if (input instanceof Request) {
      input = new Request(url, input);
    } else {
      input = url;
    }
  }

  // Block Sentry requests
  if (url.includes('ingest.sentry.io')) {
    return;
  }

  function isLivePlaylistUrl(u) {
    return (
      typeof u === 'string' &&
      u.includes('usher.ttvnw.net') &&
      (u.includes('/api/v2/channel/hls/') || u.includes('/api/channel/hls/'))
    );
  }

  function enforceSupportedCodecs(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      parsed.searchParams.set('supported_codecs', 'h265,h264');
      return parsed
        .toString()
        .replace(
          /supported_codecs=h265(?:%2C|,)h264/g,
          'supported_codecs=h265,h264'
        );
    } catch {
      if (rawUrl.includes('supported_codecs=')) {
        return rawUrl.replace(
          /supported_codecs=[^&]*/g,
          'supported_codecs=h265,h264'
        );
      }
      const sep = rawUrl.includes('?') ? '&' : '?';
      return `${rawUrl}${sep}supported_codecs=h265,h264`;
    }
  }

  function fetchWithTimeout(req, options = {}, timeoutMs = 2500) {
    if (typeof AbortController === 'undefined') {
      return oldFetch(req, options);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const mergedOptions = { ...options, signal: controller.signal };
    return oldFetch(req, mergedOptions).finally(() => {
      clearTimeout(timer);
    });
  }

  // Redirect live HLS playlist requests through the configured proxy servers.
  if (isLivePlaylistUrl(url)) {
    url = enforceSupportedCodecs(url);
    if (url.startsWith('//')) {
      url = `https:${url}`;
    } else if (url.startsWith('http://')) {
      url = `https://${url.slice('http://'.length)}`;
    }

    if (input instanceof Request) {
      input = new Request(url, input);
    } else {
      input = url;
    }

    const proxyList =
      useProxy && Array.isArray(proxyServers) && proxyServers.length > 0
        ? proxyServers
        : useProxy
          ? [
              'https://proxy4.rte.net.ru/',
              'https://proxy7.rte.net.ru/',
              'https://proxy5.rte.net.ru/',
              'https://proxy6.rte.net.ru/'
            ]
          : [];

    if (proxyList.length > 0) {
      let channel = '';
      try {
        const urlObj = new URL(url);
        const channelMatch = urlObj.pathname.match(
          /\/channel\/hls\/([^.]+)(?:\.m3u8)?/
        );
        if (channelMatch && channelMatch[1]) {
          channel = channelMatch[1];
        }
      } catch (e) {
        console.warn('Failed to parse channel from URL', e);
      }

      for (const server of proxyList) {
        const newUrl = buildProxiedUrl(server, url, channel);
        const request =
          input instanceof Request ? new Request(newUrl, input) : newUrl;

        try {
          // eslint-disable-next-line no-await-in-loop
          const proxied = await fetchWithTimeout(request, opt, 2500);
          if (proxied && proxied.ok) {
            // eslint-disable-next-line no-await-in-loop
            const text = await proxied.text();
            const patched = patchManifest(text);
            const headers = new Headers(proxied.headers);
            headers.set('content-type', 'application/vnd.apple.mpegurl');
            return new Response(patched, {
              status: proxied.status,
              statusText: proxied.statusText,
              headers
            });
          }
          console.warn(
            `Proxy server returned HTTP ${proxied ? proxied.status : 'error'}, trying next:`,
            server
          );
        } catch (e) {
          console.warn('Proxy server failed, trying next:', server, e);
        }
      }
    }
  }

  let response = await oldFetch(input, opt);

  if (isLivePlaylistUrl(url) && response && response.ok) {
    try {
      const text = await response.text();
      const patched = patchManifest(text);
      const headers = new Headers(response.headers);
      headers.set('content-type', 'application/vnd.apple.mpegurl');
      return new Response(patched, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch {
      return response;
    }
  }

  if (url.startsWith('https://usher.ttvnw.net/vod/')) {
    if (response.status != 200) {
      const vodId = url
        .split('https://usher.ttvnw.net/vod/')[1]
        .split('.m3u8')[0];
      const twitchVideoRes = await fetchTwitchDataGQL(vodId);

      if (twitchVideoRes == undefined) {
        return new Response('Unable to fetch twitch data API', { status: 403 });
      }

      const vodData = twitchVideoRes.data.video;

      // Skip if the vod is not archived
      if (
        vodData &&
        vodData.broadcastType &&
        vodData.broadcastType.toLowerCase() !== 'archive'
      ) {
        return response;
      }

      const channelData = vodData.owner;

      let sorted_dict = Object.keys(resolutions);
      sorted_dict = sorted_dict.reverse();

      let ordered_resolutions = {};

      for (const key in sorted_dict) {
        ordered_resolutions[sorted_dict[key]] = resolutions[sorted_dict[key]];
      }

      resolutions = ordered_resolutions;

      const currentURL = new URL(vodData.seekPreviewsURL);

      const domain = currentURL.host;
      const paths = currentURL.pathname.split('/');
      const vodSpecialID =
        paths[
          paths.findIndex((element) => element.includes('storyboards')) - 1
        ];

      let fakePlaylist = `#EXTM3U
#EXT-X-TWITCH-INFO:ORIGIN="s3",B="false",REGION="EU",USER-IP="127.0.0.1",SERVING-ID="${createServingID()}",CLUSTER="cloudfront_vod",USER-COUNTRY="BE",MANIFEST-CLUSTER="cloudfront_vod"`;

      const now = new Date('2023-02-10');
      const created = new Date(vodData.createdAt);

      const time_difference = now.getTime() - created.getTime();
      const days_difference = time_difference / (1000 * 3600 * 24);

      const broadcastType = vodData.broadcastType.toLowerCase();

      for (const [resKey, resValue] of Object.entries(resolutions)) {
        if (broadcastType === 'highlight') {
          url = `https://${domain}/${vodSpecialID}/${resKey}/highlight-${vodId}.m3u8`;
        } else if (broadcastType === 'upload' && days_difference > 7) {
          // Only old uploaded VOD works with this method now

          url = `https://${domain}/${channelData.login}/${vodId}/${vodSpecialID}/${resKey}/index-dvr.m3u8`;
        } else {
          url = `https://${domain}/${vodSpecialID}/${resKey}/index-dvr.m3u8`;
        }

        if (url == undefined) {
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const result = await isValidQuality(url);

        if (result) {
          const quality =
            resKey == 'chunked' ? resValue.res.split('x')[1] + 'p' : resKey;
          const enabled = resKey == 'chunked' ? 'YES' : 'NO';
          const fps = resValue.fps;

          fakePlaylist += `
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${quality}",NAME="${quality}",AUTOSELECT=${enabled},DEFAULT=${enabled}
#EXT-X-STREAM-INF:BANDWIDTH=${resValue.bandwidth},CODECS="${result.codec},mp4a.40.2",RESOLUTION=${resValue.res},VIDEO="${quality}",FRAME-RATE=${fps}
${url}`;
        }
      }

      const header = new Headers();
      header.append('Content-Type', 'application/vnd.apple.mpegurl');

      return new Response(fakePlaylist, { status: 200, headers: header });
    }
  }

  return response;
};
