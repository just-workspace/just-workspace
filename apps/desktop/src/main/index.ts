/**
 * 메인 프로세스 진입점.
 *
 * 수행 작업은 네 가지이다 — 단일 인스턴스 보장, 로그인/셸 창 전환, 트레이, IPC 중계.
 * 인증 로직은 auth/ 에 있으며 여기서는 호출만 한다.
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell as electronShell,
} from 'electron';
import os from 'node:os';
import { CONFIG } from './config';
import { broker, cancelSignIn, CancelledError, signIn, verifyServer } from './auth';
import { isSecure } from './auth/keychain';
import { setAutoStart, startedHidden } from './autostart';
import { createTray, destroyTray, getTray, setTrayUnread } from './tray';
import {
  destroyTrayMenu,
  fitTrayMenu,
  hideTrayMenu,
  push as pushTrayMenu,
  setTrayMenuStateSource,
  type TrayMenuState,
} from './windows/trayMenu';
import { setEventHandlers, startEvents, stopEvents } from './events';
import { ruleFor } from './notifyRules';
import { installPermissionHandlers } from './permissions';
import { installContextMenu } from './contextMenu';
import { createLoginWindow } from './windows/login';
import { closeMeeting, getMeetingWindow, showMeeting } from './windows/meeting';
import { sessionUrl } from './session';
import { destroySettings, settingsWindow, showSettings } from './windows/settings';
import {
  addFolder,
  loadSync,
  patchSync,
  removeFolder,
  type SyncSettings,
} from './sync/config';
import { setEngineHandlers, startSync, stopSync, syncNow } from './sync/engine';
import { openSharePicker, registerPickerIpc, resolveSource } from './windows/sharePicker';
import {
  fitShareBar,
  getShareState,
  hideShareBar,
  isShareBarOpen,
  setShareState,
  showShareBar,
} from './windows/shareBar';
import {
  activateToast,
  destroyToasts,
  dismissToast,
  fitToasts,
  replyToast,
  resendToasts,
  setToastHandlers,
  showToast,
  type Toast,
} from './windows/toasts';
import { ShellWindow, type Bounds } from './windows/shell';
import { registerNativeAudioIpc, shutdownNativeAudio } from './nativeAudio/ipc';
import { RemoteHost, type RemotePrefs } from './remote/host';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const remoteInput = require('../../native/remote-input.js') as typeof import('../../native/remote-input');

/** 원격 데스크톱 호스트 — 서버에 remote-desktop 플러그인이 활성화된 경우에만 동작(src/main/remote/host.ts) */
const remoteHost = new RemoteHost(CONFIG.serverUrl, () => broker.getAccessToken(), remoteInput.load(), () => os.hostname());

/**
 * 두 번째 인스턴스의 기동을 금지한다.
 * 인스턴스가 둘이면 리프레시 브로커도 둘이 되어, 각각 토큰을 회전시키다가 서버의
 * 재사용 탐지에 해당하여 **양쪽 모두 로그아웃된다**(broker.ts 참고). 동기화 데몬이
 * 동일 폴더를 동시에 변경하는 문제는 그다음 순위이다.
 */
/**
 * 네이티브 오디오 자가점검 — 패키징된 앱이 애드온(asar 밖 .node)을 실제로 로드하는지 CI·설치 스모크가 확인한다.
 *   just-workspace.exe --native-audio-selfcheck --selfcheck-out <파일>
 * GUI 앱은 콘솔 stdout 이 없으므로 결과(JSON)를 파일에 기록한다. 창을 표시하지 않고 즉시 종료한다.
 */
if (process.argv.includes('--native-audio-selfcheck')) {
  const outIdx = process.argv.indexOf('--selfcheck-out');
  const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { nativeAudioSelfCheck } = require('./nativeAudio/selfcheck') as typeof import('./nativeAudio/selfcheck');
  const result = nativeAudioSelfCheck();
  if (outPath) require('node:fs').writeFileSync(outPath, JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result));
  app.exit(result.ok ? 0 : 3);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// 오른쪽 클릭 복사·붙여넣기(본문 웹뷰 포함 모든 창) — Electron 에는 기본 메뉴가 없다.
