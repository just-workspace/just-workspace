#!/usr/bin/env node
/**
 * 설치 뒤 관리 화면(관리 › 구역)에서 구역을 켜고 끈다 — 화면 → backend → 설치 관리자 내부 API 경로를 실제로 탄다.
 * 최소 묶음으로 설치된 서버에서 돌린다: 채팅 켜기 → 코드 저장소 켜기(검증된 버전) → 채팅 끄기.
 *
 *   node admin-zones-ui.cjs --url https://ws.e2e.example --addr 192.168.10.20 --password-file <파일> [--out <폴더>] [--chrome <경로>]
 *
 *   --addr   접속 주소가 DNS 에 없을 때 그 이름을 이 주소로 돌린다
 * 필요한 것: playwright-core(NODE_PATH).
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright-core')

const opt = { out: 'admin-zones-shots' }
for (let a = process.argv.slice(2), i = 0; i < a.length; i++) if (a[i].startsWith('--')) opt[a[i].slice(2)] = a[++i]
if (!opt.url || !opt['password-file']) { console.error('--url 과 --password-file 이 필요합니다'); process.exit(2) }
const base = opt.url.replace(/\/+$/, '')
const host = new URL(base).hostname
let pass = 0, fail = 0, shot = 0
const ok = n => { pass++; console.log('  PASS ' + n) }
const bad = (n, d) => { fail++; console.log('  FAIL ' + n + (d ? ' — ' + d : '')) }
const expect = (n, c, d) => (c ? ok(n) : bad(n, d))

;(async () => {
  fs.mkdirSync(opt.out, { recursive: true })
  const browser = await chromium.launch({
    headless: true, ...(opt.chrome ? { executablePath: opt.chrome } : {}),
    args: opt.addr ? [`--host-resolver-rules=MAP ${host} ${opt.addr}`] : [],
  })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, locale: 'ko-KR' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)))
  const snap = async n => { shot++; await page.screenshot({ path: path.join(opt.out, `${String(shot).padStart(2, '0')}-${n}.png`), fullPage: true }) }
  const api = p => page.evaluate(async p => { try { const r = await fetch(p, { credentials: 'same-origin' }); return { status: r.status, body: await r.json().catch(() => null) } } catch { return { status: 0, body: null } } }, p)

  await page.goto(base + '/login')
  const password = fs.readFileSync(opt['password-file'], 'utf8').trim()
  const login = await page.evaluate(async pw => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: pw }) })).status, password)
  expect('관리자 로그인', login === 200, String(login))

  const open = async () => {
    await page.goto(base + '/admin/zones')
    await page.getByRole('heading', { name: '구역', exact: true }).first().waitFor({ timeout: 30000 })
    await page.getByRole('switch').first().waitFor({ timeout: 30000 })
  }
  // 그 이름의 구역 줄에 있는 스위치
  const toggle = name => page.locator('li, tr, [role="row"], div').filter({ has: page.getByText(name, { exact: true }) }).filter({ has: page.getByRole('switch') }).last().getByRole('switch')

  // act(이름, 구역 id, 켤지) — 스위치를 누르고(확인 창이 뜨면 진행 단추를 누른다) 반영될 때까지 본다
  const act = async (name, id, on) => {
    console.log(`== ${name} ${on ? '켜기' : '끄기'} ==`)
    await toggle(name).click()
    await page.waitForTimeout(1500)
    const dialog = page.getByRole('dialog').last()
    if (await dialog.count()) {
      const text = (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 300)
      console.log('   창: ' + text)
      await snap(`${id}-${on ? 'enable' : 'disable'}-dialog`)
      const buttons = dialog.getByRole('button')
      const labels = await buttons.evaluateAll(b => b.map(x => x.textContent.trim()))
      console.log('   단추: ' + labels.join(' | '))
      // 진행 단추 = 닫기·취소가 아닌 마지막 단추. 여러 단계 창이면 더 누를 것이 없을 때까지 누른다
      for (let step = 0; step < 5; step++) {
        const d = page.getByRole('dialog').last()
        if (!(await d.count())) break
        const names = await d.getByRole('button').evaluateAll(b => b.map(x => ({ t: x.textContent.trim(), off: x.disabled })))
        const go = names.map((n, i) => ({ ...n, i })).filter(n => n.t && !/취소|닫기|이전|^×$/.test(n.t) && !n.off).pop()
        if (!go) break
        await d.getByRole('button').nth(go.i).click()
        console.log('   누름: ' + go.t)
        await page.waitForTimeout(2500)
      }
    }
    await snap(`${id}-${on ? 'enable' : 'disable'}-running`)
    // backend 가 다시 뜨는 동안 화면이 견디는지 — "다시 연결" 안내를 본 적이 있는지 적어 둔다
    let sawReconnect = false, sawDown = false, done = false
    const t0 = Date.now()
    while (Date.now() - t0 < 10 * 60 * 1000) {
      const body = await page.locator('body').innerText().catch(() => '')
      if (/다시 연결/.test(body)) sawReconnect = true
      const h = await api('/api/health')
      if (h.status !== 200) sawDown = true
      const zones = (h.body && h.body.zones) || null
      if (zones && zones.includes(id) === on) {
        const listing = await api('/api/admin/system/zones')
        const rows = listing.body ? [...(listing.body.zones || []), ...(listing.body.addons || [])] : []
        const row = rows.find(r => r.id === id)
        if (row && !(row.job && row.job.status === 'running')) { done = true; break }
      }
      await page.waitForTimeout(2000)
    }
    expect(`${name}: /api/health 의 zones 에 ${on ? '들어왔다' : '빠졌다'}`, done)
    console.log(`   걸린 시간 ${Math.round((Date.now() - t0) / 1000)}초 · backend 끊김을 봤는가 ${sawDown} · "다시 연결" 안내를 봤는가 ${sawReconnect}`)
    await page.waitForTimeout(3000)
    const crashed = await page.locator('body').innerText().catch(() => '')
    expect(`${name}: 화면이 오류 화면으로 넘어가지 않았다`, !/문제가 발생|오류가 발생했습니다|Something went wrong/.test(crashed))
    await snap(`${id}-${on ? 'enabled' : 'disabled'}`)
    await open()
    const state = await toggle(name).getAttribute('aria-checked')
    expect(`${name}: 다시 열어도 스위치가 ${on ? '켜짐' : '꺼짐'}`, state === String(on), String(state))
  }

  await open()
  ok('관리 › 구역 화면이 열린다(목록은 backend 가 설치 관리자에게서 받는다)')
  const listing = await api('/api/admin/system/zones')
  expect('설치 관리자에 닿는다(installer.available)', listing.body && listing.body.installer && listing.body.installer.available === true, JSON.stringify(listing.body && listing.body.installer))
  await snap('zones')

  await act('채팅', 'chat', true)
  const menu = await page.locator('body').innerText()
  expect('메뉴에 채팅이 생겼다', (await page.locator('a[href="/chat"], a[href^="/chat"]').count()) > 0 || /채팅/.test(menu.split('구역')[0]))
  await act('코드 저장소', 'git', true)
  expect('코드 저장소 API 가 동작한다', (await api('/api/git/repos')).status === 200)
  await act('채팅', 'chat', false)

  await browser.close()
  console.log(`== 화면 오류 ${errors.length}건 ==`)
  for (const e of errors.slice(0, 5)) console.log('   ' + e)
  console.log(`== 결과: 통과 ${pass} · 실패 ${fail + (errors.length ? 1 : 0)} ==`)
  process.exit(fail || errors.length ? 1 : 0)
})().catch(e => { console.log('  FAIL 진행이 멈췄다 — ' + String(e).split('\n')[0].slice(0, 300)); process.exit(1) })
