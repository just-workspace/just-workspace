/**
 * 임베드 웹뷰 전용 프리로드 — `window.jwNativeAudio`(하이레조)와
 * `window.jwShell`(셸 → 웹 이동 명령 하나, 0.5.0) 둘만 노출한다.
 *
 * 셸의 `jw` API(preload/index.ts)는 여기에 없다 — 서버가 제공하는 코드가 접근할 수 있는 표면은 이 제한된 오디오 API 가 전부이다.
 * 메인은 요청마다 송신 webContents·origin 을 대조한다(main/nativeAudio/ipc.ts). 토큰 중 렌더러→메인으로 전달되는 것은 릴레이 토큰뿐이다.
 * 웹앱(frontend-react lib/hires)은 `window.jwNativeAudio` 가 있을 때만 'hires' 단계를 등록한다 — 브라우저에서는 undefined.
 *
 * 타입 정본은 이 파일(JwNativeAudio). frontend-react/src/lib/hires/types.ts 가 동일한 형태를 복제한다.
 */
import { contextBridge, ipcRenderer } from 'electron';

export type HiresEventType =
  | 'state' | 'started' | 'failed' | 'downgraded' | 'connected' | 'transport_fallback' | 'peer_joined' | 'peer_left' | 'peer_format'
  | 'needGrant' | 'warning' | 'stats' | 'error';

export interface HiresEventMessage { type: HiresEventType; [k: string]: unknown }

type Listener = (ev: HiresEventMessage) => void;
const listeners = new Map<string, Set<Listener>>();
let subscribed = false;

function subscribe() {
  if (subscribed) return;
  subscribed = true;
  ipcRenderer.on('native-audio:event', (_e, ev: HiresEventMessage) => {
    const set = listeners.get(ev?.type);
    if (set) for (const fn of set) { try { fn(ev); } catch { /* 리스너 오류가 다른 리스너를 차단하지 않도록 한다 */ } }
    const all = listeners.get('*');
    if (all) for (const fn of all) { try { fn(ev); } catch { /* noop */ } }
  });
}

const api = {
  /** 프리로드 API 버전 — 웹 측에서 호환 여부를 확인한다 */
  apiVersion: 1,
  /** 애드온의 실제 로드 여부(없으면 하이레조 비활성) */
  available: (): Promise<{ available: boolean; version: unknown; platform: string }> => ipcRenderer.invoke('native-audio:available'),
  listDevices: (): Promise<unknown> => ipcRenderer.invoke('native-audio:list-devices'),
  /** 장치를 연다(exclusive 협상). ok=false 면 reason/code/app/device 로 사유 전달 */
  openHires: (opts: { captureDevice?: string | null; playbackDevice?: string | null; rate: number; bits: 16 | 24 | 32; channels: 1 | 2; frameMs?: number; allowShared?: boolean; fec?: boolean; bufferPreset?: 'auto' | 60 | 120 | 250 }): Promise<unknown> =>
    ipcRenderer.invoke('native-audio:open', opts),
  /** 릴레이에 연결한다(grant = /voice/relay-token 응답) */
  connect: (grant: unknown): Promise<unknown> => ipcRenderer.invoke('native-audio:connect', grant),
  /** 'needGrant' 이벤트에 응답한다(토큰 만료 재접속) */
  setGrant: (grant: unknown): Promise<void> => ipcRenderer.invoke('native-audio:set-grant', grant),
  close: (): Promise<void> => ipcRenderer.invoke('native-audio:close'),
  stats: (): Promise<unknown> => ipcRenderer.invoke('native-audio:stats'),
  levels: (): Promise<{ left: number; right: number }> => ipcRenderer.invoke('native-audio:levels'),
  peers: (): Promise<unknown[]> => ipcRenderer.invoke('native-audio:peers'),
  setMuted: (m: boolean): Promise<void> => ipcRenderer.invoke('native-audio:set-muted', m),
  setDeafened: (d: boolean): Promise<void> => ipcRenderer.invoke('native-audio:set-deafened', d),
  setBufferPreset: (p: 'auto' | 60 | 120 | 250): Promise<void> => ipcRenderer.invoke('native-audio:set-buffer-preset', p),
  /** 이벤트 구독. type '*' 는 전체. 해제 함수를 반환한다 */
  on: (type: HiresEventType | '*', fn: Listener): (() => void) => {
    subscribe();
    let set = listeners.get(type);
    if (!set) { set = new Set(); listeners.set(type, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  },
};

contextBridge.exposeInMainWorld('jwNativeAudio', api);

export type JwNativeAudio = typeof api;

/*
 * 셸 → 웹 이동 명령(트레이 "회의"·알림 클릭). 셸이 페이지를 재로드하면 음성채널·통화가 끊기므로
 * 웹이 구독 중이면 SPA 라우터로 이동하도록 한다. 웹 측 정본 frontend-react/src/lib/desktopBridge.ts.
 * 웹 → 셸로는 "구독했다" 통지 하나만 전달된다(메인은 이 webContents 에서 수신한 것만 처리한다).
 */
const navListeners = new Set<(path: string) => void>();
let navSubscribed = false;

const shellBridge = {
  apiVersion: 1,
  onNavigate: (fn: (path: string) => void): (() => void) => {
    if (!navSubscribed) {
      navSubscribed = true;
      ipcRenderer.on('jw-shell:navigate', (_e, p: unknown) => {
        if (typeof p !== 'string') return;
        for (const f of navListeners) { try { f(p); } catch { /* noop */ } }
      });
    }
    navListeners.add(fn);
    ipcRenderer.send('jw-shell:ready', true);
    return () => {
      navListeners.delete(fn);
      if (navListeners.size === 0) ipcRenderer.send('jw-shell:ready', false);
    };
  },
};

contextBridge.exposeInMainWorld('jwShell', shellBridge);

export type JwShellBridge = typeof shellBridge;