installContextMenu();

let loginWin: BrowserWindow | null = null;
let shellWin: ShellWindow | null = null;
/** 트레이 "종료" 로만 true 가 된다. 창의 X 는 숨김 동작일 뿐이다. */
let quitting = false;

/**
 * 트레이 메뉴가 읽는 셸 상태.
 * 동기화·회의는 아직 연동 전이므로 기본값이다 — 임의 값을 생성하지 않고 그대로 표시한다.
 */
const shellState = {
  userId: '',
  displayName: '',
  sync: 'idle' as TrayMenuState['sync'],
  meetingCount: 0,
  /** 알림 일시중지 만료 시각. 경과했으면 해제된 것으로 간주한다. */
  dndUntil: null as number | null,
};

function trayMenuState(): TrayMenuState {
  const dnd = shellState.dndUntil && shellState.dndUntil > Date.now()
    ? shellState.dndUntil
    : null;
  return {
    displayName: shellState.displayName,
    host: CONFIG.serverUrl.replace(/^https?:\/\//, ''),
    sync: shellState.sync,
    meetingCount: shellState.meetingCount,
    dndUntil: dnd,
  };
}

/** 알림 송신 가능 여부. 일시중지 중이면 송신하지 않는다. */
function notificationsAllowed(): boolean {
  return !(shellState.dndUntil && shellState.dndUntil > Date.now());
}

function focusExisting(): void {
  const win = shellWin?.win ?? loginWin;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

app.on('second-instance', focusExisting);

// ── 창 전환 ────────────────────────────────────────────

function showLogin(): void {
  if (loginWin && !loginWin.isDestroyed()) {
    focusExisting();
    return;
  }
  loginWin = createLoginWindow();
  loginWin.on('closed', () => {
    loginWin = null;
    // 로그인하지 않은 상태로 창을 닫으면 앱이 트레이에만 남아 수행할 작업이 없다.
    if (!shellWin) app.quit();
  });
}

async function showShell(): Promise<void> {
  if (shellWin) {
    focusExisting();
    return;
  }
  shellWin = new ShellWindow();
  void loadMe();

  // 회의 방은 좁은 본문이 아니라 전용 창에서 연다(windows/meeting.ts 주석 참고).
  shellWin.onEnterRoom = (room) => void openMeeting(room);

  shellWin.win.on('close', (e) => {
    // 메신저·동기화가 실행되는 앱이다. X 는 창만 닫으며 앱은 계속 실행된다.
    if (quitting) return;
    e.preventDefault();
    shellWin?.win.hide();
  });
  shellWin.win.on('closed', () => {
    shellWin = null;
  });

  // 렌더러가 준비되어야 본문 좌표를 수신할 수 있다. 그 전에 뷰를 부착하면 0×0 으로
  // 부착되었다가 첫 리포트에서 크기가 급변한다.
  await new Promise<void>((resolve) => {
    if (!shellWin) return resolve();
    shellWin.win.webContents.once('did-finish-load', () => resolve());
  });
  await shellWin.mount();

  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.close();
  }
}

/** 회의 방 창을 연다. 세션은 셸 본문과 동일한 방식으로 연결한다. */
async function openMeeting(room: string): Promise<void> {
  const url = await sessionUrl(`/meetings/room/${encodeURIComponent(room)}`);
  showMeeting(room, url);
}

/** 내 정보(이름·id) — 트레이 메뉴 이름·본인 메시지 필터링·토스트 멘션 표기에 사용한다. 셸 기동 시 1회 조회한다. */
async function loadMe(): Promise<void> {
  try {
    const token = await broker.getAccessToken();
    const res = await fetch(`${CONFIG.serverUrl}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const u = (await res.json()) as { sub: string; preferred_username?: string; name?: string };
    shellState.userId = u.sub;
    shellState.displayName = u.name ?? u.preferred_username ?? '';
    pushTrayMenu();
  } catch {
    /* 네트워크 단절 — 다음 셸 열기 시 재조회한다 */
  }
}

/** 마지막으로 조회한 대화 목록. 토스트에 채널 이름을 표기하는 데 사용한다. */
let lastConversations: Array<{ id: string; name: string; type: string; unread_count?: number }> = [];

/** 안 읽음 수를 재조회하여 트레이 뱃지를 갱신한다. 레일·목록은 웹이 렌더링한다(0.5.0). */
async function refreshUnread(): Promise<void> {
  try {
    const token = await broker.getAccessToken();
    const res = await fetch(`${CONFIG.serverUrl}/api/chat/channels`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    lastConversations = await res.json();
    setTrayUnread(
      lastConversations.reduce((a, c) => a + (c.unread_count ?? 0), 0),
      shellWin?.win,
    );
  } catch {
    /* 네트워크 단절일 뿐이다. 소켓이 재연결되면 다시 호출된다. */
  }
}

/** 알림 종류 → 토스트 머리글 영역 이름(서버 NOTIFICATION_TYPES). */
const NOTICE_AREA: Record<string, string> = {
  task_assigned: '작업',
  meeting_invite: '회의',
  calendar_invite: '캘린더',
  file_shared: '파일',
  new_mail: '메일',
  board_must_read: '게시판',
  system: '알림',
};

/** 토스트 인라인 답장 → 해당 채널에 메시지 송신. 채널은 deepLink(/chat?channel=…)에서 추출한다. */
async function sendReply(t: Toast, text: string): Promise<void> {
  const body = text.trim();
  const channelId = /[?&]channel=([^&#]+)/.exec(t.deepLink ?? '')?.[1];
  if (!body || !channelId) return;
  try {
    const token = await broker.getAccessToken();
    const res = await fetch(
      `${CONFIG.serverUrl}/api/chat/channels/${encodeURIComponent(decodeURIComponent(channelId))}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: body }),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    showToast({
      id: `r-${Date.now()}`,
      kind: 'sync',
      at: Date.now(),
      title: '답장을 보내지 못했습니다',
      body: `${t.channel || '대화'} — ${e instanceof Error ? e.message : String(e)}. 앱에서 다시 보내 주세요.`,
      deepLink: t.deepLink,
    });
  }
}

