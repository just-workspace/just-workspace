#!/usr/bin/env node
/**
 * 격리 브라우저 — 세션 화면 내에 대상 페이지가 **실제로 렌더링되는지** 확인한다(미러 방식과 픽셀 방식).
 * scenarios/s10-rbi.sh 가 유지해 둔 설치(격리 브라우저 애드온 + 임시 대상 웹 서버)에서 실행한다.
 *
 *   node rbi-session-ui.cjs --url https://ws.e2e.example --addr 192.168.10.20 --password-file <파일>
 *        [--target e2e] [--mark JW-RBI-TARGET-4711] [--modes mirror,pixel] [--out <폴더>] [--chrome <경로>]
 *
 *   --addr   접속 주소와 전용 출처(rbi.<접속 주소>)가 DNS 에 없을 때 두 이름을 이 주소로 해석한다
 *   --mark   대상 페이지의 제목 문자열(미러 방식은 미러 문서에서 이 문자열을 검색한다)
 *
 * 방식별 절차: 전용 출처로 이동하여(로그인 홉) 세션을 열고 → 세션 화면을 캡처하고 → 대상 페이지의 색
 * (s10-rbi.sh 의 대상: 바탕 #fffbe6, 상자 테두리 #0050b3, 상자 바탕 #e6f4ff, 제목 글자 #b00020)이 캡처에 충분히 포함되는지 계수한다.
 * 픽셀 방식은 화면이 이미지(KasmVNC 캔버스)이므로 문자를 판독할 수 없다 — 색으로만 판정하며, 캡처는 사람이 1회 육안 확인한다.
 * 필요 사항: playwright-core(NODE_PATH).
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright-core')

const opt = { out: 'rbi-session-shots', target: 'e2e', mark: 'JW-RBI-TARGET-4711', modes: 'mirror,pixel' }
for (let a = process.argv.slice(2), i = 0; i < a.length; i++) if (a[i].startsWith('--')) opt[a[i].slice(2)] = a[++i]
if (!opt.url || !opt['password-file']) { console.error('--url 과 --password-file 이 필요합니다'); process.exit(2) }
const base = opt.url.replace(/\/+$/, '')
const host = new URL(base).hostname
let pass = 0, fail = 0
const ok = n => { pass++; console.log('  PASS ' + n) }
const bad = (n, d) => { fail++; console.log('  FAIL ' + n + (d ? ' — ' + d : '')) }
const expect = (n, c, d) => (c ? ok(n) : bad(n, d))
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 대상 페이지의 색 — [이름, r, g, b, 캡처에서 차지해야 하는 최소 비율]
// 허용 오차는 좁게 설정한다: 빈 화면(흰색)이 바탕색(#fffbe6)으로 계수되어서는 안 된다
const COLORS = [['바탕', 0xff, 0xfb, 0xe6, 0.25], ['상자 테두리', 0x00, 0x50, 0xb3, 0.002], ['상자 바탕', 0xe6, 0xf4, 0xff, 0.01], ['제목 글자', 0xb0, 0x00, 0x20, 0.0005]]
const TOLERANCE = 12

;(async () => {
  fs.mkdirSync(opt.out, { recursive: true })
  const browser = await chromium.launch({
    headless: true, ...(opt.chrome ? { executablePath: opt.chrome } : {}),
    args: opt.addr ? [`--host-resolver-rules=MAP ${host} ${opt.addr}, MAP rbi.${host} ${opt.addr}`] : [],
  })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, locale: 'ko-KR' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => { if (!/ServiceWorker/.test(String(e))) errors.push(String(e).slice(0, 200)) })

  // 캡처(PNG)에서 대상 페이지의 색이 차지하는 비율 — 별도 탭의 캔버스에서 계수한다(픽셀 방식은 압축으로 인해 색이 다소 번진다)
  const counter = await ctx.newPage()
  const colorShare = async png => counter.evaluate(async ({ b64, colors, tol }) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    const hit = colors.map(() => 0)
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < colors.length; k++) {
        const [, r, gg, b] = colors[k]
        if (Math.abs(d[i] - r) <= tol && Math.abs(d[i + 1] - gg) <= tol && Math.abs(d[i + 2] - b) <= tol) { hit[k]++; break }
      }
    }
    return hit.map(n => n / (d.length / 4))
  }, { b64: png.toString('base64'), colors: COLORS, tol: TOLERANCE })
  const drawn = share => COLORS.every((c, k) => share[k] >= c[4])
  const shareText = share => COLORS.map((c, k) => `${c[0]} ${(share[k] * 100).toFixed(2)}%`).join(', ')

  const call = (method, p, body) => page.evaluate(async ({ method, p, body }) => {
    try {
      const r = await fetch(p, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      return { status: r.status, body: await r.json().catch(() => null) }
    } catch (e) { return { status: 0, body: String(e) } }
  }, { method, p, body })

  console.log('== 로그인 ==')
  await page.goto(base + '/login')
  const password = fs.readFileSync(opt['password-file'], 'utf8').trim()
  const login = await call('POST', '/api/auth/login', { username: 'admin', password })
  expect('관리자 로그인', login.status === 200, String(login.status))
  // 모듈 rbi 는 구역 설치 후에도 비활성화 상태이다 — 관리 › 모듈·플러그인에서 활성화하는 것과 동일한 호출
  let list = await call('GET', '/api/rbi/targets')
  if (list.status === 403) {
    const on = await call('PATCH', '/api/admin/modules/rbi', { enabled: true })
    expect('모듈 rbi 켜기', on.status === 200, JSON.stringify(on).slice(0, 200))
    list = await call('GET', '/api/rbi/targets')
  }
  expect('워크스페이스 출처에서 대상 목록', list.status === 200, JSON.stringify(list).slice(0, 200))
  const origin = (list.body && list.body.public_origin) || `https://rbi.${host}`
  expect('전용 출처 = rbi.<접속 주소>', origin === `https://rbi.${host}`, origin)

  console.log('== 전용 출처(로그인 홉) ==')
  await page.goto(origin + '/')
  await page.locator(`[data-testid="rbi-target-${opt.target}"]`).waitFor({ timeout: 30000 }).then(() => ok('홉을 거쳐 대상 고르기 화면')).catch(e => bad('홉을 거쳐 대상 고르기 화면', page.url() + ' ' + String(e).slice(0, 120)))
  await page.screenshot({ path: path.join(opt.out, '01-picker.png') })
  const mine = await call('GET', '/api/rbi/targets')
  const target = ((mine.body && mine.body.targets) || []).find(t => t.key === opt.target)
  expect(`대상 ${opt.target}`, !!target, JSON.stringify(mine).slice(0, 200))
  // 이전 실행이 남긴 세션이 있으면 종료한다(사용자당 1개)
  for (const s of (mine.body && mine.body.sessions) || []) await call('DELETE', '/api/rbi/sessions/' + s.id)

  let n = 1
  for (const mode of opt.modes.split(',').filter(Boolean)) {
    console.log(`== ${mode === 'mirror' ? '미러' : '픽셀'} 방식 ==`)
    if (!target) { bad('세션 열기', '대상이 없다'); continue }
    // 최초 세션은 세션 전용 브리지를 생성하고 격리 규칙이 적용되기를 대기한다 — 시작 호출이 지연될 수 있다
    const started = await call('POST', '/api/rbi/sessions', { target_id: target.id, mode })
    expect('세션 시작(201)', started.status === 201 || started.status === 200, JSON.stringify(started).slice(0, 300))
    const sid = started.body && started.body.id
    if (!sid) continue
    let sess = started.body
    for (let i = 0; i < 60 && sess && sess.status === 'starting'; i++) { await sleep(1000); sess = (await call('GET', '/api/rbi/sessions/' + sid)).body }
    expect('세션이 돈다', sess && sess.status === 'running' && sess.mode === mode, JSON.stringify(sess).slice(0, 300))
    await page.goto(origin + '/')                      // 진행 중인 세션이 있으면 앱이 해당 화면으로 이동한다
    await page.locator('[data-testid="rbi-bar-title"]').waitFor({ timeout: 30000 }).catch(() => {})

    let share = COLORS.map(() => 0), seen = false, text = ''
    for (let i = 0; i < 45 && !seen; i++) {
      await sleep(2000)
      if (mode === 'mirror') {
        // 미러 문서는 스크립트 없는 iframe 을 부모가 조립한다 — 해당 문서의 문자열을 조회한다
        const frame = page.frames().find(f => /\/rbi\/[0-9a-f]{32}\/view/.test(f.url()))
        text = frame ? await frame.evaluate(() => document.body ? document.body.innerText : '').catch(() => '') : ''
        if (!text.includes(opt.mark)) continue
      }
      share = await colorShare(await page.screenshot())
      seen = drawn(share)
    }
    const shot = path.join(opt.out, `${String(++n).padStart(2, '0')}-${mode}.png`)
    await page.screenshot({ path: shot })
    if (mode === 'mirror') {
      expect('미러 문서에 대상의 제목 글자', text.includes(opt.mark), text.replace(/\s+/g, ' ').slice(0, 160))
      expect('미러 문서에 상자 안의 글자', text.includes('BOX-OK'), text.replace(/\s+/g, ' ').slice(0, 160))
      const src = await page.locator('iframe').first().getAttribute('sandbox').catch(() => null)
      expect('미러 iframe 은 스크립트를 허용하지 않는다', src !== null && !/allow-scripts/.test(src), String(src))
    } else {
      const frames = page.frames().map(f => f.url())
      expect('픽셀 화면(KasmVNC) iframe', frames.some(u => u.includes(`/rbi/${sid}/`) && !u.includes('/view')), frames.join(' '))
    }
    expect(`캡처에 대상 페이지의 색이 보인다(${shareText(share)})`, seen, shot)
    console.log('   캡처: ' + shot)

    const ended = await call('DELETE', '/api/rbi/sessions/' + sid)
    expect('세션 종료', ended.status === 200 || ended.status === 204, JSON.stringify(ended).slice(0, 200))
    const after = await call('GET', '/api/rbi/sessions/' + sid)
    expect('끝난 세션', after.body && after.body.status === 'ended', JSON.stringify(after).slice(0, 200))
    const gone = await page.evaluate(async sid => (await fetch(`/rbi/${sid}/`, { credentials: 'same-origin' })).status, sid).catch(() => 0)
    expect('끝난 세션의 화면 경로는 닫힌다(403)', gone === 403, String(gone))
  }

  expect('화면 오류 없음', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
