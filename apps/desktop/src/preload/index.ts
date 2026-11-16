/**
 * 프리로드 — 렌더러와 메인 사이의 유일한 통로.
 *
 * contextIsolation 을 활성화한 상태에서 렌더러에 노출할 항목만 선별해 내보낸다.
 * 여기서 노출하지 않은 항목은 렌더러가 접근할 수 없다 — Node 와 ipcRenderer 모두 해당한다.
 *
 * 중요: 토큰은 이 경계를 넘지 않는다.
 * 리프레시 토큰은 물론 액세스 토큰도 렌더러에 전달하지 않는다. 렌더러가 XSS 로
 * 침해되면 그대로 유출되기 때문이다. 인증이 필요한 요청은 메인이 대신 전송한다
 * (`api` 아래 항목은 전부 메인에서 실행된다).
 */
import { contextBridge, ipcRenderer } from 'electron';

type RemoteStatusView = { available: boolean; registered: boolean; inSession: boolean; allowRemote: boolean; unattended: boolean; deviceName: string };

export interface AppInfo {
  version: string;
  /** 설치 이름(JW_PRODUCT_NAME). 셸 제목 줄에 사용한다. */
  productName: string;
  serverUrl: string;
  deviceName: string;
  /** 'win32' | 'darwin' | 'linux'. 창 버튼 표시 여부 판단에 사용한다. */
  platform: string;
  /** OS 자격 증명 저장소 사용 가능 여부. false 면 로그인 버튼을 비활성화한다. */
  secureStore: boolean;
  /** 이 플랫폼에서의 해당 저장소 명칭. 안내 문구에 그대로 사용한다. */
  credentialStore: string;
}

export type SignInResult = { ok: true } | { ok: false; message: string; cancelled?: boolean };

/** 서버 확인 결과(main/auth verifyServer 와 동일한 형태). version 은 구버전 서버면 null. */
export interface ServerCheck {
  verified: boolean;
  version: string | null;
  features: string[];
}

export interface PickerSource {
  id: string;
  name: string;
  detail: string;
  kind: 'screen' | 'window';
  thumbnail: string | null;
}

export interface ShareState {
  mic: boolean;
  camera: boolean;
}

export interface TrayMenuState {
  displayName: string;
  host: string;
  sync: 'idle' | 'syncing' | 'up_to_date' | 'error';
  meetingCount: number;
  dndUntil: number | null;
}

export type TrayAction = 'open' | 'sync' | 'meet' | 'settings' | 'quit' | 'close';

export interface SyncFolder {
  id: string;
  name: string;
  localPath: string;
  remotePath: string;
  bytes: number | null;
  state: 'idle' | 'syncing' | 'up_to_date' | 'paused' | 'conflict' | 'error';
  conflicts: number;
}

export interface SyncSettings {
  root: string;
  folders: SyncFolder[];
  startWithOs: boolean;
  pauseOnMetered: boolean;
  propagateDeletes: false;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const api = {
  info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),

  /** 서버가 동작 중이고 알려진 발급자인지 여부("확인됨" 배지) + 서버 버전·기능 플래그. */
  verifyServer: (): Promise<ServerCheck> => ipcRenderer.invoke('app:verify-server'),

  // ── 로그인 창 ──
  signIn: (deviceName: string): Promise<SignInResult> =>
    ipcRenderer.invoke('auth:sign-in', deviceName),
  cancelSignIn: (): Promise<void> => ipcRenderer.invoke('auth:cancel'),
  signOut: (): Promise<void> => ipcRenderer.invoke('auth:sign-out'),
  /** 인가 URL 생성 시 통지한다 — 대기 카드에 그대로 표시한다. */
  onAuthUrl: (fn: (url: string) => void) => {
    ipcRenderer.on('auth:url', (_e, url: string) => fn(url));
  },

  // ── 셸 창 ── (0.5.0: 창 테두리만. 레일·검색·목록은 본문 웹이 그린다)
  /**
   * 본문 영역의 좌표를 전달한다. 임베드된 웹 뷰는 별도 레이어이므로 CSS 로 배치할 수
   * 없으며, 메인이 픽셀 좌표로 맞춰야 한다.
   */
  setContentBounds: (r: Rect) => ipcRenderer.send('shell:content-bounds', r),
  reloadContent: () => ipcRenderer.send('shell:reload'),
  history: (dir: 'back' | 'forward') => ipcRenderer.send('shell:history', dir),
  /** 본문의 뒤로/앞으로 가능 여부·제목 변경 시. */
  onNavState: (fn: (s: { canGoBack: boolean; canGoForward: boolean; title: string }) => void) => {
    ipcRenderer.on('shell:nav-state', (_e, s) => fn(s));
  },
  /** 임베드 뷰 로드 실패 시. */
  onContentError: (fn: (message: string) => void) => {
    ipcRenderer.on('shell:content-error', (_e, m: string) => fn(m));
  },
  onContentOk: (fn: () => void) => {
    ipcRenderer.on('shell:content-ok', () => fn());
  },

