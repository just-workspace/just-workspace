/**
 * 동기화 설정 저장소.
 *
 * 파일 전송 엔진은 아직 없다. 본 모듈은 **사용자가 동기화 대상으로 선택한 항목** 만
 * 보유한다 — 엔진 도입 시 해당 목록을 그대로 읽는다.
 *
 * 설정 파일은 userData 아래 평문 JSON 이다. 폴더 경로에는 비밀 정보가 없으며, 사용자가
 * 직접 열람·수정할 수 있는 형식이 적합하다(자격 증명은 credentials.bin 에 별도 저장).
 */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type FolderState = 'idle' | 'syncing' | 'up_to_date' | 'paused' | 'conflict' | 'error';

export interface SyncFolder {
  id: string;
  /** 표시 이름. 기본값은 로컬 폴더 이름. */
  name: string;
  localPath: string;
  /**
   * 서버 경로. 매핑 UI 가 아직 없어 로컬 폴더 이름에서 생성한다.
   * **반드시 `my/` 또는 `shared/` 로 시작해야 한다** — 서버의 가상 루트가 그 둘뿐이므로
   * 폴더 이름만 전달하면 목록 조회 전체가 실패한다.
   */
  remotePath: string;
  /** 마지막으로 관측한 크기(바이트). 엔진이 기록한다. */
  bytes: number | null;
  state: FolderState;
  conflicts: number;
}

export interface SyncSettings {
  /** 동기화 루트. 폴더 추가 시 기본 위치로 사용한다. */
  root: string;
  folders: SyncFolder[];
  /** 로그인 시 동기화 자동 시작. 앱 자동 시작과는 별개이다. */
  startWithOs: boolean;
  /** 종량제 네트워크에서 일시중지. */
  pauseOnMetered: boolean;
  /**
   * 삭제 전파. **v2 로 연기한 기능이므로 항상 false 이다**(설계 결정).
   * 한쪽에서 삭제해도 반대쪽은 유지된다.
   */
  propagateDeletes: false;
}

const FILE = () => path.join(app.getPath('userData'), 'sync.json');

function defaults(): SyncSettings {
  return {
    root: path.join(app.getPath('home'), 'just-workspace'),
    folders: [],
    startWithOs: true,
    pauseOnMetered: true,
    propagateDeletes: false,
  };
}

let cache: SyncSettings | null = null;

export async function loadSync(): Promise<SyncSettings> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE(), 'utf8');
    // 사용자가 직접 수정할 수 있는 파일이다. 손상된 경우에도 앱이 비정상 종료되어서는 안 된다.
    cache = { ...defaults(), ...(JSON.parse(raw) as Partial<SyncSettings>), propagateDeletes: false };
  } catch {
    cache = defaults();
  }
  return cache;
}

export async function saveSync(next: SyncSettings): Promise<SyncSettings> {
  cache = { ...next, propagateDeletes: false };
  await fs.writeFile(FILE(), JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

export async function addFolder(localPath: string): Promise<SyncSettings> {
  const s = await loadSync();
  if (s.folders.some((f) => f.localPath === localPath)) return s;

  const name = path.basename(localPath);
  s.folders.push({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    localPath,
    remotePath: `my/${name}`,
    bytes: null,
    // 엔진이 없으므로 "아직 시작 안 함" 상태이다. 최신 상태로 표시하지 않는다.
    state: 'idle',
    conflicts: 0,
  });
  return saveSync(s);
}

export async function removeFolder(id: string): Promise<SyncSettings> {
  const s = await loadSync();
  s.folders = s.folders.filter((f) => f.id !== id);
  return saveSync(s);
}

export async function patchSync(patch: Partial<SyncSettings>): Promise<SyncSettings> {
  const s = await loadSync();
  return saveSync({ ...s, ...patch });
}
