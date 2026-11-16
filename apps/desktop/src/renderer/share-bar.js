/* 공유 중 플로팅 바. 상태는 메인이 보유하며 여기서는 표시·전달만 수행한다. */
'use strict';

const $ = (id) => document.getElementById(id);

$('btn-stop').addEventListener('click', () => window.jw.share.stop());

$('btn-mic').addEventListener('click', () => window.jw.share.toggle('mic'));
$('btn-cam').addEventListener('click', () => window.jw.share.toggle('camera'));

window.jw.share.onState((s) => {
  $('btn-mic').setAttribute('aria-pressed', String(s.mic));
  $('btn-cam').setAttribute('aria-pressed', String(s.camera));
});

/*
 * 창을 바 크기에 맞춘다.
 *
 * 투명 창이므로 보이지 않아도 **마우스 이벤트는 창 전체가 가로챈다.** 여유를 크게
 * 두면 바 양옆에 보이지 않는 클릭 차단 영역이 생겨, 그 아래 창을 클릭할 수 없다.
 * 그림자가 잘리지 않을 정도만 남기고 실제 폭에 맞춘다.
 */
function reportSize() {
  const r = document.querySelector('.bar').getBoundingClientRect();
  window.jw.share.resize({
    // box-shadow: 0 10px 26px → 좌우 26, 위 16, 아래 36
    width: Math.ceil(r.width) + 52,
    height: Math.ceil(r.height) + 52,
  });
}

document.fonts.ready.then(reportSize);
new ResizeObserver(reportSize).observe(document.querySelector('.bar'));

window.jw.share.ready();
