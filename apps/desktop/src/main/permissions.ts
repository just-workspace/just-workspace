/**
 * 세션 권한 핸들러 — 워크스페이스 출처에만, 필요한 권한만 허용.
 *
 * 모든 창(셸 본문·회의·로그인)이 `session.defaultSession` 하나를 사용한다. 핸들러를
 * 세션에 두 번 등록하면 나중 것이 앞의 것을 전부 대체하므로, 여기서 한 번만 등록하고 창마다
 * 별도로 등록하지 않는다(회의 창이 자체 핸들러를 등록하면 셸의 알림 권한이 소실되던 원인).
 *
 * 핸들러가 없으면 Electron 은 **요청을 전부 허용**한다. 임베드 뷰에 표시되는 것은 워크스페이스
 * 서버뿐이나, 서버가 외부 iframe 을 포함하거나 will-navigate 가 누락한 이동이 있으면
 * 해당 페이지가 마이크·카메라·화면 권한을 그대로 획득한다. 출처가 서버 origin 이어야 한다는
 * 조건 하나로 이 취약 경로가 차단된다.
 *
 * 구조는 mattermost/desktop `main/security/permissionsManager.ts`(Apache-2.0)를
 * 참고했다 — 다만 서버가 하나이므로 origin 별 저장·프롬프트 없이 허용/거부만 수행한다.
 */
import type { Session } from 'electron';
import { isServerUrl } from './config';

/**
 * 서버 페이지에 허용하는 권한. 이 목록 외(geolocation, midi, pointerLock, hid, usb,
 * serial, idle-detection, …)는 사용하는 기능이 없으므로 프롬프트 없이 거부한다.
 *
 *   media                     회의 마이크·카메라(getUserMedia)
 *   display-capture           화면 공유(getDisplayMedia → 자체 피커가 처리)
 *   notifications             웹앱 알림 — 토스트는 셸이 렌더링하나 권한은 페이지가 요청한다
 *   clipboard-sanitized-write 복사 버튼(navigator.clipboard.writeText)
 *   fullscreen                회의 화면 전체화면
 *   speaker-selection         출력 장치 선택(setSinkId)
 */
const ALLOWED = new Set<string>([
  'media',
  'display-capture',
  'notifications',
  'clipboard-sanitized-write',
  'fullscreen',
  'speaker-selection',
]);

/** 요청 출처가 워크스페이스 서버인지 여부. 출처 정보가 없는 요청은 신뢰하지 않는다. */
function fromServer(url: string | undefined | null): boolean {
  return !!url && isServerUrl(url);
}

export function installPermissionHandlers(ses: Session): void {
  // 사용자 제스처로 발생하는 "요청"(마이크 켜기 등). requestingUrl 은 실제 요청 프레임의
  // 주소이므로 iframe 내부에서 온 요청도 해당 iframe 출처로 판정된다.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl || wc?.getURL();
    const ok = fromServer(origin) && ALLOWED.has(permission);
    if (!ok) {
      console.warn('[permissions] 거부:', permission, origin ?? '(출처 없음)');
    }
    callback(ok);
  });

  // 프롬프트 없이 조회되는 "검사"(navigator.permissions.query, 클립보드 읽기 등).
  // 요청 핸들러와 결과가 상이하면 웹앱이 '허용' 으로 판단하고 호출했다가 실패한다 — 동일 기준 적용.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const origin = requestingOrigin || details.requestingUrl;
    return fromServer(origin) && ALLOWED.has(permission);
  });
}
