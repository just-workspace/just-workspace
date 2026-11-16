/**
 * 리프레시 토큰 보관 — OS 자격 증명 저장소.
 *
 * keytar 는 사용하지 않는다. 2023년에 아카이브되었고 네이티브 모듈이므로 Electron 버전마다
 * 재빌드가 필요하다. Electron 내장 `safeStorage` 가 동일한 기능을 제공한다 —
 * Windows 는 DPAPI, macOS 는 Keychain, Linux 는 libsecret 을 사용한다.
 *
 * 암호문만 userData 에 저장하므로, 파일 전체를 복사해도 다른 계정·다른 기기에서는
 * 복호화되지 않는다.
 */
import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const FILE = () => path.join(app.getPath('userData'), 'credentials.bin');

/**
 * 저장소가 실제로 OS 암호화를 제공하는지 여부.
 * 동기 API(isEncryptionAvailable/encryptString/decryptString)는 Electron 45 에서 폐기, 46 에서 제거되므로
 * 비동기 API 를 사용한다. 동일한 OS 키 저장소이므로 기존 암호문(encryptString 산출물)도 decryptStringAsync 로 복호화된다.
 */
export function isSecure(): Promise<boolean> {
  return safeStorage.isAsyncEncryptionAvailable();
}

export async function saveRefreshToken(token: string): Promise<void> {
  if (!(await isSecure())) {
    // 암호화를 사용할 수 없는 환경(예: 키링 없는 리눅스 데스크톱)에서 평문으로 저장하지
    // 않는다. 저장을 포기하면 매번 로그인이 필요하나, 평문 토큰을 디스크에 남기는
    // 것보다 안전하다.
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
    // 파일 없음, 또는 다른 기기/계정에서 생성되어 복호화 불가.
    // 두 경우 모두 "로그인 필요" 로 동일하게 처리한다.
    return null;
  }
}

export async function clearRefreshToken(): Promise<void> {
  await fs.rm(FILE(), { force: true });
}
