/**
 * mirror-agent — 세션 컨테이너의 PID 1(시작 셸이 exec). Chromium 하나를 소유하고 6901 에서 미러를 제공한다.
 *
 * 환경변수(백엔드 policy.mirror_container_env 가 생성한다)
 *   MIRROR_URL           최초로 여는 주소(필수)
 *   MIRROR_SID           세션 id(32hex)
 *   MIRROR_AUTH          ws-nginx 가 부여하는 Authorization 값(없으면 인증 없음 — 개발용)
 *   MIRROR_POLICY        {"ci":bool,"co":bool,"dl":bool,"ul":bool} 클립보드 유입/유출·다운로드·업로드
 *   MIRROR_ALLOW         ["host[:port]", …] — Chromium URLAllowlist 와 동일한 목록(차단 알림 표시용)
 *   MIRROR_IDLE_SECONDS  뷰어 없음/입력 없음 자동 종료(기본 900)
 *   MIRROR_PORT          기본 6901 · MIRROR_VIEWPORT "1600x900" · MIRROR_CHROMIUM 실행 파일 · MIRROR_FONTS 고정 폰트 폴더
 *   MIRROR_DEV           "1" 이면 /dev/ 하네스 + 계측 API + 127.0.0.1:7100 테스트 페이지(개발 이미지 전용)
 *   MIRROR_TRACE         "1" 이면 틱마다 로그 기록
 * 비밀(MIRROR_AUTH)은 읽은 후 환경에서 삭제한다(Chromium 자식 프로세스에 상속되지 않도록 함).
 */
import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'
import { fileURLToPath } from 'node:url'
import type { PolicyInfo } from '../../protocol/vocab.ts'
import { MirrorSession } from './session.ts'
import { startServer } from './server.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
/** 패키지 루트(rbi/mirror) — tsx(agent/src) 실행과 컴파일본(agent/dist/agent/src) 실행 모두에서 package.json 이 있는 위치 */
const ROOT = (() => { let d = here; for (let i = 0; i < 6; i++) { if (fs.existsSync(path.join(d, 'package.json'))) return d; d = path.dirname(d) } return here })()
const env = process.env
const AUTH = env.MIRROR_AUTH || ''
delete env.MIRROR_AUTH
const DEV = env.MIRROR_DEV === '1'
const TRACE = env.MIRROR_TRACE === '1'

function log(...a: unknown[]): void { console.log(new Date().toISOString().slice(11, 23), '[mirror]', ...a) }

function parsePolicy(raw: string | undefined): PolicyInfo {
  // 기본값은 차단(파싱 실패 시에도 차단) — 정책이 없으면 클립보드·다운로드·업로드 모두 차단한다
  const pol: PolicyInfo = { ci: false, co: false, dl: false, ul: false }
  try {
    const p = JSON.parse(raw || '{}')
    for (const k of ['ci', 'co', 'dl', 'ul'] as const) pol[k] = p[k] === true
  } catch { /* 차단 유지 */ }
  return pol
}
function parseAllow(raw: string | undefined, url: string): string[] {
  let list: string[] = []
  try { const a = JSON.parse(raw || '[]'); if (Array.isArray(a)) list = a.filter(x => typeof x === 'string' && /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(x)) } catch { /* 없음 */ }
  try { const u = new URL(url); if (!list.length) list.push(u.port ? `${u.hostname}:${u.port}` : u.hostname) } catch { /* 없음 */ }
  if (DEV) list.push('127.0.0.1:7100')
  return list
}

