/**
 * 원격 데스크톱 창 전용 프리로드(동의 창·접속 막대·화면 러너·지원 프로그램).
 * 본 앱 프리로드(index.ts)와 분리한다 — 이 창들에는 필요한 채널만 노출한다.
 */
import { contextBridge, ipcRenderer } from 'electron';

const on = <T>(ch: string, fn: (v: T) => void) => {
  const h = (_e: Electron.IpcRendererEvent, v: T) => fn(v);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

const api = {
  consent: {
    info: (): Promise<{ requester: string; email: string; org: string; domain: string; kind: 'device' | 'support'; timeoutS: number } | null> => ipcRenderer.invoke('rd:consent:info'),
    answer: (allow: boolean) => ipcRenderer.send('rd:consent:answer', allow),
  },
  bar: {
    info: (): Promise<{ requester: string; startedAt: number } | null> => ipcRenderer.invoke('rd:bar:info'),
    stop: () => ipcRenderer.send('rd:bar:stop'),
  },
  runner: {
    init: (): Promise<{ ws_url: string; token: string; peer: string; maxWidth: number; maxHeight: number; fps: number } | null> => ipcRenderer.invoke('rd:runner:init'),
    input: (payload: Uint8Array, from: string) => ipcRenderer.send('rd:runner:input', payload, from),
    /** detail = 실패 사유 문구(진단용) */
    state: (s: 'connected' | 'closed' | 'failed', detail?: string) => ipcRenderer.send('rd:runner:state', s, detail),
    onSend: (fn: (payload: Uint8Array) => void) => on('rd:runner:send', fn),
    onSwitch: (fn: () => void) => on('rd:runner:switch', fn),
    /** 화질 변경(main/remote/quality.ts QualityParams) */
    onQuality: (fn: (q: unknown) => void) => on('rd:runner:quality', fn),
    source: (): Promise<string | null> => ipcRenderer.invoke('rd:runner:source'),
    sources: (): Promise<string[]> => ipcRenderer.invoke('rd:runner:sources'),
    used: (id: string) => ipcRenderer.send('rd:runner:used', id),
    onStop: (fn: () => void) => on('rd:runner:stop', fn),
  },
  support: {
    view: (): Promise<unknown> => ipcRenderer.invoke('rd:support:view'),
    onView: (fn: (v: unknown) => void) => on('rd:support:view', fn),
    newCode: () => ipcRenderer.send('rd:support:new-code'),
    stop: () => ipcRenderer.send('rd:support:stop'),
    setServer: (s: string) => ipcRenderer.send('rd:support:set-server', s),
    copy: (text: string) => ipcRenderer.send('rd:support:copy', text),
    close: () => ipcRenderer.send('rd:support:close'),
  },
};

contextBridge.exposeInMainWorld('rd', api);
export type RdApi = typeof api;
