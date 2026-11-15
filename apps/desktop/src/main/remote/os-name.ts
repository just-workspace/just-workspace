import os from 'node:os';

/** 사람이 읽는 OS 이름(설정 기기 목록 "Windows 11 · 온라인") — Windows 는 빌드 22000 부터 11, 서버판은 os.version() 이름으로 */
export function osName(platform: NodeJS.Platform = process.platform, release: string = os.release(), version: string = os.version()): string {
  if (platform === 'win32') {
    const build = Number(release.split('.')[2] ?? 0);
    const server = /server\s*(\d{4})?/i.exec(version);
    if (server) return server[1] ? `Windows Server ${server[1]}` : 'Windows Server';
    return build >= 22000 ? 'Windows 11' : 'Windows 10';
  }
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return platform;
}
