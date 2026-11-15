// 원격 접속 중 막대 — 접속 내내 화면 위 가장자리에 남는다. [끊기]는 즉시 세션을 끝낸다. 왼쪽 손잡이로 옮길 수 있다.
(async () => {
  const info = await window.rd.bar.info();
  if (info) document.getElementById('who').textContent = info.requester || '알 수 없는 요청자';
  const started = info?.startedAt ?? Date.now();
  const time = document.getElementById('time');
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    time.textContent = h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
  };
  tick();
  setInterval(tick, 1000);
  document.getElementById('stop').addEventListener('click', () => window.rd.bar.stop());
})();
