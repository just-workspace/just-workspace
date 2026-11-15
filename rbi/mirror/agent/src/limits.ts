/** 토큰 버킷 — 클라이언트 메시지 속도 상한(초당 rate, 순간 burst). 넘는 것은 버린다 */
export class TokenBucket {
  private tokens: number
  private at = Date.now()
  constructor(private rate: number, private burst: number) { this.tokens = burst }
  take(n = 1): boolean {
    const now = Date.now()
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate)
    this.at = now
    if (this.tokens < n) return false
    this.tokens -= n
    return true
  }
}

/** 비동기 자물쇠 — 입력 적용과 수집 읽기를 겹치지 않게(로컬 에코의 iseq 가 정확히 그 상태를 뜻하도록) */
export class Lock {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => undefined)
    return next
  }
}
