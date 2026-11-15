// 원격 접속 동의 창 — 누가(이름·이메일·조직) 들어오려는지 보여 주고 [허용]/[거부]. 남은 시간이 다 되면 메인이 거부로 처리한다.
(async () => {
  const $ = (id) => document.getElementById(id);
  const info = await window.rd.consent.info();
  if (!info) return;
  const name = info.requester || '알 수 없는 요청자';
  $('name').textContent = name;
  $('avatar').textContent = Array.from(name.trim())[0] || '?';
  if (info.email) { $('email').textContent = info.email; $('email').hidden = false; }
  const org = [info.org, info.domain].filter(Boolean).join(' · ');
  if (org) { $('org').textContent = org; $('org').hidden = false; }
  if (info.kind === 'support') $('app').textContent = 'Just Workspace 원격 지원';

  const total = info.timeoutS;
  const until = Date.now() + total * 1000;
  $('bar').setAttribute('aria-valuemax', String(total));
  const tick = () => {
    const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    $('left').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    $('fill').style.width = `${(s / total) * 100}%`;
    $('bar').setAttribute('aria-valuenow', String(s));
  };
  tick();
  setInterval(tick, 1000);
  $('allow').addEventListener('click', () => window.rd.consent.answer(true));
  $('deny').addEventListener('click', () => window.rd.consent.answer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.rd.consent.answer(false); });
  $('deny').focus(); // 기본 포커스는 거부 — Enter 연타로 허용되지 않게
})();
