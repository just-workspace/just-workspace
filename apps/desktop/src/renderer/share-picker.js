/*
 * 화면 공유 소스 피커.
 *
 * 목록은 메인이 desktopCapturer 로 받아 넘겨준다 — 렌더러에서는 부를 수 없다
 * (Electron 17+ 에서 메인 전용이 됐다).
 */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  tab: 'screen',
  sources: [],
  picked: null,
  audio: false,
};

function counts() {
  const screen = state.sources.filter((s) => s.kind === 'screen').length;
  const window_ = state.sources.filter((s) => s.kind === 'window').length;
  return { screen, window: window_ };
}

function renderTabs() {
  const c = counts();
  $('tab-screen').textContent = `전체 화면 ${c.screen}`;
  $('tab-window').textContent = `창 ${c.window}`;
  $('tab-screen').setAttribute('aria-selected', String(state.tab === 'screen'));
  $('tab-window').setAttribute('aria-selected', String(state.tab === 'window'));
  // 창 공유는 가려져도 계속 전송된다 — 창 탭에서만 알린다.
  $('note').hidden = state.tab !== 'window';
}

function renderGrid() {
  const box = $('grid');
  box.replaceChildren();

  const rows = state.sources.filter((s) => s.kind === state.tab);
  if (rows.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent =
      state.tab === 'window' ? '공유할 수 있는 창이 없습니다.' : '화면을 찾지 못했습니다.';
    box.append(p);
    return;
  }

  for (const s of rows) {
    const b = document.createElement('button');
    b.className = 'card';
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.picked === s.id));

    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    if (s.thumbnail) {
      const img = document.createElement('img');
      img.src = s.thumbnail;
      img.alt = '';
      thumb.append(img);
    }
    if (state.picked === s.id) {
      const chk = document.createElement('span');
      chk.className = 'check';
      chk.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ffffff" ' +
        'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5 5L20 6"/></svg>';
      thumb.append(chk);
    }
    b.append(thumb);

    const meta = document.createElement('span');
    meta.className = 'meta';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = s.name;
    nm.title = s.name;
    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = s.detail;
    meta.append(nm, sz);
    b.append(meta);

    b.addEventListener('click', () => {
      state.picked = s.id;
      render();
    });
    box.append(b);
  }
}

function renderAction() {
  const picked = state.sources.find((s) => s.id === state.picked);
  $('btn-share').disabled = !picked;
  $('share-label').textContent = picked ? '공유 시작' : '항목을 선택하세요';
  $('btn-audio').setAttribute('aria-pressed', String(state.audio));
}

function render() {
  renderTabs();
  renderGrid();
  renderAction();
}

$('tab-screen').addEventListener('click', () => {
  state.tab = 'screen';
  render();
});
$('tab-window').addEventListener('click', () => {
  state.tab = 'window';
  render();
});
$('btn-audio').addEventListener('click', () => {
  state.audio = !state.audio;
  renderAction();
});

const cancel = () => window.jw.picker.cancel();
$('btn-close').addEventListener('click', cancel);
$('btn-cancel').addEventListener('click', cancel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel();
  if (e.key === 'Enter' && state.picked) share();
});

function share() {
  if (!state.picked) return;
  window.jw.picker.choose({ sourceId: state.picked, withAudio: state.audio });
}
$('btn-share').addEventListener('click', share);

async function start() {
  const { sources, context } = await window.jw.picker.load();
  state.sources = sources;
  if (context) $('sub').textContent = context;
  // 주 화면을 미리 골라둔다(핸드오프 목업도 선택된 상태다). 미리 골라도
  // 공유는 버튼을 눌러야 시작되므로 실수로 나가지 않는다.
  const screens = sources.filter((s) => s.kind === 'screen');
  if (screens.length > 0) state.picked = screens[0].id;
  render();
}

start();
