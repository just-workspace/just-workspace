// 수집기 통합 시험 — 실제 Chromium(로컬 Chrome 또는 /usr/bin/chromium)에 격리 world 로 주입하여 증분 동작을 확인한다.
// 브라우저가 없으면 건너뛴다(CI 에서는 세션 이미지 내에서 실행). MIRROR_TEST_CHROME 로 경로 지정.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium, type Browser, type Page, type CDPSession } from 'playwright-core'
import { COMPUTED_STYLE_ALLOWLIST } from '../protocol/vocab.ts'
import { collectorSource, type TickResult } from '../agent/src/page/collector.ts'

const CHROME = [process.env.MIRROR_TEST_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => p && fs.existsSync(p))
const SRC = collectorSource({ styles: COMPUTED_STYLE_ALLOWLIST, maxNodes: 40000, verifyMs: 1000 })

let browser: Browser | undefined
let page: Page
let cdp: CDPSession
let ctxId = 0

before(async () => {
  if (!CHROME) return
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  cdp = await page.context().newCDPSession(page)
})
after(async () => { await browser?.close() })

async function load(html: string): Promise<TickResult> {
  await page.setContent(html)
  const tree = await cdp.send('Page.getFrameTree')
  const w = await cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'jw-mirror-test' })
  ctxId = w.executionContextId
  await cdp.send('Runtime.evaluate', { expression: SRC, contextId: ctxId })
  return tick({ full: true })
}
async function tick(o: Record<string, unknown> = {}): Promise<TickResult> {
  const r = await cdp.send('Runtime.evaluate', { expression: `__jwm.tick(${JSON.stringify(o)})`, contextId: ctxId, returnByValue: true })
  return JSON.parse(r.result.value as string) as TickResult
}
const skip = !CHROME

const PAGE = `<!doctype html><html><body style="margin:0;font:14px Arial">
<div id="frame" style="position:relative;margin:20px;border:5px solid rgb(0,0,0);padding:3px;width:400px;height:200px">
  <div id="child" style="position:absolute;left:10px;top:7px;width:50px;height:20px;background:rgb(255,0,0)">A</div>
  <span id="txt">hello</span>
</div>
<div id="drag" style="position:absolute;left:300px;top:300px;width:80px;height:40px;background:rgb(0,0,255)"><b>R1</b><i class="ic"></i></div>
<div id="box" style="position:fixed;right:10px;top:10px;width:120px;height:100px;overflow:auto"><div style="height:600px">긴 내용</div></div>
<input id="pw" type="password" value="s3cret-pass">
<input id="t" value="abc">
<p id="ps">항목</p>
<style>#ps::before{content:"» "} .ic::before{content:"\\f04b";font-family:FontAwesome}</style>
<svg id="sv" width="100" height="50"><use href="#x"/><image href="/exfil" width="10" height="10"/><path d="M 0 0 L 50 50" stroke="rgb(0,0,0)"/></svg>
<div style="height:3000px"></div>
</body></html>`

test('전체 수집: 지역 좌표(부모 padding box 기준)·fixed·의사 요소·svg 기하·비밀번호 길이만', { skip }, async () => {
  const r = await load(PAGE)
  assert.equal(r.full, true)
  const byTag = (n: string) => r.recs.filter(x => x.n === n)
  const out = JSON.stringify(r)
  assert.doesNotMatch(out, /s3cret/, '비밀번호 값이 수집기 밖으로 나오면 안 된다')
  const pw = r.recs.find(x => x.n === 'input' && x.a?.type === 'password')!
  assert.deepEqual(pw.w, { n: 11 })
  const BG = COMPUTED_STYLE_ALLOWLIST.indexOf('background-color')
  const child = r.recs.find(x => x.n === 'div' && x.cs![BG] === 'rgb(255, 0, 0)')!
  const frame = r.recs.find(x => x.i === child.p)!
  assert.equal(frame.r[2], 416, '400 + padding 3×2 + border 5×2')
  // left:10px top:7px — padding box 기준(테두리 5px 제외)
  assert.deepEqual(child.r.slice(0, 2), [10, 7])
  const fixed = r.recs.find(x => x.fr)!
  assert.ok(fixed && fixed.sc, 'fixed 상자 + 스크롤 컨테이너')
  assert.ok(r.recs.some(x => x.pb && x.pb[0] === '» '))
  assert.ok(r.recs.some(x => x.pb && x.pb[0] === '\uf04b'))
  const svg = byTag('svg')[0]
  assert.deepEqual(svg.g!.map(g => g.n), ['path'], 'use·image 는 읽지 않는다')
})

