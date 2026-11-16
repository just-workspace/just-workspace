/* 로그인 화면 — 상태는 세 가지뿐이다: 대기 전 / 브라우저 대기 중 / 실패. */
'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  server: $('server'),
  verified: $('verified'),
  device: $('device'),
  login: $('btn-login'),
  waiting: $('waiting'),
  authurl: $('authurl'),
  cancel: $('btn-cancel'),
  error: $('error'),
  errorMsg: $('error-msg'),
  storeNote: $('store-note'),
  version: $('version'),
  min: $('btn-min'),
  close: $('btn-close'),
};

els.min.addEventListener('click', () => window.jw.minimize());
els.close.addEventListener('click', () => window.jw.close());

/** 대기 중에는 입력과 버튼을 잠근다 — 중복 클릭으로 로그인이 두 건 진행되어서는 안 된다. */
function setBusy(busy) {
  els.login.disabled = busy;
  els.device.readOnly = busy;
  els.waiting.hidden = !busy;
  if (busy) els.error.hidden = true;
}

function showError(message) {
  els.errorMsg.textContent = message;
  els.error.hidden = false;
}

async function start() {
  const info = await window.jw.info();

  // 서버 주소는 표시만 한다 — v1 은 고정값이므로 편집 대상이 아니다.
  els.server.value = info.serverUrl.replace(/^https?:\/\//, '');
  els.device.value = info.deviceName;
  els.version.textContent = `v${info.version}`;
  if (info.platform === 'darwin') document.documentElement.classList.add('is-mac');
  els.storeNote.textContent = `로그인 정보는 ${info.credentialStore}에 저장됩니다`;

  // 서버 도달 확인은 지연될 수 있으므로 폼을 채운 뒤 별도로 수행한다.
  window.jw.verifyServer().then((r) => {
    els.verified.hidden = !r.verified;
    // 사이트별 빌드이므로 서버/앱 버전이 불일치할 수 있다. 둘을 나란히 표기하면
    // 문의 접수 시 캡처 한 장으로 확인할 수 있다. 구버전 서버(버전 없음)면 앱 버전만 표기.
    if (r.version) els.version.textContent = `v${info.version} · 서버 v${r.version}`;
  });

  if (!info.secureStore) {
    // 암호화 저장소가 없으면 리프레시 토큰을 디스크에 저장할 수 없다.
    // 로그인해도 앱 종료 시 소실되므로 사전에 알린다.
    els.storeNote.textContent = '자격 증명 저장소를 사용할 수 없습니다';
    els.login.disabled = true;
    showError(
      '이 기기에서는 로그인 정보를 안전하게 저장할 수 없습니다. ' +
        '리눅스라면 gnome-keyring 또는 kwallet 을 설치한 뒤 다시 실행하십시오.',
    );
  }
}

window.jw.onAuthUrl((url) => {
  els.authurl.textContent = url;
});

els.login.addEventListener('click', async () => {
  const name = els.device.value.trim();
  if (!name) {
    els.device.focus();
    showError('기기 이름을 입력하십시오.');
    return;
  }
  els.authurl.textContent = '';
  setBusy(true);

  const r = await window.jw.signIn(name);
  if (r.ok) return; // 메인이 셸 창을 열고 이 창을 닫는다.

  setBusy(false);
  // 사용자가 직접 취소한 경우는 실패가 아니다 — 오류 표시 없이 초기 화면으로 복귀.
  if (!r.cancelled) showError(r.message);
});

els.cancel.addEventListener('click', (e) => {
  e.preventDefault();
  window.jw.cancelSignIn();
});

start();
