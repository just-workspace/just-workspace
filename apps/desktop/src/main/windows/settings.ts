/**
 * 설정 창 (1040 × 720).
 *
 * 웹앱에도 설정 화면이 있으나, 이 창의 항목은 **이 기기에만 해당하는 설정**이다 —
 * 동기화 대상 폴더, 자동 시작 여부. 서버에 저장해도 다른 기기에는 의미가 없다.
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
    // macOS 에서는 창 버튼을 직접 그리지 않는다(windows/shell.ts 주석 참고).
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

/** 현재 표시 중인 설정 창. 진행 상황의 전달 대상이다. */
export function settingsWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function destroySettings(): void {
  const w = win;
  win = null;
  if (w && !w.isDestroyed()) w.destroy();
}
