// 설치 마법사의 단계 목록 규칙(src/installer-app/flow.ts) · 주소 해석(router.ts) · 표시용 변환(format.ts) · 번들 가드 · 번역 파일 짝.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { flow, isLive, liveSteps, nearestLive, nextStep, prevStep, progressOf, stepForField, stepStates, type FlowInput } from '~/installer-app/flow'
import { hashFor, parseHash } from '~/installer-app/router'
import {
  bytesText, defaultMailDomain, isAccessAddress, isAddressOrCidr, isHostPath, isSubnet24, isUsername, matchPreset, openPorts, portsLine,
  recommendMb, serverGb, zoneGb,
} from '~/installer-app/format'
import { MOCK_ADDONS, MOCK_ZONES } from '~/installer-app/api/mock'
import type { ZonesResponse } from '~/installer-app/api/types'
import { INSTALLER_TAILWIND_SOURCES, installerForbiddenModules, installerUnscannedModules } from '../../installer-bundle-guard'
import ko from '~/installer-app/i18n/ko.json'
import en from '~/installer-app/i18n/en.json'

const base: FlowInput = { mode: 'new', network: 'direct', cert: 'auto', zones: ['mail', 'chat', 'calendar', 'docs'] }
const ids = (i: Partial<FlowInput>) => flow({ ...base, ...i }).map(s => (s.skipped ? `${s.id}!` : s.id))

describe('단계 목록 규칙', () => {
  it('새로 설치 · 직접 연결 · 협업 묶음 — 메일만 켜지고 회의·AI·코드 저장소는 건너뜀', () => {
    expect(ids({})).toEqual(['check', 'start', 'domain', 'storage', 'zones', 'mail', 'meet!', 'ai!', 'git!', 'admin', 'summary', 'apply'])
  })

  it('연결에 딸린 단계는 고른 때에만 끼어든다', () => {
    expect(ids({ network: 'proxy', cert: 'proxy' })).toContain('proxy')
    expect(ids({ network: 'proxy', cert: 'upload' })).not.toContain('cert')
    expect(ids({ cert: 'upload' }).slice(2, 5)).toEqual(['domain', 'cert', 'storage'])
    expect(ids({ cert: 'temporary' })).not.toContain('cert')
    const router = ids({ network: 'router' })
    expect(router.indexOf('ports')).toBe(router.indexOf('zones') + 1)
    expect(ids({})).not.toContain('ports')
  })

  it('구역에 딸린 단계는 늘 목록에 있고, 고른 구역만 살아 있다', () => {
    expect(ids({ zones: [] }).filter(s => s.endsWith('!'))).toEqual(['mail!', 'meet!', 'ai!', 'git!'])
    expect(ids({ zones: ['meetings', 'git', 'ai', 'mail'] }).filter(s => s.endsWith('!'))).toEqual([])
    expect(isLive(flow({ ...base, zones: ['meetings'] }), 'meet')).toBe(true)
    expect(isLive(flow({ ...base, zones: ['meetings'] }), 'mail')).toBe(false)
  })

  it('빠른 설치 — 저장 위치와 구역 선택은 건너뛰고, 메일은 묶음에 메일이 있을 때만', () => {
    expect(ids({ mode: 'quick' })).toEqual(['check', 'start', 'domain', 'storage!', 'zones!', 'mail', 'meet!', 'ai!', 'git!', 'admin', 'summary', 'apply'])
    expect(liveSteps(flow({ ...base, mode: 'quick', zones: [] }))).toEqual(['check', 'start', 'domain', 'admin', 'summary', 'apply'])
  })

  it('백업에서 복원 — 다섯 단계', () => {
    expect(ids({ mode: 'restore' })).toEqual(['check', 'start', 'file', 'review', 'apply'])
  })

  it('이전·다음은 건너뛴 단계를 넘어 실제 직전·직후 단계', () => {
    const steps = flow(base)
    expect(nextStep(steps, 'mail')).toBe('admin')
    expect(prevStep(steps, 'admin')).toBe('mail')
    expect(prevStep(flow({ ...base, zones: [] }), 'admin')).toBe('zones')
    expect(prevStep(flow({ ...base, network: 'router', zones: [] }), 'admin')).toBe('ports')
    expect(prevStep(flow({ ...base, network: 'proxy', cert: 'proxy' }), 'storage')).toBe('proxy')
    expect(prevStep(flow({ ...base, mode: 'quick', zones: [] }), 'admin')).toBe('domain')
    expect(prevStep(steps, 'check')).toBeNull()
    expect(nextStep(steps, 'apply')).toBeNull()
  })

  it('단계 상태 · 진행 위치 · 없는 단계의 대체', () => {
    const states = stepStates(flow(base), 'zones')
    expect(states.find(s => s.id === 'domain')?.state).toBe('done')
    expect(states.find(s => s.id === 'zones')?.state).toBe('current')
    expect(states.find(s => s.id === 'meet')?.state).toBe('skipped')
    expect(states.find(s => s.id === 'admin')?.state).toBe('todo')
    expect(progressOf(flow(base), 'check')).toBe(0)
    expect(progressOf(flow(base), 'apply')).toBeGreaterThan(80)
    expect(nearestLive(flow(base), 'meet')).toBe('mail')
    expect(nearestLive(flow(base), 'proxy')).toBe('check')
    expect(nearestLive(flow({ ...base, mode: 'quick' }), 'zones')).toBe('domain')
  })

  it('답변 오류의 항목 → 고치러 갈 단계', () => {
    expect(stepForField('access.cert')).toBe('domain')
    expect(stepForField('access.proxy_addresses.0')).toBe('proxy')
    expect(stepForField('meetings.public_ip')).toBe('meet')
    expect(stepForField('zones')).toBe('zones')
    expect(stepForField('admin.password')).toBe('admin')
  })
})

