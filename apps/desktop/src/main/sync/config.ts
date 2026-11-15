/**
 * 동기화 설정 저장소.
 *
 * 파일 전송 엔진은 아직 없다. 이 모듈은 **사용자가 무엇을 동기화하기로 했는지** 만
 * 들고 있는다 — 엔진이 붙으면 그 목록을 그대로 읽어가면 된다.
 *
 * 설정 파일은 userData 아래 평문 JSON 이다. 폴더 경로에는 비밀이 없고, 사용자가
 * 직접 열어보고 고칠 수 있는 편이 낫다(자격 증명은 credentials.bin 에 따로 있다).
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
   * 서버 경로. 아직 매핑 UI 가 없어 로컬 폴더 이름에서 만든다.
   * **반드시 `my/` 또는 `shared/` 로 시작해야 한다** — 서버의 가상 루트가 그 둘뿐이라
   * 그냥 폴더 이름만 주면 목록 조회가 통째로 실패한다.
   */
  remotePath: string;
  /** 마지막으로 관측한 크기(바이트). 엔진이 채운다. */
  bytes: number | null;
  state: FolderState;
  conflicts: number;
}

export interface SyncSettings {
  /** 동기화 루트. 폴더를 추가할 때 기본 위치로 쓴다. */
  root: string;
  folders: SyncFolder[];
  /** 로그인 시 동기화 자동 시작. 앱 자동 시작과는 별개다. */
  startWithOs: boolean;
  /** 종량제 네트워크에서 일시중지. */
  pauseOnMetered: boolean;
  /**
   * 삭제 전파. **v2 로 미룬 기능이라 항상 false 다**(설계 결정).
   * 한쪽에서 지워도 반대쪽은 유지된다.
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
    // 사용자가 직접 고칠 수 있는 파일이다. 깨져 있어도 앱이 죽으면 안 된다.
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
    // 엔진이 없으므로 "아직 시작 안 함" 이다. 최신이라고 말하지 않는다.
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
