#!/usr/bin/env node
/**
 * 문서 편집기 열기 — 새 문서를 만들어 편집기 화면이 열리는지 확인한다. 업데이트·복원 완료 직후에 실행하여
 * 첫 시도부터 열리는지(문서 서버의 준비 대기 — 설치 관리자의 docs_not_ready) 검증하는 용도이다.
 *
 *   node office-open-ui.cjs --url https://ws.e2e.example --addr 192.168.10.20 --password-file <파일>
 *        [--kinds doc,sheet,slide] [--rounds 1] [--wait 35] [--out <폴더>] [--chrome <경로>]
 *
 * 판정: 편집기 프레임에 캔버스가 있고, 오류 문구("cannot be accessed" 등)·로드 중 표시가 없으며, /onlyoffice/ 경로의 응답에
 * 5xx 가 없을 것. 1회차의 결과를 별도로 출력한다. 필요 사항: playwright-core(NODE_PATH).
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright-core')

const opt = { kinds: 'doc,sheet,slide', rounds: '1', wait: '35', out: 'office-open-shots' }
for (let a = process.argv.slice(2), i = 0; i < a.length; i++) if (a[i].startsWith('--')) opt[a[i].slice(2)] = a[++i]
if (!opt.url || !opt['password-file']) { console.error('--url 과 --password-file 이 필요합니다'); process.exit(2) }
const base = opt.url.replace(/\/+$/, '')
const host = new URL(base).hostname
const password = fs.readFileSync(opt['password-file'], 'utf8').trim()
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const expect = (n, c, d) => { if (c) { pass++; console.log('  PASS ' + n) } else { fail++; console.log('  FAIL ' + n + (d ? ' — ' + d : '')) } }

;(async () => {
  fs.mkdirSync(opt.out, { recursive: true })
  const browser = await chromium.launch({
    headless: true, ...(opt.chrome ? { executablePath: opt.chrome } : {}),
    args: opt.addr ? [`--host-resolver-rules=MAP ${host} ${opt.addr}`] : [],
  })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 }, locale: 'ko-KR' })
  const page = await ctx.newPage()
  const serverErrors = []
  page.on('response', r => { if (r.status() >= 500 && r.url().includes('/onlyoffice/')) serverErrors.push(r.status() + ' ' + r.url().slice(0, 140)) })
  await page.goto(base + '/login')
  const login = await page.evaluate(async ([u, p]) => (await fetch('/api/auth/login', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }),
  })).status, ['admin', password])
  expect('관리자 로그인', login === 200, String(login))
  const started = Date.now()
  for (let round = 1; round <= Number(opt.rounds); round++) {
    for (const kind of opt.kinds.split(',')) {
      serverErrors.length = 0
      await page.goto(base + `/office/open?new=${kind}&dir=my`, { waitUntil: 'domcontentloaded' })
      await sleep(Number(opt.wait) * 1000)
      let errText = '', loading = false, canvas = 0
      for (const f of page.frames()) {
        const t = await f.evaluate(() => ({ txt: document.body ? document.body.innerText : '', canvas: document.querySelectorAll('canvas').length })).catch(() => null)
        if (!t) continue
        canvas += t.canvas
        const m = t.txt.match(/(cannot be accessed[^\n]*|문서를 열 수 없[^\n]*|Download failed[^\n]*|An error has occurred[^\n]*|연결이 끊[^\n]*|Connection is lost[^\n]*)/i)
        if (m) errText += m[1] + ' | '
        if (/Loading document|문서 로드 중|불러오는 중/.test(t.txt)) loading = true
      }
      const detail = `캔버스 ${canvas} · 로드 중 ${loading} · 오류 ${errText || '없음'} · 5xx ${JSON.stringify([...new Set(serverErrors)].slice(0, 4))}`
      expect(`${round}회차 ${kind} 열림(시작 후 ${Math.round((Date.now() - started) / 1000)}초)`, canvas > 0 && !errText && !loading && serverErrors.length === 0, detail)
      await page.screenshot({ path: path.join(opt.out, `r${round}-${kind}.png`) }).catch(() => {})
    }
  }
  await browser.close()
  console.log(`== 결과: 통과 ${pass} · 실패 ${fail} ==`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.log('  FAIL 실행 오류 — ' + String(e).slice(0, 300)); process.exit(1) })
