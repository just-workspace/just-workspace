/**
 * 워크스페이스 이벤트 소스 — 셸이 직접 연결하는 채팅 WebSocket.
 *
 * 셸이 별도로 연결하는 이유.
 * 토스트를 표시하는 주체는 셸이다(창이 닫혀 있어도 알림은 수신되어야 한다). 이 소켓이 연결되어 있으면 서버는
 * 웹푸시를 송신하지 않으므로(app/notifications/service.py _deliver), 모든 종류의 알림을 여기서 표시해야 한다.
 *
 * 인증은 OAuth 액세스 토큰으로 수행한다. 액세스 토큰의 수명은 1시간이므로 만료 전에 재연결해야 하며,
 * 갱신은 브로커가 이미 수행하므로 여기서는 재연결 시 새 토큰을 받아 사용하기만 한다.
 */
// 하위 프로토콜 토큰 전달·핑을 사용하기 위해 표준 클라이언트(ws)를 사용한다.
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
  /** 임의 채널에 새 메시지 수신. 본인 메시지도 포함된다 — 필터링은 호출부가 수행한다. */
  onMessage(msg: ChatMessage): void;
  /** 멘션·작업·일정·메일 등 본인 대상 알림. quiet = 서버 방해 금지(지금 켜기·일정) 중 — 토스트를 표시하지 않는다. */
  onNotification(n: Notification, quiet: boolean): void;
  /** 연결 상태 변경. */
  onState(connected: boolean): void;
}

/** 재연결 대기. 서버 장애 시 초 단위 재시도로 부하를 주지 않기 위함이다. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** 서버는 핑을 수신하면 퐁을 응답한다. 끊긴 연결을 조기에 감지하는 유일한 수단이다. */
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
    // 로그인이 해제된 상태. 재연결이 무의미하다.
    handlers?.onState(false);
    return;
  }

  const base = CONFIG.serverUrl.replace(/^http/, 'ws');
  // 토큰은 쿼리 대신 하위 프로토콜로 전달한다(쿼리는 nginx error_log 에 평문으로 기록된다) — 백엔드 app/auth/ws_auth.
  const socket = new WebSocket(`${base}/ws/chat`, ['jw.bearer', `jw.token.${Buffer.from(token, 'utf8').toString('base64url')}`]);
  ws = socket;

  socket.on('open', () => {
    attempt = 0;
    handlers?.onState(true);
    pingTimer = setInterval(() => {
      try {
        socket.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* 이후 close 이벤트가 발생한다 */
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
    /* 이미 닫힌 상태 */
  }
}