/** 설정에서 자동 시작이 활성화된 경우에만 동기화를 실행한다. */
async function startSyncIfEnabled(): Promise<void> {
  const s = await loadSync();
  if (!s.startWithOs || s.folders.length === 0) return;
  startSync(shellState.displayName || '나');
}

async function signOut(): Promise<void> {
  await broker.signOut();
  stopEvents();
  stopSync();
  closeMeeting();
  shellWin?.destroy();
  shellWin = null;
  setTrayUnread(0, null);
  showLogin();
}

// ── IPC ────────────────────────────────────────────────

function register(): void {
  // 하이레조(네이티브 오디오) — 임베드 웹뷰의 window.jwNativeAudio 가 호출한다
  registerNativeAudioIpc();
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    productName: app.getName(),
    serverUrl: CONFIG.serverUrl,
    deviceName: os.hostname(),
    platform: process.platform,
    secureStore: await isSecure(),
    // 사용자가 실제로 찾을 수 있는 이름으로 표기한다 — "OS 자격 증명 저장소" 는
    // 열어야 할 위치를 특정하지 못한다.
    credentialStore:
      process.platform === 'win32'
        ? 'Windows 자격 증명 관리자'
        : process.platform === 'darwin'
          ? '키체인'
          : '시스템 키링',
  }));

  ipcMain.handle('app:verify-server', () => verifyServer());

  ipcMain.handle('auth:sign-in', async (e, deviceName: string) => {
    try {
      await signIn({
        appVersion: app.getVersion(),
        deviceName,
        onAuthUrl: (url) => e.sender.send('auth:url', url),
      });
      await showShell();
      return { ok: true };
    } catch (err) {
      if (err instanceof CancelledError) {
        return { ok: false, cancelled: true, message: err.message };
      }
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('auth:cancel', () => {
    cancelSignIn();
  });

  ipcMain.handle('auth:sign-out', signOut);

  // ── 화면 공유 ──
  //
  // 셸(또는 임베드된 웹 앱)이 공유를 시작하면 피커를 표시하고, 선택된 소스 id 를
  // 반환한다. 실제 캡처는 해당 id 로 렌더러가 getUserMedia 를 호출하는 쪽에서 수행한다 —
  // 메인은 소스만 결정한다.
  ipcMain.handle('share:start', async (_e, context: string) => {
    const picked = await openSharePicker(shellWin?.win ?? null, context);
    if (!picked) return null;
    showShareBar();
    return picked;
  });

  ipcMain.on('share:ready', (e) => {
    e.sender.send('share:state', getShareState());
  });

  ipcMain.on('share:resize', (_e, size: { width: number; height: number }) =>
    fitShareBar(size),
  );

  ipcMain.on('share:stop', () => {
    hideShareBar();
    // 실제 트랙 정지는 미디어를 보유한 쪽(임베드 뷰)이 수행한다.
    shellWin?.win.webContents.send('share:stopped');
  });

  ipcMain.on('share:toggle', (_e, what: 'mic' | 'camera') => {
    const cur = getShareState();
    const next = setShareState({ [what]: !cur[what] });
    shellWin?.win.webContents.send('share:state', next);
  });

  ipcMain.on('shell:content-bounds', (_e, b: Bounds) => shellWin?.setBounds(b));
  ipcMain.on('shell:reload', () => shellWin?.reload());
  ipcMain.on('shell:history', (_e, dir: unknown) => {
    if (dir === 'back' || dir === 'forward') shellWin?.history(dir);
  });

  // ── 설정 · 동기화 ──
  // 원격 데스크톱(내 기기) — 설정 창의 "원격 접속" 영역. 플러그인이 없으면 available=false 로 영역을 숨긴다
  ipcMain.handle('remote:status', () => remoteHost.status());
  ipcMain.handle('remote:patch', (_e, p: Partial<RemotePrefs>) => remoteHost.setPrefs({
    ...(typeof p?.allowRemote === 'boolean' ? { allowRemote: p.allowRemote } : {}),
    ...(typeof p?.unattended === 'boolean' ? { unattended: p.unattended } : {}),
  }));
  ipcMain.handle('remote:rename', (_e, name: unknown) => remoteHost.rename(typeof name === 'string' ? name : ''));
  ipcMain.handle('remote:recent', () => remoteHost.recent(3));
  ipcMain.handle('remote:unregister', () => remoteHost.unregister());
  ipcMain.handle('sync:load', () => loadSync());
  ipcMain.handle('sync:patch', (_e, p: Partial<SyncSettings>) => patchSync(p));
  ipcMain.handle('sync:remove-folder', (_e, id: string) => removeFolder(id));
  /** 즉시 1회 실행한다. 설정 창의 상태 카드와 트레이 메뉴가 호출한다. */
  ipcMain.handle('sync:now', async () => {
    await syncNow(shellState.displayName || '나');
    return loadSync();
  });
  ipcMain.handle('sync:pick-folder', async (e) => {
    const owner = BrowserWindow.fromWebContents(e.sender);
    const s = await loadSync();
    const opts: Electron.OpenDialogOptions = {
      title: '동기화할 폴더 선택',
      defaultPath: s.root,
      properties: ['openDirectory', 'createDirectory'],
    };
    // 부모 창이 있으면 시트로 표시한다(해당 창에 부착되어 표시된다).
    const r = owner
      ? await dialog.showOpenDialog(owner, opts)
      : await dialog.showOpenDialog(opts);
    if (r.canceled || r.filePaths.length === 0) return null;
    return addFolder(r.filePaths[0]);
  });

  // ── 알림 토스트 ──
  //
  // 알림 표시 여부는 여기서 판정한다. 일시중지 중이면 생성하지 않는다 —
  // 생성 후 숨기면 뱃지·소리가 이미 출력된 뒤이다.
  ipcMain.on('notify:mention', (_e, t: Omit<Toast, 'id' | 'at' | 'kind'>) => {
    if (!notificationsAllowed()) return;
    showToast({
      ...t,
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'mention',
      at: Date.now(),
      canReply: true,
    });
  });

  ipcMain.on('toast:ready', () => resendToasts());
  ipcMain.on('toast:resize', (_e, size: { width: number; height: number }) =>
    fitToasts(size),
  );
  ipcMain.on('toast:dismiss', (_e, id: string) => dismissToast(id));
  ipcMain.on('toast:activate', (_e, id: string) => activateToast(id));
  ipcMain.on('toast:reply', (_e, p: { id: string; text: string }) =>
    replyToast(p.id, p.text),
  );

  // ── 트레이 메뉴 ──
  ipcMain.on('tray:ready', () => pushTrayMenu());
  ipcMain.on('tray:resize', (_e, size: { width: number; height: number }) =>
    fitTrayMenu(getTray(), size),
  );
  ipcMain.on('tray:dnd', (_e, minutes: number) => {
    shellState.dndUntil = minutes > 0 ? Date.now() + minutes * 60_000 : null;
    pushTrayMenu();
  });
  ipcMain.on('tray:action', (_e, action: string) => {
    // 어느 항목을 선택해도 메뉴는 닫힌다. OS 메뉴와 동일하게 동작해야 한다.
    hideTrayMenu();
    switch (action) {
      case 'open':
        if (shellWin) focusExisting();
        else if (broker.state === 'signed-in') void showShell();
        else showLogin();
        break;
      case 'sync':
        void syncNow(shellState.displayName || '나');
        showSettings(shellWin?.win ?? null);
        break;
      case 'settings':
        showSettings(shellWin?.win ?? null);
        break;
      case 'meet':
        shellWin?.navigate('/meetings');
        focusExisting();
        break;
      case 'quit':
        quitting = true;
        app.quit();
        break;
      case 'close':
      default:
        break;
    }
  });

  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
}

// ── 수명 주기 ──────────────────────────────────────────

app.whenReady().then(async () => {
  register();
  registerPickerIpc();

  // 로그인 상태가 자동 시작 여부를 결정한다. 로그아웃된 앱이 부팅 시 기동할 이유는 없다.
  broker.setStateListener((s) => setAutoStart(s === 'signed-in'));

  // 마이크·카메라·화면·알림 권한은 서버 출처에만 허용한다. 모든 창이 이 세션 하나를 사용한다
  // (permissions.ts 주석 참고 — 창마다 별도로 등록하면 서로 덮어쓴다).
  installPermissionHandlers(session.defaultSession);

  /*
   * 본문 웹의 사용자 메뉴 "로그아웃" = 본 앱의 로그아웃. 0.5.0 부터 계정 메뉴는 웹이 렌더링하므로, 웹 세션만 종료되고
   * 앱(OAuth 토큰)은 유지되는 불일치 상태가 되지 않도록 웹의 로그아웃 요청이 성공하면 앱도 로그아웃한다.
   * 회의 창 등 다른 창에서 발생한 요청은 무시한다(본문 웹뷰만 해당).
   */
  session.defaultSession.webRequest.onCompleted(
    { urls: [`${CONFIG.serverUrl}/api/auth/logout*`] },
    (d) => {
      if (d.method !== 'POST' || d.statusCode >= 400) return;
      if (!shellWin || d.webContentsId !== shellWin.viewId) return;
      void signOut();
    },
  );

  /*
   * 웹앱이 `getDisplayMedia()` 를 호출하면 브라우저 기본 피커 대신 자체 피커를 표시한다.
   *
   * 임베드 뷰에 프리로드 없이 화면 공유를 연결하는 유일한 경로이다 — 웹앱은
   * 표준 API 를 호출하고, 제공할 화면은 셸이 결정한다.
   */
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, callback) => {
      const owner = getMeetingWindow() ?? shellWin?.win ?? null;
      const picked = await openSharePicker(owner, '회의 참가자가 보게 됩니다');
      if (!picked) {
        // 빈 응답 = 사용자 취소. 웹앱은 NotAllowedError 를 수신한다.
        callback({});
        return;
      }
      const source = await resolveSource(picked.sourceId);
      if (!source) {
        callback({});
        return;
      }
      showShareBar();
      callback({
        video: source,
        // 'loopback' = 시스템 소리. Windows 에서만 유효하다.
        ...(picked.withAudio && process.platform === 'win32'
          ? { audio: 'loopback' as const }
          : {}),
      });
    },
    // useSystemPicker: false — 자체 피커를 사용한다.
    { useSystemPicker: false },
  );

  setTrayMenuStateSource(trayMenuState);
  createTray();

  /*
   * ── 이벤트 → 토스트 ──
   *
   * 규칙 판정은 여기서만 수행한다. 일시중지 중이거나 채널 규칙이 차단하면 **토스트를
   * 생성하지 않는다** — 생성 후 숨기면 소리와 뱃지는 이미 출력된 뒤이다.
   */
  setEventHandlers({
    onState: (connected) => {
      if (connected) void refreshUnread();
    },

    onMessage: (msg) => {
      // 본인이 보낸 메시지와 스레드 답글은 토스트 대상이 아니다.
      if (msg.sender_id === shellState.userId || msg.parent_id) return;
      void (async () => {
        // 안 읽음 수는 규칙과 무관하게 갱신한다. 알림을 비활성화해도 뱃지는 정확해야 한다.
        void refreshUnread();
        if (!notificationsAllowed()) return;
        if ((await ruleFor(msg.channel_id)) !== 'all') return;

        const conv = lastConversations.find((c) => c.id === msg.channel_id);
        showToast({
          id: `m-${msg.id}`,
          kind: 'mention',
          at: Date.now(),
          author: msg.sender_name || '알 수 없음',
          channel: conv ? (conv.type === 'dm' ? conv.name : `#${conv.name}`) : '',
          body: msg.content,
          canReply: true,
          deepLink: `/chat?channel=${encodeURIComponent(msg.channel_id)}`,
        });
      })();
    },

    onNotification: (n, quiet) => {
      void (async () => {
        void refreshUnread();
        // 서버 방해 금지(웹 사용자 메뉴의 "방해 금지"·알림 설정의 일정)와 트레이 일시중지를 모두 적용한다.
        if (quiet || !notificationsAllowed()) return;
        const link = n.link || '/';
        // 채팅 알림은 채널 규칙이 'off' 이면 차단한다 — 'mentions' 는 통과가 목적이다.
        const channelId = /[?&]channel=([^&#]+)/.exec(link)?.[1];
        if (channelId && (await ruleFor(decodeURIComponent(channelId))) === 'off') return;

        const id = `n-${n.id ?? Date.now()}`;
        if (n.type === 'mention' || n.type === 'thread_reply') {
          showToast({
            id,
            kind: 'mention',
            at: Date.now(),
            // actor_name 이 없으면 "홍길동님이 회원님을 멘션했습니다" → 이름만 추출한다.
            author: n.actor_name || n.title.replace(/님이.*$/, ''),
            channel: n.type === 'thread_reply' ? '스레드' : '',
            mention: `@${shellState.displayName}`,
            body: n.body ?? n.title,
            // 답장은 채널로 송신된다 — 채널을 알 수 없는 알림에는 답장 입력란을 두지 않는다.
            canReply: !!channelId && n.type === 'mention',
            deepLink: link,
          });
          return;
        }
        showToast({
          id,
          kind: 'notice',
          at: Date.now(),
          area: NOTICE_AREA[n.type] ?? '알림',
          author: n.actor_name ?? undefined,
          title: n.title,
          body: n.body ?? '',
          deepLink: link,
        });
      })();
    },
  });

  setEngineHandlers({
    onProgress: (p) => {
      // 설정 창이 열려 있으면 즉시 반영한다. 없으면 다음에 열 때 파일에서 읽는다.
      settingsWindow()?.webContents.send('sync:progress', p);
      shellState.sync = p.state === 'conflict' ? 'error' : p.state === 'syncing' ? 'syncing' : 'up_to_date';
      pushTrayMenu();
    },
    onConflict: (folderName, fileName, copyName) => {
      if (!notificationsAllowed()) return;
      showToast({
        id: `c-${Date.now()}`,
        kind: 'sync',
        at: Date.now(),
        title: `충돌 1건 · ${folderName}`,
        // 병합하지 않는다는 사실이 이 알림의 요점이다.
        body: `${fileName} — 양쪽 사본을 모두 남겨두었습니다 (내 사본: ${copyName})`,
      });
    },
  });

  setToastHandlers({
    onActivate: (t) => {
      if (t.deepLink) shellWin?.navigate(t.deepLink);
      if (shellWin) focusExisting();
      else void showShell();
    },
    // 답장은 메인이 직접 송신한다(토큰은 메인 밖으로 전달되지 않는다). 실패 시 토스트로 통지한다.
    onReply: (t, text) => void sendReply(t, text),
  });

  broker.setStateListener((s) => {
    if (s === 'signed-in') {
      startEvents();
      void startSyncIfEnabled();
      void remoteHost.start().catch((e) => console.warn('[remote] 시작 실패', e));
    } else {
      stopEvents();
      stopSync();
      void remoteHost.stop();
    }
  });

  const restored = await broker.restore();
  if (restored) {
    // 자동 시작으로 기동한 경우 창을 열지 않는다. 트레이에만 상주한다.
    if (!startedHidden()) await showShell();
  } else {
    showLogin();
  }
});

// 트레이에 상주하는 앱이므로 모든 창이 닫혀도 종료하지 않는다.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  void remoteHost.stop();
  void shutdownNativeAudio();
  quitting = true;
  stopEvents();
  stopSync();
  closeMeeting();
  destroySettings();
  destroyToasts();
  destroyTrayMenu();
  destroyTray();
  // 항상 위 창은 앱 종료 후에도 남을 수 있다. 명시적으로 닫는다.
  if (isShareBarOpen()) hideShareBar();
});

/**
 * TLS 인증서 오류는 **거부**한다 — Electron 기본값과 동일하나, 기본값에 의존하면
 * 빈 화면의 원인이 로그에 기록되지 않는다. 서버가 하나뿐이므로 "그래도 계속" 모달을
 * 표시할 이유도 없다: 사설 CA 를 사용하는 사내망이면 OS 신뢰 저장소에 등록하는 것이 올바른 방법이다.
 * callback(false) 호출은 "preventDefault 안 함 = 거부" 를 명시한 것이다.
 */
app.on('certificate-error', (_e, _wc, url, error, cert, callback) => {
  console.warn(
    '[tls] 인증서 오류 — 연결을 거부합니다:',
    error,
    url,
    `(issuer: ${cert.issuerName || '?'}, subject: ${cert.subjectName || '?'})`,
  );
  callback(false);
});

/**
 * 렌더러에서 새 창을 여는 시도는 전부 차단하고 시스템 브라우저로 전달한다.
 * 임베드된 웹 앱이 window.open 을 호출하는 경우가 있다.
 */
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) electronShell.openExternal(url);
    return { action: 'deny' };
  });
});
