/* 트레이 메뉴. 상태는 메인이 넘겨주고 클릭만 되돌려 보낸다. */
'use strict';

const $ = (id) => document.getElementById(id);

/** 일시중지 옵션. 값은 분, 0 은 해제. */
const DND_OPTIONS = [
  { minutes: 30, label: '30분' },
  { minutes: 60, label: '1시간' },
  { minutes: 480, label: '오늘 하루' },
];

const SYNC_LABEL = {
  up_to_date: '최신',
  syncing: '동기화 중',
  error: '오류',
  idle: '대기',
};

function fmtRemaining(untilMs) {
  const left = Math.max(0, untilMs - Date.now());
  const min = Math.round(left / 60000);
  if (min >= 60) return `${Math.round(min / 60)}시간 남음`;
  return `${Math.max(1, min)}분 남음`;
}

function renderDnd(state) {
  const on = state.dndUntil && state.dndUntil > Date.now();
  $('dnd-label').textContent = on
    ? `알림 일시중지 · ${fmtRemaining(state.dndUntil)}`
    : '알림 일시중지';

  const box = $('dnd-sub');
  box.replaceChildren();

  for (const o of DND_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.label;
    b.setAttribute('aria-checked', 'false');
    b.addEventListener('click', () => window.jw.tray.pauseNotifications(o.minutes));
    box.append(b);
  }
  if (on) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '일시중지 해제';
    b.setAttribute('aria-checked', 'true');
    b.addEventListener('click', () => window.jw.tray.pauseNotifications(0));
    box.append(b);
  }
}

function render(state) {
  $('me-initial').textContent = (state.displayName || '·').trim().slice(0, 1);
  $('me-name').textContent = state.displayName || '로그인 필요';
  $('me-host').textContent = state.host;

  $('sync-state').textContent = SYNC_LABEL[state.sync] ?? '—';
  // 오류일 때만 색을 바꾼다. 나머지는 성공색 그대로가 디자인이다.
  $('sync-state').style.color =
    state.sync === 'error' ? 'var(--warn)' : 'var(--ok)';

  $('btn-meet').hidden = !state.meetingCount;
  $('meet-count').textContent = String(state.meetingCount || 0);

  renderDnd(state);
}

$('btn-open').addEventListener('click', () => window.jw.tray.action('open'));
$('btn-sync').addEventListener('click', () => window.jw.tray.action('sync'));
$('btn-meet').addEventListener('click', () => window.jw.tray.action('meet'));
$('btn-settings').addEventListener('click', () => window.jw.tray.action('settings'));
$('btn-quit').addEventListener('click', () => window.jw.tray.action('quit'));

$('btn-dnd').addEventListener('click', () => {
  const sub = $('dnd-sub');
  sub.hidden = !sub.hidden;
  $('btn-dnd').setAttribute('aria-expanded', String(!sub.hidden));
  reportSize();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.jw.tray.action('close');
});

/** 메뉴 높이는 항목 수에 따라 달라진다. 창을 내용에 맞춰야 투명 영역이 클릭을 먹지 않는다. */
function reportSize() {
  const r = document.querySelector('.menu').getBoundingClientRect();
  window.jw.tray.resize({
    width: Math.ceil(r.width) + 20,   // 좌우 여백 10 + 10
    height: Math.ceil(r.height) + 20, // 위 8 + 아래 12
  });
}

window.jw.tray.onState((s) => {
  render(s);
  reportSize();
});

window.jw.tray.ready();
