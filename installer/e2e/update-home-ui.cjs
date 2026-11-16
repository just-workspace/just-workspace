#!/usr/bin/env node
/**
 * 관리 › 업데이트 현황 — "지금 확인"을 누르지 않은 상태에서 받을 수 있는 새 버전이 표시되는지 확인한다.
 * 복원 지점으로 복원(또는 롤백)한 직후에 실행한다: 설치 관리자가 완료 시 확인 결과를 무효화하고 즉시 재확인하므로,
 * 화면을 열면 확인 중 표시 후 복원 이전 버전(상위 릴리스)이 표시되어야 한다.
 *
 *   node update-home-ui.cjs --url https://ws.e2e.example --addr 192.168.10.20 --password-file <파일> --expect <버전>
 *        [--timeout 90] [--out <폴더>] [--chrome <경로>]
 *
 * 필요 사항: playwright-core(NODE_PATH).
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright-core')

const opt = { timeout: '90', out: 'update-home-shots' }
for (let a = process.argv.slice(2), i = 0; i < a.length; i++) if (a[i].startsWith('--')) opt[a[i].slice(2)] = a[++i]
if (!opt.url || !opt['password-file'] || !opt.expect) { console.error('--url, --password-file, --expect 가 필요합니다'); process.exit(2) }
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
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, locale: 'ko-KR' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => { if (!/ServiceWorker/.test(String(e))) errors.push(String(e).slice(0, 200)) })
  const checks = []
  page.on('request', r => { if (r.method() === 'POST' && /\/api\/admin\/system\/update\/check$/.test(r.url())) checks.push(r.url()) })
  await page.goto(base + '/login')
  const login = await page.evaluate(async ([u, p]) => (await fetch('/api/auth/login', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }),
  })).status, ['admin', password])
  expect('관리자 로그인', login === 200, String(login))
  await page.goto(base + '/admin/update')
  const until = Date.now() + Number(opt.timeout) * 1000
  const anyState = '[data-testid=update-available], [data-testid=update-checking], [data-testid=update-latest], [data-testid=update-check-failed]'
  let shown = ''
  while (Date.now() < until) {
    await page.locator(anyState).first().waitFor({ timeout: 20000 }).catch(() => {})
    const card = page.locator('[data-testid=update-available]')
    if (await card.count()) { shown = (await card.innerText()).replace(/\s+/g, ' '); if (shown.includes(opt.expect)) break }
    // 확인 중이면 화면이 스스로 재조회한다. 그 밖의 상태(최신·실패)는 잠시 후 다시 연다
    await sleep(3000)
    if (!(await page.locator('[data-testid=update-checking]').count())) await page.reload()
  }
  expect(`현황에 새 버전 ${opt.expect} 이 표시된다("지금 확인" 없이)`, shown.includes(opt.expect), shown.slice(0, 200) || '새 버전 카드 없음')
  expect('"지금 확인"을 호출하지 않았다', checks.length === 0, checks.join(', '))
  await page.screenshot({ path: path.join(opt.out, 'update-home.png'), fullPage: true }).catch(() => {})
  expect('화면 오류 없음', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(`== 결과: 통과 ${pass} · 실패 ${fail} ==`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.log('  FAIL 실행 오류 — ' + String(e).slice(0, 300)); process.exit(1) })
