/*
 * 셸 — 창 테두리 한 줄(이동·창 버튼·뒤로/앞으로/새로 고침).
 *
 * 0.5.0 부터 레일·검색·상단바는 그리지 않는다. 사이드바·상단바·활동 패널·사용자 메뉴·플러그인 상단 버튼까지
 * 본문 웹앱이 브라우저와 동일하게 그린다 — 데스크톱 전용 외곽 UI 를 별도로 두면 웹 기능이 추가될 때마다 불일치가 발생한다.
 *
 * 본문은 이 문서가 아니라 메인이 배치하는 웹 뷰이다. 별도 레이어이므로 CSS 로 배치할 수
 * 없어, #content 의 실제 좌표를 측정해 메인에 전달한다.
 */

const $ = (id) => document.getElementById(id);

/* ── 본문 좌표 ──────────────────────────────────────────
   임베드 뷰는 이 문서 밖의 레이어이다. 창 크기·DPI 가 변경될 때마다 실제 좌표를
   다시 측정해 전달해야 불일치가 발생하지 않는다. */
function reportBounds() {
  const r = $('content').getBoundingClientRect();
  window.jw.setContentBounds({
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  });
}

new ResizeObserver(reportBounds).observe($('content'));
window.addEventListener('resize', reportBounds);

/* ── 배선 ───────────────────────────────────────────── */
$('btn-min').addEventListener('click', () => window.jw.minimize());
$('btn-max').addEventListener('click', () => window.jw.maximize());
$('btn-close').addEventListener('click', () => window.jw.close());
$('btn-reload').addEventListener('click', () => window.jw.reloadContent());
$('btn-refresh').addEventListener('click', () => window.jw.reloadContent());
$('btn-back').addEventListener('click', () => window.jw.history('back'));
$('btn-fwd').addEventListener('click', () => window.jw.history('forward'));
// 제목 줄 더블클릭 = 최대화 전환(OS 관례). 버튼 위는 제외.
document.querySelector('.titlebar').addEventListener('dblclick', (e) => {
  if (!e.target.closest('button')) window.jw.maximize();
});

window.jw.onNavState((s) => {
  $('btn-back').disabled = !s.canGoBack;
  $('btn-fwd').disabled = !s.canGoForward;
  if (s.title) document.title = s.title;
});

window.jw.onContentError((message) => {
  $('content-fallback-msg').textContent = message;
  $('content-fallback').hidden = false;
});
window.jw.onContentOk(() => {
  $('content-fallback').hidden = true;
});

async function start() {
  reportBounds();
  const info = await window.jw.info();
  if (info.platform === 'darwin') document.documentElement.classList.add('is-mac');
  if (info.productName) $('app-name').textContent = info.productName;
}

start();
