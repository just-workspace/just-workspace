/**
 * 공유 중 플로팅 컨트롤 바 — 항상 위에 뜨는 별개 창.
 *
 * 회의 창 안에 두면, 회의 창을 최소화하거나 공유 중인 화면 뒤로 보내는 순간
 * 중지 버튼이 사라진다. "공유가 아직 켜져 있는 줄 몰랐다" 가 화면 공유에서
 * 제일 흔한 사고라, 중지 수단은 항상 손에 닿아야 한다.
 *
 * 작업 표시줄에는 넣지 않는다(skipTaskbar) — 창 목록에 뜨면 alt-tab 순환을
 * 어지럽히고, 공유 소스 목록에도 자기 자신이 나타난다.
 */
import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

export interface ShareState {
  mic: boolean;
  camera: boolean;
}

const WIDTH = 420;
const HEIGHT = 60; // 바 44px + 그림자 여백

let win: BrowserWindow | null = null;
let state: ShareState = { mic: true, camera: false };

export function isShareBarOpen(): boolean {
  return !!win;
}

export function showShareBar(): BrowserWindow {
  if (win) {
    win.showInactive();
    return win;
  }

  // 공유 중인 화면 위쪽 가운데. 커서가 있는 디스플레이를 기준으로 잡는다 —
  // 모니터가 여럿일 때 주 모니터에 고정하면 엉뚱한 화면에 뜬다.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width } = display.workArea;

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: Math.round(x + (width - WIDTH) / 2),
    y: y + 14,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 'screen-saver' 레벨이라야 전체화면 앱 위에도 남는다. 기본 레벨은 가린다.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '../../renderer/share-bar.html'));
  // showInactive: 이 바가 뜨면서 공유 중인 창의 포커스를 뺏으면 안 된다.
  win.once('ready-to-show', () => win?.showInactive());
  win.on('closed', () => {
    win = null;
  });

  return win;
}

export function hideShareBar(): void {
  const w = win;
  win = null;
  if (w && !w.isDestroyed()) w.destroy();
}

/**
 * 렌더러가 잰 실제 크기로 창을 줄이고 다시 가운데로 맞춘다.
 * 투명 창은 보이지 않는 부분도 마우스를 먹으므로 내용보다 크면 안 된다.
 */
export function fitShareBar(size: { width: number; height: number }): void {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint(win.getBounds());
  const { x, y, width } = display.workArea;
  win.setBounds({
    width: size.width,
    height: size.height,
    x: Math.round(x + (width - size.width) / 2),
    y: y + 14,
  });
}

export function getShareState(): ShareState {
  return state;
}

export function setShareState(next: Partial<ShareState>): ShareState {
  state = { ...state, ...next };
  win?.webContents.send('share:state', state);
  return state;
}
