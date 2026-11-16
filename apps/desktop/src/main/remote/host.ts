/**
 * 내 기기 원격 접속(호스트) — 서버에 원격 데스크톱 플러그인이 활성화된 경우에만 동작한다.
 *
 *  - 설정(이 기기 한정): allowRemote(원격 접속 허용), unattended(무인 접속). userData/remote.json
 *  - 호스트 비밀은 OS 자격 증명 저장소(safeStorage)로 암호화하여 userData/remote-host.bin 에 저장한다.
 *  - allowRemote 가 활성화되면 기기를 등록하고(비밀 발급) 서버 롱폴링을 수행한다. 요청 수신 시:
 *      · 무인 접속: 서버가 auto_allow(소유자 본인 요청 + 서버 설정) 이고 이 기기 설정도 활성화된 경우에만 동의 창 없이 연다
 *      · 그 외: 동의 창(요청자 이름, 30초)
 *  - 동시 세션은 하나만 허용. 진행 중이면 새 요청은 거부한다.
 */
import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError, pluginEnabled, RemoteApi, type Cred, type SessionOut } from './api';
import type { InputAddon } from './inject';
import { osName } from './os-name';
import { HostSession } from './session';
import { askConsent } from './windows';

export interface RemotePrefs { allowRemote: boolean; unattended: boolean }
export interface RemoteStatus extends RemotePrefs { available: boolean; registered: boolean; inSession: boolean; deviceName: string }
export interface RemoteLogRow { requester: string; email: string; kind: 'device' | 'support'; status: string; when: string | null; durationS: number | null }

const PREFS = () => path.join(app.getPath('userData'), 'remote.json');
const CRED = () => path.join(app.getPath('userData'), 'remote-host.bin');

async function loadPrefs(): Promise<RemotePrefs> {
  try {
    const j = JSON.parse(await fs.readFile(PREFS(), 'utf8'));
    return { allowRemote: j.allowRemote === true, unattended: j.unattended === true };
  } catch {
    return { allowRemote: false, unattended: false };
  }
}

async function savePrefs(p: RemotePrefs): Promise<void> {
  await fs.writeFile(PREFS(), JSON.stringify(p), { mode: 0o600 });
}

async function loadCred(): Promise<{ deviceId: string; secret: string } | null> {
  try {
    const buf = await fs.readFile(CRED());
    const { result } = await safeStorage.decryptStringAsync(buf);
    const j = JSON.parse(result);
    return typeof j.deviceId === 'string' && typeof j.secret === 'string' ? j : null;
  } catch {
    return null;
  }
}

async function saveCred(c: { deviceId: string; secret: string }): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('OS 자격 증명 저장소를 쓸 수 없어 원격 접속을 켤 수 없습니다');
  await fs.writeFile(CRED(), await safeStorage.encryptStringAsync(JSON.stringify(c)), { mode: 0o600 });
}

export class RemoteHost {
  private api: RemoteApi;
  private prefs: RemotePrefs = { allowRemote: false, unattended: false };
  private cred: { deviceId: string; secret: string } | null = null;
  private available = false;
  private loop: Promise<void> | null = null;
  private running = false;
  private session: HostSession | null = null;
  private deciding = new Set<string>();
  private org = { name: '', domain: '' };
  private name = '';

  constructor(private readonly serverUrl: string, private readonly token: () => Promise<string>, private readonly addon: InputAddon | null,
              private readonly deviceName: () => string = () => os.hostname()) {
    this.api = new RemoteApi(serverUrl);
  }

  /** 로그인 직후·앱 시작 시 — 플러그인 유무를 확인하고 설정에 따라 활성화한다 */
  async start(): Promise<void> {
    this.prefs = await loadPrefs();
    this.cred = await loadCred();
    this.available = await pluginEnabled(this.serverUrl, this.token);
    if (this.available && this.prefs.allowRemote) await this.goOnline();
  }

  /** 로그아웃 — 루프를 중지하고 진행 중인 세션을 종료한다(등록·비밀은 유지한다) */
  async stop(): Promise<void> {
    this.running = false;
    await this.session?.stop('signed_out');
  }

  async status(): Promise<RemoteStatus> {
    return { ...this.prefs, available: this.available, registered: !!this.cred, inSession: !!this.session?.active, deviceName: this.name || this.deviceName() };
  }

  /** 기기 이름 변경(내 기기 목록·동의 창에 표시되는 이름) */
  async rename(name: string): Promise<RemoteStatus> {
    const n = name.trim().slice(0, 100);
    if (!n) throw new Error('기기 이름을 넣으세요');
    if (!this.cred) throw new Error('아직 등록되지 않은 기기입니다. 원격 접속 허용을 먼저 켜세요');
    const r = await this.api.patchDevice(this.token, this.cred.deviceId, { name: n });
    this.name = r.device.name;
    return this.status();
  }

  /** 최근 접속 기록(서버, 소유자만) */
  async recent(limit = 3): Promise<RemoteLogRow[]> {
    if (!this.cred) return [];
    const r = await this.api.deviceSessions(this.token, this.cred.deviceId, limit);
    return r.sessions.map(s => ({
      requester: s.requester_name, email: s.requester_email ?? '', kind: s.kind, status: s.status,
      when: s.created_at ?? s.started_at ?? null, durationS: s.duration_s ?? null,
    }));
  }

