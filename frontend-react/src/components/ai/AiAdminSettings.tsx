/**
 * AI 시스템 설정(Vue components/ai/AiAdminSettings.vue) — 관리 › 설정 › AI(/admin/ai). 자기완결, 이 화면에서만 쓴다.
 *  ① 워크스페이스 모델 — 행(min 52): 워크스페이스 기본 · 워크스페이스 고급(이름 600 + "로컬/외부 · 모델" 12 muted, 상태 배지
 *     정상 success · 느림 n.ns warning · 연결 안 됨 danger — POST /api/ai/config/test 로 잼), 개인 API 키 허용 스위치.
 *     제공자·키·주소·모델을 고치는 폼은 시안에 없어 행 ⋮ 메뉴의 첫 항목 "설정" 모달로 둔다(폼은 디자이너 확인 필요).
 *  ② 도구 허용 — 스위치 행: 메일·파일·캘린더 검색(웹 검색 밖의 데이터 도구 전부) · 웹 검색. 즉시 저장 + "저장됨 ✓".
 *     외부 AI 개인데이터 접근 허용 스위치와 도구별 체크(자세히)는 기존 기능이라 같은 카드 아래에 유지(디자이너 확인 필요).
 *  ③ 한도 — 사용자당 하루 요청(0 = 제한 없음)·대화 보관(선택), 카드 푸터 저장.
 * 모듈 켜기/끄기는 '모듈 관리'에서만 — 여기선 상태 표시와 링크만.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { addToast } from '~/composables/useToast'
import { useAiLabels } from '~/composables/useAiLabels'
import { errText } from '~/utils/errText'
import { NuxtLink } from '~/components/NuxtLink'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiMenu } from '~/components/ui/Menu'
import { UiModal } from '~/components/ui/Modal'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiSelect } from '~/components/ui/Select'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiSwitch } from '~/components/ui/Switch'

const PROVIDERS = [
  { kind: 'ollama', label: '로컬 LLM (Ollama)', needsKey: false, needsBase: true },
  { kind: 'openai', label: 'OpenAI', needsKey: true, needsBase: false },
  { kind: 'anthropic', label: 'Anthropic', needsKey: true, needsBase: false },
  { kind: 'compatible', label: 'OpenAI 호환', needsKey: true, needsBase: true },
]
const providerOptions = PROVIDERS.map(p => ({ value: p.kind, label: p.label }))

/** Vue v-model 이 type="number" 입력에 하는 변환(looseToNumber) — 숫자가 아니면 문자열 그대로 */
function looseToNumber(v: string): number | string {
  const n = parseFloat(v)
  return Number.isNaN(n) ? v : n
}

interface Cfg {
  kind: string; base_url: string; model: string; advanced_model: string; max_tokens: number; external: boolean; hasKey: boolean
  external_allow_data: boolean; allow_user_keys: boolean; daily_limit: number; retention_days: number
  availableTools: string[]; dataTools: string[]; allowedTools: string[]
}
const EMPTY_CFG: Cfg = {
  kind: '', base_url: '', model: '', advanced_model: '', max_tokens: 0, external: false, hasKey: false,
  external_allow_data: false, allow_user_keys: false, daily_limit: 0, retention_days: 0,
  availableTools: [], dataTools: [], allowedTools: [],
}

interface Probe { ok: boolean; status: 'ok' | 'not_found' | 'unreachable' | 'unconfigured'; ms: number | null; model: string }

interface Prov { open: boolean; kind: string; base_url: string; api_key: string; model: string; max_tokens: number | string; models: string[]; probing: boolean; saving: boolean }
interface Adv { open: boolean; model: string; models: string[]; probing: boolean; saving: boolean }
interface Limits { daily: string | number; retention: string }

