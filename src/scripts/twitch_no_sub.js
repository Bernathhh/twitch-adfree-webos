import { configRead } from '../config';
import { USE_CUSTOM_PROXY } from '../constants/config.constants';
import { APP_VERSION } from '../constants/global.constants';
import {
  getProxyServers,
  getRawAuthToken,
  installUsherXhrPatch
} from './patch_usher_xhr';
import patchAmazonWorkerCode from './patch_amazon_worker.js?raw';

const patchAmazonWorkerUrl =
  'https://adamff-dev.github.io/twitch-adfree-webos/src/scripts/patch_amazon_worker.js?v=' +
  APP_VERSION; // For cache busting

// Fix for "Pulsar" hls.js player used on lg.tv.twitch.tv
installUsherXhrPatch();

(function () {
  // From vaft script (https://github.com/pixeltris/TwitchAdSolutions/blob/master/vaft/vaft.user.js#L299)
  function getWasmWorkerJs(twitchBlobUrl) {
    let req = new XMLHttpRequest();
    req.open('GET', twitchBlobUrl, false);
    req.overrideMimeType('text/javascript');
    req.send();
    return req.responseText;
  }

  const oldWorker = window.Worker;

  window.Worker = class Worker extends oldWorker {
    constructor(twitchBlobUrl) {
      let workerString = getWasmWorkerJs(
        `${twitchBlobUrl.replace(/'/g, '%27')}`
      );

      const useProxy = configRead(USE_CUSTOM_PROXY);
      const proxyServers = getProxyServers();
      const rawAuth = getRawAuthToken();

      const workerInjectedHeader = `
        useProxy = ${JSON.stringify(useProxy)};
        proxyServers = ${JSON.stringify(proxyServers)};
        authToken = ${JSON.stringify(rawAuth)};
      `;

      const blobParts = [workerInjectedHeader];

      if (patchAmazonWorkerCode) {
        blobParts.push('\n', patchAmazonWorkerCode, '\n');
      } else {
        blobParts.push(`\nimportScripts('${patchAmazonWorkerUrl}');\n`);
      }

      blobParts.push(workerString);

      const blobUrl = URL.createObjectURL(new Blob(blobParts));
      super(blobUrl);
    }
  };
})();

/**
 * Force babel to interpret this file as ESM so it
 * polyfills with ESM imports instead of CommonJS.
 */
export {};
