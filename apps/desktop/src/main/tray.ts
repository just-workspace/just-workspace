/**
 * 트레이 — 창을 닫아도 앱은 계속 실행된다.
 *
 * 메신저·동기화가 동작하는 앱이므로 창 닫기와 앱 종료는 서로 다른 동작이다.
 * X 는 창만 숨기며, 앱을 실제로 종료하는 경로는 트레이 메뉴 하나로 한정한다 — 경로가
 * 둘이면 사용자가 어느 쪽이 실제 종료인지 구분할 수 없다.
 *
 * 메뉴는 OS 기본 메뉴가 아니라 본 앱이 직접 그리는 창이다(windows/trayMenu.ts 주석 참고).
 */
import { BrowserWindow, app, nativeImage, Tray } from 'electron';
import path from 'node:path';
import { showTrayMenu, push as pushTrayMenu } from './windows/trayMenu';

let tray: Tray | null = null;

export function createTray(): Tray {
  if (tray) return tray;

  // macOS 메뉴 막대는 색 아이콘을 사용하지 않는다. 알파만 있는 템플릿 이미지를 전달하면
  // OS 가 밝은/어두운 막대에 맞춰 채색한다. 색 아이콘을 그대로 전달하면 다크 메뉴
  // 막대에서 청록 사각형이 그대로 노출된다.
  const icon =
    process.platform === 'darwin'
      ? nativeImage.createFromPath(path.join(__dirname, '../../assets/trayTemplate.png'))
      : nativeImage
          .createFromPath(path.join(__dirname, '../../assets/tray.png'))
          // Windows 트레이는 16px 슬롯이다. 32px 원본을 그대로 전달하면 잘린다.
          .resize({ width: 16, height: 16 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('just-workspace');

  // 좌·우 클릭 모두 동일한 메뉴를 연다. 우클릭에만 메뉴를 두면 사용자가 발견하기 어렵다.
  tray.on('click', () => showTrayMenu(tray!));
  tray.on('right-click', () => showTrayMenu(tray!));

  return tray;
}

export function getTray(): Tray | null {
  return tray;
}

/**
 * 안 읽은 개수를 툴팁과 작업 표시줄 오버레이에 반영한다.
 *
 * Windows 는 `setBadgeCount` 를 지원하지 않는다(리눅스·macOS 전용). 대신
 * 작업 표시줄 아이콘 위에 겹칠 **이미지**를 전달한다. 16px 안에서 두 자리 숫자는 판독이
 * 불가하므로 10 이상은 숫자 대신 점 하나로 표시한다(assets/badge-more.png).
 */
export function setTrayUnread(n: number, win?: BrowserWindow | null): void {
  if (!tray) return;
  tray.setToolTip(n > 0 ? `just-workspace — 안 읽음 ${n}` : 'just-workspace');

  if (process.platform === 'win32') {
    const target = win && !win.isDestroyed() ? win : null;
    if (target) {
      if (n <= 0) {
        target.setOverlayIcon(null, '');
      } else {
        const file = n <= 9 ? `badge-${n}.png` : 'badge-more.png';
        const img = nativeImage.createFromPath(
          path.join(__dirname, '../../assets', file),
        );
        target.setOverlayIcon(img, `안 읽음 ${n}`);
      }
    }
  } else {
    app.setBadgeCount?.(n);
  }

  pushTrayMenu();
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
