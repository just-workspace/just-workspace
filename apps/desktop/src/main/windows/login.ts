/**
 * 로그인 창 — 600×700 프레임리스.
 *
 * 크기는 디자인 규격이고 리사이즈를 막는다. 여기서 사용자가 하는 일은
 * 기기 이름을 정하고 버튼을 누르는 것뿐이라 늘릴 이유가 없다.
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
    // macOS 는 창 버튼을 우리가 그리지 않는다. 왼쪽 위 신호등이 OS 관례이고,
    // 없으면 "닫을 수 없는 창" 으로 보인다. hiddenInset 이 신호등만 남기고
    // 나머지 타이틀바는 우리 콘텐츠로 채우게 해준다.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } }
      : {}),
    show: false,
    // 로딩 중 흰 화면이 번쩍이지 않게 — 다크에서 특히 거슬린다.
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
