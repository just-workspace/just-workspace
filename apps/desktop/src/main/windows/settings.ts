/**
 * 설정 창 (1040 × 720).
 *
 * 웹앱에도 설정 화면이 있지만, 여기 있는 것들은 **이 기기에만 있는 것**이다 —
 * 어느 폴더를 동기화할지, 자동 시작할지. 서버에 올려봐야 다른 기기에는 의미가 없다.
 */
import { BrowserWindow } from 'electron';
import path from 'node:path';

let win: BrowserWindow | null = null;

export function showSettings(parent: BrowserWindow | null): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    parent: parent ?? undefined,
    frame: false,
    show: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, '../../../assets/icon.png'),
    // macOS 는 창 버튼을 우리가 그리지 않는다(windows/shell.ts 주석 참고).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '../../renderer/settings.html'));
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });

  return win;
}

/** 지금 떠 있는 설정 창. 진행 상황을 보낼 대상이다. */
export function settingsWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function destroySettings(): void {
  const w = win;
  win = null;
  if (w && !w.isDestroyed()) w.destroy();
}
