#!/usr/bin/env node
/**
 * 회의의 "노이즈 제거" 토글이 마이크 트랙의 잡음 억제를 **실제로** 바꾸는지 본다.
 * 회의 구역이 켜진 설치에서 돌린다(scenarios/s10-rbi.sh 의 설치가 회의 구역을 함께 켠다).
 *
 *   node meeting-noise-ui.cjs --url https://ws.e2e.example --addr 192.168.10.20 --password-file <파일> [--out <폴더>] [--chrome <경로>]
 *
 * Chromium 을 가짜 마이크·카메라(`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`)로 띄워 회의에 들어가고,
 * 토글을 끄고 켤 때마다 **보내고 있는 마이크 트랙**(RTCRtpSender 의 트랙)의 `getSettings().noiseSuppression` 을 읽는다.
 * Chromium 은 `applyConstraints` 로 이 값을 바꾸지 못한다 — 화면은 트랙을 새 제약으로 다시 잡아 바꿔 끼운다. 그래서 트랙 id 가 바뀌는 것도 본다.
 * 필요한 것: playwright-core(NODE_PATH), 가짜 장치를 지원하는 Chromium, 이 PC 에서 서버의 회의 포트(UDP 7882-7892 또는 TCP 7881)에 닿을 것.
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright-core')

const opt = { out: 'meeting-noise-shots' }
for (let a = process.argv.slice(2), i = 0; i < a.length; i++) if (a[i].startsWith('--')) opt[a[i].slice(2)] = a[++i]
if (!opt.url || !opt['password-file']) { console.error('--url 과 --password-file 이 필요합니다'); process.exit(2) }
const base = opt.url.replace(/\/+$/, '')
const host = new URL(base).hostname
let pass = 0, fail = 0
const ok = n => { pass++; console.log('  PASS ' + n) }
const bad = (n, d) => { fail++; console.log('  FAIL ' + n + (d ? ' — ' + d : '')) }
const expect = (n, c, d) => (c ? ok(n) : bad(n, d))

;(async () => {
  fs.mkdirSync(opt.out, { recursive: true })
  const browser = await chromium.launch({
    headless: true, ...(opt.chrome ? { executablePath: opt.chrome } : {}),
    args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors',
      ...(opt.addr ? [`--host-resolver-rules=MAP ${host} ${opt.addr}`] : []),
    ],
  })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, locale: 'ko-KR', permissions: ['microphone', 'camera'] })
  // 페이지가 만드는 연결을 기억해 둔다 — "보내고 있는 마이크 트랙"을 화면 밖에서 읽으려고
  await ctx.addInitScript(() => {
    const pcs = (window.__jwPcs = [])
    const Orig = window.RTCPeerConnection
    if (!Orig) return
    window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); pcs.push(pc); return pc }
    window.RTCPeerConnection.prototype = Orig.prototype
    Object.setPrototypeOf(window.RTCPeerConnection, Orig)
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => { if (!/ServiceWorker/.test(String(e))) errors.push(String(e).slice(0, 200)) })
  const call = (method, p, body) => page.evaluate(async ({ method, p, body }) => {
    const r = await fetch(p, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { method, p, body })
  // 보내고 있는 마이크 트랙 — 살아 있는 연결의 오디오 sender
  const mic = () => page.evaluate(() => {
    const out = []
    for (const pc of window.__jwPcs || []) {
      if (pc.connectionState === 'closed') continue
      for (const s of pc.getSenders()) {
        const t = s.track
        if (t && t.kind === 'audio' && t.readyState === 'live') out.push({ id: t.id, enabled: t.enabled, ns: t.getSettings().noiseSuppression, ec: t.getSettings().echoCancellation })
      }
    }
    return out
  })

  console.log('== 로그인 · 회의 만들기 ==')
  await page.goto(base + '/login')
  const password = fs.readFileSync(opt['password-file'], 'utf8').trim()
  const login = await call('POST', '/api/auth/login', { username: 'admin', password })
  expect('관리자 로그인', login.status === 200, String(login.status))
  const room = 'e2e-noise-' + Date.now().toString(36)
  const made = await call('POST', '/api/meetings/rooms', { name: room })
  expect('회의 만들기(201)', made.status === 201, JSON.stringify(made).slice(0, 200))

  console.log('== 입장 ==')
  await page.goto(base + '/meetings/room/' + encodeURIComponent(room))
  const join = page.getByRole('button', { name: /회의 참여|참여/ }).last()
  await join.waitFor({ timeout: 30000 })
  await page.waitForTimeout(2000)                       // 장치 목록이 찰 시간
  await page.screenshot({ path: path.join(opt.out, '01-device.png') })
  await join.click()
  const toggle = page.locator('button[title="노이즈 제거"]')
  await toggle.waitFor({ timeout: 60000 }).then(() => ok('회의 화면(컨트롤 바)')).catch(e => bad('회의 화면(컨트롤 바)', String(e).slice(0, 160)))
  let tracks = []
  for (let i = 0; i < 30; i++) { tracks = await mic(); if (tracks.length) break; await page.waitForTimeout(1000) }
  expect('마이크 트랙을 보내고 있다', tracks.length === 1, JSON.stringify(tracks))
  if (!tracks.length) { await page.screenshot({ path: path.join(opt.out, '02-no-mic.png') }); await browser.close(); console.log(`\n결과: 통과 ${pass} · 실패 ${fail + 1}`); process.exit(1) }
  await page.screenshot({ path: path.join(opt.out, '02-joined.png') })
  expect('처음에는 켜져 있다 — 단추', (await toggle.getAttribute('aria-pressed')) === 'true')
  expect('처음에는 켜져 있다 — 트랙의 noiseSuppression = true', tracks[0].ns === true, JSON.stringify(tracks[0]))

  // press(기대값) — 토글을 누르고, 단추가 그 상태가 되고 바쁜 표시가 풀릴 때까지 기다린 뒤 트랙을 읽는다
  const press = async want => {
    const before = (await mic())[0]
    await toggle.click()
    await page.waitForFunction(w => { const b = document.querySelector('button[title="노이즈 제거"]'); return b && b.getAttribute('aria-pressed') === String(w) && !b.disabled }, want, { timeout: 30000 }).catch(() => {})
    let after = []
    for (let i = 0; i < 20; i++) { after = await mic(); if (after.length === 1 && after[0].ns === want) break; await page.waitForTimeout(500) }
    const label = want ? '켜기' : '끄기'
    expect(`${label} — 단추`, (await toggle.getAttribute('aria-pressed')) === String(want))
    expect(`${label} — 보내는 트랙의 noiseSuppression = ${want}`, after.length === 1 && after[0].ns === want, JSON.stringify(after))
    expect(`${label} — 다른 처리(반향 제거)는 그대로`, after.length === 1 && after[0].ec === before.ec, JSON.stringify({ before, after }))
    console.log(`   트랙 ${before.id.slice(0, 8)} → ${after[0] ? after[0].id.slice(0, 8) : '없음'}${after[0] && after[0].id !== before.id ? ' (다시 잡았다)' : ' (같은 트랙)'}`)
    return after[0]
  }
  console.log('== 토글 ==')
  await press(false)
  await page.screenshot({ path: path.join(opt.out, '03-off.png') })
  await press(true)
  await press(false)
  // 마이크를 껐다 켜도(트랙을 새로 잡는다) 고른 값이 유지되는가
  const micOff = page.locator('button[title="마이크 끄기"]'), micOn = page.locator('button[title="마이크 켜기"]')
  await micOff.click()
  await micOn.waitFor({ timeout: 15000 }).then(() => ok('마이크 끄기')).catch(e => bad('마이크 끄기', String(e).slice(0, 120)))
  expect('마이크가 꺼지면 토글은 잠긴다', await toggle.isDisabled())
  await micOn.click()
  await micOff.waitFor({ timeout: 15000 }).catch(() => {})
  let again = []
  for (let i = 0; i < 20; i++) { again = (await mic()).filter(t => t.enabled); if (again.length === 1 && again[0].ns === false) break; await page.waitForTimeout(500) }
  expect('마이크를 껐다 켠 뒤에도 꺼진 채다', again.length === 1 && again[0].ns === false, JSON.stringify(again))
  await press(true)

  const del = await call('DELETE', '/api/meetings/rooms/' + encodeURIComponent(room))
  expect('회의 지우기', del.status === 204 || del.status === 200, String(del.status))
  expect('화면 오류 없음', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
