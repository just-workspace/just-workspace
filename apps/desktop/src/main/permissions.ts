/**
 * 세션 권한 핸들러 — 우리 워크스페이스 출처에만, 필요한 권한만.
 *
 * ★ 모든 창(셸 본문·회의·로그인)이 `session.defaultSession` 하나를 쓴다. 핸들러를
 * 세션에 두 번 걸면 나중 것이 앞 것을 통째로 덮으므로, 여기서 한 번만 걸고 창마다
 * 따로 걸지 않는다(회의 창이 자기만의 핸들러를 걸면 셸의 알림 권한이 사라졌던 이유).
 *
 * 핸들러가 없으면 Electron 은 **요청을 전부 허용**한다. 임베드 뷰에 뜨는 건 우리
 * 서버뿐이지만, 서버가 외부 iframe 을 품거나 will-navigate 가 놓친 이동이 있으면
 * 그 페이지가 마이크·카메라·화면을 그대로 얻는다. 출처가 서버 origin 이어야 한다는
 * 조건 하나로 그 구멍이 닫힌다.
 *
 * 구조는 mattermost/desktop `main/security/permissionsManager.ts`(Apache-2.0)를
 * 참고했다 — 다만 서버가 하나라 origin 별 저장·프롬프트 없이 허용/거부만 한다.
 */
import type { Session } from 'electron';
import { isServerUrl } from './config';

/**
 * 서버 페이지에 내주는 권한. 이 목록 밖(geolocation, midi, pointerLock, hid, usb,
 * serial, idle-detection, …)은 쓰는 기능이 없으므로 묻지도 않고 거부한다.
 *
 *   media                     회의 마이크·카메라(getUserMedia)
 *   display-capture           화면 공유(getDisplayMedia → 우리 피커가 처리)
 *   notifications             웹앱 알림 — 토스트는 셸이 그리지만 권한은 페이지가 묻는다
 *   clipboard-sanitized-write 복사 버튼(navigator.clipboard.writeText)
 *   fullscreen                회의 화면 전체화면
 *   speaker-selection         출력 장치 고르기(setSinkId)
 */
const ALLOWED = new Set<string>([
  'media',
  'display-capture',
  'notifications',
  'clipboard-sanitized-write',
  'fullscreen',
  'speaker-selection',
]);

/** 요청 출처가 우리 서버인지. 출처 정보가 없는 요청은 믿지 않는다. */
function fromServer(url: string | undefined | null): boolean {
  return !!url && isServerUrl(url);
}

export function installPermissionHandlers(ses: Session): void {
  // 사용자 제스처로 뜨는 "요청"(마이크 켜기 등). requestingUrl 은 실제 요청 프레임의
  // 주소라 iframe 안에서 온 요청도 그 iframe 출처로 판정된다.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl || wc?.getURL();
    const ok = fromServer(origin) && ALLOWED.has(permission);
    if (!ok) {
      console.warn('[permissions] 거부:', permission, origin ?? '(출처 없음)');
    }
    callback(ok);
  });

  // 프롬프트 없이 조회되는 "검사"(navigator.permissions.query, 클립보드 읽기 등).
  // 요청 핸들러와 답이 다르면 웹앱이 '허용' 인 줄 알고 불렀다가 실패한다 — 같은 기준.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const origin = requestingOrigin || details.requestingUrl;
    return fromServer(origin) && ALLOWED.has(permission);
  });
}