async function main(): Promise<void> {
  const url = env.MIRROR_URL || 'about:blank'
  const [vw, vh] = (env.MIRROR_VIEWPORT || '1600x900').split('x').map(n => parseInt(n, 10))
  const session = new MirrorSession({
    url, sid: env.MIRROR_SID || 'dev', vw: vw || 1600, vh: vh || 900, chromium: env.MIRROR_CHROMIUM,
    policy: parsePolicy(env.MIRROR_POLICY), allowHosts: parseAllow(env.MIRROR_ALLOW, url),
    idleSec: Math.max(0, parseInt(env.MIRROR_IDLE_SECONDS || '900', 10) || 0),
    maxUploadBytes: 50 * 1024 * 1024, trace: TRACE, log,
  })
  if (DEV) {
    const { startDevPages } = await import('./devpages.ts')
    await startDevPages(7100, path.join(ROOT, 'devpages'))
  }
  await session.start()
  const pol = parsePolicy(env.MIRROR_POLICY)
  const server = startServer(session, {
    port: parseInt(env.MIRROR_PORT || '6901', 10), auth: AUTH, sid: env.MIRROR_SID || 'dev', dev: DEV, root: ROOT,
    fontsDir: env.MIRROR_FONTS || path.join(ROOT, 'fonts', 'dist'), noSelect: !pol.co, log,
    devApi: DEV ? (op, u, res) => devApi(session, op, u, res) : undefined,
  })
  const stop = async () => { log('stopping'); server.close(); await session.close(); process.exit(0) }
  process.on('SIGTERM', () => { void stop() })
  process.on('SIGINT', () => { void stop() })
}

/**
 * 계측 API(MIRROR_DEV=1 일 때만) — 벤치가 원격 측 "진실" 을 확인하는 데 사용한다.
 *   goto?u=  원격 이동 · shot 원격 뷰포트 PNG(캡처 큐 경유) · active 원격 포커스 값 · flags 악성 페이지 스크립트 흔적(원격에서는 실행되는 것이 정상)
 *   stats · reset · eval?e= (원격 main world 에서 식 하나 — 벤치 시나리오용: 미믹 페이지 조작)
 * 운영 이미지에는 MIRROR_DEV 가 없다 — 404.
 */
async function devApi(session: MirrorSession, op: string, url: URL, res: http.ServerResponse): Promise<void> {
  const json = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)) }
  try {
    if (op === 'goto') {
      const u = url.searchParams.get('u') || 'about:blank'
      const t0 = performance.now()
      // DOMContentLoaded 까지만 대기 — 차단된 외부 자원(netfilter 가 drop)이 있으면 load 는 발생하지 않는다
      await session.page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 })
      json({ ok: true, ms: Math.round(performance.now() - t0) }); return
    }
    if (op === 'stats') { json(session.statsSnapshot()); return }
    if (op === 'reset') { session.resetStats(); json({ ok: true }); return }
    if (op === 'shot') {
      const buf = await session.shot()
      if (!buf) { res.writeHead(503); res.end('no shot'); return }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'no-store' }); res.end(buf); return
    }
    if (op === 'active') {
      json(await session.page.evaluate(`(() => { const a = document.activeElement; return { tag: a ? a.tagName : null, id: a ? a.id : null, name: a ? a.getAttribute('name') : null, value: a && 'value' in a ? a.value : null } })()`)); return
    }
    if (op === 'flags') {
      json(await session.page.evaluate(`({ title: document.title, evilRan: window.__evilRan ?? null, onload: window.__onload ?? null, onerror: window.__onerror ?? null, srcdoc: window.__srcdoc ?? null })`)); return
    }
    if (op === 'eval') { json({ v: await session.page.evaluate(url.searchParams.get('e') || 'null') }); return }
    res.writeHead(404); res.end()
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e).slice(0, 300))
  }
}

// 최후 방어선 — 미처리 예외 하나로 세션(Chromium) 전체가 종료되지 않도록 한다. 기동 실패는 위 main().catch 가 종료 처리한다.
process.on('uncaughtException', e => { log('uncaught', String((e as Error)?.stack || e).slice(0, 400)) })
process.on('unhandledRejection', e => { log('unhandled rejection', String((e as Error)?.stack || e).slice(0, 400)) })

main().catch(e => { console.error(e); process.exit(1) })
