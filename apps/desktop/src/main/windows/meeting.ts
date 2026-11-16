/**
 * 회의 창 (1280 × 800).
 *
 * 중요: 회의 화면은 네이티브로 재구현하지 않는다.
 * 스테이지·참가자·컨트롤을 직접 그리려면 LiveKit 클라이언트를 하나 더 구현해야
 * 한다 — 웹앱에 이미 동작하는 구현이 있으므로 두 구현을 계속 동기화해야 한다. 셸 본문을
 * 임베드로 둔 것과 동일한 이유이다.
 *
 * 셸의 담당 범위는 창 자체이다: 별도 창으로 표시하고(메인 창을 가리지 않도록), 다크로 고정하며
 * (미디어 표면은 밝게 하면 대비가 손상된다), 화면 공유 피커와
 * 항상-위 컨트롤 바를 연결한다.
 */
import { BrowserWindow, shell as electronShell } from 'electron';
import path from 'node:path';
import { isServerUrl } from '../config';

let win: BrowserWindow | null = null;
/** 현재 창이 연결된 방. 동일한 방을 다시 열면 창을 새로 생성하지 않는다. */
let currentRoom: string | null = null;

export function isMeetingOpen(): boolean {
  return !!win && !win.isDestroyed();
}

export function getMeetingWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/**
 * 회의 방을 연다. `url` 은 셸이 링크 로그인을 거쳐 생성한 최종 주소이다 —
 * 세션 연결은 호출부가 수행한다(shell.ts 와 동일한 방식).
 */
export function showMeeting(room: string, url: string): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (currentRoom !== room) {
      currentRoom = room;
      void win.loadURL(url);
    }
    if (win.isMinimized()) win.restore();
    win.focus();
    return win;
  }

  currentRoom = room;
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    frame: false,
    show: false,
    // 미디어 표면이므로 라이트 테마에서도 다크를 사용한다. 로딩 중 흰 화면 깜박임은
    // 회의 시작 시 특히 두드러진다.
    backgroundColor: '#0b1012',
    icon: path.join(__dirname, '../../../assets/icon.png'),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } }
      : {}),
    webPreferences: {
      // 회의 화면은 웹앱이 그린다. 프리로드는 주입하지 않는다 — 서버가 제공하는
      // 코드가 본 앱의 IPC 표면에 접근해서는 안 된다.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 마이크·카메라·화면 공유 권한은 여기서 설정하지 않는다. 이 창도 defaultSession 을
  // 사용하므로 세션 핸들러(main/permissions.ts)가 서버 출처에 한해 이미 허용한다 —
  // 여기서 재설정하면 해당 핸들러를 덮어써 셸의 알림·클립보드 권한이 소실된다.

  win.webContents.setWindowOpenHandler(({ url: u }) => {
    electronShell.openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, u) => {
    if (!isServerUrl(u)) {
      e.preventDefault();
      electronShell.openExternal(u);
    }
  });

  void win.loadURL(url);
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
    currentRoom = null;
  });

  return win;
}

export function closeMeeting(): void {
  const w = win;
  win = null;
  currentRoom = null;
  if (w && !w.isDestroyed()) w.destroy();
}
