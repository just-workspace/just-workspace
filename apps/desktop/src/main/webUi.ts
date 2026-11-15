/**
 * 본문 웹 UI 고르기 — Vue(frontend) / React(frontend-react).
 *
 * 앱은 서버의 웹을 그대로 얹는다(windows/shell.ts). 서버 nginx 는 쿠키 `jw_ui` 로 어느 UI 를
 * 내줄지 정한다(nginx.conf `/__ui/react`·`/__ui/vue`, `location /` 의 `$cookie_jw_ui`). 그래서
 * 첫 로드 전에 그 쿠키를 앱 세션에 심어 두면 셸 본문·회의 창 모두 같은 UI 를 받는다
 * (모든 창이 defaultSession 하나를 쓴다 — permissions.ts 참고).
 *
 * 값은 둘 다 **명시적으로** 심는다(vue 도 지우지 않고 `jw_ui=vue`). 지금 nginx 는 react 가 아니면
 * 전부 Vue 라 결과가 같고, 서버 기본값이 React 로 바뀌어도 vue 로 고른 앱은 Vue 에 남는다.
 * 속성은 nginx 가 심는 것과 같다(Path=/, SameSite=Lax, 1년, HttpOnly 아님).
 */
import type { Session } from 'electron';
import { CONFIG } from './config';

export const WEB_UI_COOKIE = 'jw_ui';
const ONE_YEAR_S = 365 * 24 * 60 * 60;

export async function applyWebUi(sess: Session, web: 'vue' | 'react' = CONFIG.web): Promise<void> {
  try {
    await sess.cookies.set({
      url: `${CONFIG.serverUrl}/`,
      name: WEB_UI_COOKIE,
      value: web,
      path: '/',
      sameSite: 'lax',
      secure: CONFIG.serverUrl.startsWith('https://'),
      expirationDate: Math.floor(Date.now() / 1000) + ONE_YEAR_S,
    });
  } catch (e) {
    // 실패해도 앱은 뜬다 — 서버 기본 UI 가 나올 뿐이다.
    console.warn('[webUi] UI 쿠키를 못 심었다:', e);
  }
}
