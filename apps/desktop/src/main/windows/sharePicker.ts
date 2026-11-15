/**
 * 화면 공유 소스 피커 창.
 *
 * ★ 이 화면 하나 때문에 런타임을 Electron 으로 정했다.
 * 브라우저의 `getDisplayMedia()` 는 브라우저가 그리는 피커를 띄운다 — 우리 디자인을
 * 입힐 수 없고, 회의 맥락(누가 보게 되는지)도 못 보여준다. `desktopCapturer` 는
 * 소스 목록과 썸네일을 우리에게 넘겨주므로 피커를 직접 그릴 수 있다.
 *
 * 그 API 는 Electron 17 부터 **메인 프로세스 전용**이다. 렌더러에서 부르면 없다.
 */
import { BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import path from 'node:path';

export interface PickerSource {
  id: string;
  name: string;
  /** 카드 두 번째 줄. 화면은 해상도, 창은 앱 이름. */
  detail: string;
  kind: 'screen' | 'window';
  /** data: URL. 없으면 카드가 빈 썸네일로 뜬다. */
  thumbnail: string | null;
}

export interface PickerResult {
  sourceId: string;
  withAudio: boolean;
}

/** 진행 중인 피커. 회의 하나에 피커 하나면 충분하다. */
let win: BrowserWindow | null = null;
let settle: ((r: PickerResult | null) => void) | null = null;
/** 부제로 띄울 회의 맥락. 창이 뜰 때마다 갈아끼운다. */
let context = '';

async function collect(): Promise<PickerSource[]> {
  const displays = screen.getAllDisplays();
  const raw = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    // 카드 썸네일이 108px 높이라 이 정도면 충분하고, 더 키우면 창이 뜨는 데
    // 눈에 띄게 느려진다(소스 하나마다 캡처가 돈다).
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: false,
  });

  return raw.map((s) => {
    const isScreen = s.id.startsWith('screen:');
    let detail = '';
    if (isScreen) {
      // display_id 로 실제 해상도를 붙인다. 이름만으로는 어느 모니터인지 모른다.
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
 * 피커를 띄우고 사용자가 고를 때까지 기다린다.
 * 취소·창 닫힘은 `null` 이다 — 호출부는 공유를 시작하지 않으면 된다.
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
      // 카드는 820×580 이고 나머지는 그림자 여백이다. 투명 창이라
      // 여백은 보이지 않고 그림자만 남는다.
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

    // 창을 그냥 닫아도 대기 중인 약속은 반드시 끝나야 한다.
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
 * 고른 id 에 해당하는 실제 캡처 소스를 되찾는다.
 *
 * `setDisplayMediaRequestHandler` 는 id 가 아니라 소스 객체를 요구한다. 피커가
 * 뜬 사이에 창이 닫혔을 수 있으므로 목록을 다시 조회해서 찾는다 — 없으면 null.
 */
export async function resolveSource(id: string) {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  return sources.find((s) => s.id === id) ?? null;
}

/** 앱 시작 시 한 번. 창마다 등록하면 "핸들러 중복" 으로 터진다. */
export function registerPickerIpc(): void {
  ipcMain.handle('picker:load', async () => ({
    sources: await collect(),
    context,
  }));
  ipcMain.on('picker:choose', (_e, r: PickerResult) => close(r));
  ipcMain.on('picker:cancel', () => close(null));
}
