/**
 * 화면 공유 소스 피커 창.
 *
 * 중요: 런타임을 Electron 으로 결정한 근거가 이 화면이다.
 * 브라우저의 `getDisplayMedia()` 는 브라우저가 그리는 피커를 표시한다 — 본 앱의 디자인을
 * 적용할 수 없고, 회의 맥락(누가 시청하게 되는지)도 표시할 수 없다. `desktopCapturer` 는
 * 소스 목록과 썸네일을 반환하므로 피커를 직접 그릴 수 있다.
 *
 * 해당 API 는 Electron 17 부터 **메인 프로세스 전용**이다. 렌더러에서는 호출할 수 없다.
 */
import { BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import path from 'node:path';

export interface PickerSource {
  id: string;
  name: string;
  /** 카드 두 번째 줄. 화면은 해상도, 창은 앱 이름. */
  detail: string;
  kind: 'screen' | 'window';
  /** data: URL. 없으면 카드가 빈 썸네일로 표시된다. */
  thumbnail: string | null;
}

export interface PickerResult {
  sourceId: string;
  withAudio: boolean;
}

/** 진행 중인 피커. 회의 하나당 피커 하나로 충분하다. */
let win: BrowserWindow | null = null;
let settle: ((r: PickerResult | null) => void) | null = null;
/** 부제로 표시할 회의 맥락. 창을 표시할 때마다 교체한다. */
let context = '';

async function collect(): Promise<PickerSource[]> {
  const displays = screen.getAllDisplays();
  const raw = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    // 카드 썸네일 높이가 108px 이므로 이 크기로 충분하다. 더 키우면 창 표시가
    // 체감될 정도로 지연된다(소스마다 캡처가 수행된다).
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: false,
  });

  return raw.map((s) => {
    const isScreen = s.id.startsWith('screen:');
    let detail = '';
    if (isScreen) {
      // display_id 로 실제 해상도를 덧붙인다. 이름만으로는 모니터를 식별할 수 없다.
      const d = displays.find((x) => String(x.id) === s.display_id);
      detail = d ? `${d.size.width} × ${d.size.height}` : '';
    }
    return {
      id: s.id,
      name: s.name,
      detail,
      kind: isScreen ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
    } as PickerSource;
  });
}

/**
 * 피커를 표시하고 사용자의 선택을 대기한다.
 * 취소·창 닫힘은 `null` 이다 — 이 경우 호출부는 공유를 시작하지 않는다.
 */
export function openSharePicker(
  parent: BrowserWindow | null,
  meetingContext: string,
): Promise<PickerResult | null> {
  if (win) {
    win.focus();
    return Promise.resolve(null);
  }
  context = meetingContext;

  return new Promise<PickerResult | null>((resolve) => {
    settle = resolve;

    win = new BrowserWindow({
      // 카드는 820×580 이며 나머지는 그림자 여백이다. 투명 창이므로
      // 여백은 보이지 않고 그림자만 표시된다.
      width: 880,
      height: 640,
      parent: parent ?? undefined,
      modal: !!parent,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '../../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.loadFile(path.join(__dirname, '../../renderer/share-picker.html'));
    win.once('ready-to-show', () => win?.show());

    // 창이 닫히는 경우에도 대기 중인 Promise 는 반드시 완료되어야 한다.
    win.on('closed', () => {
      win = null;
      settle?.(null);
      settle = null;
    });

  });
}

function close(result: PickerResult | null): void {
  const done = settle;
  settle = null;
  const w = win;
  win = null;
  done?.(result);
  if (w && !w.isDestroyed()) w.destroy();
}

/**
 * 선택된 id 에 해당하는 실제 캡처 소스를 다시 조회한다.
 *
 * `setDisplayMediaRequestHandler` 는 id 가 아니라 소스 객체를 요구한다. 피커가
 * 표시된 동안 창이 닫혔을 수 있으므로 목록을 재조회해 찾는다 — 없으면 null.
 */
export async function resolveSource(id: string) {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  return sources.find((s) => s.id === id) ?? null;
}

/** 앱 시작 시 1회 등록. 창마다 등록하면 "핸들러 중복" 오류가 발생한다. */
export function registerPickerIpc(): void {
  ipcMain.handle('picker:load', async () => ({
    sources: await collect(),
    context,
  }));
  ipcMain.on('picker:choose', (_e, r: PickerResult) => close(r));
  ipcMain.on('picker:cancel', () => close(null));
}
