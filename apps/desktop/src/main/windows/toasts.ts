/**
 * 자체 토스트 창.
 *
 * ★ 왜 OS 알림(`new Notification()`)이 아닌가.
 * 핸드오프의 멘션 토스트에는 **인라인 답장 입력**이 있다. Windows 토스트 XML 은
 * 입력 필드를 지원하지만 Electron 의 `Notification` 은 그걸 노출하지 않는다
 * (`hasReply` 는 macOS 전용). 핸드오프도 "OS 가 지원하지 않는 환경에서는 자체
 * 프레임리스 알림 창으로 대체" 를 명시했으므로 이쪽으로 만든다.
 *
 * 토스트 여러 장을 창 하나에 쌓는다. 장마다 창을 띄우면 z 순서와 위치를 OS 와
 * 다투게 되고, 하나 닫힐 때마다 나머지를 다시 배치해야 한다.
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

/** 화면을 덮지 않도록 상한을 둔다. 넘치면 오래된 것부터 접는다. */
const MAX_VISIBLE = 3;
/** 자동 소멸. 답장 입력이 있는 토스트는 사용자가 타이핑 중일 수 있어 더 길게 둔다. */
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
    // 알림이 뜨면서 지금 하던 일의 포커스를 뺏으면 안 된다.
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

/** 커서가 있는 화면의 우하단. 작업 표시줄을 피해 workArea 를 쓴다. */
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
