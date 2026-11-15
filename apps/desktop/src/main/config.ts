import fs from 'node:fs';
import path from 'node:path';

/** 빌드할 때 scripts/site.mjs 가 구운 사이트 설정(dist/site.json). */
interface Site {
  serverUrl?: string;
  appId?: string;
  productName?: string;
}

function readSite(): Site {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site.json'), 'utf8'));
  } catch {
    return {};
  }
}

const site = readSite();

/** 앱 상수. 서버 주소는 빌드 때 정해진다(JW_SERVER_URL). 실행 시 같은 변수로 덮을 수 있다(개발용). */
export const CONFIG = {
  serverUrl: (process.env.JW_SERVER_URL ?? site.serverUrl ?? 'http://localhost').replace(/\/+$/, ''),
  /** 백엔드 기본 내장 클라이언트(oauth_provider.BUILTIN_CLIENTS). */
  clientId: 'desktop-app',
  scopes: 'openid profile email',
  /** 로그인 대기 상한. 브라우저를 열어두고 자리를 비우는 경우가 있다. */
  loginTimeoutMs: 5 * 60_000,
  protocol: 'jw',
} as const;

/**
 * 이 URL 이 우리 워크스페이스 출처(scheme+host+port)인가.
 * `startsWith(serverUrl)` 로 비교하면 `https://ws.example.com.evil.tld/` 같은 주소도 통과한다.
 */
export function isServerUrl(url: string): boolean {
  try {
    return new URL(url).origin === new URL(CONFIG.serverUrl).origin;
  } catch {
    return false;
  }
}
