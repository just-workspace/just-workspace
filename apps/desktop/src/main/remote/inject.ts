/**
 * 검증된 입력 메시지를 네이티브 애드온(jw_remote_input)으로 주입한다.
 * 눌린 상태로 남은 키·버튼을 기록해 두었다가 세션 종료 시 전부 해제한다(원격 연결이 끊겨 Shift 가 눌린 상태로 남는 사고 방지).
 * 보안 화면(UAC·잠금)이 표시 중이면 주입하지 않는다 — 일반 프로세스는 주입이 불가하며, 뷰어에는 state 로 통지한다.
 */
import { comboKeys, DEFAULT_LIMITS, type InputMsg, RateLimiter, ratioToPoint, type Rect, SCANCODES } from './protocol';

export interface InputAddon {
  mouseMove(x: number, y: number): boolean;
  mouseButton(button: 0 | 1 | 2, down: boolean): boolean;
  wheel(dx: number, dy: number): boolean;
  key(scancode: number, extended: boolean, down: boolean): boolean;
  secureDesktop(): boolean;
}

export type InjectResult = 'ok' | 'rate' | 'cad_unsupported' | 'secure' | 'noaddon' | 'ignored';

export class Injector {
  private keys = new Set<string>();
  private buttons = new Set<0 | 1 | 2>();
  private limiter: RateLimiter;

  constructor(private readonly addon: InputAddon | null, private screenRect: () => Rect, limiter?: RateLimiter) {
    this.limiter = limiter ?? new RateLimiter(DEFAULT_LIMITS);
  }

  setScreen(rect: () => Rect): void {
    this.screenRect = rect;
  }

  /** 세션이 직접 처리하는 메시지(클립보드)에도 동일한 버킷으로 속도를 제한한다 */
  allow(kind: string): boolean {
    return this.limiter.allow(kind);
  }

  apply(m: InputMsg, secure: boolean): InjectResult {
    if (m.t === 'clip' || m.t === 'clipreq' || m.t === 'mon') return 'ignored'; // 세션이 별도로 처리
    const kind = m.t === 'mm' ? 'mm' : m.t === 'wh' ? 'wh' : 'default';
    if (!this.limiter.allow(kind)) return 'rate';
    if (!this.addon) return 'noaddon';
    if (secure) return 'secure';
    switch (m.t) {
      case 'mm': {
        const p = ratioToPoint(m.x, m.y, this.screenRect());
        this.addon.mouseMove(p.x, p.y);
        return 'ok';
      }
      case 'md':
      case 'mu': {
        const p = ratioToPoint(m.x, m.y, this.screenRect());
        this.addon.mouseMove(p.x, p.y);
        this.addon.mouseButton(m.b, m.t === 'md');
        if (m.t === 'md') this.buttons.add(m.b); else this.buttons.delete(m.b);
        return 'ok';
      }
      case 'wh':
        this.addon.wheel(m.dx, m.dy);
        return 'ok';
      case 'kd':
      case 'ku': {
        const sc = SCANCODES[m.c];
        if (!sc) return 'ignored';
        this.addon.key(sc[0], sc[1], m.t === 'kd');
        if (m.t === 'kd') this.keys.add(m.c); else this.keys.delete(m.c);
        return 'ok';
      }
      case 'sk': {
        const combo = comboKeys(m.k);
        if (!combo) return 'cad_unsupported';
        for (const c of combo) { const sc = SCANCODES[c]; this.addon.key(sc[0], sc[1], true); }
        for (const c of [...combo].reverse()) { const sc = SCANCODES[c]; this.addon.key(sc[0], sc[1], false); }
        return 'ok';
      }
      default:
        return 'ignored';
    }
  }

  /** 세션 종료 — 눌린 상태로 남은 키·버튼을 모두 해제한다 */
  releaseAll(): void {
    if (!this.addon) return;
    for (const c of this.keys) { const sc = SCANCODES[c]; if (sc) this.addon.key(sc[0], sc[1], false); }
    for (const b of this.buttons) this.addon.mouseButton(b, false);
    this.keys.clear();
    this.buttons.clear();
  }

  held(): { keys: string[]; buttons: number[] } {
    return { keys: [...this.keys], buttons: [...this.buttons] };
  }
}
