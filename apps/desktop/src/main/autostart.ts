/**
 * 자동 시작 — 로그인 시 트레이에만 상주한다.
 *
 * 부팅 직후 창이 표시되면 사용에 방해가 되므로 `--hidden` 을 지정하여 트레이로만 기동한다.
 * 개발 중에는 등록하지 않는다 — electron.exe 자체가 등록되기 때문이다.
 */
import { app } from 'electron';

export function isAutoStartEnabled(): boolean {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}

export function setAutoStart(enabled: boolean): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: ['--hidden'],
  });
}

/** 이번 실행이 자동 시작(또는 두 번째 인스턴스)에 의한 숨김 실행인지 여부. */
export function startedHidden(argv: string[] = process.argv): boolean {
  return argv.includes('--hidden');
}