  // ── 화면 공유 소스 피커 (별도 창) ──
  picker: {
    load: (): Promise<{ sources: PickerSource[]; context: string }> =>
      ipcRenderer.invoke('picker:load'),
    choose: (r: { sourceId: string; withAudio: boolean }) =>
      ipcRenderer.send('picker:choose', r),
    cancel: () => ipcRenderer.send('picker:cancel'),
  },

  // ── 공유 중 플로팅 바 (항상 위, 별도 창) ──
  share: {
    /**
     * 피커를 표시하고 사용자가 선택한 소스를 반환한다(취소 시 null).
     * 실제 캡처는 이 id 로 `getUserMedia({ chromeMediaSourceId })` 를 호출하는
     * 측에서 수행한다 — 메인은 대상 소스만 결정한다.
     */
    start: (context: string): Promise<{ sourceId: string; withAudio: boolean } | null> =>
      ipcRenderer.invoke('share:start', context),
    /** 바 렌더링 후 현재 상태를 1회 수신한다. */
    ready: () => ipcRenderer.send('share:ready'),
    /** 실제 바 크기. 투명 창이 내용보다 크면 보이지 않는 클릭 차단 영역이 생긴다. */
    resize: (s: { width: number; height: number }) => ipcRenderer.send('share:resize', s),
    stop: () => ipcRenderer.send('share:stop'),
    toggle: (what: 'mic' | 'camera') => ipcRenderer.send('share:toggle', what),
    onState: (fn: (s: ShareState) => void) => {
      ipcRenderer.on('share:state', (_e, s: ShareState) => fn(s));
    },
    /** 플로팅 바의 "공유 중지" 가 눌림. 트랙 중지 신호이다. */
    onStopped: (fn: () => void) => {
      ipcRenderer.on('share:stopped', () => fn());
    },
  },

  // ── 트레이 메뉴 (OS 메뉴가 아닌 자체 창) ──
  tray: {
    ready: () => ipcRenderer.send('tray:ready'),
    resize: (s: { width: number; height: number }) => ipcRenderer.send('tray:resize', s),
    action: (a: TrayAction) => ipcRenderer.send('tray:action', a),
    /** 분 단위 일시중지. 0 이면 해제. */
    pauseNotifications: (minutes: number) => ipcRenderer.send('tray:dnd', minutes),
    onState: (fn: (s: TrayMenuState) => void) => {
      ipcRenderer.on('tray:state', (_e, s: TrayMenuState) => fn(s));
    },
  },

  // ── 알림 토스트 (자체 창) ──
  toast: {
    ready: () => ipcRenderer.send('toast:ready'),
    resize: (s: { width: number; height: number }) => ipcRenderer.send('toast:resize', s),
    dismiss: (id: string) => ipcRenderer.send('toast:dismiss', id),
    activate: (id: string) => ipcRenderer.send('toast:activate', id),
    reply: (id: string, text: string) => ipcRenderer.send('toast:reply', { id, text }),
    onList: (fn: (list: unknown[]) => void) => {
      ipcRenderer.on('toast:list', (_e, list: unknown[]) => fn(list));
    },
  },

  // ── 설정 · 동기화 ──
  /** 원격 데스크톱(내 기기) 설정 — 이 기기에만 해당. available=false 면 서버에 플러그인 없음 */
  remote: {
    status: (): Promise<RemoteStatusView> => ipcRenderer.invoke('remote:status'),
    patch: (p: { allowRemote?: boolean; unattended?: boolean }): Promise<RemoteStatusView> => ipcRenderer.invoke('remote:patch', p),
    /** 기기 이름 변경(서버 PATCH name) */
    rename: (name: string): Promise<RemoteStatusView> => ipcRenderer.invoke('remote:rename', name),
    /** 최근 접속 기록 3건 */
    recent: (): Promise<Array<{ requester: string; email: string; kind: 'device' | 'support'; status: string; when: string | null; durationS: number | null }>> =>
      ipcRenderer.invoke('remote:recent'),
    /** 등록 해지(서버에서 삭제하고 이 PC의 키·설정 삭제) */
    unregister: (): Promise<RemoteStatusView> => ipcRenderer.invoke('remote:unregister'),
  },
  sync: {
    load: (): Promise<SyncSettings> => ipcRenderer.invoke('sync:load'),
    patch: (p: Partial<SyncSettings>): Promise<SyncSettings> =>
      ipcRenderer.invoke('sync:patch', p),
    /** 네이티브 폴더 선택 대화상자. 취소 시 null. */
    pickFolder: (): Promise<SyncSettings | null> => ipcRenderer.invoke('sync:pick-folder'),
    removeFolder: (id: string): Promise<SyncSettings> =>
      ipcRenderer.invoke('sync:remove-folder', id),
    /** 동기화를 1회 즉시 수행한다. 완료 후 갱신된 설정을 반환한다. */
    now: (): Promise<SyncSettings> => ipcRenderer.invoke('sync:now'),
    onProgress: (fn: (p: unknown) => void) => {
      ipcRenderer.on('sync:progress', (_e, p: unknown) => fn(p));
    },
  },

  // ── 창 조작 (프레임리스라 직접 구현) ──
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
};

contextBridge.exposeInMainWorld('jw', api);

export type JwApi = typeof api;
