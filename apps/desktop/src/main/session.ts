/**
 * 임베드 뷰에 웹 세션을 연결하는 브리지.
 *
 * 웹앱은 세션 쿠키로 동작하나 데스크톱은 OAuth 로 로그인한다. 따라서 뷰를 그대로
 * 열면 웹 로그인 화면이 표시된다. 백엔드의 일회용 링크 토큰
 * (`POST /api/auth/link-token` → `GET /api/auth/link-login`)으로 연결한다 —
 * 30초 만료, 1회용이므로 유출되어도 재사용되지 않는다.
 *
 * 셸 본문과 회의 창이 동일한 방식으로 열려야 하므로 본 모듈로 분리했다.
 */
import { CONFIG } from './config';
import { broker } from './auth/broker';

/**
 * 세션을 설정하면서 `appPath` 로 이동하는 주소를 생성한다.
 * 실패하면 앱 주소를 그대로 반환한다 — 웹 로그인 화면이 표시되더라도 빈 화면보다 낫다.
 */
export async function sessionUrl(appPath: string): Promise<string> {
  try {
    const token = await broker.getAccessToken();
    const res = await fetch(`${CONFIG.serverUrl}/api/auth/link-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`link-token ${res.status}`);
    const { token: link } = (await res.json()) as { token: string };
    const q = new URLSearchParams({ token: link, redirect: appPath });
    return `${CONFIG.serverUrl}/api/auth/link-login?${q}`;
  } catch (e) {
    console.warn('[session] 링크 로그인 실패, 일반 주소로 엽니다:', e);
    return `${CONFIG.serverUrl}${appPath}`;
  }
}
