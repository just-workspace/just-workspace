/**
 * HTTP + WebSocket — 단일 포트(6901, 세션 브리지 안 한 홉, ws-nginx 만 닿는다 — netfilter).
 *
 *   GET  /healthz              준비 확인(인증 없음 — 컨테이너 안 docker exec 확인용)
 *   GET  /view                 스크립트 없는 미러 문서(CSP: script-src 'none'; sandbox allow-same-origin; img/font 은 이 세션 경로만)
 *   WS   /mirror               어휘 스트림 + 입력
 *   GET  /asset/<sha256>       재인코딩 WebP
 *   GET  /font/<name>.woff2    고정 폰트 묶음(세션 이미지에 구운 것 — 원격 페이지의 폰트가 아니다)
 *   GET  /download/<id32>      정책이 허용한 다운로드(attachment, octet-stream)
 *   POST /upload/<id32>        정책이 허용한 업로드(파일 선택 대화상자 하나에 한 파일씩)
 *   /dev/*                     MIRROR_DEV=1 일 때만(하네스·계측) — 운영 이미지에는 하네스 파일이 없다
 * /healthz 말고는 MIRROR_AUTH(백엔드가 세션마다 만든 basic 값, nginx 가 auth_request 응답으로 붙인다)가 맞아야 한다.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { LIMITS } from '../../protocol/vocab.ts'
import type { MirrorSession } from './session.ts'

export interface FontFace { key: string; file: string; weight: string; style: string; range?: string }

export interface ServerCfg {
  port: number
  auth: string
  sid: string
  dev: boolean
  root: string
  fontsDir: string
  /** 복사 정책이 꺼져 있으면 미러 문서 전체를 선택 불가로(복사의 네이티브 길을 처음부터 막는다) */
  noSelect: boolean
  log: (...a: unknown[]) => void
  devApi?: (op: string, url: URL, res: http.ServerResponse) => Promise<void>
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.map': 'application/json', '.png': 'image/png' }
const HOST_RE = /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/
const PREFIX_RE = /^\/rbi\/[0-9a-f]{32}$/

export function loadFonts(dir: string): FontFace[] {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'fonts.json'), 'utf8')) as FontFace[]
    return list.filter(f => /^[a-z]{2,8}$/.test(f.key) && /^[a-z0-9-]{1,64}\.woff2$/.test(f.file) && /^\d{3}$/.test(f.weight) && /^(normal|italic)$/.test(f.style) && (!f.range || /^[U+0-9A-Fa-f, -]{1,20000}$/.test(f.range)))
  } catch { return [] }
}

export function fontFaceCss(fonts: FontFace[]): string {
  // font-display:block — 고정 폰트가 오기 전 다른 폭의 대체 폰트로 잠깐 그리지 않게(겹침 방지)
  return fonts.map(f => `@font-face{font-family:"jw-${f.key}";src:url("font/${f.file}") format("woff2");font-weight:${f.weight};font-style:${f.style};font-display:block${f.range ? `;unicode-range:${f.range}` : ''}}`).join('')
}

export function viewCsp(nonce: string, host: string | undefined, prefix: string): string {
  // 이미지·폰트는 이 세션의 asset/·font/ 경로만(호스트 출처 + 경로). 인셋 프레임은 부모가 만든 blob:
  const h = host && HOST_RE.test(host) ? host : ''
  const img = h ? `${h}${prefix}/asset/ blob:` : "'self' blob:"
  const font = h ? `${h}${prefix}/font/` : "'self'"
  return [
    "default-src 'none'", `img-src ${img}`, `font-src ${font}`, `style-src 'nonce-${nonce}'`, "style-src-attr 'none'", "script-src 'none'",
    "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "object-src 'none'", "media-src 'none'", "manifest-src 'none'",
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'", 'sandbox allow-same-origin',
  ].join('; ')
}

export function viewHtml(nonce: string, fonts: FontFace[], noSelect: boolean): string {
  // 미러 문서 — 스크립트 없음. 부모(우리 앱)가 contentDocument 를 조립한다. 기본 규칙만 nonce 스타일로.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>mirror</title>` +
    `<style nonce="${nonce}">${fontFaceCss(fonts)}` +
    `html,body{margin:0;padding:0;overflow:auto;background:#fff}` +
    `::-webkit-scrollbar{width:0;height:0}html,body{scrollbar-width:none}` +
    `body{font-family:"jw-lsans","jw-cjks","jw-dsans";-webkit-text-size-adjust:none;text-rendering:geometricPrecision}` +
    `#root{position:relative;overflow:visible}` +
    `.m{position:absolute;box-sizing:border-box;margin:0;padding:0}` +
    `.t{position:absolute;white-space:pre;line-height:1;user-select:text;cursor:text}` +
    `.w{display:flex;align-items:center;overflow:hidden;white-space:pre}.w .ph{opacity:.5}` +
    `.w .cr{display:inline-block;width:1px;height:1.1em;background:currentColor;vertical-align:middle;margin:0 -1px 0 0}` +
    `.w .co{text-decoration:underline;text-decoration-style:solid}` +
    `.i,.in{-webkit-user-drag:none;user-select:none}.i{object-fit:fill;display:block}.in{display:block;overflow:hidden;background:#111}` +
    `.in img{position:absolute;display:block}` +
    `.sp{position:absolute;width:1px;height:1px;pointer-events:none;visibility:hidden}` +
    (noSelect ? `*{user-select:none!important;-webkit-user-select:none!important}` : '') +
    `</style></head><body><div id="root"></div></body></html>`
}

