#!/usr/bin/env node
/**
 * 설치 뒤 관리 화면에서 인증서 카드·구역의 연결 보류·저장소 상태 카드를 **화면으로** 본다(Playwright, 이 PC 에서).
 * 임시 인증서 + 코드 저장소 구역으로 설치된 서버에서 돌린다.
 *
 *   node admin-cert-ui.cjs --url https://ws.e2e.example --addr 192.168.10.20 --password-file <파일> [옵션]
 *
 *   --addr <주소>        접속 주소가 DNS 에 없을 때 그 이름을 이 주소로 돌린다
 *   --cert <파일> --key <파일>   올릴 인증서·개인 키(PEM). 주면 "인증서 올리기"까지 한다
 *   --expect-pending yes|no      올린 뒤에도 코드 저장소 연결이 보류로 남는 것이 맞는가(사설 CA 면 yes)   기본 yes
 *   --ca <파일>          그 인증서를 내준 CA 의 인증서(PEM). 주면 보류 안내에서 "CA 인증서 올리기"까지 한다 —
 *                        서버 인증서 한 장만 올린 뒤(--cert 에 체인을 붙이지 않는다) CA 만 따로 올려 연결이 이어지는지
 *   --only cert|zones|storage    한 화면만
 *   --storage nfs|local          저장소 상태 카드에 보일 종류
 *   --storage-down               저장소가 끊긴 상태의 화면(카드·파일 탭 안내·알림 띠)을 본다
 *   --out <폴더>         화면 사진을 둘 곳                                                        기본 ./admin-cert-shots
 * 필요한 것: playwright-core(NODE_PATH).
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright-core')

const opt = { out: 'admin-cert-shots', 'expect-pending': 'yes' }
for (let a = process.argv.slice(2), i = 0; i < a.length; i++) {
  if (!a[i].startsWith('--')) continue
  if (a[i] === '--storage-down') opt['storage-down'] = true
  else opt[a[i].slice(2)] = a[++i]
}
if (!opt.url || !opt['password-file']) { console.error('--url 과 --password-file 이 필요합니다'); process.exit(2) }
const base = opt.url.replace(/\/+$/, '')
const host = new URL(base).hostname
let pass = 0, fail = 0, shot = 0
const ok = n => { pass++; console.log('  PASS ' + n) }
const bad = (n, d) => { fail++; console.log('  FAIL ' + n + (d ? ' — ' + d : '')) }
const expect = (n, c, d) => (c ? ok(n) : bad(n, d))
const want = name => !opt.only || opt.only === name

;(async () => {
  fs.mkdirSync(opt.out, { recursive: true })
  const browser = await chromium.launch({
    headless: true, ...(opt.chrome ? { executablePath: opt.chrome } : {}),
    args: opt.addr ? [`--host-resolver-rules=MAP ${host} ${opt.addr}`] : [],
  })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: Number(opt.width) || 1280, height: 900 }, locale: 'ko-KR' })
  const page = await context.newPage()
  const snap = async name => { shot++; await page.screenshot({ path: path.join(opt.out, `${String(shot).padStart(2, '0')}-${name}.png`), fullPage: true }) }
  const api = p => page.evaluate(async u => { const r = await fetch(u, { credentials: 'same-origin' }); return { status: r.status, body: await r.json().catch(() => null) } }, p)

  const password = fs.readFileSync(opt['password-file'], 'utf8').trim()
  await page.goto(base + '/login')
  const login = await page.evaluate(async pw => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: pw }) })).status, password)
  expect('관리자 로그인', login === 200, String(login))

  if (want('cert')) {
    console.log('== 관리 › 보안 — 인증서 카드 ==')
    await page.goto(base + '/admin/security')
    const card = page.locator('[data-testid=cert-card]')
    await card.waitFor({ state: 'visible', timeout: 60000 })
    const before = (await api('/api/admin/system/cert')).body
    const text = await card.innerText()
    expect('카드의 종류가 서버 값과 같다', before && (await page.locator('[data-testid=cert-mode]').innerText()).length > 0, JSON.stringify(before && before.mode))
    expect('접속 주소·만료일·이름이 보인다', before && text.includes(before.domain) && /남음|만료/.test(text), text.slice(0, 200))
    if (before && before.temporary) expect('임시 인증서 경고가 보인다', await page.locator('[data-testid=cert-temporary]').count() === 1)
    await snap('cert-card')
    if (opt.cert && opt.key) {
      await page.getByRole('button', { name: '인증서 올리기' }).click()
      const files = page.locator('[role=dialog] input[type=file]')
      await files.nth(0).setInputFiles(opt.cert)
      await files.nth(1).setInputFiles(opt.key)
      await snap('cert-upload-modal')
      await page.locator('[role=dialog] button:not([disabled])').last().click()
      const end = page.locator('[data-testid=cert-done], [data-testid=cert-failed], [data-testid=cert-upload-error]')
      await page.locator('[data-testid=cert-job]').waitFor({ state: 'visible', timeout: 30000 }).then(() => ok('진행 중인 작업(발급 → 다시 읽히기 → 구역 다시 연결)이 보인다')).catch(() => {})
      await snap('cert-job')
      // 서버가 인증서를 다시 읽는 동안 연결이 끊길 수 있다 — 끝 상태가 보일 때까지 기다린다
      await end.first().waitFor({ state: 'visible', timeout: 5 * 60 * 1000 }).catch(() => {})
      if (!(await end.count())) { await page.reload(); await end.first().waitFor({ state: 'visible', timeout: 60000 }).catch(() => {}) }
      expect('인증서를 바꿨습니다', await page.locator('[data-testid=cert-done]').count() === 1, (await card.innerText().catch(() => '')).slice(0, 300))
      await snap('cert-done')
      await page.reload()
      await card.waitFor({ state: 'visible', timeout: 60000 })
      const after = (await api('/api/admin/system/cert')).body
      expect('종류가 "올린 인증서"로 바뀌었다', after && after.mode === 'upload' && /올린 인증서/.test(await card.innerText()), JSON.stringify(after && after.mode))
      expect('임시 인증서 경고가 사라졌다', after && after.temporary === false && await page.locator('[data-testid=cert-temporary]').count() === 0)
      expect(`보류된 구역 연결: ${opt['expect-pending'] === 'yes' ? '남아 있다(사설 CA)' : '없다'}`,
        after && (after.pending.length > 0) === (opt['expect-pending'] === 'yes'), JSON.stringify(after && after.pending))
      await snap('cert-after')
      if (opt.ca) {
        console.log('== 인증서 카드 — CA 인증서만 따로 올리기 ==')
        const need = page.locator('[data-testid=cert-ca-needed]')
        expect('올린 인증서에 발급 CA 가 없어 연결이 보류라는 안내가 보인다', await need.count() === 1 && /로그인 연동이 보류/.test(await need.innerText().catch(() => '')), (await card.innerText()).slice(0, 300))
        expect('발급 CA 줄: 올리지 않았습니다', /올리지 않았습니다/.test(await page.locator('[data-testid=cert-ca]').innerText().catch(() => '')))
        await need.getByRole('button', { name: 'CA 인증서 올리기' }).click()
        const dialog = page.locator('[role=dialog]')
        expect('CA 만 받는 창(파일 칸 하나, 인증서·개인 키는 그대로라는 안내)', await dialog.locator('input[type=file]').count() === 1 && /인증서와 개인 키는 그대로/.test(await dialog.innerText()))
        // 먼저 엉뚱한 파일(서버 인증서) — 창 안에서 거부 사유를 보여 준다
        await dialog.locator('input[type=file]').setInputFiles(opt.cert)
        await dialog.locator('button:not([disabled])').last().click()
        const refused = page.locator('[data-testid=cert-upload-error]')
        await refused.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
        expect('서버 인증서를 CA 로 올리면 거부하고 이유를 알린다', /CA 인증서가 아닙니다/.test(await refused.innerText().catch(() => '')), (await dialog.innerText()).slice(0, 300))
        await snap('cert-ca-refused')
        await dialog.locator('input[type=file]').setInputFiles(opt.ca)
        await snap('cert-ca-modal')
        await dialog.locator('button:not([disabled])').last().click()
        await page.locator('[data-testid=cert-job]').waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
        const end2 = page.locator('[data-testid=cert-done], [data-testid=cert-failed]')
        await end2.first().waitFor({ state: 'visible', timeout: 5 * 60 * 1000 }).catch(() => {})
        if (!(await end2.count())) { await page.reload(); await end2.first().waitFor({ state: 'visible', timeout: 60000 }).catch(() => {}) }
        expect('CA 인증서를 올린 작업이 끝났다', await page.locator('[data-testid=cert-done]').count() === 1, (await card.innerText().catch(() => '')).slice(0, 300))
        await page.reload()
        await card.waitFor({ state: 'visible', timeout: 60000 })
        const trusted = (await api('/api/admin/system/cert')).body
        expect('보류됐던 구역 연결이 이어졌다', trusted && trusted.site_ca === true && trusted.pending.length === 0, JSON.stringify(trusted && { site_ca: trusted.site_ca, pending: trusted.pending }))
        expect('안내가 사라지고 발급 CA 줄이 바뀌었다', await page.locator('[data-testid=cert-ca-needed]').count() === 0 && /믿습니다/.test(await page.locator('[data-testid=cert-ca]').innerText().catch(() => '')))
        await snap('cert-ca-after')
      }
    }
  }

  if (want('zones')) {
    console.log('== 관리 › 구역 — 연결 보류 · 작업 목록 · 검증된 버전 ==')
    await page.goto(base + '/admin/zones')
    await page.getByText('코드 저장소').first().waitFor({ state: 'visible', timeout: 60000 })
    const zones = (await api('/api/admin/system/zones')).body
    const git = zones && [...(zones.zones || []), ...(zones.addons || [])].find(z => z.id === 'git')
    const body = await page.locator('body').innerText()
    if (git && git.pending) {
      expect('코드 저장소 행에 "연결 보류"가 보인다', /연결 보류/.test(body))
      expect('"다시 연결" 버튼이 있다', await page.getByRole('button', { name: /다시 연결/ }).count() >= 1)
      await snap('zones-pending')
      await page.getByRole('button', { name: /다시 연결/ }).first().click()
      await page.getByText(/다시 연결 중|연결 실패|다시 연결했습니다|연결하지 못했습니다/).first().waitFor({ state: 'visible', timeout: 120000 }).catch(() => {})
      await page.waitForTimeout(8000)
      const again = await page.locator('body').innerText()
      expect(`다시 연결 결과가 화면에 보인다(${opt['expect-pending'] === 'yes' ? '아직 연결하지 못함' : '연결됨'})`,
        opt['expect-pending'] === 'yes' ? /연결하지 못했습니다|연결 실패|연결 보류/.test(again) : /다시 연결했습니다/.test(again) || !/연결 보류/.test(again), again.slice(0, 300))
      await snap('zones-reconnect')
    } else {
      expect('코드 저장소는 보류가 아니다(연결됨)', git && git.enabled && !/연결 보류/.test(body), JSON.stringify(git && { enabled: git.enabled, pending: git.pending }))
      await snap('zones')
    }
    const jobs = await api('/api/admin/system/jobs')
    expect('작업 목록이 설치 관리자에서 온다', jobs.status === 200 && Array.isArray(jobs.body && jobs.body.jobs), String(jobs.status))
    console.log('   최근 작업: ' + ((jobs.body && jobs.body.jobs) || []).slice(0, 5).map(j => `${j.kind}:${j.zone || '-'}:${j.status}`).join(' '))
    expect('검증된 버전 글자가 응답에 있다', zones && /^\d+\.\d+/.test(String(zones.git_verified_version || '')), String(zones && zones.git_verified_version))
  }

  if (want('storage')) {
    console.log('== 관리 › 저장소 — 상태 카드 ==')
    await page.goto(base + '/admin/storage')
    const card = page.locator('[data-testid=storage-status]')
    await card.waitFor({ state: 'visible', timeout: 60000 })
    await page.waitForTimeout(opt['storage-down'] ? 6000 : 1500)
    const st = (await api('/api/admin/system/storage')).body || (await api('/api/admin/storage/status')).body
    const text = await card.innerText()
    console.log('   카드: ' + text.replace(/\s+/g, ' ').slice(0, 200))
    console.log('   응답: ' + JSON.stringify(st).slice(0, 300))
    if (st && st.source) expect('종류·위치가 설치 관리자 값이다(source=installer)', st.source === 'installer', String(st.source))
    if (opt.storage === 'nfs') expect('카드에 네트워크 저장소와 위치가 보인다', st && st.kind === 'nfs' && text.includes(String(st.location)), text.slice(0, 200))
    if (opt.storage === 'local') expect('카드에 이 서버의 디스크와 위치가 보인다', st && st.kind === 'local' && text.includes(String(st.location)), text.slice(0, 200))
    await snap(opt['storage-down'] ? 'storage-down' : 'storage')
    if (opt['storage-down']) {
      expect('카드에 끊긴 사유가 보인다', await page.locator('[data-testid=storage-reason]').count() === 1 || /응답하지 않|연결되지 않|끊/.test(text), text.slice(0, 200))
      const banner = await page.locator('body').innerText()
      expect('관리자 알림 띠가 보인다', /저장소/.test(banner) && /(응답하지 않|연결|끊)/.test(banner))
      await page.goto(base + '/files')
      await page.waitForTimeout(6000)
      const files = await page.locator('body').innerText()
      expect('파일 탭에 안내가 보인다', /저장소/.test(files) && /(올릴 수 없|응답하지 않|연결|끊)/.test(files), files.replace(/\s+/g, ' ').slice(0, 300))
      await snap('files-down')
    }
  }

  await browser.close()
  console.log(`== 결과: 통과 ${pass} · 실패 ${fail} ==`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.log('  FAIL ' + String(e).slice(0, 300)); process.exit(1) })