test('증분: absolute 드래그는 그 노드 하나, 문서 스크롤은 0, 내부 스크롤은 sc 하나', { skip }, async () => {
  const full = await load(PAGE)
  const BG = COMPUTED_STYLE_ALLOWLIST.indexOf('background-color')
  const before = full.recs.find(x => x.n === 'div' && x.cs![BG] === 'rgb(0, 0, 255)')!
  await page.evaluate(() => { const d = document.getElementById('drag')!; d.style.left = '350px'; d.style.top = '320px' })
  let r = await tick()
  assert.equal(r.work.geomAll, false)
  const ids = r.recs.map(x => x.n)
  assert.deepEqual(ids, ['div'], `드래그 레코드 ${JSON.stringify(r.recs.map(x => [x.n, x.r]))}`)
  // 부모(body) 기준 지역 좌표 — 정확히 +50,+20 이동(body 는 첫 자식의 margin 병합으로 y=20 에서 시작)
  assert.deepEqual([r.recs[0].r[0] - before.r[0], r.recs[0].r[1] - before.r[1]], [50, 20])
  await page.evaluate(() => window.scrollTo(0, 500))
  r = await tick()
  assert.equal(r.recs.length, 0); assert.equal(r.doc.sy, 500)
  await page.evaluate(() => { document.getElementById('box')!.scrollTop = 120 })
  // scroll 이벤트는 다음 프레임에 도착한다(에이전트의 scrollNode 는 즉시 표시)
  await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))))
  r = await tick()
  assert.equal(r.recs.length, 1, JSON.stringify(r.work)); assert.equal(r.recs[0].sc![3], 120)
})

test('증분: 글자 변화·숨김·다시 보임·삭제', { skip }, async () => {
  await load(PAGE)
  await page.evaluate(() => { document.getElementById('txt')!.firstChild!.textContent = 'world!' })
  let r = await tick()
  assert.ok(r.recs.some(x => x.t === 'x' && x.tx![0][4] === 'world!'))
  const t = (await tick({ full: true })).recs.find(x => x.t === 'x' && x.tx![0][4] === 'world!')!
  await page.evaluate(() => { document.getElementById('txt')!.style.display = 'none' })
  r = await tick()
  assert.ok(r.del.includes(t.i), '숨긴 서브트리의 텍스트는 del')
  await page.evaluate(() => { document.getElementById('txt')!.style.display = '' })
  r = await tick()
  assert.ok(r.recs.some(x => x.t === 'x' && x.tx![0][4] === 'world!'))
  await page.evaluate(() => document.getElementById('child')!.remove())
  r = await tick()
  assert.ok(r.del.length >= 2, '지운 요소와 그 텍스트')
})

test('입력: 값 변화는 input 이벤트로, 포커스 정보에 비밀번호는 길이만', { skip }, async () => {
  await load(PAGE)
  await page.focus('#t')
  await page.keyboard.press('End')
  await page.keyboard.type('X')
  let r = await tick()
  const t = r.recs.find(x => x.n === 'input' && x.w?.v !== undefined)
  assert.equal(t?.w?.v, 'abcX', JSON.stringify(r.recs.map(x => [x.n, x.w])) + JSON.stringify(r.work))
  assert.equal(r.focus?.wk, 'text'); assert.equal(r.focus?.v, 'abcX')
  await page.focus('#pw')
  r = await tick()
  assert.equal(r.focus?.wk, 'password'); assert.equal(r.focus?.n, 11); assert.equal(r.focus?.v, undefined)
})

test('여러 줄 텍스트는 줄마다 런', { skip }, async () => {
  const r = await load('<div style="width:120px;font:16px Arial">하나 둘 셋 넷 다섯 여섯 일곱 여덟 아홉 열</div>')
  const t = r.recs.find(x => x.t === 'x')!
  assert.ok(t.tx!.length >= 3)
  // Chromium 은 한글을 음절 사이에서도 줄바꿈한다(word-break: normal) — 공백을 제외하고 비교
  assert.equal(t.tx!.map(x => x[4]).join('').replace(/ /g, ''), '하나둘셋넷다섯여섯일곱여덟아홉열')
})

test('형제 순서 키: 위치 요소는 정적 형제 뒤(칠하기 순서 근사)', { skip }, async () => {
  const r = await load('<div id="p"><div style="position:absolute;left:0;top:0">abs</div><div>static</div></div>')
  const p = r.recs.find(x => x.n === 'div' && r.recs.filter(y => y.p === x.i && y.n === 'div').length === 2)!
  const kids = r.recs.filter(y => y.p === p.i && y.n === 'div').sort((a, b) => a.o - b.o)
  assert.equal(kids[0].cs![COMPUTED_STYLE_ALLOWLIST.indexOf('position')], 'static')
})
