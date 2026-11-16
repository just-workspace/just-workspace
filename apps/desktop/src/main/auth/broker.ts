/**
 * 토큰 브로커 — 갱신을 직렬화하는 단일 지점.
 *
 * 본 파일의 존재 이유는 다음과 같다.
 *
 * 서버는 리프레시 토큰에 **강제 회전 + 재사용 탐지**를 적용한다. 사용된 토큰을
 * 재사용하면 "탈취된 것" 으로 판정하여 **토큰 패밀리 전체를 폐기**한다.
 *
 * 데스크톱 앱에는 토큰을 사용하는 주체가 최소 셋이다 —
 * 웹 뷰 · 회의 창 · 동기화 데몬. 액세스 토큰 만료 시점에 셋이 동시에 갱신을
 * 요청하면, 첫 요청이 토큰을 회전시키고 나머지 둘은 **이미 회전된 토큰**으로
 * 요청하게 된다. 서버는 이를 재사용으로 판정하여 전부 차단한다.
 *
 * 증상은 "가끔 아무 이유 없이 로그아웃" 이며, 타이밍에 의존하므로 재현되지 않는다.
 *
 * 해법: 갱신은 이 브로커만 수행한다. 진행 중인 갱신이 있으면 이후 호출자는
 * **동일한 프로미스를 공유**한다 — 요청을 큐에 적재하지 않고 하나로 병합한다.
 * 렌더러는 리프레시 토큰에 접근할 수 없으며 수명이 짧은 액세스 토큰만 IPC 로 수신한다.
 */
import { clearRefreshToken, loadRefreshToken, saveRefreshToken } from './keychain';
import { CONFIG } from '../config';

export interface Tokens {
  accessToken: string;
  expiresAt: number; // epoch ms
  scope: string;
}

export type AuthState = 'signed-out' | 'signed-in';

/** 만료 직전에 사전 갱신한다. 경계에서 401 수신 후 재시도하는 방식보다 유리하다. */
const REFRESH_SKEW_MS = 60_000;

class TokenBroker {
  private tokens: Tokens | null = null;
  /** 진행 중인 갱신. 동시 호출자는 이를 공유한다 — 큐가 아닌 병합 방식. */
  private inFlight: Promise<Tokens> | null = null;
  private onStateChange: ((s: AuthState) => void) | null = null;

  setStateListener(fn: (s: AuthState) => void) {
    this.onStateChange = fn;
  }

  /** 로그인 직후 호출. 리프레시 토큰을 OS 저장소에 저장한다. */
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
      // 토큰이 만료되었거나 서버가 폐기한 상태. 별도 통지 없이 로그아웃 상태로 전환한다.
      await this.signOut();
      return false;
    }
  }

  /**
   * 유효한 액세스 토큰을 반환한다. 필요 시 갱신하되, 동시 호출은 하나로 병합한다.
   */
  async getAccessToken(): Promise<string> {
    if (this.tokens && Date.now() < this.tokens.expiresAt - REFRESH_SKEW_MS) {
      return this.tokens.accessToken;
    }
    const t = await this.refresh();
    return t.accessToken;
  }

  private refresh(): Promise<Tokens> {
    // 병합 지점. 갱신이 진행 중이면 새 요청을 보내지 않고 동일한 결과를 대기한다.
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
      // invalid_grant = 토큰 폐기(재사용 탐지, 기기 해지, 비밀번호 변경).
      // 재시도가 무의미하므로 저장된 토큰을 삭제하고 재로그인을 유도한다.
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

    // 서버가 회전시킨 새 토큰을 즉시 저장한다. 저장에 실패하면 다음 갱신 시
    // 이전 토큰을 송신하여 재사용 탐지에 해당하므로, 저장 실패는 로그아웃으로 처리한다.
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
