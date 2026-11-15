/**
 * 자산 — 원격 페이지가 받은 이미지 바이트를 **디코드→재인코딩(WebP)** 해 sha256 으로 보관한다.
 *
 * 원본 바이트는 클라이언트로 가지 않는다. 가는 것은 sharp(libvips) 가 새로 만든 WebP 한 종류뿐이고,
 * 메타데이터(EXIF/ICC/XMP)는 기본 제거, 치수 상한 4096, 입력 픽셀 상한. SVG 이미지도 여기서 래스터가 된다(librsvg, 버퍼 입력 — 외부 참조 안 따라감).
 * 바이트 출처: Network.getResponseBody(요청 id 를 responseReceived 에서 기억) → 실패하면 Page.getResourceContent → data: URL 직접 디코드.
 * 에이전트는 **원격이 이미 받은 것만** 쓴다 — 새로 내려받지 않는다(네트워크 격리는 netfilter 가, 이건 원격 캐시를 읽을 뿐).
 * 상한: 세션당 자산 개수·총 바이트(넘으면 새 자산을 만들지 않고 'limit' 알림).
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { Protocol } from 'cdp-protocol'

export interface Asset { sha: string; buf: Buffer; mime: string; w: number; h: number }

type Sender = <T extends keyof Protocol.CommandParameters>(m: T, p?: Protocol.CommandParameters[T]) => Promise<Protocol.CommandReturnValues[T]>

const MAX_DIM = 4096
const MAX_INPUT_BYTES = 20 * 1024 * 1024
const LOSSLESS_PIXELS = 256 * 256

export interface AssetLimits { maxCount: number; maxBytes: number }

export class AssetStore {
  private byUrl = new Map<string, { sha?: string; failed?: boolean }>()
  private bySha = new Map<string, Asset>()
  private reqByUrl = new Map<string, string>()
  private frameId = ''
  private bytes = 0
  limited = false
  stats = { fetched: 0, failed: 0, inBytes: 0, outBytes: 0, encodeMs: 0, rasters: 0, count: 0 }

  constructor(private send: Sender, private onReady: (url: string) => void, private limits: AssetLimits = { maxCount: 4000, maxBytes: 256 * 1024 * 1024 }, private onLimit?: () => void) {}

  /** Network 이벤트에서 요청 id 기억(이미지만) */
  onResponse(ev: Protocol.Network.responseReceivedPayload): void {
    const mime = ev.response.mimeType || ''
    if (ev.type === 'Image' || mime.startsWith('image/')) {
      this.reqByUrl.set(ev.response.url, ev.requestId)
      if (this.reqByUrl.size > 20000) this.reqByUrl.delete(this.reqByUrl.keys().next().value!)
    }
  }
  setFrame(frameId: string): void { this.frameId = frameId }

  get(sha: string): Asset | undefined { return this.bySha.get(sha) }

  /** URL 의 재인코딩 자산 sha. 아직 없으면 undefined(요청만 걸어 둔다 — 준비되면 onReady(url)) */
  shaFor(url: string): string | undefined {
    const e = this.byUrl.get(url)
    if (e) return e.sha
    if (this.full()) return undefined
    const entry: { sha?: string; failed?: boolean } = {}
    this.byUrl.set(url, entry)
    void this.fetchAndEncode(url).then(a => {
      if (a) { entry.sha = a.sha; this.keep(a); this.onReady(url) } else entry.failed = true
    }).catch(() => { entry.failed = true; this.stats.failed++ })
    return undefined
  }

  /** 우리가 찍은 픽셀(아이콘 래스터) → 재인코딩 WebP(무손실) 자산 */
  async putRaster(png: Buffer): Promise<string | undefined> {
    if (this.full()) return undefined
    try {
      const out = await sharp(png, { limitInputPixels: MAX_DIM * MAX_DIM }).webp({ lossless: true, effort: 2 }).toBuffer({ resolveWithObject: true })
      const sha = createHash('sha256').update(out.data).digest('hex')
      this.stats.rasters++
      this.keep({ sha, buf: out.data, mime: 'image/webp', w: out.info.width, h: out.info.height })
      return sha
    } catch { return undefined }
  }

  private full(): boolean {
    if (this.bySha.size >= this.limits.maxCount || this.bytes >= this.limits.maxBytes) {
      if (!this.limited) { this.limited = true; this.onLimit?.() }
      return true
    }
    return false
  }
  private keep(a: Asset): void {
    if (this.bySha.has(a.sha)) return
    this.bySha.set(a.sha, a)
    this.bytes += a.buf.length
    this.stats.count = this.bySha.size
  }

  private async rawBytes(url: string): Promise<Buffer | undefined> {
    if (url.startsWith('data:')) {
      const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url)
      if (!m) return undefined
      try { return m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8') } catch { return undefined }
    }
    const rid = this.reqByUrl.get(url)
    if (rid) {
      try {
        const r = await this.send('Network.getResponseBody', { requestId: rid })
        return Buffer.from(r.body, r.base64Encoded ? 'base64' : 'utf8')
      } catch { /* 버퍼에서 밀렸을 수 있다 */ }
    }
    if (this.frameId) {
      try {
        const r = await this.send('Page.getResourceContent', { frameId: this.frameId, url })
        return Buffer.from(r.content, r.base64Encoded ? 'base64' : 'utf8')
      } catch { /* 캐시에 없음 */ }
    }
    return undefined
  }

  private async fetchAndEncode(url: string): Promise<Asset | undefined> {
    const raw = await this.rawBytes(url)
    if (!raw || raw.length === 0 || raw.length > MAX_INPUT_BYTES) { this.stats.failed++; return undefined }
    const t0 = performance.now()
    try {
      const img = sharp(raw, { limitInputPixels: MAX_DIM * MAX_DIM, animated: false, failOn: 'none' })
      const meta = await img.metadata()
      let pipe = img
      const w = meta.width ?? 0, h = meta.height ?? 0
      if (w > MAX_DIM || h > MAX_DIM) pipe = pipe.resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside' })
      const lossless = w * h <= LOSSLESS_PIXELS
      const out = await pipe.webp({ quality: 82, lossless, effort: 3 }).toBuffer({ resolveWithObject: true })
      const sha = createHash('sha256').update(out.data).digest('hex')
      this.stats.fetched++; this.stats.inBytes += raw.length; this.stats.outBytes += out.data.length; this.stats.encodeMs += performance.now() - t0
      return { sha, buf: out.data, mime: 'image/webp', w: out.info.width, h: out.info.height }
    } catch {
      this.stats.failed++
      return undefined
    }
  }
}
