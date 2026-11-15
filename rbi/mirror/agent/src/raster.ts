/**
 * 아이콘 래스터 — 작성자 아이콘 폰트(Font Awesome·Glyphicons 따위, 사용자 영역 글리프)로 그린 상자를 원격에서 찍어 자산으로 보낸다.
 * 폰트 바이트는 넘기지 않는다(웹폰트 파서 표면). 사용자 PC 가 받는 것은 우리가 찍은 픽셀의 무손실 WebP 뿐.
 *
 * 키 = (글자·폰트·크기·굵기·색·상자 크기·뒤 배경) — 같은 아이콘은 한 번만 찍는다. 화면 밖이면 보일 때까지 미룬다.
 * 캡처는 capture-queue 의 한 줄(우선순위 1)로 — 인셋·계측과 겹치지 않는다.
 */
import type { CaptureQueue } from './capture-queue.ts'
import type { AssetStore } from './assets.ts'

export class RasterStore {
  private sha = new Map<string, string>()
  private failed = new Map<string, number>()
  /** 키 → 그 키를 기다리는 노드 id */
  private waiting = new Map<string, Set<number>>()
  /** 노드 → 키(지금 원하는 것) */
  private wantOf = new Map<number, string>()
  stats = { captured: 0, failed: 0, cached: 0 }

  constructor(
    private queue: CaptureQueue,
    private assets: AssetStore,
    /** 노드의 지금 뷰포트 사각형(수집기) */
    private vrect: (id: number) => Promise<[number, number, number, number] | null>,
    private onReady: (ids: Iterable<number>) => void,
    private viewport: () => { w: number; h: number },
    public maxPerPump = 6,
  ) {}

  reset(): void { this.waiting.clear(); this.wantOf.clear() }

  get(nodeId: number, key: string): string | undefined {
    const hit = this.sha.get(key)
    if (hit) { this.stats.cached++; this.wantOf.delete(nodeId); return hit }
    if ((this.failed.get(key) || 0) >= 3) return undefined
    this.wantOf.set(nodeId, key)
    let set = this.waiting.get(key); if (!set) { set = new Set(); this.waiting.set(key, set) }
    set.add(nodeId)
    return undefined
  }

  forget(nodeId: number): void {
    const k = this.wantOf.get(nodeId)
    if (k) { this.waiting.get(k)?.delete(nodeId); if (!this.waiting.get(k)?.size) this.waiting.delete(k) }
    this.wantOf.delete(nodeId)
  }

  get pending(): number { return this.waiting.size }

  /** 틱마다: 기다리는 키 중 보이는 노드가 있는 것을 몇 개 찍는다 */
  pump(): void {
    let n = 0
    for (const [key, ids] of this.waiting) {
      if (n >= this.maxPerPump) break
      if (this.queue.has(`r:${key}`)) continue
      const id = ids.values().next().value as number | undefined
      if (id === undefined) { this.waiting.delete(key); continue }
      n++
      void this.capture(key, id)
    }
  }

  private async capture(key: string, id: number): Promise<void> {
    const vp = this.viewport()
    const png = await this.queue.submit({
      key: `r:${key}`, prio: 1, format: 'png', maxAgeMs: 2000,
      clip: async () => {
        const r = await this.vrect(id)
        if (!r) return undefined
        const [x, y, w, h] = r
        // 완전히 보일 때만(잘린 아이콘을 캐시하지 않게)
        if (w < 1 || h < 1 || w > 512 || h > 512 || x < 0 || y < 0 || x + w > vp.w || y + h > vp.h) return undefined
        return { x, y, width: w, height: h, scale: 1 }
      },
    })
    if (!png) return // 화면 밖 — 다음 펌프에서 다시
    const sha = await this.assets.putRaster(png)
    if (!sha) { this.failed.set(key, (this.failed.get(key) || 0) + 1); this.stats.failed++; return }
    this.sha.set(key, sha)
    this.stats.captured++
    const ids = this.waiting.get(key)
    this.waiting.delete(key)
    if (ids) { for (const i of ids) this.wantOf.delete(i); this.onReady(ids) }
  }
}
