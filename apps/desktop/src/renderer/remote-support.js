// 원격 지원(포터블) 화면 — 메인(src/main/remote/support.ts)이 전송하는 상태에 따라 한 구역만 표시한다.
const $ = (id) => document.getElementById(id);
const VIEWS = ['server', 'code', 'expired', 'pending', 'active', 'ended', 'error'];
let timer = null;

const pad = (n) => String(n).padStart(2, '0');
const clock = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
};
/** "482913057" → "482 913 057"(시안 표기) */
const spaced = (c) => (c ? c.replace(/\D/g, '').replace(/(\d{3})(?=\d)/g, '$1 ') : '— — —');
const setOpt = (id, text) => { $(id).textContent = text || ''; $(id).hidden = !text; };
const initial = (name) => Array.from((name || '?').trim())[0] || '?';

function every(fn) {
  fn();
  timer = setInterval(fn, 1000);
}

function show(v) {
  for (const k of VIEWS) $(`v-${k}`).hidden = k !== v.phase;
  // 연결 중에는 닫기 버튼을 숨긴다 — 연결 종료는 [세션 끊기] 하나로 한정한다(창을 닫아도 연결은 종료된다)
  $('close').hidden = v.phase === 'active';
  clearInterval(timer);
  if (v.phase === 'server') {
    $('server').value = v.server || '';
    $('server-err').textContent = v.error || '';
    $('server').focus();
  } else if (v.phase === 'code') {
    $('code').textContent = spaced(v.code);
    $('code-copy').dataset.code = v.code || '';
    $('code-copy-txt').textContent = '코드 복사';
    const until = v.expiresAt ? new Date(v.expiresAt).getTime() : 0;
    if (until) every(() => { $('code-left').textContent = clock((until - Date.now()) / 1000); });
  } else if (v.phase === 'expired') {
    $('exp-code').textContent = spaced(v.code);
  } else if (v.phase === 'pending') {
    setOpt('pend-name', v.requester || '알 수 없는 요청자');
    setOpt('pend-email', v.email);
    setOpt('pend-org', [v.org, v.domain].filter(Boolean).join(' · '));
    $('pend-code').textContent = spaced(v.code);
    const until = Date.now() + (v.timeoutS || 30) * 1000;
    every(() => { $('pend-badge').textContent = `응답 대기 ${clock(Math.ceil((until - Date.now()) / 1000))}`; });
  } else if (v.phase === 'active') {
    $('act-name').textContent = v.requester || '알 수 없는 요청자';
    $('act-avatar').textContent = initial(v.requester);
    setOpt('act-email', v.email);
    const started = v.startedAt || Date.now();
    every(() => { $('act-time').textContent = clock((Date.now() - started) / 1000); });
  } else if (v.phase === 'ended') {
    const denied = v.reason === 'denied';
    $('end-title').textContent = denied ? '접속을 거부했습니다' : '원격 지원이 끝났습니다';
    $('end-icon').style.color = denied ? 'hsl(var(--muted-foreground))' : '';
    const parts = [v.requester, !denied && v.durationS != null ? `세션 시간 ${clock(v.durationS)}` : ''].filter(Boolean);
    $('end-meta').textContent = parts.join(' · ');
    $('end-meta').hidden = !parts.length;
    $('end-close').focus();
  } else if (v.phase === 'error') {
    $('error-txt').textContent = v.message;
  }
}

$('server-ok').addEventListener('click', () => window.rd.support.setServer($('server').value));
$('server').addEventListener('keydown', (e) => { if (e.key === 'Enter') window.rd.support.setServer($('server').value); });
$('code-copy').addEventListener('click', () => {
  const c = $('code-copy').dataset.code;
  if (!c) return;
  window.rd.support.copy(c);
  $('code-copy-txt').textContent = '복사했습니다';
});
// 코드를 드래그 선택해 Ctrl+C·오른쪽 클릭으로 복사해도 숫자만 복사된다(화면 표기 "482 913 057" 의 공백 제외) —
// 메신저·웹 입력칸 어디에 붙여 넣어도 그대로 일치한다.
document.addEventListener('copy', (e) => {
  const sel = window.getSelection();
  const text = sel ? sel.toString() : '';
  const inCode = sel && sel.anchorNode && ['code', 'exp-code', 'pend-code'].some((id) => $(id).contains(sel.anchorNode));
  if (!inCode) return;
  const digits = text.replace(/\D/g, '');
  if (!digits) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', digits);
});
// 코드 글자를 누르면 전체 복사(버튼과 동일)
$('code').addEventListener('click', () => $('code-copy').click());

for (const id of ['exp-new', 'error-retry']) $(id).addEventListener('click', () => window.rd.support.newCode());
$('active-stop').addEventListener('click', () => window.rd.support.stop());
$('close').addEventListener('click', () => window.rd.support.close());
$('end-close').addEventListener('click', () => window.rd.support.close());
window.rd.support.onView(show);
window.rd.support.view().then((v) => { if (v) show(v); });
