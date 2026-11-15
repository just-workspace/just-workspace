/**
 * 리프레시 토큰 보관 — OS 자격 증명 저장소.
 *
 * keytar 를 쓰지 않는다. 2023년에 아카이브됐고 네이티브 모듈이라 Electron 버전마다
 * 재빌드가 필요하다. Electron 내장 `safeStorage` 가 같은 일을 한다 —
 * Windows 는 DPAPI, macOS 는 Keychain, Linux 는 libsecret 을 쓴다.
 *
 * 암호문만 userData 에 남기므로, 파일을 통째로 복사해도 다른 계정·다른 기기에서는
 * 복호화되지 않는다.
 */
import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const FILE = () => path.join(app.getPath('userData'), 'credentials.bin');

/**
 * 저장소가 실제로 OS 암호화를 제공하는지.
 * 동기 API(isEncryptionAvailable/encryptString/decryptString)는 Electron 45 에서 폐기, 46 에서 제거라
 * 비동기 쪽을 쓴다. 같은 OS 키 저장소라 기존 암호문(encryptString 산출물)도 decryptStringAsync 가 읽는다.
 */
export function isSecure(): Promise<boolean> {
  return safeStorage.isAsyncEncryptionAvailable();
}

export async function saveRefreshToken(token: string): Promise<void> {
  if (!(await isSecure())) {
    // 암호화가 없는 환경(예: 키링 없는 리눅스 데스크톱)에서 평문으로 떨어뜨리지
    // 않는다. 저장을 포기하면 매번 로그인해야 하지만, 평문 토큰을 디스크에 남기는
    // 것보다 낫다.
    throw new Error(
      'OS 자격 증명 저장소를 쓸 수 없습니다. 리눅스라면 gnome-keyring 또는 ' +
        'kwallet 을 설치한 뒤 다시 시도하세요.',
    );
  }
  const enc = await safeStorage.encryptStringAsync(token);
  await fs.writeFile(FILE(), enc, { mode: 0o600 });
}

export async function loadRefreshToken(): Promise<string | null> {
  try {
    const buf = await fs.readFile(FILE());
    const { result } = await safeStorage.decryptStringAsync(buf);
    return result;
  } catch {
    // 파일 없음, 또는 다른 기기/계정에서 만들어져 복호화 불가.
    // 둘 다 "로그인 필요" 로 동일하게 처리한다.
    return null;
  }
}

export async function clearRefreshToken(): Promise<void> {
  await fs.rm(FILE(), { force: true });
}
