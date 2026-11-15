// jw_remote_input 로더 — 원격 데스크톱 호스트 입력 주입(src/remote_input.cpp). 없으면 null(주입 불가로 처리).
'use strict';
const path = require('node:path');
const fs = require('node:fs');

const candidates = [
  path.join(__dirname, 'build', 'Release', 'jw_remote_input.node'),
  path.join(__dirname, 'build', 'Debug', 'jw_remote_input.node'),
];

let cached;
function load() {
  if (cached !== undefined) return cached;
  cached = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { cached = require(p); } catch (e) { console.warn('[remote-input] 로드 실패', e); }
      break;
    }
  }
  return cached;
}

module.exports = { load };
