/**
 * 미러 세션 — Chromium 하나(Playwright, --remote-debugging-pipe, 포트 없음)를 소유하고 뷰어 하나에게 어휘를 흘린다.
 *
 * 틱: (격리 world 의) 수집기 tick() → 바뀐 원시 레코드만 → convert → VNode JSON 비교 → patch. 문서가 바뀌면(이동) 전체 → snapshot.
 * 틱을 부르는 신호: 32px 스크린캐스트 프레임(무언가 칠해졌다) · 입력 · 자산/폰트/래스터 준비 · 이동. 신호가 없으면 느린 유휴 틱.
 * 틱 간격은 직전 틱 비용의 2배 이상(최소 33ms) — 큰 페이지가 CPU 를 다 먹지 않게.
 * 정책(클립보드·다운로드·업로드)은 여기서 강제한다 — 클라이언트가 무엇을 보내든 막힌 방향은 원격에 닿지 않는다.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'
import { chromium, type BrowserContext, type CDPSession, type Page, type Download, type FileChooser, type Dialog } from 'playwright-core'
import type { Protocol } from 'cdp-protocol'
import {
  COMPUTED_STYLE_ALLOWLIST, LIMITS, PROTOCOL_VERSION, type ClientMsg, type DocInfo, type PolicyInfo, type ServerMsg, type VNode,
  cleanText, fnv1a, isColor, validateClientMsg,
} from '../../protocol/vocab.ts'
import { collectorSource, type RawRec, type TickResult } from './page/collector.ts'
import { convert, SYNTH_BASE, synthId, type ConvertDeps } from './convert.ts'
import { AssetStore } from './assets.ts'
import { FontResolver, type PlatformFont } from './fonts.ts'
import { CaptureQueue } from './capture-queue.ts'
import { InsetStreamer } from './inset.ts'
import { RasterStore } from './raster.ts'
import { InputBridge } from './input.ts'
import { Lock, TokenBucket } from './limits.ts'

type Sender = <T extends keyof Protocol.CommandParameters>(m: T, p?: Protocol.CommandParameters[T]) => Promise<Protocol.CommandReturnValues[T]>

export interface MirrorConfig {
  url: string
  sid: string
  vw: number
  vh: number
  chromium?: string
  policy: PolicyInfo
  /** Chromium URLAllowlist 와 같은 호스트 목록(host[:port]) — 신뢰 크롬 알림용(차단 자체는 Chromium 정책이 한다) */
  allowHosts: string[]
  /** 뷰어 없음/입력 없음 자동 종료(초). 0 이면 끔 */
  idleSec: number
  maxUploadBytes: number
  trace: boolean
  log: (...a: unknown[]) => void
}

const WORLD = 'jw-mirror'
const MIN_TICK_MS = 33
const IDLE_TICK_MS = 400
const EVAL_TIMEOUT_MS = 4000
const SNAPSHOT_CHUNK = 6000
const COLLECTOR_SRC = collectorSource({ styles: COMPUTED_STYLE_ALLOWLIST, maxNodes: LIMITS.maxNodes, verifyMs: 1000 })

export interface DownloadRec { path: string; name: string; size: number }

export class MirrorSession {
  ctx!: BrowserContext
  page!: Page
  cdp!: CDPSession
  send!: Sender
  queue!: CaptureQueue
  assets!: AssetStore
  fonts!: FontResolver
  raster!: RasterStore
  insets!: InsetStreamer
  input!: InputBridge
  ws: WebSocket | null = null

  private worldId: number | null = null
  private installing: Promise<void> | null = null
  private seq = 0
  private raw = new Map<number, RawRec>()
  private nodes = new Map<number, VNode>()
  private json = new Map<number, string>()
  private synthOf = new Map<number, Set<number>>()
  /** 스타일 출처 요소 → 그 글자 노드들(텍스트 스타일은 부모 계산값이라, 부모가 바뀌면 글자 레코드가 같아도 다시 변환해야 한다) */
  private textsOf = new Map<number, Set<number>>()
  private urlUsers = new Map<string, Set<number>>()
  private iconHosts = new Map<number, string>()
  private reconvert = new Set<number>()
  private doc: DocInfo = { cw: 1, ch: 1, vw: 1, vh: 1, sx: 0, sy: 0, url: '', title: '' }
  private docJson = ''
  private needFull = true
  private needSnapshot = true
  private painted = false
  private dirty = true
  private ticking = false
  private lastTickAt = 0
  private lastTickCost = 0
  private timer: NodeJS.Timeout | null = null
  private timerAt = 0
  private focusId = 0
  private lastVal = ''
  private degradedSent = false
  private dialogs = new Map<number, Dialog>()
  private dialogSeq = 0
  private choosers = new Map<string, { fc: FileChooser; multi: boolean; files: string[]; bytes: number }>()
  downloads = new Map<string, DownloadRec>()
  private bucket = new TokenBucket(LIMITS.clientMsgsPerSec, LIMITS.clientMsgBurst)
  /** 입력 적용 ↔ 수집 읽기 직렬화 */
  private lock = new Lock()
  private lastInputAt = Date.now()
  private lastViewerAt = Date.now()
  private tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'))
  bytesOut = 0
  stats = {
    ticks: 0, collectMs: 0, maxCollectMs: 0, convertMs: 0, lastCollectMs: 0, recs: 0, patches: 0, snapshots: 0, bytesPatch: 0,
    fullPasses: 0, worldInstalls: 0, evalErrors: 0, droppedClientMsgs: 0, rejectedClientMsgs: 0,
    work: { style: 0, geom: 0, text: 0, verify: 0, geomAll: 0 },
    tickHist: [] as number[],
  }

