/**
 * 토큰 브로커 — 갱신을 직렬화하는 단일 지점.
 *
 * ★ 이 파일이 존재하는 이유가 전부 여기 있다.
 *
 * 서버는 리프레시 토큰에 **강제 회전 + 재사용 탐지**를 건다. 한 번 쓴 토큰을
 * 다시 쓰면 "탈취된 것" 으로 보고 **토큰 패밀리 전체를 폐기**한다.
 *
 * 그런데 데스크톱 앱에는 토큰을 쓰는 주체가 최소 셋이다 —
 * 웹 뷰 · 회의 창 · 동기화 데몬. 액세스 토큰이 만료되는 순간 셋이 동시에 갱신을
 * 때리면, 첫 요청이 토큰을 회전시키고 나머지 둘은 **이미 회전된 토큰**을 들고
 * 들어간다. 서버는 이를 재사용으로 판정하고 전부 끊는다.
 *
 * 증상은 "가끔 아무 이유 없이 로그아웃" 이고, 타이밍에 달려 있어 재현이 안 된다.
 *
 * 해법: 갱신은 이 브로커만 한다. 진행 중인 갱신이 있으면 나중에 온 호출자는
 * **같은 프로미스를 공유**한다 — 요청을 큐에 쌓는 게 아니라 하나로 합친다.
 * 렌더러는 리프레시 토큰을 아예 보지 못하고 짧은 액세스 토큰만 IPC 로 받는다.
 */
import { clearRefreshToken, loadRefreshToken, saveRefreshToken } from './keychain';
import { CONFIG } from '../config';

export interface Tokens {
  accessToken: string;
  expiresAt: number; // epoch ms
  scope: string;
}

export type AuthState = 'signed-out' | 'signed-in';

/** 만료 직전에 미리 갱신한다. 경계에서 401 을 맞고 재시도하는 것보다 낫다. */
const REFRESH_SKEW_MS = 60_000;

class TokenBroker {
  private tokens: Tokens | null = null;
  /** 진행 중인 갱신. 동시 호출자는 이걸 공유한다 — 큐가 아니라 합류다. */
  private inFlight: Promise<Tokens> | null = null;
  private onStateChange: ((s: AuthState) => void) | null = null;

  setStateListener(fn: (s: AuthState) => void) {
    this.onStateChange = fn;
  }

  /** 로그인 직후 호출. 리프레시 토큰을 OS 저장소에 넣는다. */
  async adopt(accessToken: string, expiresIn: number, refreshToken: string, scope: string) {
    this.tokens = {
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
      scope,
    };
    await saveRefreshToken(refreshToken);
    this.onStateChange?.('signed-in');
  }

  /** 저장된 리프레시 토큰이 있으면 세션을 복원한다. */
  async restore(): Promise<boolean> {
    const rt = await loadRefreshToken();
    if (!rt) return false;
    try {
      await this.refresh();
      return true;
    } catch {
      // 토큰이 만료됐거나 서버가 폐기했다. 조용히 로그아웃 상태로 둔다.
      await this.signOut();
      return false;
    }
  }

  /**
   * 유효한 액세스 토큰을 돌려준다. 필요하면 갱신하되, 동시 호출은 하나로 합친다.
   */
  async getAccessToken(): Promise<string> {
    if (this.tokens && Date.now() < this.tokens.expiresAt - REFRESH_SKEW_MS) {
      return this.tokens.accessToken;
    }
    const t = await this.refresh();
    return t.accessToken;
  }

  private refresh(): Promise<Tokens> {
    // ★ 합류 지점. 이미 갱신 중이면 새 요청을 보내지 않고 같은 결과를 기다린다.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<Tokens> {
    const rt = await loadRefreshToken();
    if (!rt) throw new Error('로그인이 필요합니다');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: CONFIG.clientId,
    });

    const res = await fetch(`${CONFIG.serverUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // invalid_grant = 토큰이 폐기됐다(재사용 탐지, 기기 해지, 비밀번호 변경).
      // 재시도해도 소용없으므로 저장된 토큰을 버리고 재로그인을 유도한다.
      if (res.status === 400 || res.status === 401) {
        await this.signOut();
      }
      throw new Error(`토큰 갱신 실패 (${res.status}) ${detail.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      scope?: string;
    };

    // 서버가 회전시킨 새 토큰을 즉시 저장한다. 여기서 실패하면 다음 갱신 때
    // 옛 토큰을 보내 재사용 탐지에 걸리므로, 저장 실패는 로그아웃으로 처리한다.
    if (json.refresh_token) {
      try {
        await saveRefreshToken(json.refresh_token);
      } catch (e) {
        await this.signOut();
        throw e;
      }
    }

    this.tokens = {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
      scope: json.scope ?? '',
    };
    this.onStateChange?.('signed-in');
    return this.tokens;
  }

  async signOut(): Promise<void> {
    this.tokens = null;
    await clearRefreshToken();
    this.onStateChange?.('signed-out');
  }

  get state(): AuthState {
    return this.tokens ? 'signed-in' : 'signed-out';
  }
}

export const broker = new TokenBroker();
