// jw_native_audio 로더 — 빌드 산출물(build/Release/jw_native_audio.node)을 찾아 require 한다.
// N-API 바이너리라 Electron(메인 프로세스)과 Node(테스트 하네스) 어디서나 같은 파일을 쓴다.
// asar 안에서는 electron-builder 의 asarUnpack 으로 풀린 경로(app.asar.unpacked)로 자동 치환된다.
'use strict';
const path = require('node:path');
const fs = require('node:fs');

const candidates = [
  path.join(__dirname, 'build', 'Release', 'jw_native_audio.node'),
  path.join(__dirname, 'build', 'Debug', 'jw_native_audio.node'),
];

let loaded = null;
let loadError = null;

function load() {
  if (loaded) return loaded;
  if (loadError) throw loadError;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        loaded = require(p);
        return loaded;
      } catch (e) {
        loadError = e;
        throw e;
      }
    }
  }
  loadError = new Error(`jw_native_audio.node not found (looked in ${candidates.join(', ')}). Run: npm run native:build`);
  loadError.code = 'JW_NATIVE_AUDIO_MISSING';
  throw loadError;
}

module.exports = {
  load,
  /** 바이너리가 있는지(없어도 앱은 떠야 한다 — 하이레조만 비활성) */
  available() {
    return candidates.some((p) => fs.existsSync(p));
  },
  candidates,
};
