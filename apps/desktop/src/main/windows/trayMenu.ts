/**
 * 트레이 메뉴 — OS 기본 메뉴 대신 직접 그리는 팝업 창.
 *
 * Electron 의 `Menu` 는 OS 가 그린다. 아바타·동기화 상태·안 읽음 뱃지를 넣을 수
 * 없고 폭·반경도 우리가 정하지 못한다. 핸드오프는 그 셋을 다 요구하므로
 * 프레임리스 창으로 만든다.
 *
 * 대신 OS 메뉴가 공짜로 주던 것을 직접 해야 한다:
 *   · 바깥을 누르면 닫기      → blur
 *   · 트레이 아이콘 옆에 배치  → tray.getBounds() + 작업 영역으로 클램프
 *   · Esc 로 닫기            → 렌더러에서 keydown
 */
import { BrowserWindow, Tray, screen } from 'electron';
import path from 'node:path';

export interface TrayMenuState {
  displayName: string;
  host: string;
  /** 동기화 상태. 렌더러가 라벨로 바꾼다. */
  sync: 'idle' | 'syncing' | 'up_to_date' | 'error';
  /** 참가 가능한 회의 수. 0 이면 항목 자체를 숨긴다. */
  meetingCount: number;
  /** 알림 일시중지 만료 시각(epoch ms). null 이면 꺼져 있다. */
  dndUntil: number | null;
}

let win: BrowserWindow | null = null;
let getState: (() => TrayMenuState) | null = null;

export function setTrayMenuStateSource(fn: () => TrayMenuState): void {
  getState = fn;
}

function create(): BrowserWindow {
  const w = new BrowserWindow({
    width: 252,
    height: 320,
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
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  w.loadFile(path.join(__dirname, '../../renderer/tray-menu.html'));
  // 포커스를 잃으면 닫는다 — OS 메뉴와 같은 감각이어야 한다.
  w.on('blur', () => hideTrayMenu());
  w.on('closed', () => {
    win = null;
  });
  return w;
}

/** 트레이 아이콘 근처에 놓되 화면 밖으로 나가지 않게 클램프한다. */
function place(tray: Tray): void {
  if (!win) return;
  const icon = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: icon.x, y: icon.y });
  const area = display.workArea;
  const { width, height } = win.getBounds();

  // 작업 표시줄이 아래에 있으면 위로, 위에 있으면 아래로 펼친다.
  const trayAtBottom = icon.y > area.y + area.height / 2;
  const y = trayAtBottom ? icon.y - height : icon.y + icon.height;

  let x = Math.round(icon.x + icon.width / 2 - width / 2);
  x = Math.min(Math.max(x, area.x), area.x + area.width - width);

  win.setPosition(x, Math.min(Math.max(y, area.y), area.y + area.height - height));
}

export function isTrayMenuOpen(): boolean {
  return !!win && win.isVisible();
}

export function showTrayMenu(tray: Tray): void {
  if (!win) win = create();
  if (win.isVisible()) {
    hideTrayMenu();
    return;
  }
  push();
  place(tray);
  win.show();
  win.focus();
}

export function hideTrayMenu(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

export function destroyTrayMenu(): void {
  const w = win;
  win = null;
  if (w && !w.isDestroyed()) w.destroy();
}

/** 현재 상태를 렌더러로 보낸다. 상태가 바뀔 때마다 호출해도 된다. */
export function push(): void {
  if (!win || win.isDestroyed() || !getState) return;
  win.webContents.send('tray:state', getState());
}

/** 렌더러가 잰 크기로 창을 맞춘다. 투명 영역이 넓으면 클릭을 가로챈다. */
export function fitTrayMenu(
  tray: Tray | null,
  size: { width: number; height: number },
): void {
  if (!win || win.isDestroyed()) return;
  win.setBounds({ ...win.getBounds(), width: size.width, height: size.height });
  if (tray) place(tray);
}
