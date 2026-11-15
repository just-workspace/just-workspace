/**
 * 원격 데스크톱 호스트 세션 하나 — 동의를 받은 뒤 LiveKit 방에 화면을 보내고, 뷰어 입력을 받아 주입한다.
 * 내 기기(host.ts)와 1회성 지원(support.ts)이 같이 쓴다. 끝내는 길은 하나(stop): 키 떼기 → 창 닫기 → 서버에 종료 알림.
 */
import { BrowserWindow, clipboard, desktopCapturer, ipcMain, screen } from 'electron';
import type { EndWhy, LivekitInfo } from './api';
import { Injector, type InputAddon } from './inject';
import { encodeHost, MAX_CLIP, parseInput, type Rect } from './protocol';
import { qualityParams, type QualityMode } from './quality';
import { createRunner, remoteLog, showBar } from './windows';

export interface HostSessionOptions {
  sessionId: string;
  requester: string;
  livekit: LivekitInfo;
  addon: InputAddon | null;
  /** 서버에 종료를 알린다(끊기·창 닫힘·오류 모두). why 는 진단용 사유 */
  notifyEnd: (why: EndWhy) => Promise<void>;
  onClosed?: (reason: string) => void;
}

const MAX_W = 2560;
const MAX_H = 1600;
const FPS = 30;

export class HostSession {
  private runner: BrowserWindow | null = null;
  private closeBar: (() => void) | null = null;
  private injector: Injector;
  private displayIndex = 0;
  private timers: NodeJS.Timeout[] = [];
  private secure = false;
  private stopped = false;
  /** 뷰어가 고른 화질(quality.ts) — 모니터를 바꿔도 유지된다 */
  private quality: { m: QualityMode; vw: number; vh: number } = { m: 'auto', vw: 0, vh: 0 };
  private readonly onInput = (e: Electron.IpcMainEvent, payload: Uint8Array, from: string) => {
    if (e.sender !== this.runner?.webContents) return;
    if (from !== this.opts.livekit.peer_identity) return; // 상대 정체성에서 온 것만
    this.handle(payload);
  };
  /** 러너가 알린 마지막 오류(실패 사유로 서버에 보낸다) */
  private lastError = '';
  private readonly onRunnerState = (e: Electron.IpcMainEvent, s: string, detail?: unknown) => {
    if (e.sender !== this.runner?.webContents) return;
    if (typeof detail === 'string' && detail) this.lastError = detail.slice(0, 300);
    if (s === 'connected') { this.applyQuality(); return; }
    if (s === 'failed') {
      // 실패 사유 앞에 이 PC 화면 구성 진단을 붙인다(서버 감사 기록 client_detail, 300자)
      void this.diagnose().then((d) => { this.lastError = `${d} | ${this.lastError}`.slice(0, 300); void this.stop('runner_failed'); });
      return;
    }
    if (s === 'closed') void this.stop('room_closed');
  };

