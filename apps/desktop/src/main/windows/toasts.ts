/**
 * 자체 토스트 창.
 *
 * OS 알림(`new Notification()`)을 사용하지 않는 이유.
 * 디자인의 멘션 토스트에는 **인라인 답장 입력**이 있다. Windows 토스트 XML 은
 * 입력 필드를 지원하지만 Electron 의 `Notification` 은 이를 노출하지 않는다
 * (`hasReply` 는 macOS 전용). 디자인도 "OS 가 지원하지 않는 환경에서는 자체
 * 프레임리스 알림 창으로 대체" 를 명시했으므로 자체 창으로 구현한다.
 *
 * 여러 토스트를 창 하나에 적층한다. 토스트마다 창을 생성하면 z 순서와 위치가 OS 와
 * 경합하고, 하나가 닫힐 때마다 나머지를 재배치해야 한다.
 */
import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

export interface Toast {
  id: string;
  /** mention = 사람이 보낸 말(답장 가능) · notice = 작업·일정·메일 같은 알림 · sync = 동기화 충돌 */
  kind: 'mention' | 'notice' | 'sync';
  /** notice: 머리글 "just-workspace · <영역>" */
  area?: string;
  at: number;
  /** mention */
  author?: string;
  channel?: string;
  mention?: string;
  /** sync · notice */
  title?: string;
  body: string;
  canReply?: boolean;
  /** 클릭했을 때 열 앱 내부 경로. */
  deepLink?: string;
}

export interface ToastHandlers {
  onActivate(t: Toast): void;
  onReply(t: Toast, text: string): void;
}

/** 화면을 가리지 않도록 상한을 둔다. 초과 시 오래된 것부터 접는다. */
const MAX_VISIBLE = 3;
/** 자동 소멸. 답장 입력이 있는 토스트는 사용자가 입력 중일 수 있으므로 더 길게 유지한다. */
const TTL_MS = 8_000;
const TTL_REPLY_MS = 20_000;

let win: BrowserWindow | null = null;
let handlers: ToastHandlers | null = null;
let queue: Toast[] = [];
const timers = new Map<string, NodeJS.Timeout>();

export function setToastHandlers(h: ToastHandlers): void {
  handlers = h;
}

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;

  win = new BrowserWindow({
    width: 384,
    height: 200,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 알림 표시 시 사용자가 진행 중인 작업의 포커스를 가져가서는 안 된다.
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '../../renderer/toast.html'));
  win.on('closed', () => {
    win = null;
  });
  return win;
}

/** 커서가 위치한 화면의 우하단. 작업 표시줄을 피하기 위해 workArea 를 사용한다. */
function place(size: { width: number; height: number }): void {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  win.setBounds({
    width: size.width,
    height: size.height,
    x: x + width - size.width,
    y: y + height - size.height,
  });
}

function push(): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('toast:list', queue);
  if (queue.length === 0) {
    win.hide();
  } else if (!win.isVisible()) {
    win.showInactive();
  }
}

export function showToast(t: Toast): void {
  queue = [t, ...queue].slice(0, MAX_VISIBLE);
  ensure();
  push();

  const ttl = t.canReply ? TTL_REPLY_MS : TTL_MS;
  timers.set(
    t.id,
    setTimeout(() => dismissToast(t.id), ttl),
  );
}

export function dismissToast(id: string): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  queue = queue.filter((t) => t.id !== id);
  push();
}

export function clearToasts(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  queue = [];
  push();
}

export function activateToast(id: string): void {
  const t = queue.find((x) => x.id === id);
  if (t) handlers?.onActivate(t);
  dismissToast(id);
}

export function replyToast(id: string, text: string): void {
  const t = queue.find((x) => x.id === id);
  if (t) handlers?.onReply(t, text);
  dismissToast(id);
}

export function fitToasts(size: { width: number; height: number }): void {
  place(size);
}

export function resendToasts(): void {
  push();
}

export function destroyToasts(): void {
  clearToasts();
  const w = win;
  win = null;
  if (w && !w.isDestroyed()) w.destroy();
}
