/**
 * 하이레조 IPC(메인) — 임베드 웹뷰의 `window.jwNativeAudio`(preload/webview.ts) 가 호출하는 유일한 표면.
 *
 * 보안 경계
 *  · 임베드 웹뷰에는 원래 프리로드가 없다(서버 코드가 본 앱의 IPC 에 접근하지 못하도록). 하이레조는 네이티브 장치가 필요하므로 예외로 **범위가 좁은 프리로드 하나**만 부착하고,
 *    여기 핸들러는 (1) 등록된 웹뷰 webContents 에서 온 요청만, (2) 해당 프레임의 origin 이 CONFIG.serverUrl 과 동일한 경우에만 수신한다.
 *  · 토큰은 릴레이 토큰(HMAC, 120 s, 음성방 하나)만 렌더러→메인으로 전달된다. OAuth 토큰은 계속 메인 밖으로 전달되지 않는다.
 *  · 네트워크(WebTransport/WebSocket)·장치 I/O 는 전부 메인에서 실행된다. 렌더러는 상태·통계만 수신한다.
 */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { CONFIG } from '../config';
import { nativeAudio } from './engine';
import { HiresSession, type HiresEvent, type HiresOpenOptions } from './session';
import type { RelayGrant } from './relay/transport';

let view: WebContents | null = null;
let session: HiresSession | null = null;

export const NATIVE_AUDIO_CHANNEL = 'native-audio:event';

/** 셸이 임베드 웹뷰를 생성할 때 등록한다 — 이 webContents 만 하이레조 IPC 를 사용할 수 있다 */
export function attachNativeAudioView(wc: WebContents | null): void {
  if (view && view !== wc) void closeSession();
  view = wc;
  wc?.once('destroyed', () => { if (view === wc) { view = null; void closeSession(); } });
}

function allowed(e: IpcMainInvokeEvent): boolean {
  if (!view || e.sender !== view) return false;
  try {
    const origin = new URL(e.senderFrame?.url ?? e.sender.getURL()).origin;
    return origin === new URL(CONFIG.serverUrl).origin;
  } catch {
    return false;
  }
}

function forward(ev: HiresEvent): void {
  if (!view || view.isDestroyed()) return;
  // stats 는 1 s 주기 — 그대로 송신한다(렌더러 getStats 로도 조회 가능하나 이벤트가 더 빠르다)
  view.send(NATIVE_AUDIO_CHANNEL, ev);
}

function ensureSession(): HiresSession {
  if (!session) {
    session = new HiresSession();
    session.on('event', forward);
  }
  return session;
}

async function closeSession(): Promise<void> {
  const s = session;
  session = null;
  if (s) { try { await s.close(); } catch { /* noop */ } s.removeAllListeners(); }
}

function guarded<T extends unknown[], R>(fn: (...a: T) => R | Promise<R>) {
  return (e: IpcMainInvokeEvent, ...a: T): R | Promise<R> => {
    if (!allowed(e)) throw new Error('native-audio: not allowed from this frame');
    return fn(...a);
  };
}

export function registerNativeAudioIpc(): void {
  ipcMain.handle('native-audio:available', (e) => {
    if (!allowed(e)) return { available: false };
    const n = nativeAudio();
    return { available: !!n, version: n ? n.version() : null, platform: process.platform };
  });
  ipcMain.handle('native-audio:list-devices', guarded(() => ensureSession().listDevices()));
  ipcMain.handle('native-audio:open', guarded((opts: HiresOpenOptions) => {
    // 테스트 전용 옵션은 렌더러에서 활성화할 수 없다
    const { backend: _b, testSignal: _t, seed: _s, noPlayback: _n, ...safe } = opts ?? ({} as HiresOpenOptions);
    return ensureSession().open(safe as HiresOpenOptions);
  }));
  ipcMain.handle('native-audio:connect', guarded(async (grant: RelayGrant) => {
    await ensureSession().connect(grant);
    return { state: session!.currentState, peers: session!.getPeers() };
  }));
  ipcMain.handle('native-audio:set-grant', guarded((grant: RelayGrant) => { session?.setGrant(grant); }));
  ipcMain.handle('native-audio:close', guarded(() => closeSession()));
  ipcMain.handle('native-audio:stats', guarded(() => session?.getStats() ?? null));
  ipcMain.handle('native-audio:levels', guarded(() => session?.levels() ?? { left: -100, right: -100 }));
  ipcMain.handle('native-audio:peers', guarded(() => session?.getPeers() ?? []));
  ipcMain.handle('native-audio:set-muted', guarded((m: boolean) => { session?.setMuted(!!m); }));
  ipcMain.handle('native-audio:set-deafened', guarded((d: boolean) => { session?.setDeafened(!!d); }));
  ipcMain.handle('native-audio:set-buffer-preset', guarded((p: 'auto' | 60 | 120 | 250) => { session?.setBufferPreset(p); }));
}

/** 앱 종료 시 */
export async function shutdownNativeAudio(): Promise<void> {
  await closeSession();
}
