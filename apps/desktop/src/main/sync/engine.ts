/**
 * 파일 동기화 엔진.
 *
 * 아래 세 가지 설계 결정은 사전에 확정된 것이며, 코드도 이를 그대로 따른다.
 *
 *   1. **선택한 폴더만** 동기화한다. 전체 동기화 옵션은 없다.
 *   2. **충돌은 병합하지 않는다.** 양쪽 사본을 모두 보존하고 사용자에게 알린다.
 *   3. **삭제 전파는 v2 로 연기한다.** 한쪽에서 삭제해도 반대쪽은 유지된다.
 *
 * 중요: 3번에 의해 본 엔진의 구조가 크게 단순해진다.
 * 삭제를 전파하려면 "사라진 파일" 이 삭제된 것인지 아직 관측하지 못한 것인지 구분해야 하며,
 * 이를 위해서는 마지막으로 성공한 동기화의 스냅샷을 신뢰할 수 있어야 한다. 스냅샷이
 * 부정확하면 **파일이 통지 없이 삭제된다** — 동기화 도구에서 가장 심각한 실패이다. 삭제하지
 * 않기로 하면 스냅샷이 부정확해도 최악의 결과가 "옛 파일이 되살아난다" 에 그친다.
 *
 * 따라서 상태 파일(state.json)은 성능을 위한 캐시에 불과하며, 없어도 정확도가
 * 저하되지 않는다 — 재생성 시 모든 파일이 "양쪽에 있고 다르다" 로 판정되어
 * 충돌 처리를 거치며, 사본이 하나 추가될 뿐 유실은 없다.
 */
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { broker } from '../auth/broker';
import { loadSync, saveSync, type FolderState, type SyncFolder } from './config';

export interface SyncProgress {
  folderId: string;
  state: FolderState;
  /** 현재 처리 중인 파일 이름. 없으면 유휴 상태. */
  current?: string;
  done: number;
  total: number;
  conflicts: number;
  bytes: number;
}

export interface EngineHandlers {
  onProgress(p: SyncProgress): void;
  /** 충돌 발생. 토스트로 알린다. */
  onConflict(folderName: string, fileName: string, copyName: string): void;
}

/** 파일 하나에 대해 마지막 동기화 완료 시점의 상태. */
interface FileSnapshot {
  /** 로컬 mtime(ms) 과 크기 — 로컬 변경 여부를 판정한다. */
  localMtime: number;
  localSize: number;
  /** 서버 mtime(ms) 과 크기 — 원격 변경 여부를 판정한다. */
  remoteMtime: number;
  remoteSize: number;
}

type Snapshot = Record<string, FileSnapshot>;

/** 폴더별 스냅샷 파일. userData 에 저장한다 — 동기화 폴더 안에 두면 스냅샷 자체가 동기화 대상이 된다. */
const STATE_DIR = () => path.join(app.getPath('userData'), 'sync-state');
const statePath = (folderId: string) => path.join(STATE_DIR(), `${folderId}.json`);

/** 동기화 제외 대상. 편집기·OS 가 생성하는 임시 파일과 본 엔진의 충돌 사본. */
const IGNORE = [
  /(^|[\\/])\./,          // 숨김 파일
  /(^|[\\/])~\$/,          // Office 임시 파일
  /\.(tmp|swp|part|crdownload)$/i,
  /(^|[\\/])(Thumbs\.db|desktop\.ini|\.DS_Store)$/i,
];

const POLL_MS = 60_000;

let handlers: EngineHandlers | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let stopped = true;

export function setEngineHandlers(h: EngineHandlers): void {
  handlers = h;
}

function ignored(rel: string): boolean {
  return IGNORE.some((re) => re.test(rel));
}

