/**
 * 임베드 뷰에 웹 세션을 붙이는 다리.
 *
 * 웹앱은 세션 쿠키로 돌아가는데 데스크톱은 OAuth 로 로그인한다. 그래서 뷰를 그냥
 * 열면 웹 로그인 화면이 나온다. 백엔드의 일회용 링크 토큰
 * (`POST /api/auth/link-token` → `GET /api/auth/link-login`)으로 잇는다 —
 * 30초 만료, 1회용이라 유출돼도 재사용되지 않는다.
 *
 * 셸 본문과 회의 창이 같은 방식으로 열려야 해서 여기로 뺐다.
 */
import { CONFIG } from './config';
import { broker } from './auth/broker';

/**
 * 세션을 심으면서 `appPath` 로 가는 주소를 만든다.
 * 실패하면 그냥 앱 주소를 돌려준다 — 웹 로그인 화면이 뜨더라도 흰 화면보다 낫다.
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
