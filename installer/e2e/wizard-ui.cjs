#!/usr/bin/env node
/**
 * 설치 마법사를 **화면 조작으로** 끝까지 진행한다(Playwright) — 검수 서버 외부(이 PC)에서 실행된다.
 *
 *   node wizard-ui.cjs --url https://192.168.10.20:8443 --token XXXXXXXXXXXX [옵션]
 *
 *   --url <주소>        설치 관리자 주소(자체 서명 인증서이므로 검증하지 않는다)
 *   --token <토큰>      설치 토큰(서버의 `docker logs jw-installer`). --locked 지정 시 불필요
 *   --flow new|quick    일반 설치(협업 프리셋 · 임시 인증서 · 이 서버의 디스크) / 빠른 설치          기본 new
 *   --domain <이름>     접속 주소로 입력할 이름(DNS 미등록 가능)                                  기본 ws.e2e.example
 *   --mail-domain <이름>                                                                         기본 e2e.example
 *   --width <픽셀>      화면 폭(390 이면 휴대폰 폭)                                               기본 1280
 *   --out <폴더>        단계별 화면 캡처 저장 위치                                                기본 ./wizard-shots
 *   --locked            설치가 완료된 서버의 잠김 화면만 확인한다
 *   --chrome <경로>     크롬 실행 파일(미지정 시 playwright 내장본 사용)
 *
 * 필요 사항: playwright-core(NODE_PATH 로 탐색 가능해야 한다). 관리자 비밀번호는 실행 시 난수로 생성하며 출력하지 않는다
 * (환경변수 E2E_ADMIN_PASSWORD 를 지정하면 그 값을 사용한다).
 * 종료 시 확인 항목과 콘솔 오류 수를 출력한다. 하나라도 불일치하면 종료 코드 1.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { chromium } = require('playwright-core')

function args() {
  const out = { flow: 'new', domain: 'ws.e2e.example', 'mail-domain': 'e2e.example', width: '1280', out: 'wizard-shots' }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue
    const key = a[i].slice(2)
    if (key === 'locked') out.locked = true
    else out[key] = a[++i]
  }
  if (!out.url) { console.error('--url 이 필요합니다'); process.exit(2) }
  if (!out.locked && !out.token) { console.error('--token 이 필요합니다'); process.exit(2) }
  out.url = out.url.replace(/\/+$/, '')
  return out
}

const opt = args()
const width = Number(opt.width) || 1280
const password = process.env.E2E_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url')
let pass = 0
let fail = 0
const failed = []
const consoleErrors = []
let shot = 0

function ok(name) { pass++; console.log(`  PASS ${name}`) }
function bad(name, detail) { fail++; failed.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
function expect(name, cond, detail) { if (cond) ok(name); else bad(name, detail) }

async function main() {
  fs.mkdirSync(opt.out, { recursive: true })
  const browser = await chromium.launch({ headless: true, ...(opt.chrome ? { executablePath: opt.chrome } : {}) })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, viewport: { width, height: width < 600 ? 844 : 900 }, locale: 'ko-KR',
  })
  const page = await context.newPage()
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)) })
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e).slice(0, 300)))

  const snap = async name => {
    shot++
    await page.screenshot({ path: path.join(opt.out, `${String(shot).padStart(2, '0')}-${name}-${width}.png`), fullPage: true })
  }
  const heading = async (text, timeout = 30000) => {
    await page.getByRole('heading', { name: text }).first().waitFor({ state: 'visible', timeout })
  }
  const hash = () => page.evaluate(() => window.location.hash)
  const next = async (name = '다음') => {
    const button = page.getByRole('button', { name, exact: true }).last()
    await button.waitFor({ state: 'visible', timeout: 30000 })
    await page.waitForFunction(label => {
      const all = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === label)
      const b = all[all.length - 1]
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
    }, name, { timeout: 120000 })
    await button.click()
  }
  const noOverflow = async name => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(`${name}: 가로로 넘치지 않는다`, wide <= 1, `넘침 ${wide}px`)
  }

  // ─── 잠김 화면 전용 ───
  if (opt.locked) {
    await page.goto(opt.url + '/')
    await heading('설치가 이미 끝났습니다')
    ok('잠김 화면')
    expect('로그인 화면으로 가는 링크', await page.getByRole('link', { name: '로그인 화면으로' }).count() === 1)
    expect('다시 설치 명령이 보인다', (await page.getByText(/jw reinstall --yes/).count()) > 0)
    await snap('locked')
    await noOverflow('잠김')
    return finish(browser)
  }

  // ─── 토큰 미제공 · 잘못된 토큰 ───
  console.log('== 토큰 화면 ==')
  let res = await page.goto(opt.url + '/')
  expect('세션 없이 / 는 화면을 준다(200)', res.status() === 200, String(res.status()))
  const headers = res.headers()
  expect('CSP: script-src self · frame-ancestors none', /script-src 'self'/.test(headers['content-security-policy'] || '') && /frame-ancestors 'none'/.test(headers['content-security-policy'] || ''))
  expect('Referrer-Policy: no-referrer', headers['referrer-policy'] === 'no-referrer')
  expect('X-Content-Type-Options: nosniff', headers['x-content-type-options'] === 'nosniff')
  expect('installer.html 은 no-cache', headers['cache-control'] === 'no-cache')
  await heading('설치 토큰을 확인합니다')
  ok('토큰 없는 주소 → 토큰 화면')
  await snap('token-none')
  await noOverflow('토큰')
  await page.goto(opt.url + '/?token=AAAAAAAAAAAA')
  await heading('설치 토큰을 확인합니다')
  expect('틀린 토큰은 주소에서 지워진다', !(await page.evaluate(() => window.location.search)).includes('token'))
  expect('틀린 토큰의 사유가 보인다', (await page.getByText(/토큰이 맞지 않습니다/).count()) > 0)
  await snap('token-wrong')

  // ─── 토큰으로 진입 ───
  console.log('== 사전 점검 ==')
  await page.goto(`${opt.url}/?token=${encodeURIComponent(opt.token)}`)
  await heading('사전 점검', 60000)
  expect('토큰이 주소에 남지 않는다', !(await page.evaluate(() => window.location.href)).includes(opt.token))
  // 점검이 완료되어 "다음"을 누를 수 있을 때까지 대기
  await page.waitForFunction(() => {
    const all = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '다음')
    const b = all[all.length - 1]
    return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
  }, null, { timeout: 180000 })
  const pre = await page.evaluate(async () => (await fetch('/api/state', { credentials: 'same-origin' })).json())
  expect('사전 점검 통과(서버 상태)', pre.preflight && pre.preflight.ok === true)
  const rows = await page.locator('main li').count()
  expect('사전 점검 항목 14개가 그려진다', rows >= 14, `항목 ${rows}개`)
  await snap('check')
  await noOverflow('사전 점검')
  await next()

  console.log('== 시작 방식 ==')
  await heading('어떻게 시작할까요')
  await page.getByRole('radio', { name: opt.flow === 'quick' ? /빠른 설치/ : /새로 설치/ }).click()
  await snap('start')
  await next()

  console.log('== 접속 주소 ==')
  await page.getByLabel('접속 주소').first().waitFor({ timeout: 30000 })
  await page.getByLabel('접속 주소').first().fill(opt.domain)
  await page.keyboard.press('Tab')
  if (opt.flow !== 'quick') {
    await heading('접속 주소와 연결 형태')
    await page.getByRole('radio', { name: /공인 주소에 직접 연결/ }).click()
    // DNS 에 없는 이름이므로 "임시 인증서"를 선택할 수 있게 된다. 확인 완료까지 대기한다
    const temp = page.getByRole('radio', { name: /임시 인증서로 설치하고 나중에 발급/ })
    await temp.waitFor({ state: 'visible', timeout: 60000 })
    await temp.click()
    expect('감지한 연결 형태가 표시된다', (await page.getByText(/감지됨/).count()) > 0)
  }
  else {
    // 빠른 설치: DNS 에 없는 이름이면 "임시 인증서"를 직접 선택해야 다음 단계로 진행된다
    const temp = page.getByText('임시 인증서로 설치하고 나중에 발급')
    await temp.waitFor({ state: 'visible', timeout: 60000 })
    await temp.click()
    ok('빠른 설치: 접속 주소가 이 서버를 가리키지 않으면 임시 인증서를 고르게 한다')
  }
  await snap('domain')
  await noOverflow('접속 주소')
  await next()

  if (opt.flow !== 'quick') {
    console.log('== 저장 위치 ==')
    await heading('파일을 어디에 저장할까요')
    await page.getByRole('radio', { name: /이 서버의 디스크/ }).click()
    expect('기본 저장 폴더가 표시된다', (await page.getByText(/volumes\/ws-storage-data/).count()) > 0)
    await snap('storage')
    await next()

    console.log('== 구역 ==')
    await heading('쓸 구역을 고릅니다')
    await page.getByRole('radio', { name: '협업', exact: true }).or(page.getByRole('button', { name: '협업', exact: true })).or(page.getByRole('tab', { name: '협업', exact: true })).first().click()
    const zonesBody = await page.locator('main').innerText()
    expect('구역 목록이 서버 값으로 그려진다(메일 · 채팅 · 문서)', /메일/.test(zonesBody) && /채팅/.test(zonesBody) && /문서/.test(zonesBody))
    expect('권장 메모리 합계가 보인다', /권장 메모리/.test(zonesBody) && /GB/.test(zonesBody))
    await snap('zones')
    await noOverflow('구역')
    await next()
  }

  // 메일 화면은 메일 구역이 활성화된 경우에만 표시된다(빠른 설치도 협업 프리셋이면 표시된다)
  const settled = () => page.waitForFunction(() => /^#\/(ports|mail|meet|ai|git|admin)/.test(window.location.hash), null, { timeout: 30000 })
  await settled()
  if ((await hash()).startsWith('#/ports')) {
    // 공유기 뒤로 감지된 경우 — 포워딩할 포트 안내
    console.log('== 포트 포워딩 안내 ==')
    const body = await page.locator('main').innerText()
    expect('포트 안내: 넘길 포트(80 · 443)', /80/.test(body) && /443/.test(body))
    await snap('ports')
    await next()
    await page.waitForFunction(() => !window.location.hash.startsWith('#/ports'), null, { timeout: 30000 })
    await settled()
  }
  if ((await hash()).startsWith('#/mail') || await page.getByRole('heading', { name: '메일을 어떻게 보낼까요' }).count()) {
    console.log('== 메일 ==')
    await heading('메일을 어떻게 보낼까요')
    await page.getByRole('radio', { name: /내장 메일 서버/ }).click()
    await page.getByLabel('메일 도메인').fill(opt['mail-domain'])
    await page.getByText('메일 도메인에 등록할 레코드').waitFor({ timeout: 60000 })
    await page.waitForFunction(() => document.querySelectorAll('main table tbody tr').length >= 5 || document.body.innerText.includes('DKIM'), null, { timeout: 60000 })
    const mailBody = await page.locator('main').innerText()
    expect('메일 레코드 표(MX · SPF · DKIM · DMARC)', /MX/.test(mailBody) && /DKIM|_domainkey/.test(mailBody) && /_dmarc/.test(mailBody))
    expect('DKIM 값이 실제 키로 채워진다', /v=DKIM1; k=rsa; p=MII/.test(mailBody))
    await snap('mail')
    await noOverflow('메일')
    await next()
  }

  console.log('== 관리자 ==')
  await heading('관리자 계정')
  const fillAdmin = async () => {
    const main = page.locator('main')
    await main.locator('input[autocomplete="name"]').fill('관리자')
    await main.locator('input[autocomplete="username"]').fill('admin')
    await main.locator('input[autocomplete="new-password"]').nth(0).fill(password)
    await main.locator('input[autocomplete="new-password"]').nth(1).fill(password)
  }
  await fillAdmin()
  await snap('admin')

  // ─── 새로 고침 후 재개 ───
  console.log('== 새로 고침 뒤 이어 하기 ==')
  await page.reload()
  await heading('관리자 계정', 60000)
  ok('새로 고침해도 하던 화면에 그대로 있다')
  // 주소를 다시 열면(창을 닫았다가 재접속한 경우) 재개 화면이 표시된다
  await page.goto(opt.url + '/')
  await heading('하던 설치를 이어갑니다', 60000)
  ok('다시 들어오면 이어 하기 화면')
  await snap('resume')
  await page.getByRole('button', { name: '이어서 하기' }).click()
  await heading('관리자 계정', 30000)
  expect('이어 하면 하던 화면(관리자 계정)으로 간다', (await hash()).startsWith('#/admin'), await hash())
  expect('서버가 이어 할 단계를 기억한다', (await page.evaluate(async () => (await fetch('/api/state', { credentials: 'same-origin' })).json())).step === 'admin')
  await fillAdmin()
  await next()

  console.log('== 요약 ==')
  await heading('이대로 설치합니다')
  // 요약은 사전 점검을 한 차례 더 수행한 뒤 채워진다. "설치"를 누를 수 있을 때까지 대기한다
  await page.waitForFunction(() => {
    const all = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '설치')
    const b = all[all.length - 1]
    return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
  }, null, { timeout: 180000 })
  const summary = await page.locator('main').innerText()
  expect('요약: 접속 주소', summary.includes(`https://${opt.domain}`))
  expect('요약: 열리는 포트(80 · 443 · 메일)', /80 · 443/.test(summary) && /993/.test(summary))
  expect('요약: 임시 인증서 주의', /임시 인증서로 설치합니다/.test(summary))
  expect('요약: 서버가 준 주의가 전부 보인다(메일 DNS · 계정 도메인)', /25/.test(summary) && summary.includes(`@${opt['mail-domain']}`))
  expect('요약: 모르는 주의 키가 없다', !/확인이 필요한 항목이 있습니다/.test(summary))
  await snap('summary')
  await noOverflow('요약')
  await next('설치')

  console.log('== 적용 ==')
  await heading('설치하는 중입니다', 60000)
  ok('적용 화면(진행 중)')
  await page.waitForTimeout(8000)
  await snap('apply-running')
  await noOverflow('적용')
  await page.getByRole('heading', { name: '설치가 끝났습니다' }).first().waitFor({ state: 'visible', timeout: 25 * 60 * 1000 })
  ok('적용 완료')
  await snap('apply-done')
  const open = page.getByRole('button', { name: '완료 화면 열기' }).or(page.getByRole('link', { name: '완료 화면 열기' }))
  if (await open.count()) await open.first().click()
  await page.getByText('다음에 할 일').waitFor({ timeout: 30000 })
  const done = await page.locator('body').innerText()
  const openHref = await page.getByRole('link', { name: /워크스페이스 열기/ }).first().getAttribute('href')
  expect('완료 화면: 워크스페이스 열기가 접속 주소로 간다', openHref === `https://${opt.domain}`, String(openHref))
  expect('완료 화면: 할 일(사람 초대 · 백업 · 인증서)', /사람 초대/.test(done) && /백업 설정/.test(done) && /인증서 발급/.test(done))
  const links = await page.locator('a[href*="/admin/"]').evaluateAll(a => a.map(x => x.getAttribute('href')))
  expect('완료 화면: 관리 화면 링크가 실제 경로', links.length >= 2 && links.every(h => /\/admin\/(users|storage|mail)$/.test(h)), links.join(' '))
  await snap('done')
  await noOverflow('완료')

  console.log('== 설치 뒤 잠김 ==')
  await page.goto(opt.url + '/')
  await heading('설치가 이미 끝났습니다', 60000)
  ok('설치 뒤에는 잠김 화면')
  expect('잠김 화면: 다시 설치 명령', (await page.getByText(/jw reinstall --yes/).count()) > 0)
  await snap('locked')
  return finish(browser)
}

async function finish(browser) {
  await browser.close()
  // 잠금 이후의 API 는 423 을 반환한다. 브라우저가 해당 응답을 콘솔 오류로 기록하는 것은 화면 오류가 아니다
  const real = consoleErrors.filter(e => !/status of (401|423)/.test(e))
  console.log(`== 콘솔 오류 ${real.length}건 (401·423 응답 알림 ${consoleErrors.length - real.length}건 제외) ==`)
  for (const e of real.slice(0, 10)) console.log('   ' + e)
  if (real.length) { fail++; failed.push('콘솔 오류') }
  console.log(`== 결과: 통과 ${pass} · 실패 ${fail} (폭 ${width}) ==`)
  for (const f of failed) console.log('   실패: ' + f)
  process.exit(fail ? 1 : 0)
}

process.on('unhandledRejection', e => { console.log('  FAIL ' + String(e).slice(0, 200)); process.exit(1) })
main().catch(async e => {
  console.log('  FAIL 진행이 멈췄다 — ' + String(e).split('\n')[0].slice(0, 300))
  process.exit(1)
})
