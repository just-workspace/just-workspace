/**
 * 프리로드 — 렌더러와 메인 사이의 유일한 통로.
 *
 * contextIsolation 을 켠 상태에서 렌더러에 노출할 것만 골라 내보낸다.
 * 여기서 노출하지 않은 것은 렌더러가 건드릴 방법이 없다 — Node 도, ipcRenderer 도.
 *
 * ★ 토큰은 이 경계를 넘지 않는다.
 * 리프레시 토큰은 물론이고 액세스 토큰도 렌더러에 주지 않는다. 렌더러가 XSS 로
 * 뚫리면 그대로 유출되기 때문이다. 인증이 필요한 요청은 메인이 대신 보낸다
 * (`api` 아래 항목들이 전부 메인에서 실행된다).
 */
import { contextBridge, ipcRenderer } from 'electron';

type RemoteStatusView = { available: boolean; registered: boolean; inSession: boolean; allowRemote: boolean; unattended: boolean; deviceName: string };

export interface AppInfo {
  version: string;
  /** 설치 이름(JW_PRODUCT_NAME). 셸 제목 줄에 쓴다. */
  productName: string;
  serverUrl: string;
  deviceName: string;
  /** 'win32' | 'darwin' | 'linux'. 창 버튼을 그릴지 판단한다. */
  platform: string;
  /** OS 자격 증명 저장소를 쓸 수 있는지. false 면 로그인 버튼을 막는다. */
  secureStore: boolean;
  /** 이 플랫폼에서 그 저장소를 부르는 이름. 안내 문구에 그대로 쓴다. */
  credentialStore: string;
}

export type SignInResult = { ok: true } | { ok: false; message: string; cancelled?: boolean };

/** 서버 확인 결과(main/auth verifyServer 와 같은 모양). version 은 옛 서버면 null. */
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

  /** 서버가 살아 있고 우리가 아는 발급자인지("확인됨" 배지) + 서버 버전·기능 플래그. */
  verifyServer: (): Promise<ServerCheck> => ipcRenderer.invoke('app:verify-server'),

  // ── 로그인 창 ──
  signIn: (deviceName: string): Promise<SignInResult> =>
    ipcRenderer.invoke('auth:sign-in', deviceName),
  cancelSignIn: (): Promise<void> => ipcRenderer.invoke('auth:cancel'),
  signOut: (): Promise<void> => ipcRenderer.invoke('auth:sign-out'),
  /** 인가 URL 이 만들어지면 알려준다 — 대기 카드에 그대로 표시한다. */
  onAuthUrl: (fn: (url: string) => void) => {
    ipcRenderer.on('auth:url', (_e, url: string) => fn(url));
  },

  // ── 셸 창 ── (0.5.0: 창 테두리만. 레일·검색·목록은 본문 웹이 그린다)
  /**
   * 본문 영역의 좌표를 알린다. 임베드된 웹 뷰는 별도 레이어라 CSS 로 배치할 수
   * 없고, 메인이 픽셀 좌표로 맞춰야 한다.
   */
  setContentBounds: (r: Rect) => ipcRenderer.send('shell:content-bounds', r),
  reloadContent: () => ipcRenderer.send('shell:reload'),
  history: (dir: 'back' | 'forward') => ipcRenderer.send('shell:history', dir),
  /** 본문의 뒤로/앞으로 가능 여부·제목이 바뀌었다. */
  onNavState: (fn: (s: { canGoBack: boolean; canGoForward: boolean; title: string }) => void) => {
    ipcRenderer.on('shell:nav-state', (_e, s) => fn(s));
  },
  /** 임베드 뷰가 로드에 실패했을 때. */
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
     * 피커를 띄우고 사용자가 고른 소스를 돌려준다(취소하면 null).
     * 실제 캡처는 이 id 로 `getUserMedia({ chromeMediaSourceId })` 를 부르는
     * 쪽에서 한다 — 메인은 어느 소스인지만 정해준다.
     */
    start: (context: string): Promise<{ sourceId: string; withAudio: boolean } | null> =>
      ipcRenderer.invoke('share:start', context),
    /** 바가 그려진 뒤 현재 상태를 한 번 받아온다. */
    ready: () => ipcRenderer.send('share:ready'),
    /** 실제 바 크기. 투명 창이 내용보다 크면 보이지 않는 클릭 사각지대가 된다. */
    resize: (s: { width: number; height: number }) => ipcRenderer.send('share:resize', s),
    stop: () => ipcRenderer.send('share:stop'),
    toggle: (what: 'mic' | 'camera') => ipcRenderer.send('share:toggle', what),
    onState: (fn: (s: ShareState) => void) => {
      ipcRenderer.on('share:state', (_e, s: ShareState) => fn(s));
    },
    /** 플로팅 바의 "공유 중지" 가 눌렸다. 트랙을 멈추라는 신호다. */
    onStopped: (fn: () => void) => {
      ipcRenderer.on('share:stopped', () => fn());
    },
  },

  // ── 트레이 메뉴 (OS 메뉴가 아니라 우리 창) ──
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
  /** 원격 데스크톱(내 기기) 설정 — 이 기기에만. available=false 면 서버에 플러그인이 없다 */
  remote: {
    status: (): Promise<RemoteStatusView> => ipcRenderer.invoke('remote:status'),
    patch: (p: { allowRemote?: boolean; unattended?: boolean }): Promise<RemoteStatusView> => ipcRenderer.invoke('remote:patch', p),
    /** 기기 이름 바꾸기(서버 PATCH name) */
    rename: (name: string): Promise<RemoteStatusView> => ipcRenderer.invoke('remote:rename', name),
    /** 최근 접속 기록 3건 */
    recent: (): Promise<Array<{ requester: string; email: string; kind: 'device' | 'support'; status: string; when: string | null; durationS: number | null }>> =>
      ipcRenderer.invoke('remote:recent'),
    /** 등록 해지(서버에서 지우고 이 PC의 키·설정 삭제) */
    unregister: (): Promise<RemoteStatusView> => ipcRenderer.invoke('remote:unregister'),
  },
  sync: {
    load: (): Promise<SyncSettings> => ipcRenderer.invoke('sync:load'),
    patch: (p: Partial<SyncSettings>): Promise<SyncSettings> =>
      ipcRenderer.invoke('sync:patch', p),
    /** 네이티브 폴더 선택 대화상자. 취소하면 null. */
    pickFolder: (): Promise<SyncSettings | null> => ipcRenderer.invoke('sync:pick-folder'),
    removeFolder: (id: string): Promise<SyncSettings> =>
      ipcRenderer.invoke('sync:remove-folder', id),
    /** 지금 한 바퀴 돌린다. 끝나면 갱신된 설정을 돌려준다. */
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
