#!/usr/bin/env node
/**
 * 설치 마법사의 "백업에서 복원"을 **화면을 눌러서** 끝까지 진행한다(Playwright) — 검수 서버 밖(이 PC)에서 돈다.
 *
 *   node restore-ui.cjs --url https://192.168.10.20:8443 --token XXXXXXXXXXXX --backup ./backup.jwbak [옵션]
 *
 *   --url <주소>        설치 관리자 주소(자체 서명 인증서라 검증하지 않는다)
 *   --token <토큰>      설치 토큰
 *   --backup <파일>     올릴 백업 파일(.jwbak) — 이 PC 에 있는 것
 *   --path <경로>       올리는 대신 서버에 있는 파일의 경로를 알려 준다(--backup 대신)
 *   --password-file <파일>  설정이 암호로 보호된 백업일 때(먼저 틀린 암호를 한 번 넣어 본다)
 *   --domain <이름>     복원할 때 바꿀 접속 주소(비우면 백업의 주소 그대로)
 *   --nfs <서버:/경로>  네트워크 저장소를 다시 연결한다(백업이 NFS 였을 때)
 *   --expect-files restored|not_included|nfs   완료 화면의 파일 문구                            기본 restored
 *   --stop-at review    내용 확인 화면까지만 보고 끝낸다(복원을 시작하지 않는다)
 *   --width <픽셀>      화면 폭                                                                   기본 1280
 *   --out <폴더>        화면 사진을 둘 곳                                                         기본 ./restore-shots
 *   --chrome <경로>     크롬 실행 파일
 *
 * 필요한 것: playwright-core(NODE_PATH 로 찾을 수 있게). 하나라도 어긋나면 종료 코드 1.
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright-core')

function args() {
  const out = { width: '1280', out: 'restore-shots', 'expect-files': 'restored' }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) out[a[i].slice(2)] = a[++i]
  if (!out.url || !out.token || !(out.backup || out.path)) { console.error('--url, --token, 그리고 --backup 또는 --path 가 필요합니다'); process.exit(2) }
  out.url = out.url.replace(/\/+$/, '')
  return out
}

const opt = args()
const width = Number(opt.width) || 1280
let pass = 0
let fail = 0
const failed = []
const consoleErrors = []
let shot = 0
const ok = name => { pass++; console.log(`  PASS ${name}`) }
const bad = (name, detail) => { fail++; failed.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
const expect = (name, cond, detail) => (cond ? ok(name) : bad(name, detail))

async function main() {
  fs.mkdirSync(opt.out, { recursive: true })
  const browser = await chromium.launch({ headless: true, ...(opt.chrome ? { executablePath: opt.chrome } : {}) })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: width < 600 ? 844 : 900 }, locale: 'ko-KR' })
  const page = await context.newPage()
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)) })
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e).slice(0, 300)))
  const snap = async name => {
    shot++
    await page.screenshot({ path: path.join(opt.out, `${String(shot).padStart(2, '0')}-${name}-${width}.png`), fullPage: true })
  }
  const heading = (text, timeout = 30000) => page.getByRole('heading', { name: text }).first().waitFor({ state: 'visible', timeout })
  const enabled = (label, timeout = 120000) => page.waitForFunction(l => {
    const all = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === l)
    const b = all[all.length - 1]
    return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
  }, label, { timeout })
  const press = async (label, timeout) => {
    await enabled(label, timeout)
    await page.getByRole('button', { name: label, exact: true }).last().click()
  }
  const noOverflow = async name => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(`${name}: 가로로 넘치지 않는다`, wide <= 1, `넘침 ${wide}px`)
  }
  const api = p => page.evaluate(async u => (await fetch(u, { credentials: 'same-origin' })).json(), p)

  console.log('== 사전 점검 · 시작 방식 ==')
  await page.goto(`${opt.url}/?token=${encodeURIComponent(opt.token)}`)
  await heading('사전 점검', 60000)
  await press('다음', 180000)
  await heading('어떻게 시작할까요')
  await page.getByRole('radio', { name: /백업에서 복원/ }).click()
  await snap('start')
  await press('다음')

  console.log('== 백업 파일 ==')
  await heading('백업 파일 올리기')
  expect('"아직 지원하지 않습니다"가 아니다', (await page.getByText(/아직 지원하지 않습니다/).count()) === 0)
  if (opt.path) {
    await page.getByText('서버에 있는 파일 경로', { exact: true }).click()
    await page.getByLabel('서버에 있는 백업 파일 경로').fill(opt.path)
    await press('파일 확인')
  } else {
    const size = fs.statSync(opt.backup).size
    await page.locator('input[type=file]').first().setInputFiles(opt.backup)
    // 올리는 중(진행률) → 확인 중 → 확인됨
    const sawProgress = await page.getByText(/올리는 중|확인 중/).first().waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)
    expect('올리는 중·확인 중 상태가 보인다', sawProgress)
    await snap('file-uploading')
    console.log(`   올린 크기 ${size} 바이트`)
  }
  if (opt['password-file']) {
    await page.getByLabel('백업 암호').waitFor({ state: 'visible', timeout: 10 * 60 * 1000 })
    ok('암호 보호 백업 → 암호 입력이 나온다')
    await snap('file-password')
    await page.getByLabel('백업 암호').fill('not-the-password')
    await press('암호 확인')
    await page.getByText(/암호가 맞지 않습니다|암호가 틀렸/).first().waitFor({ state: 'visible', timeout: 120000 })
    ok('틀린 암호 → 다시 입력')
    await page.getByLabel('백업 암호').fill(fs.readFileSync(opt['password-file'], 'utf8').trim())
    await press('암호 확인')
  }
  await page.getByText('확인됨', { exact: true }).first().waitFor({ state: 'visible', timeout: 20 * 60 * 1000 })
  ok('백업 확인됨')
  const file = await api('/api/restore/file')
  expect('서버의 파일 상태 ok·ready', file.status === 'ok' && file.state === 'ready', JSON.stringify(file))
  if (opt.backup) expect('서버에 저장된 크기 = 올린 크기', file.size_bytes === fs.statSync(opt.backup).size, String(file.size_bytes))
  await snap('file-ok')
  await noOverflow('백업 파일')
  // 화면에 다시 들어와도 상태가 남아 있다
  await page.reload()
  await page.getByText('확인됨', { exact: true }).first().waitFor({ state: 'visible', timeout: 60000 })
  ok('새로 고쳐도 확인된 백업이 남아 있다')
  await press('다음')

  console.log('== 내용 확인 ==')
  await heading('이 백업으로 복원합니다', 60000)
  const review = await api('/api/restore/review')
  const text = await page.locator('main').innerText()
  expect('만든 서버가 보인다', !!review.source_url && text.includes(review.source_url), review.source_url)
  expect('버전: 복원할 수 있음', review.version_status === 'ok' && /복원할 수 있음/.test(text))
  expect('계정 수가 보인다', review.users != null && text.includes(String(review.users)))
  const address = page.getByLabel('접속 주소').first()
  expect('접속 주소가 백업의 주소로 채워져 있다', (await address.inputValue()) === review.domain, await address.inputValue())
  const fromNfs = review.storage.kind === 'nfs'
  if (fromNfs) {
    expect('NFS 였던 백업: 이 서버의 디스크는 고를 수 없다', await page.getByRole('radio', { name: /이 서버의 디스크/ }).isDisabled())
    expect('NFS 였던 백업: 잠긴 사유가 보인다', /공유를 다시 연결/.test(text))
  } else if (!review.files_included) {
    expect('파일 없는 로컬 백업: 경고가 보인다', /파일 없이 복원합니다/.test(text))
  } else {
    expect('파일 포함: 크기가 보인다', /파일/.test(text) && review.files_bytes > 0)
  }
  if (opt.nfs) {
    const [server, exportPath] = [opt.nfs.slice(0, opt.nfs.indexOf(':')), opt.nfs.slice(opt.nfs.indexOf(':') + 1)]
    if (!fromNfs) await page.getByRole('radio', { name: /네트워크 저장소/ }).click()
    const inputs = page.locator('main input[type=text], main input:not([type])')
    const serverInput = page.getByLabel(/서버 주소|NAS 주소/).first()
    const exportInput = page.getByLabel(/공유 경로|내보내기 경로/).first()
    if (await serverInput.count()) { await serverInput.fill(server); await exportInput.fill(exportPath) }
    else { await inputs.nth(0).fill(server); await inputs.nth(1).fill(exportPath) }
    await page.keyboard.press('Tab')
    await page.getByText(/연결을 확인했습니다|연결됨|같은 저장소/).first().waitFor({ state: 'visible', timeout: 120000 }).catch(() => {})
  }
  if (opt.domain) {
    await address.fill(opt.domain)
    await page.keyboard.press('Tab')
  }
  await snap('review')
  await noOverflow('내용 확인')
  if (opt['stop-at'] === 'review') return finish(browser)
  await enabled('복원', 180000)
  const reviewText = await page.locator('main').innerText()
  if (opt.domain || /아직 이 서버를 가리키지 않습니다/.test(reviewText)) {
    expect('접속 주소가 이 서버를 가리키지 않아도 막지 않고 경고만 한다', /임시 인증서로 설치합니다/.test(reviewText))
  }
  await snap('review-ready')
  await press('복원')

  console.log('== 적용 ==')
  await heading('복원하는 중입니다', 60000)
  ok('적용 화면(진행 중)')
  await page.waitForTimeout(6000)
  const running = await page.locator('main').innerText()
  expect('복원 단계 이름이 보인다', /설정 파일/.test(running) && /데이터 되돌리기/.test(running), running.slice(0, 200))
  await snap('apply-running')
  await noOverflow('적용')
  await page.getByRole('heading', { name: '복원이 끝났습니다' }).first().waitFor({ state: 'visible', timeout: 40 * 60 * 1000 })
  ok('복원 완료')
  await snap('apply-done')
  const open = page.getByRole('button', { name: '완료 화면 열기' }).or(page.getByRole('link', { name: '완료 화면 열기' }))
  if (await open.count()) await open.first().click()
  await page.getByText('다음에 할 일').waitFor({ timeout: 30000 })
  const done = await page.locator('body').innerText()
  const want = { restored: /백업에 든 파일도 되돌렸습니다/, not_included: /파일 없이 복원했습니다/, nfs: /네트워크 저장소를 다시 연결했습니다/ }[opt['expect-files']]
  expect(`완료 화면: 파일 문구(${opt['expect-files']})`, want.test(done), done.slice(0, 300))
  expect('완료 화면: 할 일(접속 주소 옮기기 · 원래 서버 끄기)', /접속 주소 옮기기/.test(done) && /원래 서버 끄기/.test(done))
  const domain = opt.domain || review.domain
  const href = await page.getByRole('link', { name: /워크스페이스 열기/ }).first().getAttribute('href')
  expect('완료 화면: 워크스페이스 열기가 접속 주소로 간다', href === `https://${domain}`, String(href))
  await snap('done')
  await noOverflow('완료')

  console.log('== 복원 뒤 잠김 ==')
  await page.goto(opt.url + '/')
  await heading('설치가 이미 끝났습니다', 60000)
  ok('복원 뒤에는 잠김 화면')
  await snap('locked')
  return finish(browser)
}

async function finish(browser) {
  await browser.close()
  const real = consoleErrors.filter(e => !/status of (401|409|423)/.test(e))
  console.log(`== 콘솔 오류 ${real.length}건 (401·409·423 응답 알림 ${consoleErrors.length - real.length}건 제외) ==`)
  for (const e of real.slice(0, 10)) console.log('   ' + e)
  if (real.length) { fail++; failed.push('콘솔 오류') }
  console.log(`== 결과: 통과 ${pass} · 실패 ${fail} (폭 ${width}) ==`)
  for (const f of failed) console.log('   실패: ' + f)
  process.exit(fail ? 1 : 0)
}

process.on('unhandledRejection', e => { console.log('  FAIL ' + String(e).slice(0, 300)); process.exit(1) })
main().catch(e => { console.log('  FAIL ' + String(e).slice(0, 300)); process.exit(1) })
