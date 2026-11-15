/**
 * 1회성 원격 지원(포터블 지원 프로그램) — 계정 없이 접속 코드를 받아 보여 주고, 지원자(회원)가 코드를 넣으면 동의를 받아 연다.
 * 화면은 시안 SupportApp: ① 코드 대기 → ② 요청 도착(동의 창은 따로 맨 위) → ③ 연결됨 → ④ 종료.
 *  - 코드는 5분·1회. 만료되면 [새 코드 받기]. 창을 닫으면 코드·세션 모두 무효(서버에 종료 알림).
 *  - 세션이 한 번 끝나면(거부 포함) 새 코드를 주지 않는다 — 다시 받으려면 프로그램을 새로 실행한다.
 *  - 무인 재접속 없음: 이 프로그램이 떠 있고 사람이 [허용]했을 때만 열린다.
 */
import { BrowserWindow, clipboard, ipcMain } from 'electron';
import path from 'node:path';
import { HttpError, RemoteApi, type Cred } from './api';
import type { InputAddon } from './inject';
import { HostSession } from './session';
import { askConsent } from './windows';

export type SupportView =
  | { phase: 'server'; server: string; error?: string }
  | { phase: 'code'; code: string; expiresAt: string; org: string }
  | { phase: 'expired'; code: string }
  | { phase: 'pending'; code: string; requester: string; email: string; org: string; domain: string; timeoutS: number }
  | { phase: 'active'; requester: string; email: string; startedAt: number }
  | { phase: 'ended'; reason: string; requester: string; durationS: number | null }
  | { phase: 'error'; message: string };

export class SupportController {
  private win: BrowserWindow | null = null;
  private api: RemoteApi | null = null;
  private cred: Cred | null = null;
  private org = '';
  private domain = '';
  private code = '';
  private finished = false;
  private session: HostSession | null = null;
  private polling = false;
  private view: SupportView;

  constructor(private server: string, private readonly addon: InputAddon | null, private readonly saveServer: (s: string) => Promise<void>) {
    this.view = server ? { phase: 'code', code: '', expiresAt: '', org: '' } : { phase: 'server', server: '' };
  }

  open(): BrowserWindow {
    this.win = new BrowserWindow({
      width: 420, height: 560, useContentSize: true, frame: false, resizable: false, maximizable: false, fullscreenable: false, show: false,
      title: '원격 지원', backgroundColor: '#1a1f27', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, '../../preload/remote.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    ipcMain.handle('rd:support:view', (e) => (e.sender === this.win?.webContents ? this.view : null));
    ipcMain.on('rd:support:new-code', (e) => { if (e.sender === this.win?.webContents) void this.newCode(); });
    ipcMain.on('rd:support:stop', (e) => { if (e.sender === this.win?.webContents) void this.session?.stop('host_stop'); });
    ipcMain.on('rd:support:set-server', (e, s: string) => { if (e.sender === this.win?.webContents) void this.setServer(s); });
    ipcMain.on('rd:support:copy', (e, s: unknown) => {
      if (e.sender === this.win?.webContents && typeof s === 'string' && /^\d{9}$/.test(s)) void clipboard.writeText(s);
    });
    ipcMain.on('rd:support:close', (e) => { if (e.sender === this.win?.webContents) this.win?.close(); });
    this.win.on('close', () => { void this.shutdown(); });
    void this.win.loadFile(path.join(__dirname, '../../renderer/remote-support.html'));
    this.win.once('ready-to-show', () => this.win?.show());
    if (this.server) void this.newCode();
    return this.win;
  }

  private setView(v: SupportView): void {
    this.view = v;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('rd:support:view', v);
  }

  private async setServer(raw: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(raw.trim());
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) throw new Error('https');
    } catch {
      this.setView({ phase: 'server', server: raw, error: 'https:// 로 시작하는 워크스페이스 주소를 넣으세요' });
      return;
    }
    this.server = url.origin;
    await this.saveServer(this.server);
    await this.newCode();
  }

  private async newCode(): Promise<void> {
    if (this.session?.active || this.finished) return;
    await this.release();
    this.api = new RemoteApi(this.server);
    try {
      const r = await this.api.supportCode();
      this.cred = { kind: 'support', sessionId: r.session_id, secret: r.host_secret };
      this.org = r.org_name;
      this.domain = r.org_domain ?? '';
      this.code = r.code;
      this.setView({ phase: 'code', code: r.code, expiresAt: r.expires_at, org: r.org_name });
      void this.poll();
    } catch (e) {
      const msg = e instanceof HttpError
        ? (e.status === 429 ? '코드를 너무 자주 받았습니다. 잠시 후 다시 시도하세요' : e.status === 404 || e.status === 403 ? '이 서버에서는 원격 지원을 쓸 수 없습니다' : e.message)
        : '서버에 연결하지 못했습니다';
      this.setView({ phase: 'error', message: msg });
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    let since = 'waiting_code';
    try {
      while (this.cred && this.api && !this.session?.active) {
        const cred = this.cred;
        let r;
        try {
          r = await this.api.supportPoll(cred, 25, since);
        } catch {
          await new Promise(res => setTimeout(res, 3000));
          continue;
        }
        if (cred !== this.cred) break; // 새 코드로 바뀜
        since = r.session.status;
        if (r.session.status === 'pending') {
          const who = {
            requester: r.session.requester_name, email: r.session.requester_email ?? '',
            org: r.org_name ?? this.org, domain: r.org_domain ?? this.domain,
          };
          // 코드를 쓴 순간 서버가 폐기했다 — 이 뒤로는 어떻게 끝나든 새 코드를 주지 않는다
          this.finished = true;
          this.setView({ phase: 'pending', code: this.code, ...who, timeoutS: 30 });
          const allow = await askConsent({ ...who, kind: 'support', timeoutS: 30 });
          const d = await this.api.supportDecision(cred, allow).catch(() => null);
          if (allow && d?.livekit && d.session.status === 'active') {
            const api = this.api;
            const startedAt = Date.now();
            this.session = new HostSession({
              sessionId: cred.kind === 'support' ? cred.sessionId : '', requester: who.requester, livekit: d.livekit, addon: this.addon,
              // 사유를 실은 보고가 막혀도(웹 방화벽 등) 세션은 끝나야 한다 — 실패하면 사유 없이 다시
              notifyEnd: async (why) => { await api.supportEnd(cred, why).catch(() => api.supportEnd(cred)).catch(() => {}); },
              onClosed: (reason) => {
                this.session = null;
                this.cred = null;
                this.setView({ phase: 'ended', reason, requester: who.requester, durationS: Math.round((Date.now() - startedAt) / 1000) });
              },
            });
            this.session.start();
            this.setView({ phase: 'active', requester: who.requester, email: who.email, startedAt });
          } else {
            this.cred = null;
            this.setView({ phase: 'ended', reason: 'denied', requester: who.requester, durationS: null });
          }
          break;
        }
        if (r.session.status === 'expired' || r.session.status === 'ended' || r.session.status === 'denied') {
          this.cred = null;
          this.setView({ phase: 'expired', code: this.code });
          break;
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /** 지금 코드·세션을 서버에서 무효로 */
  private async release(): Promise<void> {
    const cred = this.cred;
    this.cred = null;
    if (cred && this.api) await this.api.supportEnd(cred).catch(() => {});
  }

  async shutdown(): Promise<void> {
    await this.session?.stop('host_closed');
    await this.release();
  }
}