export function AiAdminSettings() {
  const { t } = useI18n()
  const { toolLabel } = useAiLabels()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [moduleEnabled, setModuleEnabled] = useState(false)
  const [cfg, setCfgState] = useState<Cfg>(EMPTY_CFG)
  // 이벤트 처리기에서 "지금" 값(Vue reactive 는 늘 최신)
  const cfgRef = useRef(cfg)
  const setCfg = (next: Cfg) => { cfgRef.current = next; setCfgState(next) }

  const [probes, setProbes] = useState<{ base: Probe | null; adv: Probe | null }>({ base: null, adv: null })

  const [limits, setLimits] = useState<Limits>({ daily: '0', retention: '0' })
  const [limitsOrig, setLimitsOrig] = useState<Limits>({ daily: '0', retention: '0' })
  const [limitsSaving, setLimitsSaving] = useState(false)
  const [limitsSaved, setLimitsSaved] = useState(false)

  async function probe(advanced: boolean) {
    try { return await $fetch<Probe>('/api/ai/config/test', { method: 'POST', credentials: 'include', body: { advanced } }) }
    catch { return { ok: false, status: 'unreachable', ms: null, model: '' } as Probe }
  }
  async function probeAll() {
    setProbes({ base: null, adv: null })
    const base = await probe(false)
    setProbes(p => ({ ...p, base }))
    if (cfgRef.current.advanced_model) {
      const adv = await probe(true)
      setProbes(p => ({ ...p, adv }))
    }
  }

  async function load() {
    setLoading(true)
    setLoadError('')
    try {
      const [c, s] = await Promise.all([
        $fetch<any>('/api/ai/config', { credentials: 'include' }),
        $fetch<any>('/api/ai/status', { credentials: 'include' }),
      ])
      const next: Cfg = {
        ...cfgRef.current,
        kind: c.kind || '', base_url: c.base_url || '', model: c.model || '', advanced_model: c.advanced_model || '',
        max_tokens: c.max_tokens ?? 0, external: !!c.external, hasKey: !!c.has_key,
        external_allow_data: !!c.governance?.external_allow_data, allow_user_keys: !!c.governance?.allow_user_keys,
        daily_limit: c.governance?.daily_limit || 0, retention_days: c.governance?.retention_days || 0,
        availableTools: c.available_tools || [], dataTools: c.data_tools || [],
      }
      const allowed = c.governance?.allowed_tools || []
      next.allowedTools = allowed.length ? allowed : [...next.availableTools]
      setCfg(next)
      setModuleEnabled(s.module_enabled)
      const l = { daily: String(next.daily_limit), retention: String(next.retention_days) }
      setLimits(l)
      setLimitsOrig({ ...l })
      void probeAll()
    } catch (e: any) {
      setLoadError(t('ai.admin.loadFailed', { msg: errText(e, e?.message || String(e)) }))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── ① 모델 상태 ──
  function badge(p: Probe | null): { tone: 'success' | 'warning' | 'danger' | 'neutral'; text: string } | null {
    if (!p) return null
    if (p.status === 'unconfigured') return { tone: 'warning', text: t('aiAdmin.status.unconfigured') }
    if (p.status === 'unreachable') return { tone: 'danger', text: t('aiAdmin.status.unreachable') }
    if (p.status === 'not_found') return { tone: 'danger', text: t('aiAdmin.status.notFound') }
    if ((p.ms ?? 0) > 1500) return { tone: 'warning', text: t('aiAdmin.status.slow', { s: ((p.ms ?? 0) / 1000).toFixed(1) }) }
    return { tone: 'success', text: t('aiAdmin.status.ok') }
  }
  const where = cfg.external ? t('aiAdmin.external') : t('aiAdmin.local')
  const baseBadge = badge(probes.base)
  const advBadge = badge(probes.adv)

  // ── 제공자 모달(기본 모델) ──
  const [prov, setProvState] = useState<Prov>({ open: false, kind: 'ollama', base_url: '', api_key: '', model: '', max_tokens: 0, models: [], probing: false, saving: false })
  const provRef = useRef(prov)
  const patchProv = (p: Partial<Prov>) => { provRef.current = { ...provRef.current, ...p }; setProvState(provRef.current) }
  const provDef = PROVIDERS.find(p => p.kind === prov.kind)
  const provModels = (() => {
    const list = prov.models.map(m => ({ value: m, label: m }))
    if (prov.model && !prov.models.includes(prov.model)) list.push({ value: prov.model, label: prov.model })
    return list
  })()
  function openProvider() {
    const c = cfgRef.current
    patchProv({ open: true, kind: c.kind || 'ollama', base_url: c.base_url, api_key: '', model: c.model, max_tokens: c.max_tokens, models: c.model ? [c.model] : [], probing: false, saving: false })
  }
  async function loadModels(patch: (p: { models?: string[]; probing?: boolean }) => void, body?: Record<string, string>): Promise<string[]> {
    patch({ probing: true })
    let models: string[]
    try {
      const r = body
        ? await $fetch<{ models: string[] }>('/api/ai/probe-models', { method: 'POST', credentials: 'include', body })
        : await $fetch<{ models: string[] }>('/api/ai/models', { credentials: 'include' })
      models = r.models || []
      patch({ models })
      if (!models.length) addToast('info', t('ai.admin.noModels'))
    } catch (e: any) {
      addToast('error', t('ai.admin.probeFailed', { msg: errText(e, e?.message || String(e)) }))
      models = []
    } finally { patch({ probing: false }) }
    return models
  }
  async function loadProvModels() {
    const p = provRef.current, c = cfgRef.current
    const changed = p.api_key.trim() || p.kind !== c.kind || p.base_url !== c.base_url
    await loadModels(patchProv, changed ? { kind: p.kind, base_url: p.base_url, api_key: p.api_key } : undefined)
    const now = provRef.current
    if (now.models.length && !now.models.includes(now.model)) patchProv({ model: now.models[0] })
  }
  async function saveProvider() {
    patchProv({ saving: true })
    try {
      const p = provRef.current
      const body: any = { kind: p.kind, model: p.model.trim(), base_url: p.base_url.trim(), max_tokens: p.max_tokens }
      if (p.api_key.trim()) body.api_key = p.api_key
      await $fetch('/api/ai/config', { method: 'PUT', credentials: 'include', body })
      patchProv({ open: false })
      addToast('success', t('ai.admin.saved'))
      await load()
    } catch (e: any) {
      addToast('error', t('ai.admin.saveFailed', { msg: errText(e, e?.message || String(e)) }))
    } finally { patchProv({ saving: false }) }
  }

  // ── 고급 모델 모달 ──
  const [adv, setAdvState] = useState<Adv>({ open: false, model: '', models: [], probing: false, saving: false })
  const advRef = useRef(adv)
  const patchAdv = (p: Partial<Adv>) => { advRef.current = { ...advRef.current, ...p }; setAdvState(advRef.current) }
  const advOptions = (() => {
    const list = adv.models.map(m => ({ value: m, label: m }))
    if (adv.model && !adv.models.includes(adv.model)) list.push({ value: adv.model, label: adv.model })
    return list
  })()
  function openAdvanced() { patchAdv({ open: true, model: cfgRef.current.advanced_model, models: [], probing: false, saving: false }) }
  async function saveAdvanced(value: string) {
    patchAdv({ saving: true })
    try {
      await $fetch('/api/ai/config', { method: 'PUT', credentials: 'include', body: { advanced_model: value } })
      patchAdv({ open: false })
      await load()
    } catch (e: any) {
      addToast('error', t('ai.admin.saveFailed', { msg: errText(e, e?.message || String(e)) }))
    } finally { patchAdv({ saving: false }) }
  }

  // ── 거버넌스(즉시 저장) ──
  const [govSaved, setGovSaved] = useState(false)
  const govTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  async function saveGovernance(extra: Record<string, unknown> = {}) {
    try {
      const c = cfgRef.current
      const allowed = c.allowedTools.length === c.availableTools.length ? [] : c.allowedTools
      await $fetch('/api/ai/governance', {
        method: 'PUT', credentials: 'include',
        body: { allowed_tools: allowed, external_allow_data: c.external_allow_data, allow_user_keys: c.allow_user_keys, ...extra },
      })
      setGovSaved(true)
      if (govTimer.current) clearTimeout(govTimer.current)
      govTimer.current = setTimeout(() => { setGovSaved(false) }, 2000)
      return true
    } catch (e: any) {
      addToast('error', t('ai.admin.saveFailed', { msg: errText(e, e?.message || String(e)) }))
      await load()
      return false
    }
  }
  function setGov(key: 'external_allow_data' | 'allow_user_keys', v: boolean) {
    setCfg({ ...cfgRef.current, [key]: v })
    void saveGovernance()
  }
  function setAllowed(tool: string, on: boolean) {
    const list = [...cfgRef.current.allowedTools]
    const i = list.indexOf(tool)
    if (on && i < 0) list.push(tool)
    else if (!on && i >= 0) list.splice(i, 1)
    setCfg({ ...cfgRef.current, allowedTools: list })
    void saveGovernance()
  }
  const WEB = 'web_search'
  const searchTools = cfg.availableTools.filter(x => x !== WEB)
  const searchOn = searchTools.length > 0 && searchTools.every(x => cfg.allowedTools.includes(x))
  const webOn = cfg.allowedTools.includes(WEB)
  const hasWeb = cfg.availableTools.includes(WEB)
  function setGroup(group: 'search' | 'web', on: boolean) {
    const c = cfgRef.current
    const tools = group === 'web' ? [WEB] : c.availableTools.filter(x => x !== WEB)
    const allowedTools = on ? [...new Set([...c.allowedTools, ...tools])] : c.allowedTools.filter(x => !tools.includes(x))
    setCfg({ ...c, allowedTools })
    void saveGovernance()
  }

  // ── 한도(카드 저장) ──
  const limitChanges = Number(limits.daily !== limitsOrig.daily) + Number(limits.retention !== limitsOrig.retention)
  const retentionOptions = (() => {
    const opts = [0, 30, 90, 180, 365].map(d => ({ value: String(d), label: d ? t('aiAdmin.days', { n: d }) : t('aiAdmin.keepForever') }))
    if (!opts.some(o => o.value === limits.retention)) opts.push({ value: limits.retention, label: t('aiAdmin.days', { n: limits.retention }) })
    return opts
  })()
  const dailyError = /^\d+$/.test(String(limits.daily)) ? '' : t('aiAdmin.numberError')
  async function saveLimits() {
    if (dailyError) return
    setLimitsSaving(true)
    if (await saveGovernance({ daily_limit: Number(limits.daily), retention_days: Number(limits.retention) })) {
      setLimitsOrig({ ...limits })
      setLimitsSaved(true); setTimeout(() => { setLimitsSaved(false) }, 2000)
    }
    setLimitsSaving(false)
  }

  if (loadError) return <UiErrorTile placement="panel" title={loadError} onRetry={() => { void load() }} />

  return (
    <div id="ai" className="flex flex-col gap-3.5">
      {/* ① 워크스페이스 모델 */}
      <SettingsCard
        title={t('aiAdmin.modelsTitle')}
        description={t('aiAdmin.modelsDesc')}
        saved={govSaved}
        flush
        header={(
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <UiStatusDot status={moduleEnabled ? 'ok' : 'off'} label={moduleEnabled ? t('ai.admin.moduleOn') : t('ai.admin.moduleOff')} />
            <NuxtLink to="/admin/modules" className="text-primary hover:underline">{moduleEnabled ? t('ai.admin.moduleOn') : t('ai.admin.moduleOff')}</NuxtLink>
          </span>
        )}
      >
        {loading ? <UiSkeleton preset="list" rows={3} /> : (
          <>
            <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">{t('aiAdmin.base')}</b>
                <span className="block truncate text-xs text-muted-foreground">{cfg.model ? `${where} · ${cfg.kind} · ${cfg.model}` : t('aiAdmin.notSet')}</span>
              </span>
              {baseBadge && <UiBadge tone={baseBadge.tone} tint>{baseBadge.text}</UiBadge>}
              {/* 행 액션 = ⋮ 하나, 첫 항목 "설정" */}
              <UiMenu
                triggerIcon="more-vertical"
                label={t('aiAdmin.rowMenu', { name: t('aiAdmin.base') })}
                items={[{ key: 'configure', label: t('aiAdmin.configure'), icon: 'settings' }]}
                onSelect={() => openProvider()}
              />
            </div>
            <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">{t('aiAdmin.advanced')}</b>
                <span className="block truncate text-xs text-muted-foreground">{cfg.advanced_model ? `${where} · ${cfg.advanced_model}` : t('aiAdmin.advancedNone')}</span>
              </span>
              {cfg.advanced_model && advBadge && <UiBadge tone={advBadge.tone} tint>{advBadge.text}</UiBadge>}
              <UiMenu
                triggerIcon="more-vertical"
                label={t('aiAdmin.rowMenu', { name: t('aiAdmin.advanced') })}
                items={[
                  { key: 'configure', label: t('aiAdmin.configure'), icon: 'settings', disabled: !cfg.model },
                  ...(cfg.advanced_model ? [{ key: 'clear', label: t('aiAdmin.advancedClear'), icon: 'close', danger: true, separated: true }] : []),
                ]}
                onSelect={(k) => { if (k === 'configure') openAdvanced(); else if (k === 'clear') void saveAdvanced('') }}
              />
            </div>
            <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">{t('ai.admin.userKeys')}</b>
                <span className="block text-xs text-muted-foreground">{t('aiAdmin.userKeysDesc')}</span>
              </span>
              <UiSwitch modelValue={cfg.allow_user_keys} ariaLabel={t('ai.admin.userKeys')} onUpdateModelValue={(v: boolean) => setGov('allow_user_keys', v)} />
            </div>
          </>
        )}
      </SettingsCard>

      {/* ② 도구 허용 */}
      <SettingsCard title={t('aiAdmin.toolsTitle')} description={t('aiAdmin.toolsDesc')} saved={govSaved} flush>
        {loading ? <UiSkeleton preset="list" rows={2} /> : (
          <>
            <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">{t('aiAdmin.searchTools')}</b>
                <span className="block text-xs text-muted-foreground">{t('aiAdmin.searchToolsDesc')}</span>
              </span>
              <UiSwitch modelValue={searchOn} ariaLabel={t('aiAdmin.searchTools')} onUpdateModelValue={(v: boolean) => setGroup('search', v)} />
            </div>
            {hasWeb && (
              <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
                <span className="min-w-0 flex-1">
                  <b className="block font-semibold text-foreground">{t('aiAdmin.webSearch')}</b>
                  <span className="block text-xs text-muted-foreground">{t('aiAdmin.webSearchDesc')}</span>
                </span>
                <UiSwitch modelValue={webOn} ariaLabel={t('aiAdmin.webSearch')} onUpdateModelValue={(v: boolean) => setGroup('web', v)} />
              </div>
            )}
            <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">{t('ai.admin.externalData')}</b>
                <span className="block text-xs text-muted-foreground">{t('ai.admin.externalDataDesc')}</span>
              </span>
              <UiSwitch modelValue={cfg.external_allow_data} ariaLabel={t('ai.admin.externalData')} onUpdateModelValue={(v: boolean) => setGov('external_allow_data', v)} />
            </div>
            <details className="group border-t border-border px-5 py-3 text-[13px]">
              <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 font-medium text-foreground">
                <UiIcon name="chevron-right" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />{t('aiAdmin.perTool')}
                {' '}
                <span className="text-xs font-normal text-muted-foreground">({t('ai.admin.allowedToolsHint')})</span>
              </summary>
              <div className="grid grid-cols-1 gap-x-4 pt-1 sm:grid-cols-2">
                {cfg.availableTools.map(toolName => (
                  <div key={toolName} className="flex min-h-10 items-center gap-2">
                    <UiCheckbox modelValue={cfg.allowedTools.includes(toolName)} label={toolLabel(toolName)} size={16} onUpdateModelValue={(v: boolean) => setAllowed(toolName, v)} />
                    <span className="font-mono text-[11px] text-muted-foreground">{toolName}</span>
                    {cfg.dataTools.includes(toolName) && <UiBadge tone="warning" tint size={18}>{t('ai.admin.dataTool')}</UiBadge>}
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t('ai.admin.dataToolNote')}</p>
            </details>
          </>
        )}
      </SettingsCard>

      {/* ③ 한도 */}
      <SettingsCard
        title={t('aiAdmin.limitsTitle')}
        changes={limitChanges}
        saving={limitsSaving}
        saved={limitsSaved}
        onSave={() => { void saveLimits() }}
        onReset={() => setLimits({ ...limitsOrig })}
      >
        {loading ? <UiSkeleton preset="text" rows={2} /> : (
          <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
            <UiInput modelValue={limits.daily} onUpdateModelValue={v => setLimits(l => ({ ...l, daily: looseToNumber(v) }))} type="number" min="0" label={t('aiAdmin.daily')} hint={t('aiAdmin.dailyHint')} error={dailyError} mono />
            <UiSelect modelValue={limits.retention} onUpdateModelValue={v => setLimits(l => ({ ...l, retention: v as string }))} options={retentionOptions} label={t('aiAdmin.retention')} hint={t('aiAdmin.retentionHint')} />
          </div>
        )}
      </SettingsCard>

      {/* 제공자 설정 모달 */}
      {prov.open && (
        <UiModal
          title={t('aiAdmin.providerModal')}
          size="520"
          onClose={() => patchProv({ open: false })}
          footer={(
            <>
              <UiButton variant="outline" size="sm" onClick={() => patchProv({ open: false })}>{t('common.cancel')}</UiButton>
              <UiButton size="sm" disabled={prov.saving} onClick={() => { void saveProvider() }}>{t('common.save')}</UiButton>
            </>
          )}
        >
          <form className="grid gap-3.5" onSubmit={(e: FormEvent) => { e.preventDefault(); void saveProvider() }}>
            <UiSelect modelValue={prov.kind} onUpdateModelValue={v => { const k = String(v ?? ''); patchProv(k !== prov.kind ? { kind: k, models: [], model: '' } : { kind: k }) }} label={t('ai.admin.provider')} options={providerOptions} />
            {provDef?.needsKey && (
              <UiPasswordInput
                modelValue={prov.api_key}
                onUpdateModelValue={v => patchProv({ api_key: v })}
                label={t('ai.admin.apiKey')}
                hint={cfg.hasKey ? t('ai.admin.keySaved') : t('ai.admin.keyUnset')}
                placeholder={cfg.hasKey ? '●●●●' : 'sk-…'}
                autocomplete="new-password"
              />
            )}
            {provDef?.needsBase && (
              <UiInput modelValue={prov.base_url} onUpdateModelValue={v => patchProv({ base_url: v })} label={t('ai.admin.endpoint')} hint={t('ai.admin.endpointHint')} autocomplete="off" mono />
            )}
            <div className="flex items-end gap-2">
              {prov.models.length
                ? <UiSelect modelValue={prov.model} onUpdateModelValue={v => patchProv({ model: String(v ?? '') })} label={t('ai.admin.model')} options={provModels} className="flex-1" />
                : <UiInput modelValue={prov.model} onUpdateModelValue={v => patchProv({ model: v })} label={t('ai.admin.model')} placeholder={t('ai.admin.modelPlaceholder')} autocomplete="off" mono className="flex-1" />}
              <UiButton variant="outline" type="button" disabled={prov.probing} className="whitespace-nowrap" onClick={() => { void loadProvModels() }}>{prov.probing ? '…' : t('ai.admin.loadModels')}</UiButton>
            </div>
            <UiInput modelValue={prov.max_tokens} onUpdateModelValue={v => patchProv({ max_tokens: looseToNumber(v) })} type="number" label={t('ai.admin.maxTokens')} min="0" max="128000" mono className="w-40" />
            <button type="submit" className="hidden" />
          </form>
        </UiModal>
      )}

      {/* 고급 모델 모달 */}
      {adv.open && (
        <UiModal
          title={t('aiAdmin.advancedModal')}
          size="440"
          onClose={() => patchAdv({ open: false })}
          footer={(
            <>
              {cfg.advanced_model && (
                <UiButton variant="ghost" size="sm" className="mr-auto text-danger hover:text-danger" disabled={adv.saving} onClick={() => { void saveAdvanced('') }}>{t('aiAdmin.advancedClear')}</UiButton>
              )}
              <UiButton variant="outline" size="sm" onClick={() => patchAdv({ open: false })}>{t('common.cancel')}</UiButton>
              <UiButton size="sm" disabled={adv.saving || !adv.model.trim()} onClick={() => { void saveAdvanced(adv.model.trim()) }}>{t('common.save')}</UiButton>
            </>
          )}
        >
          <p className="text-[13px] text-muted-foreground">{t('aiAdmin.advancedHelp', { kind: cfg.kind })}</p>
          <div className="flex items-end gap-2">
            {adv.models.length
              ? <UiSelect modelValue={adv.model} onUpdateModelValue={v => patchAdv({ model: String(v ?? '') })} label={t('ai.admin.model')} options={advOptions} className="flex-1" />
              : <UiInput modelValue={adv.model} onUpdateModelValue={v => patchAdv({ model: v })} label={t('ai.admin.model')} placeholder={t('ai.admin.modelPlaceholder')} autocomplete="off" mono className="flex-1" />}
            <UiButton variant="outline" type="button" disabled={adv.probing} className="whitespace-nowrap" onClick={() => { void loadModels(patchAdv) }}>{adv.probing ? '…' : t('ai.admin.loadModels')}</UiButton>
          </div>
        </UiModal>
      )}
    </div>
  )
}

export default AiAdminSettings
