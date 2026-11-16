/**
 * 캡처 큐 — Page.captureScreenshot 을 **직렬로만** 호출한다.
 *
 * 캡처 두 개가 동시에 실행되면 Chromium 이 clip 을 혼동하며(계측용 전체 화면이 인셋 영역 9장 타일로 출력됨),
 * 페이지 이동 시점에 걸린 캡처는 반환되지 않는다(인셋 0fps). 따라서
 *   - 작업은 하나씩만 실행한다(running 하나). 인셋·아이콘 래스터·계측 스크린샷이 모두 이 큐를 경유한다.
 *   - 동일 key 의 작업이 아직 큐에 있으면 새 작업으로 교체한다(인셋 프레임이 누적되지 않는다). 대기 시간이 과도한 작업은 폐기한다(maxAgeMs).
 *   - 이동 중(main frame 이 로딩을 시작해 DOMContentLoaded 전까지, 상한 3초)에는 정지한다. 걸린 작업은 상한(timeoutMs) 경과 후 실패 처리한다.
 *   - 우선순위: 0(계측) > 1(래스터) > 2(인셋).
 */
import type { Protocol } from 'cdp-protocol'

type Sender = <T extends keyof Protocol.CommandParameters>(m: T, p?: Protocol.CommandParameters[T]) => Promise<Protocol.CommandReturnValues[T]>

export interface CaptureJob {
  key: string
  prio: 0 | 1 | 2
  /** 캡처 직전에 clip 을 결정한다(그 사이 요소가 이동했을 수 있다). undefined 면 생략 */
  clip: () => Promise<Protocol.Page.Viewport | undefined>
  format: 'webp' | 'png' | 'jpeg'
  quality?: number
  maxAgeMs?: number
}

interface Queued { job: CaptureJob; at: number; resolve: (b: Buffer | undefined) => void }

export class CaptureQueue {
  private q: Queued[] = []
  private running = false
  private navUntil = 0
  private navTimer: NodeJS.Timeout | null = null
  stats = { done: 0, dropped: 0, replaced: 0, timeouts: 0, errors: 0, navPauses: 0, busyMs: 0, lastError: '' }

  constructor(private send: Sender, public timeoutMs = 1500) {}

  /** 이동 시작 — 최대 maxMs 동안 정지한다(로딩 완료 신호 수신 시 조기 해제) */
  pauseForNav(maxMs = 3000): void {
    this.stats.navPauses++
    this.navUntil = Date.now() + maxMs
    if (this.navTimer) clearTimeout(this.navTimer)
    this.navTimer = setTimeout(() => { this.navTimer = null; this.pump() }, maxMs + 5)
  }
  resumeAfterNav(): void { this.navUntil = 0; if (this.navTimer) { clearTimeout(this.navTimer); this.navTimer = null } this.pump() }
  get paused(): boolean { return Date.now() < this.navUntil }
  get busy(): boolean { return this.running || this.q.length > 0 }
  /** 큐가 비고 실행 중인 작업이 종료될 때까지 대기(계측용) */
  async idle(maxMs = 3000): Promise<void> { const t = Date.now(); while ((this.running || this.q.length) && Date.now() - t < maxMs) await new Promise(r => setTimeout(r, 15)) }

  submit(job: CaptureJob): Promise<Buffer | undefined> {
    return new Promise(resolve => {
      const i = this.q.findIndex(x => x.job.key === job.key)
      if (i >= 0) { this.q[i].resolve(undefined); this.q.splice(i, 1); this.stats.replaced++ }
      this.q.push({ job, at: Date.now(), resolve })
      this.q.sort((a, b) => a.job.prio - b.job.prio || a.at - b.at)
      this.pump()
    })
  }

  /** 동일 key 가 큐에 있거나 실행 중인지 여부 */
  has(key: string): boolean { return this.q.some(x => x.job.key === key) || this.currentKey === key }
  private currentKey = ''

  drop(prefix: string): void {
    this.q = this.q.filter(x => { if (x.job.key.startsWith(prefix)) { x.resolve(undefined); this.stats.dropped++; return false } return true })
  }

  private pump(): void {
    if (this.running || !this.q.length || this.paused) return
    const it = this.q.shift()!
    if (it.job.maxAgeMs && Date.now() - it.at > it.job.maxAgeMs) { this.stats.dropped++; it.resolve(undefined); this.pump(); return }
    this.running = true
    this.currentKey = it.job.key
    const t0 = performance.now()
    void this.run(it.job).then(buf => { it.resolve(buf); if (buf) this.stats.done++ }).catch(e => {
      this.stats.errors++; this.stats.lastError = String(e).slice(0, 200); it.resolve(undefined)
    }).finally(() => {
      this.stats.busyMs += performance.now() - t0
      this.running = false
      this.currentKey = ''
      this.pump()
    })
  }

  /** 상한 초과로 폐기한 캡처(Chromium 내부에서는 계속 실행 중일 수 있다) — 다음 캡처는 해당 캡처가 종료되거나 상한이 한 번 더 경과할 때까지 대기한다(중첩 시 clip 이 혼동된다) */
  private stuck: Promise<unknown> | null = null

  private async run(job: CaptureJob): Promise<Buffer | undefined> {
    if (this.stuck) { await Promise.race([this.stuck, new Promise(r => setTimeout(r, this.timeoutMs))]); this.stuck = null }
    const clip = await job.clip()
    if (!clip || clip.width < 1 || clip.height < 1) return undefined
    let timer: NodeJS.Timeout | undefined
    const call = this.send('Page.captureScreenshot', { format: job.format, quality: job.format === 'png' ? undefined : job.quality ?? 70, fromSurface: true, captureBeyondViewport: false, clip })
    call.catch(() => { /* 상한 경과 후의 지연 실패 */ })
    try {
      const shot = await Promise.race([
        call,
        new Promise<never>((_, rej) => { timer = setTimeout(() => { this.stats.timeouts++; this.stuck = call; rej(new Error('capture timeout')) }, this.timeoutMs) }),
      ])
      return Buffer.from(shot.data, 'base64')
    } finally { if (timer) clearTimeout(timer) }
  }
}
