/**
 * 워크스페이스 이벤트 소스 — 셸이 직접 붙는 채팅 WebSocket.
 *
 * ★ 왜 셸이 따로 붙는가.
 * 토스트를 띄우는 주체는 셸이다(창이 닫혀 있어도 알림은 와야 한다). 이 소켓이 붙어 있으면 서버는
 * 웹푸시를 보내지 않으므로(app/notifications/service.py _deliver), 모든 종류의 알림을 여기서 띄워야 한다.
 *
 * 인증은 OAuth 액세스 토큰이다. 액세스 토큰은 1시간짜리라 만료 전에 다시 붙어야 하고,
 * 그 갱신은 브로커가 이미 하고 있으므로 여기서는 재연결 때 새 토큰을 받아 쓰기만 한다.
 */
// 하위 프로토콜 토큰 전달·핑을 쓰려고 표준 클라이언트(ws)를 쓴다.
import WebSocket from 'ws';
import { CONFIG } from './config';
import { broker } from './auth/broker';

export interface ChatMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_name?: string;
  content: string;
  message_type?: string;
  parent_id?: string | null;
}

export interface Notification {
  id?: string;
  /** mention · thread_reply · task_assigned · meeting_invite · calendar_invite · file_shared · new_mail · board_must_read · system */
  type: string;
  title: string;
  body: string | null;
  link?: string | null;
  actor_name?: string | null;
}

export interface EventHandlers {
  /** 어느 채널에든 새 메시지가 왔다. 내 것도 포함된다 — 거르는 건 호출부. */
  onMessage(msg: ChatMessage): void;
  /** 멘션·작업·일정·메일 등 나를 향한 알림. quiet = 서버 방해 금지(지금 켜기·일정) 중 — 토스트는 띄우지 않는다. */
  onNotification(n: Notification, quiet: boolean): void;
  /** 연결 상태가 바뀌었다. */
  onState(connected: boolean): void;
}

/** 재연결 대기. 서버가 죽었을 때 초당 재시도로 두들기지 않는다. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** 서버는 핑을 받으면 퐁을 준다. 죽은 연결을 빨리 알아채는 유일한 방법이다. */
const PING_MS = 25_000;

let ws: WebSocket | null = null;
let handlers: EventHandlers | null = null;
let attempt = 0;
let stopped = true;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;

export function setEventHandlers(h: EventHandlers): void {
  handlers = h;
}

function clearTimers(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pingTimer) clearInterval(pingTimer);
  reconnectTimer = null;
  pingTimer = null;
}

function scheduleReconnect(): void {
  if (stopped) return;
  const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  attempt += 1;
  reconnectTimer = setTimeout(() => void connect(), wait);
}

async function connect(): Promise<void> {
  if (stopped) return;

  let token: string;
  try {
    token = await broker.getAccessToken();
  } catch {
    // 로그인이 끊겼다. 재연결해봐야 소용없다.
    handlers?.onState(false);
    return;
  }

  const base = CONFIG.serverUrl.replace(/^http/, 'ws');
  // 토큰은 쿼리 대신 하위 프로토콜로(쿼리는 nginx error_log 에 평문으로 남는다) — 백엔드 app/auth/ws_auth.
  const socket = new WebSocket(`${base}/ws/chat`, ['jw.bearer', `jw.token.${Buffer.from(token, 'utf8').toString('base64url')}`]);
  ws = socket;

  socket.on('open', () => {
    attempt = 0;
    handlers?.onState(true);
    pingTimer = setInterval(() => {
      try {
        socket.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* 곧 close 가 온다 */
      }
    }, PING_MS);
  });

  socket.on('message', (raw) => {
    let data: { type?: string; message?: ChatMessage; notification?: Notification; quiet?: boolean };
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (data.type === 'new_message' && data.message) {
      handlers?.onMessage(data.message);
    } else if (data.type === 'notification' && data.notification) {
      handlers?.onNotification(data.notification, data.quiet === true);
    }
  });

  const down = () => {
    clearTimers();
    if (ws === socket) ws = null;
    handlers?.onState(false);
    scheduleReconnect();
  };
  socket.on('close', down);
  socket.on('error', down);
}

export function startEvents(): void {
  if (!stopped) return;
  stopped = false;
  attempt = 0;
  void connect();
}

export function stopEvents(): void {
  stopped = true;
  clearTimers();
  const socket = ws;
  ws = null;
  try {
    socket?.close();
  } catch {
    /* 이미 닫혔다 */
  }
}
