/**
 * 회의 창 (1280 × 800).
 *
 * ★ 회의 화면은 네이티브로 다시 그리지 않는다.
 * 스테이지·참가자·컨트롤을 우리가 그리려면 LiveKit 클라이언트를 한 벌 더 만들어야
 * 한다 — 웹앱에 이미 도는 것이 있는데 두 벌을 영원히 따라 맞추게 된다. 셸 본문을
 * 임베드로 둔 것과 같은 이유다.
 *
 * 셸이 맡는 건 창 자체다: 별도 창으로 띄우고(메인 창을 가리지 않게), 다크로 고정하고
 * (미디어 표면은 밝게 만들면 대비가 깨진다 — 핸드오프 규칙), 화면 공유 피커와
 * 항상-위 컨트롤 바를 붙인다.
 */
import { BrowserWindow, shell as electronShell } from 'electron';
import path from 'node:path';
import { isServerUrl } from '../config';

let win: BrowserWindow | null = null;
/** 현재 창이 붙어 있는 방. 같은 방을 또 열면 창을 새로 만들지 않는다. */
let currentRoom: string | null = null;

export function isMeetingOpen(): boolean {
  return !!win && !win.isDestroyed();
}

export function getMeetingWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/**
 * 회의 방을 연다. `url` 은 셸이 링크 로그인을 태워 만든 최종 주소다 —
 * 세션 붙이기는 호출부가 한다(shell.ts 와 같은 방식).
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
    // 미디어 표면이라 라이트 테마에서도 다크다. 로딩 중 흰 화면이 번쩍이면
    // 회의 시작이 유독 거슬린다.
    backgroundColor: '#0b1012',
    icon: path.join(__dirname, '../../../assets/icon.png'),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } }
      : {}),
    webPreferences: {
      // 회의 화면은 웹앱이 그린다. 프리로드를 넣지 않는다 — 서버가 내려주는
      // 코드가 우리 IPC 표면에 닿으면 안 된다.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 마이크·카메라·화면 공유 권한은 여기서 걸지 않는다. 이 창도 defaultSession 을
  // 쓰므로 세션 핸들러(main/permissions.ts)가 서버 출처에 한해 이미 허용한다 —
  // 여기서 다시 걸면 그 핸들러를 덮어써 셸의 알림·클립보드 권한이 사라진다.

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
