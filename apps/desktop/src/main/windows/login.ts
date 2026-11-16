/**
 * 로그인 창 — 600×700 프레임리스.
 *
 * 크기는 디자인 규격이며 리사이즈를 차단한다. 이 창에서 사용자가 수행하는 동작은
 * 기기 이름 지정과 버튼 클릭뿐이므로 확대할 이유가 없다.
 */
import { BrowserWindow } from 'electron';
import path from 'node:path';

export function createLoginWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 600,
    height: 700,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    // macOS 에서는 창 버튼을 직접 그리지 않는다. 왼쪽 위 신호등이 OS 관례이며,
    // 없으면 "닫을 수 없는 창" 으로 보인다. hiddenInset 은 신호등만 남기고
    // 나머지 타이틀바 영역을 본 앱의 콘텐츠로 채울 수 있게 한다.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } }
      : {}),
    show: false,
    // 로딩 중 흰 화면 깜박임 방지 — 다크 테마에서 특히 두드러진다.
    backgroundColor: '#00000000',
    icon: path.join(__dirname, '../../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/login.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}