async function api(pathAndQuery: string, init?: RequestInit): Promise<Response> {
  const token = await broker.getAccessToken();
  return fetch(`${CONFIG.serverUrl}${pathAndQuery}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

/* ── 스냅샷 ───────────────────────────────────────────── */

async function loadSnapshot(folderId: string): Promise<Snapshot> {
  try {
    return JSON.parse(await fs.readFile(statePath(folderId), 'utf8')) as Snapshot;
  } catch {
    // 파일이 없거나 손상된 경우. 캐시에 불과하므로 빈 상태로 시작해도 파일이 유실되지 않는다.
    return {};
  }
}

async function saveSnapshot(folderId: string, snap: Snapshot): Promise<void> {
  await fs.mkdir(STATE_DIR(), { recursive: true });
  await fs.writeFile(statePath(folderId), JSON.stringify(snap), 'utf8');
}

/* ── 양쪽 목록 ────────────────────────────────────────── */

interface Entry {
  rel: string;
  mtime: number;
  size: number;
}

async function walkLocal(root: string, base = ''): Promise<Entry[]> {
  const out: Entry[] = [];
  let items: import('node:fs').Dirent[];
  try {
    items = await fs.readdir(path.join(root, base), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const rel = base ? `${base}/${it.name}` : it.name;
    if (ignored(rel)) continue;
    if (it.isDirectory()) {
      out.push(...(await walkLocal(root, rel)));
    } else if (it.isFile()) {
      const st = await fs.stat(path.join(root, rel));
      out.push({ rel, mtime: Math.floor(st.mtimeMs), size: st.size });
    }
  }
  return out;
}

async function walkRemote(remoteRoot: string, base = ''): Promise<Entry[]> {
  const out: Entry[] = [];
  const vp = base ? `${remoteRoot}/${base}` : remoteRoot;
  const res = await api(`/api/files/list?path=${encodeURIComponent(vp)}`);
  if (!res.ok) return out;
  const { items } = (await res.json()) as {
    items: Array<{ name: string; is_dir: boolean; size: number; modified_at: string | null }>;
  };
  for (const it of items) {
    const rel = base ? `${base}/${it.name}` : it.name;
    if (ignored(rel)) continue;
    if (it.is_dir) {
      out.push(...(await walkRemote(remoteRoot, rel)));
    } else {
      out.push({
        rel,
        mtime: it.modified_at ? Date.parse(it.modified_at) : 0,
        size: it.size,
      });
    }
  }
  return out;
}

/* ── 전송 ─────────────────────────────────────────────── */

async function ensureRemoteDir(remoteRoot: string, rel: string): Promise<void> {
  const dir = path.posix.dirname(rel);
  if (dir === '.' || dir === '') return;
  // mkdir 은 대상이 이미 존재하면 오류를 반환하나, 이는 의도한 상태이므로 무시한다.
  const parts = dir.split('/');
  let acc = remoteRoot;
  for (const p of parts) {
    acc = `${acc}/${p}`;
    await api('/api/files/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: acc }),
    }).catch(() => undefined);
  }
}

/** 이 크기를 초과하는 파일은 청크 세션으로 업로드한다. 그 이하는 단일 POST 가 비용이 낮다. */
const CHUNK_THRESHOLD = 8 * 1024 * 1024;
const CHUNK_MIN = 1024 * 1024;
const CHUNK_MAX = 64 * 1024 * 1024;
const CHUNK_RETRIES = 3;

/**
 * 서버의 청크 세션 API(`/api/files/upload/sessions`) 지원 여부. 미지원(404/405)이면 1회만
 * 확인하고 이후에는 단일 업로드만 사용한다 — 구버전 서버에 연결해도 동기화는 동작해야 한다.
 */
let chunkedSupported: boolean | null = null;

function remoteDirOf(remoteRoot: string, rel: string): string {
  const dir = path.posix.dirname(rel);
  return dir === '.' ? remoteRoot : `${remoteRoot}/${dir}`;
}

async function upload(localRoot: string, remoteRoot: string, rel: string): Promise<boolean> {
  await ensureRemoteDir(remoteRoot, rel);
  const abs = path.join(localRoot, rel);
  const st = await fs.stat(abs);
  const mtime = Math.floor(st.mtimeMs);
  const target = remoteDirOf(remoteRoot, rel);

  if (st.size > CHUNK_THRESHOLD && chunkedSupported !== false) {
    const r = await uploadChunked(abs, target, path.posix.basename(rel), st.size, mtime);
    if (r !== 'unsupported') return r;
    chunkedSupported = false;
  }
  return uploadSingle(abs, target, path.posix.basename(rel), st.size, mtime);
}

/** 단일 multipart POST. 소형 파일용(대형 파일은 전체가 메모리에 적재된다). */
async function uploadSingle(
  abs: string,
  target: string,
  name: string,
  size: number,
  mtime: number,
): Promise<boolean> {
  const buf = await fs.readFile(abs);
  const form = new FormData();
  form.append('file', new Blob([buf]), name);
  // mtime 을 함께 전송해 서버가 보존하도록 한다 — 생략 시 서버 mtime=업로드 시각이 되어
  // 다음 주기에 "서버에서 바뀜" 으로 판정된다.
  const res = await api(
    `/api/files/upload?path=${encodeURIComponent(target)}&size=${size}&mtime=${mtime}`,
    { method: 'POST', body: form },
  );
  return res.ok;
}

/**
 * 청크 세션: POST sessions → PUT {id}/{n} × N → POST commit.
 * 파일을 조각 단위로만 읽으므로 메모리 사용량이 청크 하나 크기로 유지된다. 청크 실패 시 수 회
 * 재시도하고, 계속 실패하면 세션을 삭제하고 false 를 반환한다. 서버가 API 를 지원하지 않으면 'unsupported'.
 */
async function uploadChunked(
  abs: string,
  target: string,
  name: string,
  size: number,
  mtime: number,
): Promise<boolean | 'unsupported'> {
  const created = await api('/api/files/upload/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target, name, size, mtime }),
  });
  if (created.status === 404 || created.status === 405) return 'unsupported';
  if (!created.ok) return false;
  const session = (await created.json()) as { id: string; chunk_size?: number };
  const chunk = Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, session.chunk_size ?? CHUNK_THRESHOLD));
  const base = `/api/files/upload/sessions/${encodeURIComponent(session.id)}`;

  const fh = await fs.open(abs, 'r');
  try {
    let offset = 0;
    for (let n = 1; offset < size; n += 1) {
      const len = Math.min(chunk, size - offset);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      if (bytesRead <= 0) break;
      const body = new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
      let ok = false;
      for (let attempt = 0; attempt < CHUNK_RETRIES && !ok; attempt += 1) {
        try {
          const res = await api(`${base}/${n}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body,
          });
          ok = res.ok;
          // 4xx 는 재전송해도 결과가 동일하다(크기 상한·세션 만료). 즉시 중단.
          if (!ok && res.status >= 400 && res.status < 500) break;
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        await api(base, { method: 'DELETE' }).catch(() => undefined);
        return false;
      }
      offset += bytesRead;
    }
  } finally {
    await fh.close();
  }
  const committed = await api(`${base}/commit`, { method: 'POST' });
  if (!committed.ok) {
    await api(base, { method: 'DELETE' }).catch(() => undefined);
    return false;
  }
  return true;
}

