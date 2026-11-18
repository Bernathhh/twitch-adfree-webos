#!/usr/bin/env node

const fs = require('fs');

const packageInfo = require('../package.json');
const appinfo = require('../assets/appinfo.json');

fs.writeFileSync(
  'assets/appinfo.json',
  `${JSON.stringify(
    {
      ...appinfo,
      version: packageInfo.version
    },
    null,
    2
  )}\n`
);

fs.writeFileSync(
  'src/constants/global.constants.js',
  `export const APP_VERSION = '${packageInfo.version}';\n`
);