  constructor(private cfg: MirrorConfig) {}

  async start(): Promise<void> {
    const exe = this.cfg.chromium || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)
    // 기본(영구) 컨텍스트 — 관리 정책 IncognitoModeAvailability=1 이 newContext(=시크릿)를 막는다(P0)
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-profile-'))
    this.ctx = await chromium.launchPersistentContext(profile, {
      executablePath: exe, headless: true,
      viewport: { width: this.cfg.vw, height: this.cfg.vh }, deviceScaleFactor: 1, locale: 'ko-KR', ignoreHTTPSErrors: true,
      acceptDownloads: this.cfg.policy.dl,
      args: [
        '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-smooth-scrolling', '--hide-scrollbars',
        '--lang=ko-KR', '--font-render-hinting=none', '--disable-features=TranslateUI',
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      ],
    })
    this.page = this.ctx.pages()[0] ?? await this.ctx.newPage()
    this.cdp = await this.ctx.newCDPSession(this.page)
    this.send = ((m: string, p?: unknown) => this.cdp.send(m as never, p as never)) as Sender
    this.queue = new CaptureQueue(this.send)
    this.assets = new AssetStore(this.send, url => this.onAsset(url), undefined, () => this.notify({ t: 'notice', k: 'limit', detail: 'assets' }))
    this.fonts = new FontResolver(id => this.queryFonts(id), ids => this.requeue(ids))
    const vrect = (id: number) => this.call<[number, number, number, number] | null>(`__jwm.vrect(${id | 0})`).then(r => r ?? null)
    const viewport = () => ({ w: this.doc.vw || this.cfg.vw, h: this.doc.vh || this.cfg.vh })
    this.raster = new RasterStore(this.queue, this.assets, vrect, ids => this.requeue(ids), viewport)
    this.insets = new InsetStreamer(this.queue, () => this.insetTargets(), vrect, viewport, buf => this.sendBinary(buf))
    this.input = new InputBridge(this.send, expr => this.call(expr), this.cfg.policy, m => this.notify(m))