async function download(localRoot: string, remoteRoot: string, rel: string): Promise<boolean> {
  const res = await api(`/api/files/download?path=${encodeURIComponent(`${remoteRoot}/${rel}`)}`);
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = path.join(localRoot, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  return true;
}

/** 충돌 사본 이름. `회의록.md` → `회의록 (충돌 남기완).md` */
function conflictName(rel: string, who: string): string {
  const dir = path.posix.dirname(rel);
  const ext = path.posix.extname(rel);
  const stem = path.posix.basename(rel, ext);
  const name = `${stem} (충돌 ${who})${ext}`;
  return dir === '.' ? name : `${dir}/${name}`;
}

/* ── 한 폴더 동기화 ───────────────────────────────────── */

async function syncFolder(folder: SyncFolder, who: string): Promise<{
  state: FolderState;
  conflicts: number;
  bytes: number;
}> {
  const localRoot = folder.localPath;
  // 서버 가상 경로는 my/… 또는 shared/… 이다. 선행 슬래시만 제거하고 그대로 사용한다.
  const remoteRoot = folder.remotePath.replace(/^\/+/, '') || `my/${folder.name}`;
  const snap = await loadSnapshot(folder.id);

  const [locals, remotes] = await Promise.all([
    walkLocal(localRoot),
    walkRemote(remoteRoot).catch(() => [] as Entry[]),
  ]);

  const localMap = new Map(locals.map((e) => [e.rel, e]));
  const remoteMap = new Map(remotes.map((e) => [e.rel, e]));
  const all = new Set([...localMap.keys(), ...remoteMap.keys()]);

  let conflicts = 0;
  let done = 0;
  let bytes = 0;
  const total = all.size;

  for (const rel of all) {
    const l = localMap.get(rel);
    const r = remoteMap.get(rel);
    const s = snap[rel];

    handlers?.onProgress({
      folderId: folder.id,
      state: 'syncing',
      current: rel,
      done,
      total,
      conflicts,
      bytes,
    });
    done += 1;

    // 크기·mtime 이 스냅샷과 동일하면 변경 없음으로 판정한다. 매번 해시를 계산하면
    // 대형 폴더에서 디스크 I/O 부하가 과도해진다.
    const localChanged = !!l && (!s || l.mtime !== s.localMtime || l.size !== s.localSize);
    const remoteChanged = !!r && (!s || r.mtime !== s.remoteMtime || r.size !== s.remoteSize);

    try {
      if (l && !r) {
        // 로컬에만 존재한다. 신규 파일이거나 서버에서 삭제된 파일이다.
        // 삭제 전파는 v2 대상이므로 후자도 업로드한다 — 삭제하지 않는다.
        if (await upload(localRoot, remoteRoot, rel)) {
          const st = await fs.stat(path.join(localRoot, rel));
          snap[rel] = {
            localMtime: Math.floor(st.mtimeMs),
            localSize: st.size,
            remoteMtime: Math.floor(st.mtimeMs),
            remoteSize: st.size,
          };
          bytes += st.size;
        }
      } else if (!l && r) {
        // 서버에만 존재한다. 마찬가지로 로컬에서 삭제된 파일일 수 있으나 다운로드한다.
        if (await download(localRoot, remoteRoot, rel)) {
          const st = await fs.stat(path.join(localRoot, rel));
          snap[rel] = {
            localMtime: Math.floor(st.mtimeMs),
            localSize: st.size,
            remoteMtime: r.mtime,
            remoteSize: r.size,
          };
          bytes += r.size;
        }
      } else if (l && r) {
        if (localChanged && remoteChanged) {
          /*
           * 양쪽 모두 변경됨 — 병합하지 않는다.
           * 서버 사본을 원래 이름으로 다운로드하고, 로컬 사본은 이름을 변경해 보존한 뒤 업로드한다.
           * 이로써 어느 쪽도 유실되지 않으며, 두 사본이 양쪽에 모두 존재하게 된다.
           */
          const copy = conflictName(rel, who);
          await fs.rename(path.join(localRoot, rel), path.join(localRoot, copy));
          await download(localRoot, remoteRoot, rel);
          await upload(localRoot, remoteRoot, copy);
          conflicts += 1;
          handlers?.onConflict(folder.name, path.posix.basename(rel), path.posix.basename(copy));
          delete snap[rel];
          delete snap[copy];
        } else if (localChanged) {
          if (await upload(localRoot, remoteRoot, rel)) {
            snap[rel] = {
              localMtime: l.mtime,
              localSize: l.size,
              remoteMtime: l.mtime,
              remoteSize: l.size,
            };
            bytes += l.size;
          }
        } else if (remoteChanged) {
          if (await download(localRoot, remoteRoot, rel)) {
            const st = await fs.stat(path.join(localRoot, rel));
            snap[rel] = {
              localMtime: Math.floor(st.mtimeMs),
              localSize: st.size,
              remoteMtime: r.mtime,
              remoteSize: r.size,
            };
            bytes += r.size;
          }
        } else if (!s) {
          // 스냅샷이 없으나 양쪽 크기가 동일한 경우 — 동일 파일로 간주하고 기록만 수행한다.
          snap[rel] = {
            localMtime: l.mtime,
            localSize: l.size,
            remoteMtime: r.mtime,
            remoteSize: r.size,
          };
        }
      }
    } catch (e) {
      console.warn('[sync] 파일 실패:', folder.name, rel, e);
    }
  }

  await saveSnapshot(folder.id, snap);
  return {
    state: conflicts > 0 ? 'conflict' : 'up_to_date',
    conflicts,
    bytes: locals.reduce((a, e) => a + e.size, 0),
  };
}

/* ── 루프 ─────────────────────────────────────────────── */

/** 동기화를 1회 즉시 수행한다. 이미 수행 중이면 no-op. */
export async function syncNow(who: string): Promise<void> {
  if (running) return;
  running = true;
  try {
    const settings = await loadSync();
    for (const folder of settings.folders) {
      if (folder.state === 'paused') continue;
      try {
        const r = await syncFolder(folder, who);
        folder.state = r.state;
        folder.conflicts = r.conflicts;
        folder.bytes = r.bytes;
        handlers?.onProgress({
          folderId: folder.id,
          state: r.state,
          done: 1,
          total: 1,
          conflicts: r.conflicts,
          bytes: r.bytes,
        });
      } catch (e) {
        console.warn('[sync] 폴더 실패:', folder.name, e);
        folder.state = 'error';
        handlers?.onProgress({
          folderId: folder.id,
          state: 'error',
          done: 0,
          total: 0,
          conflicts: folder.conflicts,
          bytes: folder.bytes ?? 0,
        });
      }
    }
    await saveSync(settings);
  } finally {
    running = false;
  }
}

export function startSync(who: string): void {
  if (!stopped) return;
  stopped = false;
  void syncNow(who);
  timer = setInterval(() => {
    if (!stopped) void syncNow(who);
  }, POLL_MS);
}

export function stopSync(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

export function isSyncing(): boolean {
  return running;
}
