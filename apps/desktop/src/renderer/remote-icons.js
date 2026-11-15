// 원격 데스크톱 창 공용 아이콘 — 웹 키트 아이콘 표(frontend-react/src/utils/icons.ts)에서 이 창들이 쓰는 것만 옮겼다.
// <span class="icon" data-icon="lock"></span> 을 찾아 SVG 를 채운다(CSP script-src 'self' 안에서 인라인 스크립트 없이).
(() => {
  const P = {
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    'mouse-pointer': '<path d="M4.04 4.65a.5.5 0 0 1 .61-.61l15.6 5.6a.5.5 0 0 1-.04.95l-6.4 1.94a1 1 0 0 0-.66.66l-1.94 6.4a.5.5 0 0 1-.95.04z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    'alert-triangle': '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    'grip-vertical': '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
    'monitor-pc': '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  };
  for (const el of document.querySelectorAll('[data-icon]')) {
    const d = P[el.getAttribute('data-icon')];
    if (!d) continue;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  }
})();