const COMMON_HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin', 'x-dns-prefetch-control': 'off',
}

function authOk(header: string | undefined, want: string): boolean {
  if (!want) return true
  if (!header) return false
  const a = Buffer.from(header), b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function startServer(session: MirrorSession, cfg: ServerCfg): http.Server {
  const fonts = loadFonts(cfg.fontsDir)
  cfg.log(`fonts: ${fonts.length} faces from ${cfg.fontsDir}`)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    const p = url.pathname
    if (p === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return }
    if (!authOk(req.headers.authorization, cfg.auth)) { res.writeHead(401); res.end(); return }
    if (p === '/view' && req.method === 'GET') {
      const nonce = randomBytes(18).toString('base64url')
      const prefixHdr = String(req.headers['x-rbi-prefix'] || '')
      const prefix = PREFIX_RE.test(prefixHdr) ? prefixHdr : ''
      res.writeHead(200, {
        ...COMMON_HEADERS, 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': viewCsp(nonce, req.headers.host, prefix),
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), fullscreen=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()',
      })
      res.end(viewHtml(nonce, fonts, cfg.noSelect)); return
    }
    const am = /^\/asset\/([0-9a-f]{64})$/.exec(p)
    if (am && req.method === 'GET') {
      const a = session.assets.get(am[1])
      if (!a) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { ...COMMON_HEADERS, 'content-type': a.mime, 'content-length': a.buf.length, 'cache-control': 'private, max-age=86400, immutable', 'content-security-policy': "default-src 'none'; sandbox" })
      res.end(a.buf); return
    }
    const fm = /^\/font\/([a-z0-9-]{1,64}\.woff2)$/.exec(p)
    if (fm && req.method === 'GET') {
      const f = fonts.find(x => x.file === fm[1])
      if (!f) { res.writeHead(404); res.end(); return }
      const file = path.join(cfg.fontsDir, f.file)
      fs.stat(file, (err, st) => {
        if (err) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { ...COMMON_HEADERS, 'content-type': 'font/woff2', 'content-length': st.size, 'cache-control': 'private, max-age=86400, immutable' })
        fs.createReadStream(file).pipe(res)
      })
      return
    }
    const dm = /^\/download\/([0-9a-f]{32})$/.exec(p)
    if (dm && req.method === 'GET') {
      const d = session.downloads.get(dm[1])
      if (!d) { res.writeHead(404); res.end(); return }
      res.writeHead(200, {
        ...COMMON_HEADERS, 'content-type': 'application/octet-stream', 'content-length': d.size,
        'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(d.name)}`,
        'content-security-policy': "default-src 'none'; sandbox",
      })
      fs.createReadStream(d.path).pipe(res); return
    }
    const um = /^\/upload\/([0-9a-f]{32})$/.exec(p)
    if (um && req.method === 'POST') {
      const len = parseInt(String(req.headers['content-length'] || '0'), 10)
      if (!Number.isFinite(len) || len < 0 || len > LIMITS.maxUploadBytes) { res.writeHead(413); res.end(); req.resume(); return }
      const chunks: Buffer[] = []
      let got = 0
      req.on('data', (c: Buffer) => { got += c.length; if (got > LIMITS.maxUploadBytes) { req.destroy(); return } chunks.push(c) })
      req.on('end', () => {
        let name = 'upload'
        try { name = decodeURIComponent(String(req.headers['x-upload-name'] || 'upload')) } catch { /* 그대로 */ }
        const last = req.headers['x-upload-last'] !== '0'
        void session.upload(um[1], name, Buffer.concat(chunks), last).then(code => { res.writeHead(code, { 'cache-control': 'no-store' }); res.end() })
          .catch(() => { res.writeHead(500); res.end() })
      })
      return
    }
    if (cfg.dev && p.startsWith('/dev/api/') && cfg.devApi) { void cfg.devApi(p.slice(9), url, res); return }
    if (cfg.dev && p.startsWith('/dev/')) {
      const rel = p.slice(5) || 'index.html'
      const file = path.resolve(cfg.root, 'client/dist', rel.includes('..') ? 'index.html' : rel || 'index.html')
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
        fs.createReadStream(file).pipe(res); return
      }
    }
    res.writeHead(404); res.end()
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxClientMsgBytes })
  wss.on('error', e => cfg.log('ws server error', String(e).slice(0, 120)))
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => { /* 업그레이드 전 끊김 — 무시 */ })
    const url = new URL(req.url || '/', 'http://x')
    if (url.pathname !== '/mirror' || !authOk(req.headers.authorization, cfg.auth)) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, ws => session.attach(ws))
  })
  server.listen(cfg.port, '0.0.0.0', () => cfg.log(`listening :${cfg.port} (dev=${cfg.dev})`))
  return server
}