    await this.send('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024 })
    this.cdp.on('Network.responseReceived', ev => this.assets.onResponse(ev))
    this.cdp.on('Network.requestWillBeSent', ev => this.onRequest(ev))
    await this.send('Page.enable')
    await this.send('DOM.enable')
    await this.send('CSS.enable')
    await this.send('DOM.getDocument', { depth: 0 }).catch(() => undefined)
    this.cdp.on('Page.frameStartedLoading', ev => { if (ev.frameId === this.mainFrame) this.queue.pauseForNav() })
    this.cdp.on('Page.frameNavigated', ev => { if (!ev.frame.parentId) this.onNavigated(ev.frame.id) })
    this.cdp.on('Page.domContentEventFired', () => { this.queue.resumeAfterNav(); this.markDirty() })
    this.cdp.on('Page.loadEventFired', () => { this.queue.resumeAfterNav(); this.markDirty() })
    this.cdp.on('Page.frameStoppedLoading', ev => { if (ev.frameId === this.mainFrame) { this.queue.resumeAfterNav(); this.markDirty() } })
    this.cdp.on('DOM.documentUpdated', () => { void this.send('DOM.getDocument', { depth: 0 }).catch(() => undefined) })
    // 시각 변화 감지기 — 32px 스크린캐스트. 프레임이 오면 "무언가 칠해졌다"(변이 없는 :hover·애니메이션 포함)
    this.cdp.on('Page.screencastFrame', ev => { this.painted = true; this.markDirty(); void this.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {}) })
    await this.send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 32, maxHeight: 32, everyNthFrame: 1 })
    const tree = await this.send('Page.getFrameTree')
    this.mainFrame = tree.frameTree.frame.id
    this.assets.setFrame(this.mainFrame)

    this.page.on('dialog', d => this.onDialog(d))
    this.page.on('download', d => { void this.onDownload(d) })
    this.page.on('filechooser', fc => this.onFileChooser(fc))
    this.ctx.on('page', p => { void this.onPopup(p) })

    this.cfg.log('chromium', this.ctx.browser()?.version() ?? '(persistent)', 'viewport', this.cfg.vw, this.cfg.vh, '→', this.cfg.url, 'policy', JSON.stringify(this.cfg.policy))
    await this.page.goto(this.cfg.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => this.cfg.log('goto failed', String(e).slice(0, 200)))
    this.schedule()
    if (this.cfg.idleSec > 0) setInterval(() => this.idleCheck(), 15000).unref()
  }
  private mainFrame = ''

  // ── 격리 world ──
  private async install(): Promise<void> {
    if (this.installing) return this.installing
    this.installing = (async () => {
      try {
        const tree = await this.send('Page.getFrameTree')
        this.mainFrame = tree.frameTree.frame.id
        const w = await this.send('Page.createIsolatedWorld', { frameId: this.mainFrame, worldName: WORLD, grantUniveralAccess: false })
        const r = await this.send('Runtime.evaluate', { expression: COLLECTOR_SRC, contextId: w.executionContextId, returnByValue: true })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
        this.worldId = w.executionContextId
        this.needFull = true
        this.stats.worldInstalls++
      } catch (e) {
        this.worldId = null
        if (this.cfg.trace) this.cfg.log('install failed', String(e).slice(0, 160))
      } finally { this.installing = null }
    })()
    return this.installing
  }

  /** 수집기 호출(값). 문맥이 사라졌으면 null 로 — 다음 틱에 다시 심는다 */
  async call<T>(expr: string): Promise<T | undefined> {
    if (this.worldId === null) return undefined
    const ctxId = this.worldId
    let timer: NodeJS.Timeout | undefined
    try {
      const r = await Promise.race([
        this.send('Runtime.evaluate', { expression: expr, contextId: ctxId, returnByValue: true }),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('eval timeout')), EVAL_TIMEOUT_MS) }),
      ])
      if (r.exceptionDetails) { this.stats.evalErrors++; if (/__jwm is not defined/.test(r.exceptionDetails.exception?.description || r.exceptionDetails.text)) this.worldId = null; return undefined }
      return r.result.value as T
    } catch (e) {
      this.stats.evalErrors++
      if (/context|Cannot find|destroyed|Target closed/i.test(String(e)) && this.worldId === ctxId) this.worldId = null
      return undefined
    } finally { if (timer) clearTimeout(timer) }
  }

  private async queryFonts(refId: number): Promise<PlatformFont[] | undefined> {
    if (this.worldId === null) return undefined
    const r = await this.send('Runtime.evaluate', { expression: `__jwm.el(${refId | 0})`, contextId: this.worldId, returnByValue: false })
    const oid = r.result.objectId
    if (!oid) return undefined
    try {
      const n = await this.send('DOM.requestNode', { objectId: oid })
      // 텍스트 노드면 부모 요소로(getPlatformFontsForNode 는 요소의 자식 텍스트를 본다)
      let nodeId = n.nodeId
      const d = await this.send('DOM.describeNode', { nodeId })
      if (d.node.nodeType === 3 && d.node.parentId) nodeId = d.node.parentId
      const f = await this.send('CSS.getPlatformFontsForNode', { nodeId })
      return f.fonts
    } finally { void this.send('Runtime.releaseObject', { objectId: oid }).catch(() => {}) }
  }

  // ── 신호 ──
  markDirty(): void { this.dirty = true; this.schedule() }

  private schedule(): void {
    const since = performance.now() - this.lastTickAt
    const minGap = Math.max(MIN_TICK_MS, Math.min(500, this.lastTickCost * 2))
    const wait = this.dirty ? Math.max(0, minGap - since) : IDLE_TICK_MS
    const at = performance.now() + wait
    if (this.timer) { if (this.timerAt <= at + 1) return; clearTimeout(this.timer) }
    this.timerAt = at
    this.timer = setTimeout(() => { this.timer = null; void this.tick() }, wait)
  }

  private onNavigated(frameId: string): void {
    this.mainFrame = frameId
    this.assets.setFrame(frameId)
    this.worldId = null
    this.needFull = true
    this.queue.pauseForNav()
    this.raster.reset()
    this.insets.reset()
    this.iconHosts.clear()
    this.markDirty()
  }

  private onRequest(ev: Protocol.Network.requestWillBeSentPayload): void {
    if (ev.type !== 'Document' || ev.frameId !== this.mainFrame) return
    try {
      const u = new URL(ev.request.url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return
      if (!hostAllowed(u, this.cfg.allowHosts)) this.notify({ t: 'notice', k: 'blocked-nav', detail: cleanText(`${u.protocol}//${u.host}${u.pathname}`).slice(0, 500) })
    } catch { /* 무시 */ }
  }

  // ── 틱 ──
  private async tick(): Promise<void> {
    if (this.ticking) { this.schedule(); return }
    this.ticking = true
    const wasDirty = this.dirty
    this.dirty = false
    try {
      if (!this.ws) return
      if (this.dialogs.size) return // JS 대화상자가 열려 있으면 렌더러가 멈춰 있다
      if (this.worldId === null) { await this.install(); if (this.worldId === null) { this.dirty = true; return } }
      if (!wasDirty && performance.now() - this.lastTickAt < IDLE_TICK_MS && !this.needFull) return
      let pre = ''
      if (this.input.pointer) { pre += `__jwm.pointer(${this.input.pointer[0]}, ${this.input.pointer[1]});`; this.input.pointer = null }
      if (this.input.pressed) { pre += '__jwm.active();'; this.input.pressed = false }
      const opts = { full: this.needFull, paint: this.painted }
      this.needFull = false
      this.painted = false
      // 입력 적용과 겹치지 않게 읽는다 — 그래야 iseq(여기까지 적용됨)가 읽은 상태와 정확히 맞는다(로컬 에코 대조)
      let iseq = 0
      const t0 = performance.now()
      const out = await this.lock.run(() => { iseq = this.input.appliedSeq; return this.call<string>(`${pre}__jwm.tick(${JSON.stringify(opts)})`) })
      const t1 = performance.now()
      if (!out) { if (opts.full) this.needFull = true; this.dirty = true; return }
      const res = JSON.parse(out) as TickResult
      this.apply(res, iseq)
      const t2 = performance.now()
      this.lastTickAt = performance.now()
      this.lastTickCost = t2 - t0
      const st = this.stats
      st.ticks++; st.collectMs += t1 - t0; st.lastCollectMs = res.ms; st.maxCollectMs = Math.max(st.maxCollectMs, res.ms); st.convertMs += t2 - t1
      st.recs += res.recs.length
      if (res.full) st.fullPasses++
      st.work.style += res.work.style; st.work.geom += res.work.geom; st.work.text += res.work.text; if (res.work.verify) st.work.verify++; if (res.work.geomAll) st.work.geomAll++
      if (res.recs.length || res.del.length) { st.tickHist.push(Math.round((t2 - t0) * 10) / 10); if (st.tickHist.length > 4000) st.tickHist.shift() }
      if (this.cfg.trace && (res.recs.length || res.del.length)) this.cfg.log(`tick full=${res.full} recs=${res.recs.length} del=${res.del.length} in-page=${res.ms}ms total=${(t2 - t0).toFixed(1)}ms work=${JSON.stringify(res.work)}`)
      this.raster.pump()
    } catch (e) {
      if (this.cfg.trace) this.cfg.log('tick error', String(e).slice(0, 200))
    } finally {
      this.ticking = false
      this.schedule()
    }
  }

  private deps: ConvertDeps = {
    shaFor: (url, id) => {
      let set = this.urlUsers.get(url); if (!set) { set = new Set(); this.urlUsers.set(url, set) }
      set.add(id)
      return this.assets.shaFor(url)
    },
    font: (id, ref, ff, fw, fi, text) => this.fonts.resolve(id, ref, ff, fw, fi, text),
    raster: (id, key) => this.raster.get(id, key),
    raw: id => this.raw.get(id),
    iconHost: (id, set) => {
      if (set === undefined) return this.iconHosts.get(id)
      if (this.iconHosts.get(id) !== set) { this.iconHosts.set(id, set); this.reconvert.add(id); this.dirty = true }
      return set
    },
  }

  private apply(res: TickResult, iseq: number): void {
    const add: VNode[] = [], upd: VNode[] = [], del: number[] = []
    if (res.full) {
      // 새 문서(또는 다시 읽기) — 상태를 비우고 스냅샷으로
      this.raw.clear(); this.nodes.clear(); this.json.clear(); this.synthOf.clear(); this.textsOf.clear(); this.urlUsers.clear(); this.iconHosts.clear(); this.reconvert.clear()
      this.raster.reset()
      this.needSnapshot = true
    }
    for (const id of res.del) this.drop(id, del)
    const todo = new Set<number>()
    for (const r of res.recs) {
      const prev = this.raw.get(r.i)
      if (prev?.ps && prev.ps !== r.ps) this.textsOf.get(prev.ps)?.delete(r.i)
      this.raw.set(r.i, r); todo.add(r.i)
      if (r.t === 'x' && r.ps) { let set = this.textsOf.get(r.ps); if (!set) { set = new Set(); this.textsOf.set(r.ps, set) } set.add(r.i) }
    }
    // 요소의 계산값이 바뀌었다 → 그 요소를 스타일 출처로 쓰는 글자들도 다시(수집기는 같은 글자 레코드를 다시 보내지 않는다)
    for (const r of res.recs) if (r.t === 'e') { const ts = this.textsOf.get(r.i); if (ts) for (const t of ts) if (this.raw.has(t)) todo.add(t) }
    for (const id of this.reconvert) if (this.raw.has(id)) todo.add(id)
    this.reconvert.clear()
    for (const id of todo) {
      const r = this.raw.get(id)!
      const c = convert(r, this.deps)
      this.put(id, c.node, add, upd, del)
      // 합성 자식(의사 요소 글자)
      const prev = this.synthOf.get(id)
      const now = new Set<number>()
      for (const x of c.extra) { now.add(x.id); this.put(x.id, x, add, upd, del) }
      if (prev) for (const sid of prev) if (!now.has(sid)) this.drop(sid, del)
      if (now.size) this.synthOf.set(id, now); else this.synthOf.delete(id)
    }
    // 문서 정보
    const d = res.doc
    const doc: DocInfo = {
      cw: Math.max(1, Math.min(1e7, Math.round(d.cw))), ch: Math.max(1, Math.min(1e7, Math.round(d.ch))),
      vw: Math.round(d.vw), vh: Math.round(d.vh), sx: d.sx, sy: d.sy,
      url: cleanText(d.url).slice(0, 4096), title: cleanText(d.title).slice(0, 300),
    }
    if (isColor(d.bg)) doc.bg = d.bg
    const dj = JSON.stringify(doc)
    const docChanged = dj !== this.docJson
    this.doc = doc; this.docJson = dj
    if (res.truncated && !this.degradedSent) { this.degradedSent = true; this.notify({ t: 'notice', k: 'degraded', detail: `nodes>${LIMITS.maxNodes}` }) }
    const ms = Math.round(res.ms * 100) / 100
    if (this.needSnapshot) {
      this.needSnapshot = false
      this.sendSnapshot(iseq, ms)
    } else if (add.length || upd.length || del.length || docChanged) {
      this.sendPatch(iseq, ms, add, upd, del, docChanged ? doc : undefined)
    } else {
      this.sendMsg({ t: 'tick', seq: ++this.seq, iseq, ms })
    }
    this.reportFocus(res, iseq)
  }

  private put(id: number, node: VNode | undefined, add: VNode[], upd: VNode[], del: number[]): void {
    if (!node) { if (this.json.has(id)) this.drop(id, del); return }
    const j = JSON.stringify(node)
    const prev = this.json.get(id)
    if (prev === j) return
    this.json.set(id, j)
    this.nodes.set(id, node)
    if (prev === undefined) add.push(node); else upd.push(node)
  }

  private drop(id: number, del: number[]): void {
    const r = this.raw.get(id)
    if (r?.ps) this.textsOf.get(r.ps)?.delete(id)
    this.textsOf.delete(id)
    this.raw.delete(id)
    this.fonts.forget(id)
    this.raster.forget(id)
    this.iconHosts.delete(id)
    if (this.json.delete(id)) del.push(id)
    this.nodes.delete(id)
    const syn = this.synthOf.get(id)
    if (syn) { for (const s of syn) { if (this.json.delete(s)) del.push(s); this.nodes.delete(s) } this.synthOf.delete(id) }
  }

  /** 자산·폰트·래스터가 준비됐다 → 그 노드들을 다시 변환 */
  private requeue(ids: Iterable<number>): void { for (const id of ids) if (id < SYNTH_BASE) this.reconvert.add(id); this.markDirty() }
  private onAsset(url: string): void { const s = this.urlUsers.get(url); if (s) this.requeue(s) }

  private insetTargets(): number[] {
    const out: number[] = []
    for (const n of this.nodes.values()) if (n.k === 'inset' && !n.s?.hid && n.w >= 2 && n.h >= 2) out.push(n.id)
    return out
  }

  private reportFocus(res: TickResult, iseq: number): void {
    const f = res.focus
    const isWidget = f && (f.wk === 'text' || f.wk === 'textarea' || f.wk === 'password')
    const id = f ? f.id : 0
    if (id !== this.focusId) { this.focusId = id; this.sendMsg({ t: 'focus', id }) }
    if (!f || !isWidget) { this.lastVal = ''; return }
    const v = f.wk === 'password' ? '•'.repeat(Math.min(f.n, 10000)) : cleanText(f.v ?? '')
    const msg: ServerMsg = { t: 'val', id: f.id, iseq, vh: fnv1a(v), n: v.length, ss: Math.min(f.ss, 1e7), se: Math.min(f.se, 1e7) }
    if (f.wk !== 'password') msg.v = v
    const key = `${f.id}|${msg.vh}|${msg.ss}|${msg.se}`
    if (key !== this.lastVal || this.input.valDirty) { this.lastVal = key; this.input.valDirty = false; this.sendMsg(msg) }
  }

  // ── 보내기 ──
  private sendSnapshot(iseq: number, ms: number): void {
    const all = [...this.nodes.values()]
    this.stats.snapshots++
    this.sendMsg({ t: 'snapshot', seq: ++this.seq, iseq, doc: this.doc, nodes: all.slice(0, SNAPSHOT_CHUNK), ms })
    for (let i = SNAPSHOT_CHUNK; i < all.length; i += SNAPSHOT_CHUNK) {
      this.sendMsg({ t: 'patch', seq: ++this.seq, iseq, add: all.slice(i, i + SNAPSHOT_CHUNK), upd: [], del: [], ms: 0 })
    }
  }
  private sendPatch(iseq: number, ms: number, add: VNode[], upd: VNode[], del: number[], doc?: DocInfo): void {
    this.stats.patches++
    // 아주 큰 패치는 나눠서(한 메시지 상한) — 같은 iseq, del·doc 은 첫 조각에
    const items: [0 | 1, VNode][] = [...add.map(n => [0, n] as [0, VNode]), ...upd.map(n => [1, n] as [1, VNode])]
    for (let i = 0; i === 0 || i < items.length; i += SNAPSHOT_CHUNK) {
      const part = items.slice(i, i + SNAPSHOT_CHUNK)
      const m: ServerMsg = { t: 'patch', seq: ++this.seq, iseq, add: part.filter(x => x[0] === 0).map(x => x[1]), upd: part.filter(x => x[0] === 1).map(x => x[1]), del: i === 0 ? del : [], ms }
      if (i === 0 && doc) m.doc = doc
      this.sendMsg(m)
    }
  }

  notify(m: ServerMsg): void { this.sendMsg(m) }

  sendMsg(m: ServerMsg): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const s = JSON.stringify(m)
    if (s.length > LIMITS.maxServerMsgBytes) { this.cfg.log('message too large, dropped', m.t, s.length); this.notify({ t: 'notice', k: 'limit', detail: 'message' }); return }
    this.bytesOut += s.length
    if (m.t === 'patch' || m.t === 'snapshot') this.stats.bytesPatch += s.length
    this.ws.send(s)
    // 클라이언트가 너무 느리다 — 메모리를 지키려 끊는다(다시 붙으면 스냅샷)
    if (this.ws.bufferedAmount > 96 * 1024 * 1024) { this.cfg.log('viewer too slow, closing'); this.ws.close(1013, 'slow') }
  }
  sendBinary(buf: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (this.ws.bufferedAmount > 8 * 1024 * 1024) return // 밀리면 인셋 프레임부터 버린다
    this.bytesOut += buf.length
    this.ws.send(buf)
  }

  // ── 뷰어 ──
  attach(ws: WebSocket): void {
    if (this.ws && this.ws !== ws) { try { this.ws.close(4000, 'replaced') } catch { /* */ } }
    this.ws = ws
    this.lastViewerAt = Date.now()
    this.needSnapshot = true
    this.sendMsg({ t: 'hello', v: PROTOCOL_VERSION, sid: this.cfg.sid, seq: this.seq, vw: this.cfg.vw, vh: this.cfg.vh, pol: this.cfg.policy })
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      if (!this.bucket.take()) { this.stats.droppedClientMsgs++; if (this.stats.droppedClientMsgs % 2000 === 1999) { this.cfg.log('client flooding'); } return }
      void this.onClient(data.toString())
    })
    ws.on('close', () => { if (this.ws === ws) { this.ws = null; this.insets.stop(); this.lastViewerAt = Date.now() } })
    // 상한(64KB)을 넘는 프레임·깨진 프레임은 ws 가 'error' 를 낸다 — 듣는 쪽이 없으면 프로세스가 죽는다(70KB 붙여넣기 한 번에 세션이 끝난다).
    // 그 연결만 끊는다(1009 등). 세션·Chromium 은 그대로 — 다시 붙으면 스냅샷.
    ws.on('error', e => { this.cfg.log('viewer socket error', String((e as Error & { code?: string }).code || e).slice(0, 80)); try { ws.terminate() } catch { /* */ } })
    this.insets.start()
    this.markDirty()
  }

  private async onClient(raw: string): Promise<void> {
    if (raw.length > LIMITS.maxClientMsgBytes) { this.stats.rejectedClientMsgs++; return }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { this.stats.rejectedClientMsgs++; return }
    const m = validateClientMsg(parsed)
    if (!m) { this.stats.rejectedClientMsgs++; return }
    try {
      if (m.t === 'ping') { this.sendMsg({ t: 'pong', ts: m.ts }); return }
      if (m.t === 'resync') { this.needSnapshot = true; this.markDirty(); return }
      if (m.t === 'dialog') { this.answerDialog(m); return }
      if (m.t === 'chooser') { this.choosers.delete(m.id); return }
      if (m.t !== 'resize') this.lastInputAt = Date.now()
      const applied = await this.lock.run(() => this.input.handle(m))
      if (applied || m.t === 'scroll') this.markDirty()
      if (m.t === 'scroll' && m.id === 0) void this.quickScroll()
    } catch (e) {
      if (this.cfg.trace) this.cfg.log('input error', m.t, String(e).slice(0, 160))
    }
  }

  /** 스크롤 빠른 길 — 수집 없이 문서 오프셋만 먼저(노드는 스크롤 불변이라 따로 갈 것이 없다) */
  private async quickScroll(): Promise<void> {
    const r = await this.call<[number, number]>('[window.scrollX, window.scrollY]')
    if (!r) return
    const doc = { ...this.doc, sx: Math.round(r[0] * 100) / 100, sy: Math.round(r[1] * 100) / 100 }
    this.doc = doc; this.docJson = JSON.stringify(doc)
    this.sendMsg({ t: 'patch', seq: ++this.seq, iseq: this.input.appliedSeq, doc, add: [], upd: [], del: [], ms: 0 })
  }

  // ── 대화상자·다운로드·업로드·팝업 ──
  private onDialog(d: Dialog): void {
    const id = ++this.dialogSeq
    this.dialogs.set(id, d)
    const k = d.type() as 'alert' | 'confirm' | 'prompt' | 'beforeunload'
    const msg: ServerMsg = { t: 'dialog', id, k: ['alert', 'confirm', 'prompt', 'beforeunload'].includes(k) ? k : 'alert', msg: cleanText(d.message()).slice(0, 4000) }
    if (k === 'prompt') msg.def = cleanText(d.defaultValue()).slice(0, 4000)
    if (!this.ws) { this.dialogs.delete(id); void d.dismiss().catch(() => {}); return }
    this.sendMsg(msg)
    // 답이 없으면 60초 뒤 닫는다(렌더러가 멈춰 있다)
    setTimeout(() => { if (this.dialogs.get(id) === d) { this.dialogs.delete(id); void d.dismiss().catch(() => {}); this.markDirty() } }, 60000).unref()
  }
  private answerDialog(m: Extract<ClientMsg, { t: 'dialog' }>): void {
    const d = this.dialogs.get(m.id)
    if (!d) return
    this.dialogs.delete(m.id)
    void (m.ok ? d.accept(d.type() === 'prompt' ? (m.text ?? '') : undefined) : d.dismiss()).catch(() => {})
    this.markDirty()
  }

  private async onDownload(d: Download): Promise<void> {
    const name = safeName(d.suggestedFilename())
    if (!this.cfg.policy.dl) { this.notify({ t: 'notice', k: 'blocked-download', name }); void d.cancel().catch(() => {}); return }
    const id = randomBytes(16).toString('hex')
    const dest = path.join(this.tmp, 'dl-' + id)
    try {
      await d.saveAs(dest)
      const size = fs.statSync(dest).size
      this.downloads.set(id, { path: dest, name, size })
      this.cfg.log(`download ${id.slice(0, 8)}: ${size} B (${JSON.stringify(d.suggestedFilename())})`)
      this.notify({ t: 'notice', k: 'download', id, name, size })
    } catch (e) {
      this.cfg.log('download failed', String(e).slice(0, 160))
    }
  }

  private onFileChooser(fc: FileChooser): void {
    if (!this.cfg.policy.ul) { this.notify({ t: 'notice', k: 'blocked-upload' }); return }
    const id = randomBytes(16).toString('hex')
    this.choosers.set(id, { fc, multi: fc.isMultiple(), files: [], bytes: 0 })
    this.notify({ t: 'notice', k: 'filechooser', id, multi: fc.isMultiple() })
    setTimeout(() => this.choosers.delete(id), 10 * 60 * 1000).unref()
  }

  /** POST /upload/<id> — 한 파일씩. last 면 원격 file input 에 넣는다 */
  async upload(id: string, name: string, body: Buffer, last: boolean): Promise<number> {
    if (!this.cfg.policy.ul) return 403
    const c = this.choosers.get(id)
    if (!c) return 404
    if (body.length > this.cfg.maxUploadBytes || c.bytes + body.length > this.cfg.maxUploadBytes * 4) return 413
    if (!c.multi && c.files.length >= 1) return 409
    // 파일마다 폴더 하나 — 원격 페이지가 보는 이름이 사용자가 고른 이름 그대로가 되게
    const dir = path.join(this.tmp, 'up-' + id, String(c.files.length))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, safeName(name))
    fs.writeFileSync(file, body)
    c.files.push(file); c.bytes += body.length
    if (last) {
      this.choosers.delete(id)
      await c.fc.setFiles(c.files)
      const n = await c.fc.element().evaluate(el => (el as HTMLInputElement).files?.length ?? -1).catch(() => -2)
      this.cfg.log(`upload ${id.slice(0, 8)}: ${c.files.length} file(s), ${c.bytes} B → input has ${n}`)
      this.markDirty()
    }
    return 200
  }

  private async onPopup(p: Page): Promise<void> {
    if (p === this.page) return
    // 새 창은 열지 않는다 — 주소가 허용 호스트면 지금 탭에서 연다
    let url = p.url()
    if (!url || url === 'about:blank') { await p.waitForEvent('framenavigated', { timeout: 3000 }).catch(() => null); url = p.url() }
    await p.close().catch(() => {})
    try {
      const u = new URL(url)
      if ((u.protocol === 'http:' || u.protocol === 'https:') && hostAllowed(u, this.cfg.allowHosts)) {
        this.notify({ t: 'notice', k: 'blocked-popup', detail: cleanText(`${u.host}${u.pathname}`).slice(0, 500) })
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      } else this.notify({ t: 'notice', k: 'blocked-popup', detail: cleanText(url).slice(0, 500) })
    } catch { this.notify({ t: 'notice', k: 'blocked-popup' }) }
  }

  private idleCheck(): void {
    const now = Date.now(), lim = this.cfg.idleSec * 1000
    const noViewer = !this.ws && now - this.lastViewerAt > lim
    const noInput = now - this.lastInputAt > lim
    if (noViewer || noInput) {
      this.cfg.log(`idle shutdown (${noViewer ? 'no viewer' : 'no input'} > ${this.cfg.idleSec}s)`)
      try { this.ws?.close(4001, 'idle') } catch { /* */ }
      void this.ctx.close().catch(() => {}).finally(() => process.exit(0))
    }
  }

  statsSnapshot(): Record<string, unknown> {
    const t = Math.max(1, this.stats.ticks)
    const h = [...this.stats.tickHist].sort((a, b) => a - b)
    const q = (p: number) => (h.length ? h[Math.min(h.length - 1, Math.floor(p * (h.length - 1) + 0.5))] : null)
    return {
      ticks: this.stats.ticks, avgCollectMs: +(this.stats.collectMs / t).toFixed(2), maxCollectMs: +this.stats.maxCollectMs.toFixed(1),
      avgConvertMs: +(this.stats.convertMs / t).toFixed(2), updateMs: { n: h.length, p50: q(0.5), p95: q(0.95), max: q(1) },
      nodes: this.nodes.size, recs: this.stats.recs, patches: this.stats.patches, snapshots: this.stats.snapshots, fullPasses: this.stats.fullPasses,
      worldInstalls: this.stats.worldInstalls, evalErrors: this.stats.evalErrors, work: this.stats.work,
      bytesOut: this.bytesOut, bytesPatch: this.stats.bytesPatch, droppedClientMsgs: this.stats.droppedClientMsgs, rejectedClientMsgs: this.stats.rejectedClientMsgs,
      assets: this.assets.stats, fonts: this.fonts.stats, raster: this.raster.stats, queue: this.queue.stats, insets: this.insets.stats, input: this.input.stats,
      rss: process.memoryUsage().rss,
    }
  }
  resetStats(): void { this.stats.tickHist = []; this.stats.ticks = 0; this.stats.collectMs = 0; this.stats.convertMs = 0; this.stats.maxCollectMs = 0; this.stats.recs = 0 }

  /** 계측용(MIRROR_DEV) — 캡처 큐를 통한 기준 스크린샷 */
  async shot(): Promise<Buffer | undefined> {
    await this.queue.idle()
    const lm = await this.send('Page.getLayoutMetrics')
    const vv = lm.cssVisualViewport
    return this.queue.submit({ key: 'dev-shot', prio: 0, format: 'png', clip: async () => ({ x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale: 1 }) })
  }

  async close(): Promise<void> {
    await this.ctx.close().catch(() => {})
    try { fs.rmSync(this.tmp, { recursive: true, force: true }) } catch { /* */ }
  }
}

export function hostAllowed(u: URL, allow: string[]): boolean {
  const host = u.hostname.toLowerCase()
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  for (const a of allow) {
    const [h, p] = a.toLowerCase().split(':')
    if (h === host && (!p || p === port)) return true
  }
  return false
}

/** 내려받기·올리기 파일 이름 — 경로·제어문자·따옴표 제거, 255자 */
export function safeName(n: string): string {
  const s = cleanText(n || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 200)
  return s || 'download'
}

export { synthId }
