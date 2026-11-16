/**
 * 로그인 흐름 구성 (RFC 8252).
 *
 *   시스템 브라우저 → 루프백 콜백 → 코드 교환 → 키체인 → 기기 등록
 *
 * 앱 내부 웹뷰에 로그인 폼을 표시하지 않는 이유는 loopback.ts 주석 참고.
 */
import { shell } from 'electron';
import { CONFIG } from '../config';
import { broker } from './broker';
import { CancelledError, startLoopback, type Listener } from './loopback';
import { createPkce, createState } from './pkce';

export { CancelledError };

export interface SignInOptions {
  appVersion: string;
  /** 사용자가 로그인 화면에서 입력한 기기 이름. */
  deviceName: string;
  /** 인가 URL — 브라우저가 열리지 않은 경우 사용자가 직접 열 수 있도록 화면에 표시한다. */
  onAuthUrl?: (url: string) => void;
}

/**
 * 진행 중인 로그인. 취소 버튼은 이 객체를 통해 대기를 중단한다.
 * 로그인 창은 하나뿐이므로 동시에 둘이 열리는 경우는 없다.
 */
let active: Listener | null = null;

export function cancelSignIn(): void {
  active?.cancel();
}

export async function signIn(opts: SignInOptions): Promise<void> {
  const pkce = createPkce();
  const state = createState();
  const listener = await startLoopback();
  active = listener;

  try {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CONFIG.clientId,
      redirect_uri: listener.redirectUri,
      scope: CONFIG.scopes,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
    });
    const authUrl = `${CONFIG.serverUrl}/oauth/authorize?${params}`;
    opts.onAuthUrl?.(authUrl);
    await shell.openExternal(authUrl);

    const cb = await listener.wait(CONFIG.loginTimeoutMs);

    if (cb.error) {
      throw new Error(cb.errorDescription || cb.error);
    }
    // CSRF 방어 — 본 앱이 시작하지 않은 콜백은 수용하지 않는다.
    if (cb.state !== state) {
      throw new Error('state 불일치 — 로그인 요청이 변조되었을 수 있습니다');
    }
    // RFC 9207 — 서버가 iss 를 포함하여 응답한다. 복수의 IdP 를 사용할 때 응답의
    // 출처를 확인하는 값이다. 워크스페이스 서버가 전송하므로 대조한다.
    if (cb.iss && cb.iss !== CONFIG.serverUrl) {
      throw new Error('발급자가 예상과 다릅니다');
    }
    if (!cb.code) {
      throw new Error('인가 코드를 받지 못했습니다');
    }

    const res = await fetch(`${CONFIG.serverUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: cb.code,
        redirect_uri: listener.redirectUri,
        client_id: CONFIG.clientId,
        code_verifier: pkce.verifier,
      }),
    });
    if (!res.ok) {
      throw new Error(`토큰 교환 실패 (${res.status})`);
    }
    const tok = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      scope?: string;
    };
    if (!tok.refresh_token) {
      // openid 스코프만으로는 서버가 리프레시 토큰을 발급하지 않는다. 이 경우 액세스 토큰
      // 만료(1시간) 후 매번 재로그인이 필요하므로 설정 문제로 판정한다.
      throw new Error('리프레시 토큰이 발급되지 않았습니다 — 스코프 설정을 확인하세요');
    }
    await broker.adopt(tok.access_token, tok.expires_in, tok.refresh_token, tok.scope ?? '');
    await registerDevice(opts.appVersion, opts.deviceName);
  } finally {
    active = null;
    listener.close();
  }
}

/** 기기 등록 — 실패해도 로그인은 유효하다. 목록에 표시되지 않을 뿐이다. */
async function registerDevice(appVersion: string, deviceName: string): Promise<void> {
  try {
    const token = await broker.getAccessToken();
    const res = await fetch(`${CONFIG.serverUrl}/api/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: deviceName,
        platform: process.platform,
        app_version: appVersion,
      }),
    });
    if (!res.ok) {
      console.warn('[auth] 기기 등록 실패:', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.warn('[auth] 기기 등록 실패:', e);
  }
}

/** 서버 확인 결과. 로그인 화면 배지와 설정 "정보" 가 동일한 값을 참조한다. */
export interface ServerCheck {
  /** OIDC 발급자가 워크스페이스 서버 주소와 일치하는지 여부 — "확인됨" 배지. */
  verified: boolean;
  /** 서버 버전(`/api/platform/capabilities`). 해당 엔드포인트가 없는 구버전 서버이면 null. */
  version: string | null;
  /** 서버가 활성화한 기능 플래그(`realtime.multi_connection` 등). 없으면 빈 배열. */
  features: string[];
}

/**
 * 서버가 동작 중이며 알려진 발급자인지 확인한다 — 로그인 화면의 "확인됨" 배지.
 * 실패해도 로그인을 차단하지 않는다. 사내망/외부망 전환 중일 수 있다.
 */
export async function verifyServer(): Promise<ServerCheck> {
  const [verified, caps] = await Promise.all([verifyIssuer(), fetchCapabilities()]);
  return { verified, version: caps?.version ?? null, features: caps?.features ?? [] };
}

async function verifyIssuer(): Promise<boolean> {
  try {
    const res = await fetch(`${CONFIG.serverUrl}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const doc = (await res.json()) as { issuer?: string };
    return doc.issuer === CONFIG.serverUrl;
  } catch {
    return false;
  }
}

/**
 * 서버 버전·기능 플래그. 인증 없이 조회하는 공개 정보이다.
 *
 * 데스크톱은 사이트별로 별도 빌드·배포되므로 서버와 클라이언트 버전 불일치가
 * 빈번하다. 양측 버전을 로그와 설정 창에 기록해 두면 동작 불량 원인의 절반가량을
 * 여기서 식별할 수 있다. 엔드포인트가 없는 서버는 404 → null 로 처리한다.
 */
async function fetchCapabilities(): Promise<{ version: string; features: string[] } | null> {
  try {
    const res = await fetch(`${CONFIG.serverUrl}/api/platform/capabilities`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      if (res.status !== 404) console.warn('[server] capabilities 조회 실패:', res.status);
      return null;
    }
    const doc = (await res.json()) as { version?: unknown; features?: unknown };
    if (typeof doc.version !== 'string') return null;
    const features = Array.isArray(doc.features)
      ? doc.features.filter((f): f is string => typeof f === 'string')
      : [];
    console.log(`[server] ${CONFIG.serverUrl} v${doc.version} features=${features.join(',') || '-'}`);
    return { version: doc.version, features };
  } catch (e) {
    console.warn('[server] capabilities 조회 실패:', e instanceof Error ? e.message : e);
    return null;
  }
}

export { broker };
