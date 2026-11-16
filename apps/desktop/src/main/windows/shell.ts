/**
 * 셸 창 — 창 테두리 한 줄 + 임베드된 웹 앱.
 *
 * 0.5.0 부터 셸은 창 테두리(이동·창 버튼·뒤로/앞으로/새로 고침)만 그린다. 레일·상단바·활동 패널·사용자 메뉴는
 * 웹앱이 브라우저와 동일하게 그린다(WebContentsView). 데스크톱 전용 외곽 UI 를 별도로 두면 웹 기능이 추가될 때마다
 * 두 구현을 동기화해야 하며, 실제로 불일치가 반복되었다(홈·위키·게시판·플러그인·관리·알림 패널 누락).
 *
 * 임베드 뷰에 세션을 연결하는 방법은 session.ts 주석 참고.
 */
import { app, BrowserWindow, ipcMain, session, WebContentsView, shell as electronShell } from 'electron';
import path from 'node:path';
import { CONFIG, isServerUrl } from '../config';
import { sessionUrl } from '../session';
import { attachNativeAudioView } from '../nativeAudio/ipc';

/** `/meetings/room/<name>` 에서 방 이름을 추출한다. 해당하지 않으면 null. */
function matchRoom(url: string): string | null {
  const m = /\/meetings\/room\/([^/?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ShellWindow {
  readonly win: BrowserWindow;
  private view: WebContentsView | null = null;
  private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  /** 현재 뷰가 가리키는 앱 내부 경로. 세션이 끊겨 다시 열 때 그대로 복원한다. */
  private currentPath = '/';
  /** 웹의 이동 명령 구독 여부(window.jwShell.onNavigate). 참이면 재로드하지 않고 SPA 라우터로 이동한다. */
  private bridgeReady = false;
  /** 회의 방 진입 시도 시 호출된다. 창 표시 여부는 메인이 결정한다. */
  onEnterRoom: ((room: string) => void) | null = null;

  constructor() {
    this.win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1040,
      minHeight: 640,
      frame: false,
      // macOS 에서는 창 버튼을 직접 그리지 않는다. 왼쪽 위 신호등이 OS 관례이며,
      // 없으면 "닫을 수 없는 창" 으로 보인다. hiddenInset 은 신호등만 남기고
      // 나머지 타이틀바 영역을 본 앱의 콘텐츠로 채울 수 있게 한다.
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 9 } }
        : {}),
      show: false,
      backgroundColor: '#00000000',
      icon: path.join(__dirname, '../../../assets/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.win.loadFile(path.join(__dirname, '../../renderer/shell.html'));
    this.win.once('ready-to-show', () => this.win.show());
  }

  /** 본문 웹뷰의 webContents id(웹 로그아웃 감지용). 미생성 시 -1. */
  get viewId(): number {
    return this.view?.webContents.id ?? -1;
  }

  /** 렌더러가 측정한 본문 좌표. 뷰가 이미 있으면 즉시 적용한다. */
  setBounds(b: Bounds) {
    this.bounds = b;
    this.view?.setBounds(b);
  }

  /**
   * 웹앱의 서비스 워커·캐시를 삭제한다. 웹앱은 PWA 이므로 서비스 워커가 이전 번들을 유지하면 서버를 수정해도 앱 안에는
   * 이전 화면이 계속 표시된다(0.5.0 배포 직후 "사이드 메뉴가 없다" — 이전 번들은 셸 안에서 외곽 UI 를 숨긴다).
   * 앱은 항상 서버에 연결해 사용하므로 오프라인 캐시가 불필요하다. 로그인 쿠키·로컬 저장소는 변경하지 않는다.
   */
  private async dropWebCache(): Promise<void> {
    try {
      await session.defaultSession.clearStorageData({
        origin: new URL(CONFIG.serverUrl).origin,
        storages: ['serviceworkers', 'cachestorage'],
      });
      await session.defaultSession.clearCache();
    } catch (e) {
      console.warn('[shell] 웹 캐시 비우기 실패', e);
    }
  }

  async mount(): Promise<void> {
    if (this.view) return;
    await this.dropWebCache();

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // 웹 앱에는 셸 프리로드(`jw`)를 주입하지 않는다. 주입하면 서버가 제공하는 코드가
        // 본 앱의 IPC 표면에 접근한다. 예외 1건: 하이레조(장치 독점 오디오)는 네이티브가 필요하므로
        // `window.jwNativeAudio` 만 노출하는 제한된 프리로드(preload/webview.ts)를 연결한다.
        // 메인 측 핸들러는 이 webContents + 서버 origin 에서 수신한 요청만 처리한다(main/nativeAudio/ipc.ts).
        preload: path.join(__dirname, '../../preload/webview.js'),
        sandbox: true,
      },
    });
    attachNativeAudioView(view.webContents);

    // 웹 → 셸 "이동 명령 구독함" — 이 뷰에서 수신한 것만 처리한다(다른 창·프레임은 무시).
    const onReady = (e: Electron.IpcMainEvent, on: unknown) => {
      if (e.sender !== view.webContents || e.senderFrame !== view.webContents.mainFrame) return;
      if (!isServerUrl(view.webContents.getURL())) return;
      this.bridgeReady = on === true;
    };
    ipcMain.on('jw-shell:ready', onReady);
    view.webContents.once('destroyed', () => ipcMain.off('jw-shell:ready', onReady));
    // 문서를 재로드하면 구독도 소멸한다 — 새 문서가 다시 통지할 때까지 재로드 방식으로 이동한다.
    view.webContents.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) this.bridgeReady = false;
    });

    // 브라우저와 동일: Alt+←/→ 뒤로·앞으로, F5·Ctrl+R 새로 고침.
    view.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.alt && input.key === 'ArrowLeft') { e.preventDefault(); this.history('back'); }
      else if (input.alt && input.key === 'ArrowRight') { e.preventDefault(); this.history('forward'); }
      else if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r' && !input.shift)) {
        e.preventDefault();
        this.reload();
      }
    });

    /*
     * 중요: 웹앱에 "지금 셸 안이다" 를 통지한다.
     *
     * 생략 시 웹앱이 자체 사이드바·상단바를 그대로 그려, 네이티브로
     * 그린 레일 옆에 동일한 요소가 중복 표시된다. 결과적으로 웹 사이트를
     * 그대로 표시한 것처럼 보인다.
     *
     * 쿼리 파라미터는 앱 안에서 링크를 1회만 이동해도 소실되고, 쿠키는 동일 브라우저의
     * 일반 탭에도 영향을 준다. UA 는 이 뷰가 표시하는 모든 페이지에 그대로 포함되므로
     * 페이지 이동 후에도 판별이 유지된다.
     *
     * 버전(`/x.y.z`)도 함께 포함한다 — 웹은 0.3.1 이상이면 자체 모듈 목록 칸을 그리고,
     * 그보다 이전 셸(자체 목록 칸이 있던 셸)이면 숨긴다(useDesktopShell.ts).
     */
    view.webContents.setUserAgent(
      `${view.webContents.getUserAgent()} JustWorkspaceDesktop/${app.getVersion()}`,
    );
    this.view = view;
    this.win.contentView.addChildView(view);
    view.setBounds(this.bounds);

    // 외부 링크는 시스템 브라우저로 연다. 앱 안에서 임의 사이트가 열려서는 안 된다.
    view.webContents.setWindowOpenHandler(({ url }) => {
      electronShell.openExternal(url);
      return { action: 'deny' };
    });
    // 워크스페이스 외부로의 최상위 이동도 차단한다.
    view.webContents.on('will-navigate', (e, url) => {
      if (!isServerUrl(url)) {
        e.preventDefault();
        electronShell.openExternal(url);
      }
    });

    view.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 = ERR_ABORTED. 새 주소로 전환할 때마다 발생하므로 무시한다.
      if (!isMainFrame || code === -3) return;
      this.win.webContents.send(
        'shell:content-error',
        `${desc} (${code})\n${url}`,
      );
    });
    view.webContents.on('did-finish-load', () => {
      this.win.webContents.send('shell:content-ok');
      this.pushNavState();
    });
    view.webContents.on('did-navigate', (_e, url) => { this.trackPath(url); this.pushNavState(); });
    view.webContents.on('page-title-updated', () => this.pushNavState());

    /*
     * 회의 방은 이 좁은 본문이 아니라 전용 창에서 열어야 한다.
     *
     * 웹앱은 SPA 이므로 "회의 시작" 을 눌러도 will-navigate 가 발생하지 않는다 — 주소만
     * history 로 변경된다. 따라서 in-page 이동을 감시하고, 방 진입을 시도하면
     * 본문은 회의 목록으로 되돌리고 별도 창을 표시한다.
     */
    view.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.trackPath(url);
      this.pushNavState();
      const room = matchRoom(url);
      if (!room) return;
      this.onEnterRoom?.(room);
      this.navigate('/meetings');
    });

    await this.load(this.currentPath);
  }

  /** 앱 내부 경로로 이동한다. 세션이 없으면 링크 토큰으로 먼저 생성한다. */
  async load(appPath: string): Promise<void> {
    this.currentPath = appPath;
    if (!this.view) return;

    const url = await sessionUrl(appPath);
    await this.view.webContents.loadURL(url).catch((e) => {
      this.win.webContents.send('shell:content-error', String(e?.message ?? e));
    });
  }

  navigate(appPath: string): void {
    if (!this.view) return;
    this.currentPath = appPath;
    // 웹이 구독 중이면 SPA 라우터로 이동한다 — 재로드하면 음성채널·통화가 끊긴다.
    if (this.bridgeReady) {
      this.view.webContents.send('jw-shell:navigate', appPath);
      return;
    }
    // 세션이 이미 연결되어 있으면 링크 토큰을 다시 사용할 필요가 없다.
    this.view.webContents
      .loadURL(`${CONFIG.serverUrl}${appPath}`)
      .catch(() => void this.load(appPath));
  }

  /** 새로 고침(버튼·F5) — 캐시를 삭제하고 현재 위치를 다시 연다. 서버 변경 후 이전 화면이 남지 않도록 하기 위함. */
  reload(): void {
    void this.dropWebCache().then(() => this.load(this.currentPath));
  }

  history(dir: 'back' | 'forward'): void {
    const h = this.view?.webContents.navigationHistory;
    if (!h) return;
    if (dir === 'back' && h.canGoBack()) h.goBack();
    else if (dir === 'forward' && h.canGoForward()) h.goForward();
  }

  /** 다시 열 때 동일 위치로 복귀하도록 현재 앱 경로를 기록한다(서버 주소 범위 안일 때만). */
  private trackPath(url: string): void {
    if (!isServerUrl(url)) return;
    const u = new URL(url);
    // 로그인 링크 토큰 경로는 기록하지 않는다(일회용).
    if (u.pathname.startsWith('/api/')) return;
    this.currentPath = `${u.pathname}${u.search}${u.hash}`;
  }

  private pushNavState(): void {
    const wc = this.view?.webContents;
    if (!wc || this.win.isDestroyed()) return;
    this.win.webContents.send('shell:nav-state', {
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      title: wc.getTitle(),
    });
  }

  destroy(): void {
    if (this.view) {
      this.win.contentView.removeChildView(this.view);
      this.view.webContents.close();
      this.view = null;
    }
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}
