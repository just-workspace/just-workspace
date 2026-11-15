// "목록에 없는 모듈은 꺼진 것" 판정 — 서버는 설치하지 않은 구역의 모듈을 목록에서 뺀다.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({ modules: null as unknown, health: {} as Record<string, unknown> }))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string) => {
    if (url === '/api/platform/modules') return api.modules
    if (url === '/api/health') return api.health
    return {}
  }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { platformStore, isModuleEnabled, moduleEnabledIn, fetchModules } = await import('~/composables/usePlatform')
const { siteConfigStore, fetchAppConfig, isZoneInstalled, zoneInstalledIn } = await import('~/composables/useSiteConfig')

const mod = (id: string, enabled = true, type = 'builtin') => ({ id, name: id, icon: '', route: `/${id}`, type, requires: [], enabled })

beforeEach(() => {
  platformStore.setState({ modules: [], loaded: false })
  siteConfigStore.setState({ loaded: false, zones: null })
  api.modules = null
  api.health = {}
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('모듈 판정', () => {
  it('목록을 받기 전에는 보류 — 무엇이든 켜진 것으로 본다(화면을 막지 않는다)', () => {
    expect(isModuleEnabled('mail')).toBe(true)
    expect(isModuleEnabled('some-plugin')).toBe(true)
    expect(moduleEnabledIn([], false, 'chat')).toBe(true)
  })

  it('목록을 받은 뒤: 목록에 없으면 꺼짐, 있으면 enabled 값', () => {
    platformStore.setState({ loaded: true, modules: [mod('files'), mod('chat', false), mod('notes', true, 'plugin')] })
    expect(isModuleEnabled('files')).toBe(true)
    expect(isModuleEnabled('chat')).toBe(false)
    expect(isModuleEnabled('mail')).toBe(false)      // 설치하지 않은 구역 — 목록에 없다
    expect(isModuleEnabled('wiki')).toBe(false)
    expect(isModuleEnabled('notes')).toBe(true)      // 플러그인은 목록에 있으니 그대로
  })

  it('목록 모양이 아닌 답은 받은 것으로 치지 않는다(전부 꺼지지 않게 보류 유지)', async () => {
    api.modules = {}
    await fetchModules()
    expect(platformStore.getState().loaded).toBe(false)
    expect(isModuleEnabled('mail')).toBe(true)

    api.modules = { modules: [mod('files')] }
    await fetchModules()
    expect(platformStore.getState().loaded).toBe(true)
    expect(isModuleEnabled('mail')).toBe(false)
  })
})

describe('구역 판정', () => {
  it('구역 목록을 모르면 보류, 알면 그 목록대로', async () => {
    expect(isZoneInstalled('docs')).toBe(true)
    expect(zoneInstalledIn(null, 'ai')).toBe(true)

    api.health = { service: 'WS', config: {} }           // zones 를 주지 않는 서버
    await fetchAppConfig()
    expect(siteConfigStore.getState().zones).toBeNull()
    expect(isZoneInstalled('docs')).toBe(true)

    siteConfigStore.setState({ loaded: false })
    api.health = { service: 'WS', config: {}, zones: ['chat', 'ai'] }
    await fetchAppConfig()
    expect(isZoneInstalled('ai')).toBe(true)
    expect(isZoneInstalled('docs')).toBe(false)
    expect(zoneInstalledIn([], 'mail')).toBe(false)      // core 만 설치
  })
})