  /**
   * 캡처 실패 진단 — 모니터 수·크기·배율·주 모니터, 화면 소스 수, 작은 미리보기가 실제로 그려지는 소스 수.
   * 미리보기가 전부 비면 OS·보안 프로그램(화면 캡처 방지·DRM)이 캡처를 막는 쪽, 일부만 비면 그 모니터만 문제.
   * 예: "displays 2 (2560x1440@1.5*, 1920x1080@1) sources 2 thumbs 1/2"
   */
  private async diagnose(): Promise<string> {
    try {
      const prim = screen.getPrimaryDisplay().id;
      const ds = this.displays().map(d => `${Math.round(d.size.width * d.scaleFactor)}x${Math.round(d.size.height * d.scaleFactor)}@${d.scaleFactor}${d.id === prim ? '*' : ''}`);
      const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 64, height: 36 } });
      const ok = src.filter(x => !x.thumbnail.isEmpty() && x.thumbnail.toBitmap().some(b => b !== 0)).length;
      // "키=값" 여러 개는 앞단 웹 방화벽(WAF)이 공격으로 보고 종료 보고 자체를 403 으로 막을 수 있다 — 낱말과 숫자로 쓴다
      return `displays ${ds.length} (${ds.join(', ')}) sources ${src.length} thumbs ${ok}/${src.length}`;
    } catch (e) {
      return `diag-fail ${e instanceof Error ? e.message : String(e)}`.slice(0, 80);
    }
  }

  constructor(private readonly opts: HostSessionOptions) {
    this.injector = new Injector(opts.addon, () => this.currentRect());
  }

  private displays(): Electron.Display[] {
    return screen.getAllDisplays();
  }

  /** 지금 보내는 모니터의 물리 픽셀 영역(SendInput 좌표계). Windows 는 DIP → 물리 변환 */
  private currentRect(): Rect {
    const ds = this.displays();
    const d = ds[Math.min(this.displayIndex, ds.length - 1)] ?? screen.getPrimaryDisplay();
    const b = process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  /** 실제로 잡히는 화면 크기 — 모니터 물리 해상도를 MAX_W×MAX_H 안으로 비율 유지해 줄인 값 */
  private captureSize(): { w: number; h: number } {
    const r = this.currentRect();
    const k = Math.min(1, MAX_W / r.width, MAX_H / r.height);
    return { w: Math.round(r.width * k), h: Math.round(r.height * k) };
  }

  private applyQuality(): void {
    const view = this.quality.vw && this.quality.vh ? { w: this.quality.vw, h: this.quality.vh } : null;
    const q = qualityParams(this.quality.m, this.captureSize(), view);
    if (this.runner && !this.runner.isDestroyed()) this.runner.webContents.send('rd:runner:quality', q);
    void remoteLog(`[session] 화질 ${q.mode} ${q.maxBitrate / 1e6}Mbps ${q.fps}fps ÷${q.scale}`);
  }

  private readonly onUsedSource = (e: Electron.IpcMainEvent, id: unknown) => {
    if (e.sender !== this.runner?.webContents || typeof id !== 'string') return;
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((src) => {
      const s = src.find(x => x.id === id);
      const i = s ? this.displays().findIndex(d => String(d.id) === s.display_id) : -1;
      if (i >= 0 && i !== this.displayIndex) {
        this.injector.releaseAll();
        this.displayIndex = i;
        void remoteLog(`[session] 다른 모니터로 대체 캡처 — ${i + 1}번`);
        this.sendInfo();
        this.applyQuality();
      }
    });
  };

  private async pickSource(): Promise<Electron.DesktopCapturerSource | null> {
    const ds = this.displays();
    const d = ds[Math.min(this.displayIndex, ds.length - 1)];
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    return sources.find(s => d && s.display_id === String(d.id)) ?? sources[0] ?? null;
  }

  start(): void {
    ipcMain.on('rd:runner:input', this.onInput);
    ipcMain.on('rd:runner:state', this.onRunnerState);
    // 예전 방식 캡처 폴백용 소스 id(러너 capture() 2·3단계)
    ipcMain.handle('rd:runner:source', async (e) => (e.sender === this.runner?.webContents ? (await this.pickSource())?.id ?? null : null));
    // 고른 모니터가 끝내 안 잡히면 러너가 다른 모니터를 차례로 시도한다(4단계) — 화면 소스 id 전부
    ipcMain.handle('rd:runner:sources', async (e) => {
      if (e.sender !== this.runner?.webContents) return [];
      const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      return src.map(s => s.id);
    });
    // 러너가 실제로 잡은 소스 — 다른 모니터로 대체됐으면 입력 좌표·모니터 표시를 그 모니터로 맞춘다
    ipcMain.on('rd:runner:used', this.onUsedSource);
    ipcMain.handle('rd:runner:init', (e) => (e.sender === this.runner?.webContents ? {
      ws_url: this.opts.livekit.ws_url, token: this.opts.livekit.token, peer: this.opts.livekit.peer_identity,
      maxWidth: MAX_W, maxHeight: MAX_H, fps: FPS,
    } : null));
    this.runner = createRunner(() => this.pickSource());
    this.runner.on('closed', () => { this.runner = null; void this.stop('runner_closed'); });
    this.closeBar = showBar(this.opts.requester, () => void this.stop('host_stop'));

    // 보안 화면(UAC·잠금) 감지 — 바뀔 때만 뷰어에 알린다
    this.timers.push(setInterval(() => {
      const s = !!this.opts.addon?.secureDesktop();
      if (s !== this.secure) { this.secure = s; this.send({ t: 'state', s: s ? 'secure_desktop' : 'ok' }); }
    }, 1000));
    // 호스트 클립보드는 자동으로 내보내지 않는다 — 뷰어가 [클립보드 받기](clipreq)를 누를 때만 보낸다(텍스트만, 길이 제한)
    // 연결 직후·주기적으로 화면 정보
    this.timers.push(setInterval(() => this.sendInfo(), 10_000));
    setTimeout(() => this.sendInfo(), 1500);
  }

  private sendInfo(): void {
    const ds = this.displays();
    const r = this.currentRect();
    this.send({
      t: 'info', w: r.width, h: r.height, cur: this.displayIndex, q: this.quality.m,
      mons: ds.map((d, i) => ({ i, name: d.label || `${i + 1}`, w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor) })),
    });
  }

  private send(msg: unknown): void {
    if (this.runner && !this.runner.isDestroyed()) this.runner.webContents.send('rd:runner:send', encodeHost(msg));
  }

  private handle(payload: Uint8Array): void {
    const m = parseInput(payload instanceof Uint8Array ? payload : new Uint8Array(payload as ArrayBuffer));
    if (!m) { this.send({ t: 'err', code: 'bad' }); return; }
    if ((m.t === 'clip' || m.t === 'clipreq') && !this.injector.allow(m.t)) return;
    if (m.t === 'clip') {
      void clipboard.writeText(m.text).catch(() => {});
      return;
    }
    if (m.t === 'clipreq') {
      void clipboard.readText().then((c) => {
        if (c && c.length <= MAX_CLIP) this.send({ t: 'clip', text: c });
        else this.send({ t: 'err', code: c ? 'clip_too_long' : 'clip_empty' });
      }).catch(() => this.send({ t: 'err', code: 'clip_empty' }));
      return;
    }
    if (m.t === 'q') {
      if (!this.injector.allow('q')) return;
      this.quality = { m: m.m, vw: m.vw, vh: m.vh };
      this.applyQuality();
      this.send({ t: 'q', m: m.m });
      return;
    }
    if (m.t === 'mon') {
      if (m.i < this.displays().length && m.i !== this.displayIndex) {
        this.injector.releaseAll();
        this.displayIndex = m.i;
        this.runner?.webContents.send('rd:runner:switch');
        setTimeout(() => { this.sendInfo(); this.applyQuality(); }, 800);
      }
      return;
    }
    const r = this.injector.apply(m, this.secure);
    if (r === 'cad_unsupported') this.send({ t: 'err', code: 'cad_unsupported' });
    else if (r === 'secure') this.send({ t: 'state', s: 'secure_desktop' });
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    void remoteLog(`[session] 종료 ${reason}${this.lastError ? ` — ${this.lastError}` : ''}`);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.injector.releaseAll();
    ipcMain.removeListener('rd:runner:input', this.onInput);
    ipcMain.removeListener('rd:runner:state', this.onRunnerState);
    ipcMain.removeHandler('rd:runner:init');
    ipcMain.removeHandler('rd:runner:source');
    ipcMain.removeHandler('rd:runner:sources');
    ipcMain.removeListener('rd:runner:used', this.onUsedSource);
    this.closeBar?.();
    this.closeBar = null;
    const r = this.runner;
    this.runner = null;
    if (r && !r.isDestroyed()) { r.webContents.send('rd:runner:stop'); setTimeout(() => { if (!r.isDestroyed()) r.destroy(); }, 500); }
    const why: EndWhy = { reason: reason.replace(/[^a-z_]/g, '_').slice(0, 40), ...(this.lastError ? { detail: this.lastError } : {}) };
    try { await this.opts.notifyEnd(why); } catch (e) { console.warn('[remote] 종료 알림 실패', e); }
    this.opts.onClosed?.(reason);
  }

  get active(): boolean {
    return !this.stopped;
  }
}
