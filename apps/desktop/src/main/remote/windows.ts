/**
 * 원격 데스크톱 창 — 동의 창, "원격 접속 중" 막대, 화면 송출 러너(숨김).
 *
 * 동의 창과 막대는 항상 위에 표시된다. 원격 접속은 화면 앞의 사용자가 인지하지 못한 채 이루어져서는 안 된다:
 *  - 동의 창: 접속 요청자(이름·조직)를 표시하고 [허용]/[거부], 30초 무응답이면 거부.
 *  - 막대: 접속 중 계속 화면 상단에 유지되며 [끊기]를 선택하면 즉시 종료된다. 닫기·최소화 수단이 없다.
 * 러너는 숨김 창에서 LiveKit 으로 화면을 송출하고 데이터 채널을 메인으로 전달한다(remote-runner.html).
 */
import { app, BrowserWindow, ipcMain, screen, session as electronSession } from 'electron';
import { appendFile, stat, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * 원격 세션 진단 로그 — userData/remote.log(1MB 초과 시 .old 로 1회 로테이션한다).
 * 러너는 숨김 창이므로 오류가 어디에도 표시되지 않았다("승인했는데 바로 끊긴다"). 러너 콘솔·종료 사유를 여기에 기록한다.
 */
export async function remoteLog(line: string): Promise<void> {
  try {
    const f = path.join(app.getPath('userData'), 'remote.log');
    const st = await stat(f).catch(() => null);
    if (st && st.size > 1_000_000) await rename(f, `${f}.old`).catch(() => {});
    await appendFile(f, `${new Date().toISOString()} ${line}
`);
  } catch { /* 로그 실패로 세션을 차단하지 않는다 */ }
}

const PRELOAD = () => path.join(__dirname, '../../preload/remote.js');
const PAGE = (name: string) => path.join(__dirname, '../../renderer', name);

export interface ConsentInfo { requester: string; email: string; org: string; domain: string; kind: 'device' | 'support'; timeoutS: number }

/** 동의 창. 허용이면 true. 무응답·닫기는 false */
export function askConsent(info: ConsentInfo): Promise<boolean> {
  return new Promise((resolve) => {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const W = 480, H = 520;
    const win = new BrowserWindow({
      width: W, height: H, useContentSize: true, transparent: true, x: Math.round(d.x + (d.width - W) / 2), y: Math.round(d.y + (d.height - H) / 3),
      frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: false, show: false, backgroundColor: '#00000000',
      webPreferences: { preload: PRELOAD(), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ipcMain.removeListener('rd:consent:answer', onAnswer);
      ipcMain.removeHandler('rd:consent:info');
      if (!win.isDestroyed()) win.destroy();
      resolve(v);
    };
    const onAnswer = (e: Electron.IpcMainEvent, allow: boolean) => { if (e.sender === win.webContents) finish(allow === true); };
    ipcMain.on('rd:consent:answer', onAnswer);
    ipcMain.handle('rd:consent:info', (e) => (e.sender === win.webContents ? info : null));
    const timer = setTimeout(() => finish(false), info.timeoutS * 1000);
    win.on('closed', () => finish(false));
    void win.loadFile(PAGE('remote-consent.html'));
    win.once('ready-to-show', () => { win.show(); win.focus(); });
  });
}

/** 접속 중 막대(화면 상단 가장자리에 부착된 카드). 반환된 함수로 닫는다. onStop 은 사용자가 [끊기]를 선택했을 때 호출 */
export function showBar(requester: string, onStop: () => void): () => void {
  const d = screen.getPrimaryDisplay().workArea;
  const W = 440, H = 72; // 막대 40 + 그림자 자리
  const startedAt = Date.now();
  const win = new BrowserWindow({
    width: W, height: H, x: Math.round(d.x + (d.width - W) / 2), y: d.y,
    frame: false, transparent: true, resizable: false, movable: true, minimizable: false, maximizable: false,
    fullscreenable: false, closable: false, skipTaskbar: true, alwaysOnTop: true, focusable: true, show: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD(), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true); // 막대 자체는 원격 화면에 송출되지 않도록 한다(뷰어 측은 자신의 화면이 보이므로 혼동 방지)
  const onStopMsg = (e: Electron.IpcMainEvent) => { if (e.sender === win.webContents) onStop(); };
  ipcMain.on('rd:bar:stop', onStopMsg);
  ipcMain.handle('rd:bar:info', (e) => (e.sender === win.webContents ? { requester, startedAt } : null));
  void win.loadFile(PAGE('remote-bar.html'));
  win.once('ready-to-show', () => win.showInactive());
  return () => {
    ipcMain.removeListener('rd:bar:stop', onStopMsg);
    ipcMain.removeHandler('rd:bar:info');
    if (!win.isDestroyed()) { win.setClosable(true); win.destroy(); }
  };
}

/** 화면 송출 러너 — 전용 메모리 파티션(기본 세션의 화면 공유 피커·권한 처리와 분리) */
export function createRunner(pickSource: () => Promise<Electron.DesktopCapturerSource | null>): BrowserWindow {
  const ses = electronSession.fromPartition('remote-runner', { cache: false });
  /*
   * 러너는 로컬 파일 페이지이므로 LiveKit 웹소켓에 `Origin: file://` 이 포함된다. 프런트 웹 방화벽(WAF)이 이를 공격으로 판정하여
   * 403 을 반환하면 승인 직후 "could not establish signal connection" 으로 연결이 끊긴다(내 기기·1회성 지원 모두).
   * 이 파티션에서 나가는 요청의 Origin 을 요청 대상 자신의 출처(wss→https)로 변경한다 — 동일 출처 요청으로 인식되도록.
   */
  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    const h = { ...d.requestHeaders };
    try {
      const u = new URL(d.url);
      if (u.protocol === 'wss:' || u.protocol === 'https:') {
        const origin = `https://${u.host}`;
        for (const k of Object.keys(h)) if (k.toLowerCase() === 'origin') delete h[k];
        h.Origin = origin;
      }
    } catch { /* 주소를 읽을 수 없으면 그대로 둔다 */ }
    cb({ requestHeaders: h });
  });
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'display-capture'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'display-capture');
  // 동의는 이미 받은 상태 — 피커 없이 현재 송출 대상 모니터를 제공한다
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    const src = await pickSource();
    cb(src ? { video: src } : {});
  });
  const win = new BrowserWindow({
    width: 320, height: 200, show: false, skipTaskbar: true,
    webPreferences: {
      preload: PRELOAD(), contextIsolation: true, nodeIntegration: false, sandbox: true,
      session: ses, backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (e) => { void remoteLog(`[runner:${e.level}] ${e.message}`); });
  win.webContents.on('render-process-gone', (_e, d) => { void remoteLog(`[runner] 렌더러 종료 ${d.reason} ${d.exitCode}`); });
  void win.loadFile(PAGE('remote-runner.html'));
  return win;
}