describe('화면 주소', () => {
  it('단계와 고치기 표시를 읽고 쓴다', () => {
    expect(parseHash('#/domain')).toEqual({ id: 'domain', fix: false })
    expect(parseHash('#/mail?fix=1')).toEqual({ id: 'mail', fix: true })
    expect(parseHash('')).toEqual({ id: null, fix: false })
    expect(parseHash('#/nope')).toEqual({ id: null, fix: false })
    expect(hashFor('zones', { fix: true })).toBe('#/zones?fix=1')
    expect(hashFor('apply')).toBe('#/apply')
  })
})

describe('표시용 변환', () => {
  const catalog: ZonesResponse = {
    core: { id: 'core', name: { ko: '기본', en: 'Core' }, summary: { ko: '', en: '' }, memory_mb: { recommend: 4000 }, ports: ['80/tcp', '443/tcp'] },
    presets: { minimal: [], collab: ['mail', 'chat', 'calendar', 'docs'], full: MOCK_ZONES.map(z => z.id) },
    zones: MOCK_ZONES, addons: MOCK_ADDONS,
  }

  it('권장 메모리 합계 — 최소 4 · 협업 7 · 전체 9.5 GB', () => {
    expect(zoneGb(recommendMb(catalog, []))).toBe(4)
    expect(zoneGb(recommendMb(catalog, catalog.presets.collab))).toBe(7)
    expect(zoneGb(recommendMb(catalog, catalog.presets.full))).toBe(9.5)
    expect(serverGb(16384)).toBe(16)
  })

  it('묶음 맞추기 · 포트 표기', () => {
    expect(matchPreset(catalog, ['docs', 'mail', 'chat', 'calendar'])).toBe('collab')
    expect(matchPreset(catalog, ['mail'])).toBeNull()
    expect(portsLine(['25/tcp', '465/tcp'])).toBe('25 · 465')
    expect(portsLine(['7881/tcp', '7882-7892/udp'])).toBe('TCP 7881 · UDP 7882-7892')
    expect(portsLine(['4433/udp'])).toBe('UDP 4433')
  })

  it('열 포트 — 중계와 무손실 오디오는 켰을 때만', () => {
    const off = openPorts(catalog, ['meetings'], { turn: false, lossless: false }).map(r => r.spec)
    expect(off).toEqual(['80/tcp', '443/tcp', '7881/tcp', '7882-7892/udp'])
    const on = openPorts(catalog, ['meetings', 'sso'], { turn: true, lossless: true }).map(r => r.spec)
    expect(on).toEqual(['80/tcp', '443/tcp', '7881/tcp', '7882-7892/udp', '3478/udp', '4433/udp', '389/tcp', '636/tcp'])
  })

  it('입력 형식 검사', () => {
    expect(isAccessAddress('workspace.example.com')).toBe(true)
    expect(isAccessAddress('203.0.113.24')).toBe(true)
    expect(isAccessAddress('workspace')).toBe(false)
    expect(isAddressOrCidr('192.168.10.0/24')).toBe(true)
    expect(isAddressOrCidr('192.168.10.300')).toBe(false)
    expect(isSubnet24('172.28.0.0/24')).toBe(true)
    expect(isSubnet24('172.28.0.0/16')).toBe(false)
    expect(isUsername('admin')).toBe(true)
    expect(isUsername('Admin 1')).toBe(false)
    expect(isHostPath('/srv/files')).toBe(true)
    expect(isHostPath('/')).toBe(false)
    expect(isHostPath('srv/files')).toBe(false)
    expect(defaultMailDomain('workspace.example.com')).toBe('example.com')
    expect(defaultMailDomain('example.com')).toBe('example.com')
    expect(defaultMailDomain('203.0.113.24')).toBe('')
    expect(bytesText(3_650_000_000)).toBe('3.4 GB')
  })
})

