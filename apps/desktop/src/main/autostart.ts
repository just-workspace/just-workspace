/**
 * 자동 시작 — 로그인 시 트레이에만 뜬다.
 *
 * 부팅하자마자 창이 튀어나오면 거슬리므로 `--hidden` 을 붙여 트레이로만 올린다.
 * 개발 중에는 등록하지 않는다 — electron.exe 자체가 등록돼 버린다.
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

/** 이번 실행이 자동 시작(또는 두 번째 인스턴스)에서 온 숨김 실행인지. */
export function startedHidden(argv: string[] = process.argv): boolean {
  return argv.includes('--hidden');
}
