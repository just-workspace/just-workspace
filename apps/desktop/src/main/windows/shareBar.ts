/**
 * 공유 중 플로팅 컨트롤 바 — 항상 위에 표시되는 별도 창.
 *
 * 회의 창 안에 두면 회의 창을 최소화하거나 공유 중인 화면 뒤로 보내는 순간
 * 중지 버튼이 사라진다. "공유가 아직 켜져 있는 줄 몰랐다" 는 화면 공유에서
 * 가장 빈번한 사고이므로, 중지 수단은 항상 접근 가능해야 한다.
 *
 * 작업 표시줄에는 표시하지 않는다(skipTaskbar) — 창 목록에 나타나면 alt-tab 순환을
 * 방해하고, 공유 소스 목록에도 이 창 자체가 나타난다.
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

  // 공유 중인 화면의 상단 중앙에 배치한다. 커서가 위치한 디스플레이를 기준으로 한다 —
  // 다중 모니터 환경에서 주 모니터에 고정하면 의도하지 않은 화면에 표시된다.
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

  // 'screen-saver' 레벨이어야 전체화면 앱 위에도 유지된다. 기본 레벨에서는 가려진다.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '../../renderer/share-bar.html'));
  // showInactive: 바 표시 시 공유 중인 창의 포커스를 가져가서는 안 된다.
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
 * 렌더러가 측정한 실제 크기로 창을 축소하고 다시 중앙 정렬한다.
 * 투명 창은 보이지 않는 영역도 마우스 이벤트를 가로채므로 내용보다 커서는 안 된다.
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