describe('번들 가드', () => {
  it('워크스페이스 화면·셸·API 클라이언트·무거운 라이브러리를 막고, 키트와 마법사 자신은 둔다', () => {
    const bad = [
      'D:\\app\\src\\pages\\mail.tsx', '/app/src/App.tsx', '/app/src/lib/api.ts', '/app/src/router/index.tsx', '/app/src/components/layout/Shell.tsx',
      '/app/src/components/ui/Toast.tsx', '/app/src/composables/useAuth.ts', '/app/node_modules/react-router/dist/index.js', '/app/node_modules/livekit-client/dist/x.js',
      '/app/node_modules/ofetch/dist/index.mjs',
    ]
    const ok = [
      '/app/src/installer-app/main.tsx', '/app/src/components/ui/Button.tsx', '/app/src/components/ui/StepList.tsx', '/app/src/i18n/index.ts',
      '/app/src/lib/utils.ts', '/app/src/lib/clipboard.ts', '/app/src/composables/useToast.ts', '/app/node_modules/react/index.js', '/app/node_modules/zustand/esm/index.mjs',
    ]
    expect(installerForbiddenModules([...bad, ...ok])).toHaveLength(bad.length)
    expect(installerForbiddenModules(ok)).toEqual([])
  })

  it('CSS 가 훑는 소스 목록 = installer.css 의 @source, 목록 밖의 모듈은 걸린다', () => {
    const installerCss = readFileSync(resolve(__dirname, '../../src/installer-app/installer.css'), 'utf8')
    // installer.css 는 src/installer-app/ 에 위치 — @source 의 상대 경로를 frontend-react 기준으로 해석
    const fromCss = [...installerCss.matchAll(/^@source '([^']+)';\r?$/gm)].map((m) => {
      const parts = ['src', 'installer-app']
      for (const seg of m[1].split('/')) {
        if (seg === '..') parts.pop()
        else if (seg !== '.' && seg !== '') parts.push(seg)
      }
      return parts.join('/') + (m[1].endsWith('/') ? '/' : '')
    })
    expect(fromCss.sort()).toEqual([...INSTALLER_TAILWIND_SOURCES].sort())
    expect(installerCss).toContain("@import 'tailwindcss' source(none);")
    const ok = [
      '/app/src/installer-app/screens/Zones.tsx', '/app/src/components/ui/Button.tsx', '/app/src/lib/utils.ts', '/app/src/i18n/index.ts',
      '/app/src/i18n/locales/ko.json', '/app/src/assets/css/theme.css', '/app/node_modules/react/index.js', 'D:\\repo\\frontend-react\\src\\utils\\icons.ts',
    ]
    expect(installerUnscannedModules(ok)).toEqual([])
    expect(installerUnscannedModules([...ok, '/app/src/lib/date.ts', '/app/src/composables/useFiles.ts']))
      .toEqual(['/app/src/lib/date.ts', '/app/src/composables/useFiles.ts'])
  })
})

describe('번역 파일', () => {
  const keys = (d: Record<string, unknown>, p = ''): string[] =>
    Object.entries(d).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]))
  const values = (d: Record<string, unknown>): string[] =>
    Object.values(d).flatMap(v => (v && typeof v === 'object' ? values(v as Record<string, unknown>) : [String(v)]))

  it('한국어와 영어의 키가 같다', () => {
    expect(keys(en).sort()).toEqual(keys(ko).sort())
  })

  it('문구에 해석기가 다르게 읽는 글자(복수형 구분선 · 연결 표식)나 자리표시자가 없다', () => {
    for (const v of [...values(ko), ...values(en)]) {
      expect(v).not.toMatch(/\|/)
      expect(v).not.toMatch(/@[:.]/)
      expect(v).not.toMatch(/\[[^\]]+\]/)
    }
  })

  it('"상태 감시" 구역은 어디에도 없다', () => {
    expect(JSON.stringify(ko)).not.toContain('상태 감시')
    expect(MOCK_ZONES.map(z => z.id)).toEqual(['mail', 'chat', 'calendar', 'docs', 'meetings', 'git', 'ai'])
    expect(MOCK_ADDONS.map(z => z.id)).toEqual(['sso', 'rbi'])
  })
})
