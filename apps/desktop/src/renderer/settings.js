/*
 * 설정 창 — 현재는 동기화 패널만 실제로 동작한다.
 *
 * 파일 전송 엔진은 아직 없다. 따라서 "최신 상태" 와 같은 문구를 임의로 표시하지 않으며,
 * 폴더 미선택 시에는 미선택으로, 엔진 미구현 시에는 미구현으로 표기한다.
 */
'use strict';

const $ = (id) => document.getElementById(id);

const SECTIONS = [
  {
    id: 'general', label: '일반',
    icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  },
  {
    id: 'notifications', label: '알림',
    icon: '<path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10.5 20a2 2 0 0 0 3 0"/>',
  },
  {
    id: 'sync', label: '동기화',
    icon: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  },
  {
    id: 'meetings', label: '회의',
    icon: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3z"/>',
  },
  {
    id: 'account', label: '계정 · 기기',
    icon: '<circle cx="12" cy="8" r="3.4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  },
  {
    id: 'about', label: '정보',
    icon: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  },
];

// 원격 접속 영역 — 서버에 원격 데스크톱 플러그인이 있을 때만 메뉴에 추가한다(start 에서)
const REMOTE_SECTION = {
  id: 'remote', label: '원격 접속',
  icon: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
};
let remote = null;

const STATE_LABEL = {
  idle: '대기 중',
  syncing: '동기화 중',
  up_to_date: '최신',
  paused: '일시중지',
  conflict: '충돌',
  error: '오류',
};

const STATE_COLOR = {
  idle: 'var(--dot-idle)',
  syncing: 'var(--brand)',
  up_to_date: 'var(--ok)',
  paused: 'var(--dot-idle)',
  conflict: 'var(--warn)',
  error: 'var(--warn)',
};

let current = 'sync';
let settings = null;
/** app:info 결과. "정보" 패널에서 앱 버전·서버 주소 표기에 사용한다. */
let appInfo = null;
/** 서버 확인 결과(버전·기능). 지연될 수 있으므로 비동기로 채우고, 수신 시 패널을 다시 그린다. */
let serverCheck = null;

function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function renderNav() {
  const nav = $('nav');
  nav.replaceChildren();
  for (const s of SECTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    if (s.id === current) b.setAttribute('aria-current', 'page');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', s.id === current ? 'var(--brand)' : 'var(--icon-strong)');
    svg.setAttribute('stroke-width', s.id === current ? '1.9' : '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = s.icon;
    b.append(svg, document.createTextNode(s.label));
    b.addEventListener('click', () => {
      current = s.id;
      renderNav();
      renderPanel();
    });
    nav.append(b);
  }
}

const KIND_LABEL = { device: '내 기기', support: '1회성 지원' };
const pad2 = (n) => String(n).padStart(2, '0');
const fmtWhen = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtDur = (s) => {
  if (s == null || s < 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`;
};

function renderRemote() {
  if (!remote) return;
  $('opt-remote').setAttribute('aria-pressed', String(remote.allowRemote));
  $('opt-unattended').setAttribute('aria-pressed', String(remote.unattended));
  $('opt-unattended').disabled = !remote.allowRemote;
  $('row-unattended').classList.toggle('off', !remote.allowRemote);
  const nameInput = $('rd-name');
  if (document.activeElement !== nameInput) nameInput.value = remote.deviceName || '';
  nameInput.disabled = !remote.registered;
  $('rd-name-save').disabled = !remote.registered || nameInput.value.trim() === (remote.deviceName || '') || !nameInput.value.trim();
  $('rd-unreg').disabled = !remote.registered;
  $('remote-note').textContent = remote.inSession
    ? '지금 원격 접속 중입니다. 화면 위 막대의 [끊기]로 끝낼 수 있습니다.'
    : remote.allowRemote
      ? (remote.registered ? '' : '기기를 등록하지 못했습니다. 잠시 후 다시 켜 보세요.')
      : (remote.registered ? '' : '켜면 이 PC를 워크스페이스 기기 목록에 등록합니다.');
  $('remote-note').hidden = !$('remote-note').textContent;
}

async function renderRemoteLog() {
  const box = $('rd-log');
  let rows = [];
  try { rows = remote?.registered ? await window.jw.remote.recent() : []; } catch { rows = null; }
  box.replaceChildren();
  if (!rows || rows.length === 0) {
    const e = document.createElement('div');
    e.className = 'rd-empty';
    e.textContent = rows ? '아직 접속 기록이 없습니다.' : '접속 기록을 불러오지 못했습니다.';
    box.append(e);
    return;
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'rd-row';
    const denied = r.status === 'denied' || (r.status === 'expired' && r.durationS == null);
    const who = document.createElement('span');
    who.className = 'who';
    const person = r.email ? `${r.requester} (${r.email})` : r.requester;
    who.textContent = denied ? `요청 거부됨 — ${r.requester || '알 수 없는 요청자'}` : person;
    const kind = document.createElement('span');
    kind.className = `kind${denied ? ' deny' : r.kind === 'support' ? ' sup' : ''}`;
    kind.textContent = denied ? '거부' : KIND_LABEL[r.kind] || r.kind;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = fmtWhen(r.when);
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = denied ? '—' : fmtDur(r.durationS);
    row.append(who, kind, when, dur);
    box.append(row);
  }
}

function renderPanel() {
  const isSync = current === 'sync';
  const isRemote = current === 'remote';
  $('panel-sync').hidden = !isSync;
  $('panel-remote').hidden = !isRemote;
  $('panel-soon').hidden = isSync || isRemote;
  if (isRemote) { renderRemote(); void renderRemoteLog(); }
  if (current === 'about') {
    // 사이트별 빌드이므로 앱/서버 버전 불일치가 빈번하다. 문의 시 이 한 줄로 확인할 수 있도록
    // 둘을 나란히 표기한다. 구버전 서버(capabilities 없음)면 서버 버전은 '—'.
    const host = appInfo ? appInfo.serverUrl.replace(/^https?:\/\//, '') : '—';
    const ver = appInfo ? `v${appInfo.version}` : '—';
    const sver = serverCheck ? (serverCheck.version ? `v${serverCheck.version}` : '—') : '확인 중…';
    $('soon-text').textContent = `앱 ${ver} · 서버 ${host} ${sver}`;
  } else if (!isSync) {
    const label = SECTIONS.find((s) => s.id === current)?.label ?? '';
    $('soon-text').textContent =
      `${label} 설정은 아직 여기 없습니다. 워크스페이스 화면의 설정에서 바꿀 수 있습니다.`;
  }
}

function renderStatus() {
  const folders = settings.folders;
  const icon = $('status-icon');
  icon.replaceChildren();

  if (folders.length === 0) {
    icon.className = 'badge-icon idle';
    icon.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--icon-muted)" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
    $('status-title').textContent = '동기화할 폴더가 없습니다';
    $('status-detail').textContent = '아래에서 폴더를 추가하면 그 폴더만 동기화합니다';
    $('quota').hidden = true;
    return;
  }

  const conflicts = folders.reduce((a, f) => a + f.conflicts, 0);
  const syncing = folders.some((f) => f.state === 'syncing');
  const known = folders.filter((f) => f.bytes !== null);
  const total = known.reduce((a, f) => a + f.bytes, 0);

  if (conflicts > 0) {
    icon.className = 'badge-icon warn';
    icon.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17.2h.01"/></svg>';
    $('status-title').textContent = `충돌 ${conflicts}건`;
  } else if (syncing) {
    icon.className = 'badge-icon';
    icon.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>';
    $('status-title').textContent = '동기화 중';
  } else {
    icon.className = 'badge-icon idle';
    icon.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--icon-muted)" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
    // 1회 이상 동기화된 이력이 있으면 최신, 없으면 시작 전.
    const everSynced = folders.some((f) => f.state === 'up_to_date' || f.bytes !== null);
    $('status-title').textContent = everSynced ? '최신 상태' : '아직 시작하지 않음';
  }

  const totalConflicts = folders.reduce((a, f) => a + f.conflicts, 0);
  $('status-detail').textContent =
    `폴더 ${folders.length}개` +
    (totalConflicts > 0 ? ` · 충돌 ${totalConflicts}건 (양쪽 사본 보존)` : ' · 대기 중인 항목 없음');

  $('quota').hidden = known.length === 0;
  if (known.length > 0) {
    $('quota-used').textContent = fmtBytes(total);
    $('quota-cap').textContent = '';
    $('quota-fill').style.width = '0%';
  }
}

function renderRows() {
  const box = $('rows');
  box.replaceChildren();

  if (settings.folders.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '선택한 폴더만 동기화합니다. 전체 동기화 옵션은 없습니다.';
    box.append(p);
    return;
  }

  for (const f of settings.folders) {
    const row = document.createElement('div');
    row.className = 'row';

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = f.name;

    const remote = document.createElement('span');
    remote.className = 'mono';
    remote.textContent = f.remotePath;
    // 로컬 경로는 툴팁으로 표시한다. 열이 넷뿐이므로 둘 다 표시할 공간이 없다.
    remote.title = `로컬: ${f.localPath}`;

    const size = document.createElement('span');
    size.className = 'mono';
    size.textContent = fmtBytes(f.bytes);

    const state = document.createElement('span');
    state.className = 'state';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = STATE_COLOR[f.state] ?? 'var(--dot-idle)';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = f.conflicts > 0 ? `충돌 ${f.conflicts}건` : STATE_LABEL[f.state];
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '제거';
    del.addEventListener('click', async () => {
      settings = await window.jw.sync.removeFolder(f.id);
      render();
    });
    state.append(dot, lbl, del);

    row.append(nm, remote, size, state);
    box.append(row);
  }
}

function renderConflict() {
  const withConflict = settings.folders.filter((f) => f.conflicts > 0);
  $('conflict').hidden = withConflict.length === 0;
  if (withConflict.length === 0) return;
  $('conflict-detail').textContent =
    `${withConflict.map((f) => f.name).join(', ')} 에서 충돌이 있습니다. ` +
    '합치지 않고 양쪽 사본을 모두 남겨두었습니다.';
}

function renderOptions() {
  $('opt-startup').setAttribute('aria-pressed', String(settings.startWithOs));
  $('opt-metered').setAttribute('aria-pressed', String(settings.pauseOnMetered));
  $('opt-deletes').setAttribute('aria-pressed', 'false');
  $('root-path').textContent = settings.root;
}

function render() {
  renderStatus();
  renderRows();
  renderConflict();
  renderOptions();
}

$('btn-min').addEventListener('click', () => window.jw.minimize());
$('btn-max').addEventListener('click', () => window.jw.maximize());
$('btn-close').addEventListener('click', () => window.jw.close());

$('btn-add').addEventListener('click', async () => {
  const next = await window.jw.sync.pickFolder();
  if (next) {
    settings = next;
    render();
  }
});

$('btn-sync-now').addEventListener('click', async () => {
  const b = $('btn-sync-now');
  b.disabled = true;
  b.textContent = '동기화 중…';
  try {
    settings = await window.jw.sync.now();
    render();
  } finally {
    b.disabled = false;
    b.textContent = '지금 동기화';
  }
});

// 엔진이 파일 하나를 처리할 때마다 통지한다. 상태 카드만 갱신하고 표는 변경하지
// 않는다 — 파일마다 표를 다시 그리면 스크롤 위치가 흔들린다.
window.jw.sync.onProgress((p) => {
  if (!settings) return;
  const f = settings.folders.find((x) => x.id === p.folderId);
  if (!f) return;
  f.state = p.state;
  f.conflicts = p.conflicts;
  if (p.bytes) f.bytes = p.bytes;
  if (p.state === 'syncing' && p.total > 0) {
    $('status-title').textContent = '동기화 중';
    $('status-detail').textContent = `${f.name} · ${p.done}/${p.total}` +
      (p.current ? ` · ${p.current}` : '');
  } else {
    renderStatus();
    renderRows();
    renderConflict();
  }
});

$('opt-startup').addEventListener('click', async () => {
  settings = await window.jw.sync.patch({ startWithOs: !settings.startWithOs });
  renderOptions();
});
$('opt-metered').addEventListener('click', async () => {
  settings = await window.jw.sync.patch({ pauseOnMetered: !settings.pauseOnMetered });
  renderOptions();
});

$('opt-remote').addEventListener('click', async () => {
  remote = await window.jw.remote.patch({ allowRemote: !remote.allowRemote });
  renderRemote();
  void renderRemoteLog();
});
$('rd-name').addEventListener('input', () => {
  $('rd-name-hint').classList.remove('err');
  $('rd-name-hint').textContent = '내 기기 목록과 접속 요청 창에 이 이름이 보입니다.';
  renderRemote();
});
async function saveName() {
  const v = $('rd-name').value.trim();
  if (!v || v === remote.deviceName) return;
  try {
    remote = await window.jw.remote.rename(v);
    $('rd-name').blur();
    $('rd-name-hint').textContent = '저장했습니다.';
  } catch (e) {
    $('rd-name-hint').classList.add('err');
    $('rd-name-hint').textContent = (e && e.message ? String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '') || '이름을 바꾸지 못했습니다.';
  }
  renderRemote();
}
$('rd-name-save').addEventListener('click', () => void saveName());
$('rd-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') void saveName(); });
// 등록 해지는 재확인을 거친다(복구 불가 — 키가 폐기된다)
$('rd-unreg').addEventListener('click', () => {
  $('rd-unreg').hidden = true;
  $('rd-confirm').hidden = false;
  $('rd-danger-desc').textContent = '정말 해지할까요? 진행 중인 원격 접속이 있으면 바로 끊깁니다.';
  $('rd-unreg-cancel').focus();
});
function resetUnreg() {
  $('rd-unreg').hidden = false;
  $('rd-confirm').hidden = true;
  $('rd-danger-desc').textContent = '내 기기 목록에서 지우고 원격 접속 키를 폐기합니다. 다시 쓰려면 새로 등록해야 합니다.';
}
$('rd-unreg-cancel').addEventListener('click', resetUnreg);
$('rd-unreg-ok').addEventListener('click', async () => {
  $('rd-unreg-ok').disabled = true;
  try {
    remote = await window.jw.remote.unregister();
    resetUnreg();
  } catch {
    $('rd-danger-desc').textContent = '해지하지 못했습니다. 네트워크를 확인하고 다시 시도하세요.';
  } finally {
    $('rd-unreg-ok').disabled = false;
  }
  renderRemote();
  void renderRemoteLog();
});
$('opt-unattended').addEventListener('click', async () => {
  remote = await window.jw.remote.patch({ unattended: !remote.unattended });
  renderRemote();
});

async function start() {
  const info = await window.jw.info();
  appInfo = info;
  window.jw.verifyServer().then((r) => {
    serverCheck = r;
    if (current === 'about') renderPanel();
  });
  if (info.platform === 'darwin') document.documentElement.classList.add('is-mac');
  // 자동 시작 문구는 플랫폼마다 명칭이 다르다.
  $('opt-startup-label').textContent =
    info.platform === 'win32'
      ? 'Windows 시작 시 동기화 자동 시작'
      : info.platform === 'darwin'
        ? '로그인 시 동기화 자동 시작'
        : '시작 시 동기화 자동 시작';

  settings = await window.jw.sync.load();
  try {
    remote = await window.jw.remote.status();
    if (remote.available) SECTIONS.splice(SECTIONS.findIndex((x) => x.id === 'account'), 0, REMOTE_SECTION);
  } catch {
    remote = null;
  }
  renderNav();
  renderPanel();
  render();
}

start();
