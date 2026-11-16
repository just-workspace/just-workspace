#!/usr/bin/env node
/**
 * 관리 › 업데이트 화면을 조작하여 업데이트 1회를 끝까지 수행한다 — 화면 → backend → 설치 관리자 내부 API 경로를 실제로 경유한다.
 * 수신 가능한 버전이 있는 서버에서 실행한다(모의 릴리스 환경은 scenarios/u-update.sh).
 *
 *   node admin-update-ui.cjs --url https://ws.e2e.example --addr 192.168.10.20 --password-file <파일>
 *        [--user <계정> --user-password-file <파일>] [--out <폴더>] [--chrome <경로>]
 *
 * 창을 2개 연다: 관리자(진행 화면)와 일반 사용자(사전 공지 띠·점검 모드 화면). 일반 사용자 계정은 --user 로 지정한다 — 로그인에는
 * 복구 이메일 인증이 필요하므로, 인증을 마친 계정을 서버에서 미리 준비한다(미지정 시 본 스크립트가 가입·승인하나 인증 전이라 로그인이 거부된다).
 * 확인 항목: 현황의 새 버전 안내 → 업데이트 시작 → 사전 공지(일반 사용자 창의 띠) → "지금 바로 시작" → 진행(backend 가
 * 중지된 동안의 "다시 연결 중", 일반 사용자 창의 점검 모드 화면) → 완료 → 기록.
 * 필요 사항: playwright-core(NODE_PATH).
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { chromium } = require('playwright-core')

const opt = { out: 'admin-update-shots' }
for (let a = process.argv.slice(2), i = 0; i < a.length; i++) if (a[i].startsWith('--')) opt[a[i].slice(2)] = a[++i]
if (!opt.url || !opt['password-file']) { console.error('--url 과 --password-file 이 필요합니다'); process.exit(2) }
const base = opt.url.replace(/\/+$/, '')
const host = new URL(base).hostname
let pass = 0, fail = 0, shot = 0
const ok = n => { pass++; console.log('  PASS ' + n) }
const bad = (n, d) => { fail++; console.log('  FAIL ' + n + (d ? ' — ' + d : '')) }
const expect = (n, c, d) => (c ? ok(n) : bad(n, d))
const text = async page => (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ')

;(async () => {
  fs.mkdirSync(opt.out, { recursive: true })
  const browser = await chromium.launch({
    headless: true, ...(opt.chrome ? { executablePath: opt.chrome } : {}),
    args: opt.addr ? [`--host-resolver-rules=MAP ${host} ${opt.addr}`] : [],
  })
  const newPage = async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, locale: 'ko-KR' })
    const page = await ctx.newPage()
    page.errors = []
    page.on('pageerror', e => { if (!/ServiceWorker/.test(String(e))) page.errors.push(String(e).slice(0, 200)) })
    return page
  }
  const admin = await newPage()
  const user = await newPage()
  const snap = async (page, n) => { shot++; await page.screenshot({ path: path.join(opt.out, `${String(shot).padStart(2, '0')}-${n}.png`), fullPage: true }).catch(() => {}) }
  const call = (page, method, p, body) => page.evaluate(async ([method, p, body]) => {
    try {
      const r = await fetch(p, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      return { status: r.status, body: await r.json().catch(() => null) }
    } catch { return { status: 0, body: null } }
  }, [method, p, body])
  const loginAs = async (page, username, password) => {
    await page.goto(base + '/login')
    return (await call(page, 'POST', '/api/auth/login', { username, password })).status
  }

  const password = fs.readFileSync(opt['password-file'], 'utf8').trim()
  expect('관리자 로그인', (await loginAs(admin, 'admin', password)) === 200)

  // 일반 사용자 — --user 와 --user-password-file 로 지정하거나, 여기서 가입시킨 후 관리자가 승인한다
  // (가입 후 메일 주소 확인을 요구하는 설치에서는 사전 생성한 계정을 지정한다)
  let name = opt.user, userPass = opt['user-password-file'] ? fs.readFileSync(opt['user-password-file'], 'utf8').trim() : null
  await user.goto(base + '/login')
  let reg = { status: '-' }
  if (!name || !userPass) {
    name = 'viewer' + crypto.randomBytes(3).toString('hex')
    userPass = crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '') + 'Aa1!'
    reg = await call(user, 'POST', '/api/auth/register', { username: name, password: userPass, display_name: '검수 사용자', recovery_email: `${name}@example.com` })
    const users = await call(admin, 'GET', `/api/admin/users?q=${name}`)
    const list = Array.isArray(users.body) ? users.body : ((users.body && (users.body.users || users.body.items)) || [])
    const row = list.find(u => u.username === name)
    if (row) await call(admin, 'POST', `/api/admin/users/${row.id}/approve`)
  }
  const userLogin = await loginAs(user, name, userPass)
  expect('일반 사용자 로그인', userLogin === 200, `가입 ${reg.status} · 로그인 ${userLogin}` + (userLogin === 403 ? ' — 복구 이메일 인증을 마친 계정을 --user 로 지정한다' : ''))
  await user.goto(base + '/')
  await user.waitForTimeout(3000)

  console.log('== 현황 ==')
  await admin.goto(base + '/admin/update')
  await admin.getByRole('heading', { name: '업데이트', exact: true }).first().waitFor({ timeout: 30000 })
  const status = await call(admin, 'GET', '/api/admin/system/update/status')
  const target = status.body && status.body.available && status.body.available.version
  const from = status.body && status.body.current && status.body.current.version
  expect('받을 버전이 있다(backend 대신 부르기 → 설치 관리자)', status.status === 200 && !!target, JSON.stringify(status.body && status.body.available))
  await admin.getByText(String(target)).first().waitFor({ timeout: 20000 }).catch(() => {})
  const home = await text(admin)
  expect('현황에 새 버전이 보인다', home.includes(String(target)), home.slice(0, 200))
  await snap(admin, 'home')

  console.log('== 업데이트 시작 ==')
  // 현황의 새 버전 카드 → 내용 보기(변경 내용·바뀌는 구역) → 업데이트 시작
  const details = admin.getByRole('button', { name: /내용 보기/ }).or(admin.getByRole('link', { name: /내용 보기/ })).first()
  if (await details.count()) {
    await details.click()
    await admin.waitForTimeout(1500)
    const notes = await text(admin)
    expect('변경 내용 화면에 바뀌는 구역과 예상 중단 시간이 보인다', /구역|중단/.test(notes), notes.slice(0, 200))
    await snap(admin, 'notes')
  }
  await admin.getByRole('button', { name: '업데이트 시작' }).first().click()
  await admin.waitForTimeout(1500)
  // 확인 창이 있으면 진행 버튼을 클릭한다
  for (let i = 0; i < 3; i++) {
    const dialog = admin.locator('[role="dialog"], [role="alertdialog"]').last()
    if (!(await dialog.count())) break
    console.log('   창: ' + (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 200))
    await snap(admin, 'confirm')
    const names = await dialog.getByRole('button').evaluateAll(b => b.map(x => ({ t: x.textContent.trim(), off: x.disabled })))
    const go = names.map((n, i) => ({ ...n, i })).filter(n => n.t && !/취소|닫기|^×$/.test(n.t) && !n.off).pop()
    if (!go) break
    await dialog.getByRole('button').nth(go.i).click()
    console.log('   누름: ' + go.t)
    await admin.waitForTimeout(2000)
  }
  let job = null
  for (let i = 0; i < 20 && !job; i++) {
    const st = await call(admin, 'GET', '/api/admin/system/update/status')
    job = st.body && st.body.job
    if (!job) await admin.waitForTimeout(1000)
  }
  expect('작업이 예고로 시작됐다', !!job && job.status === 'countdown', JSON.stringify(job && job.status))
  const adminCountdown = await text(admin)
  expect('관리자 화면에 예고 안내가 보인다', /남은 시간|곧 업데이트를 시작/.test(adminCountdown), adminCountdown.slice(0, 200))
  await snap(admin, 'countdown')
  // 일반 사용자 창 — 새로 고침 없이 띠가 표시되어야 한다(실시간 알림)
  let userText = ''
  for (let i = 0; i < 20; i++) {
    userText = await text(user)
    if (/뒤 업데이트를 시작합니다|곧 업데이트를 시작합니다/.test(userText)) break
    await user.waitForTimeout(1000)
  }
  expect('일반 사용자 창에 예고 띠가 떴다(새로 고치지 않고)', /뒤 업데이트를 시작합니다|곧 업데이트를 시작합니다/.test(userText), userText.slice(0, 200))
  await snap(user, 'user-countdown')

  console.log('== 지금 바로 시작 ==')
  const now = admin.getByRole('button', { name: /지금.*시작/ }).first()
  expect('"지금 바로 시작" 단추가 있다', (await now.count()) > 0, (await admin.getByRole('button').evaluateAll(b => b.map(x => x.textContent.trim()).filter(Boolean))).join(' | '))
  await now.click()
  await admin.waitForTimeout(1500)
  const t0 = Date.now()
  let sawReconnect = false, sawDown = false, sawUserMaint = false, sawSteps = new Set(), final = null, lastShot = 0
  while (Date.now() - t0 < 25 * 60 * 1000) {
    const body = await text(admin)
    if (/다시 연결 중/.test(body)) { if (!sawReconnect) await snap(admin, 'reconnecting'); sawReconnect = true }
    for (const s of ['사전 점검', '백업', '이미지', '구역', '상태 확인']) if (body.includes(s)) sawSteps.add(s)
    const u = await text(user)
    if (/점검 중입니다|업데이트 중입니다/.test(u)) { if (!sawUserMaint) await snap(user, 'user-maintenance'); sawUserMaint = true }
    const j = await call(admin, 'GET', `/api/admin/system/update/jobs/${job.id}`)
    if (j.status !== 200) sawDown = true
    if (j.body && ['done', 'failed', 'cancelled'].includes(j.body.status)) { final = j.body; break }
    if (Date.now() - lastShot > 45000) { lastShot = Date.now(); await snap(admin, 'progress') }
    await admin.waitForTimeout(1500)
  }
  console.log(`   걸린 시간 ${Math.round((Date.now() - t0) / 1000)}초 · 진행 조회가 끊긴 적 ${sawDown} · "다시 연결 중" ${sawReconnect} · 본 단계 이름 ${[...sawSteps].join(',')}`)
  expect('작업이 끝났다(done)', final && final.status === 'done', JSON.stringify(final && { status: final.status, error: final.error }))
  expect('진행 화면에 단계가 보였다', sawSteps.size >= 3, [...sawSteps].join(','))
  expect('일반 사용자 창이 점검 화면으로 바뀌었다', sawUserMaint)
  expect('backend 가 내려간 동안 진행 화면이 "다시 연결 중"으로 버텼다', !sawDown || sawReconnect, `끊김 ${sawDown} / 안내 ${sawReconnect}`)
  await admin.waitForTimeout(4000)
  const done = await text(admin)
  expect('완료 화면', /업데이트가 완료되었습니다|업데이트했습니다/.test(done), done.slice(0, 200))
  expect('화면이 오류 화면으로 넘어가지 않았다', !/문제가 발생|오류가 발생했습니다|Something went wrong/.test(done))
  await snap(admin, 'done')
  // 일반 사용자 창은 점검 모드 종료 시 자동으로 복귀한다
  let back = false
  for (let i = 0; i < 30 && !back; i++) {
    back = !/점검 중입니다|업데이트 중입니다/.test(await text(user))
    if (!back) await user.waitForTimeout(2000)
  }
  expect('일반 사용자 창이 점검 화면에서 돌아왔다', back)
  await snap(user, 'user-back')

  console.log('== 기록 ==')
  await admin.goto(base + '/admin/update/history').catch(() => {})
  await admin.waitForTimeout(3000)
  let hist = await text(admin)
  if (!hist.includes(String(target))) {
    await admin.goto(base + '/admin/update')
    await admin.getByRole('tab', { name: '기록' }).or(admin.getByRole('link', { name: '기록' })).or(admin.getByRole('button', { name: '기록' })).first().click().catch(() => {})
    await admin.waitForTimeout(3000)
    hist = await text(admin)
  }
  // 기록 행에는 적용된 버전과 결과가 표시된다(이전 버전은 행을 펼쳐야 표시된다)
  expect('기록에 이번 업데이트가 있다', hist.includes(String(target)) && /성공/.test(hist), hist.slice(0, 300))
  await snap(admin, 'history')
  const health = await call(admin, 'GET', '/api/health')
  expect(`/api/health 의 버전이 ${target}`, health.body && health.body.version === target, JSON.stringify(health.body && health.body.version))

  await browser.close()
  const errors = [...admin.errors, ...user.errors]
  console.log(`== 화면 오류 ${errors.length}건 ==`)
  for (const e of errors.slice(0, 5)) console.log('   ' + e)
  console.log(`== 결과: 통과 ${pass} · 실패 ${fail + (errors.length ? 1 : 0)} ==`)
  process.exit(fail || errors.length ? 1 : 0)
})().catch(e => { console.log('  FAIL 진행이 멈췄다 — ' + String(e).split('\n')[0].slice(0, 300)); process.exit(1) })
