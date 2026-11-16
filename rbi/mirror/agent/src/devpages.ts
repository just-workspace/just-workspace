/**
 * 스파이크 전용 — 세션 컨테이너 내부 127.0.0.1:7100 에서 테스트 페이지(jsPlumb 미믹·악성 페이지·캔버스 콘솔)를 제공한다.
 * 운영 이미지에서는 MIRROR_DEV 가 없으므로 기동하지 않는다. 외부에서 접근할 수 없다(loopback 바인드).
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.cfg': 'application/octet-stream' }

export function startDevPages(port: number, dir: string): Promise<void> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    let rel = decodeURIComponent(url.pathname)
    if (rel === '/' || rel === '') rel = '/index.html'
    if (rel.includes('..')) { res.writeHead(400); res.end(); return }
    // 추출 시도 기록용 — 악성 페이지가 유발하는 요청을 집계한다
    if (rel.startsWith('/exfil')) { console.log('[devpages] EXFIL HIT (remote side, expected)', req.url); res.writeHead(204); res.end(); return }
    const file = path.join(dir, rel)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => { console.log(`[devpages] http://127.0.0.1:${port}/ ← ${dir}`); resolve() }))
}