  /** 등록 해지 — 서버에서 삭제하고(키 폐기) 이 PC의 비밀·설정도 삭제한다. 재사용하려면 신규 등록 필요 */
  async unregister(): Promise<RemoteStatus> {
    this.running = false;
    await this.session?.stop('device_revoked');
    if (this.cred) {
      try { await this.api.deleteDevice(this.token, this.cred.deviceId); } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
    }
    this.cred = null;
    this.name = '';
    await fs.rm(CRED(), { force: true });
    this.prefs = { allowRemote: false, unattended: false };
    await savePrefs(this.prefs);
    return this.status();
  }

  async setPrefs(p: Partial<RemotePrefs>): Promise<RemoteStatus> {
    if (!this.available) this.available = await pluginEnabled(this.serverUrl, this.token);
    if (!this.available) return this.status();
    this.prefs = { ...this.prefs, ...p };
    if (!this.prefs.allowRemote) this.prefs.unattended = false;
    await savePrefs(this.prefs);
    if (this.prefs.allowRemote) {
      await this.goOnline();
    } else {
      this.running = false;
      await this.session?.stop('host_disabled');
    }
    if (this.cred) {
      try {
        await this.api.patchDevice(this.token, this.cred.deviceId, { allow_remote: this.prefs.allowRemote, unattended: this.prefs.unattended });
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) { this.cred = null; if (this.prefs.allowRemote) await this.goOnline(); }
        else console.warn('[remote] 기기 설정 반영 실패', e);
      }
    }
    return this.status();
  }

  private async ensureRegistered(): Promise<boolean> {
    if (this.cred) return true;
    try {
      const r = await this.api.register(this.token, this.deviceName(), process.platform, osName());
      this.cred = { deviceId: r.device.id, secret: r.host_secret };
      this.name = r.device.name;
      await saveCred(this.cred);
      await this.api.patchDevice(this.token, this.cred.deviceId, { allow_remote: this.prefs.allowRemote, unattended: this.prefs.unattended });
      return true;
    } catch (e) {
      console.warn('[remote] 기기 등록 실패', e);
      this.cred = null;
      return false;
    }
  }

  private async goOnline(): Promise<void> {
    if (!(await this.ensureRegistered())) return;
    if (this.running) return;
    this.running = true;
    this.loop = this.pollLoop().finally(() => { this.loop = null; });
  }

  private hostCred(): Cred | null {
    return this.cred ? { kind: 'host', deviceId: this.cred.deviceId, secret: this.cred.secret } : null;
  }

  private async pollLoop(): Promise<void> {
    let known = '';
    let backoff = 1000;
    while (this.running) {
      const cred = this.hostCred();
      if (!cred) break;
      try {
        const r = await this.api.hostPoll(cred, 25, known);
        backoff = 1000;
        this.name = r.device.name || this.name;
        this.org = { name: r.org_name ?? this.org.name, domain: r.org_domain ?? this.org.domain };
        known = r.sessions.map(s => `${s.id}:${s.status}`).join(',');
        for (const s of r.sessions) if (s.status === 'pending') void this.onRequest(cred, s);
        // 서버가 종료한 세션(관리자 종료·만료)이면 여기서도 종료한다
        if (this.session?.active && !r.sessions.some(s => s.status === 'active')) {
          await this.session.stop('server_ended');
        }
      } catch (e) {
        if (e instanceof HttpError && (e.status === 401 || e.status === 404)) {
          // 비밀이 변경되었거나 기기가 해지됨 → 재등록
          this.cred = null;
          await fs.rm(CRED(), { force: true });
          if (!(await this.ensureRegistered())) { this.running = false; break; }
        } else if (e instanceof HttpError && e.status === 403) {
          this.available = false; // 플러그인 비활성화됨
          this.running = false;
          break;
        }
        await new Promise(res => setTimeout(res, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private async onRequest(cred: Cred, s: SessionOut): Promise<void> {
    if (this.deciding.has(s.id)) return;
    this.deciding.add(s.id);
    try {
      let allow: boolean;
      if (this.session?.active) allow = false;
      else if (s.auto_allow && this.prefs.unattended) allow = true;
      else allow = await askConsent({
        requester: s.requester_name, email: s.requester_email ?? '', org: this.org.name, domain: this.org.domain, kind: 'device', timeoutS: 30,
      });
      const r = await this.api.hostDecision(cred, s.id, allow);
      if (allow && r.livekit && r.session.status === 'active') {
        this.session = new HostSession({
          sessionId: s.id, requester: s.requester_name, livekit: r.livekit, addon: this.addon,
          notifyEnd: async (why) => { await this.api.hostEnd(cred, s.id, why).catch(() => this.api.hostEnd(cred, s.id)).catch(() => {}); },
          onClosed: () => { this.session = null; },
        });
        this.session.start();
      }
    } catch (e) {
      console.warn('[remote] 요청 처리 실패', e);
    } finally {
      this.deciding.delete(s.id);
    }
  }
}
