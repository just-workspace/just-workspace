/**
 * 인셋 — canvas/video/iframe/embed/shadow host 영역을 WebP 로 10~15fps 찍어 바이너리 프레임으로 보낸다(콘솔은 P1 에서 이것으로).
 * 캡처는 capture-queue 한 줄(우선순위 2, 같은 노드 키는 최신만, 200ms 넘게 기다린 프레임은 버림) — P0 의 동시 캡처 clip 섞임·이동 중 무한 대기를 없앴다.
 * 바뀌지 않은 프레임(바이트 해시 같음)은 보내지 않는다. 뷰포트와 겹치는 부분만 찍고, 잘린 위치는 프레임 머리에 적는다.
 * 프레임 머리: [0x01][u32 nodeId][u32 seq][u16 w][u16 h][i16 dx][i16 dy] + webp (dx,dy = 노드 상자 안에서의 위치)
 */
import { createHash } from 'node:crypto'
import { INSET_FRAME_TAG, INSET_HEADER_BYTES } from '../../protocol/vocab.ts'
import type { CaptureQueue } from './capture-queue.ts'

export interface InsetTarget { id: number }

export class InsetStreamer {
  private lastHash = new Map<number, string>()
  private seq = 0
  private timer: NodeJS.Timeout | null = null
  stats = { frames: 0, skipped: 0, bytes: 0, offscreen: 0 }

  constructor(
    private queue: CaptureQueue,
    private targets: () => number[],
    /** 노드의 지금 뷰포트 사각형 */
    private vrect: (id: number) => Promise<[number, number, number, number] | null>,
    private viewport: () => { w: number; h: number },
    private emit: (buf: Buffer) => void,
    public fps = 12, public quality = 70,
  ) {}

  start(): void { if (!this.timer) this.timer = setInterval(() => this.tick(), Math.round(1000 / this.fps)) }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null } this.queue.drop('i:') }
  reset(): void { this.lastHash.clear() }

  private tick(): void {
    const ids = this.targets()
    for (const id of ids) {
      if (this.queue.has(`i:${id}`)) continue // 앞 프레임이 아직 — 쌓지 않는다
      let off: [number, number] = [0, 0]
      let size: [number, number] = [0, 0]
      void this.queue.submit({
        key: `i:${id}`, prio: 2, format: 'webp', quality: this.quality, maxAgeMs: 200,
        clip: async () => {
          const r = await this.vrect(id)
          if (!r) return undefined
          const vp = this.viewport()
          const [nx, ny, nw, nh] = r
          const x0 = Math.max(0, nx), y0 = Math.max(0, ny), x1 = Math.min(vp.w, nx + nw), y1 = Math.min(vp.h, ny + nh)
          if (x1 - x0 < 2 || y1 - y0 < 2) { this.stats.offscreen++; return undefined }
          off = [Math.round(x0 - nx), Math.round(y0 - ny)]
          size = [Math.round(x1 - x0), Math.round(y1 - y0)]
          return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: 1 }
        },
      }).then(data => {
        if (!data) return
        const h = createHash('sha1').update(data).update(`${off}`).digest('hex')
        if (this.lastHash.get(id) === h) { this.stats.skipped++; return }
        this.lastHash.set(id, h)
        const head = Buffer.alloc(INSET_HEADER_BYTES)
        head.writeUInt8(INSET_FRAME_TAG, 0)
        head.writeUInt32BE(id >>> 0, 1)
        head.writeUInt32BE(++this.seq >>> 0, 5)
        head.writeUInt16BE(Math.min(65535, size[0]), 9)
        head.writeUInt16BE(Math.min(65535, size[1]), 11)
        head.writeInt16BE(Math.max(-32768, Math.min(32767, off[0])), 13)
        head.writeInt16BE(Math.max(-32768, Math.min(32767, off[1])), 15)
        const frame = Buffer.concat([head, data])
        this.stats.frames++; this.stats.bytes += frame.length
        this.emit(frame)
      })
    }
  }
}
