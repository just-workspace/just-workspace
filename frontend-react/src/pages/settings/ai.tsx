// Vue 원본: frontend/pages/settings/ai.vue
// 설정 › AI.
//  ① 기본 모델 — 라디오 행: 워크스페이스 기본 · 워크스페이스 고급(관리자가 지정했을 때) · 내 API 키. 고르면 바로 저장(PUT /api/ai/my-settings) + "저장됨 ✓".
//  ② 내 API 키 — 관리자가 허용한 경우만. 제공자 160 + API 키(저장돼 있으면 점선 칸에 가림값 + [바꾸기]),
//     "연결 확인됨 · MM/DD", 카드 안에 모델·주소 칸, 푸터 = 왼쪽 "키 삭제"(danger) · 오른쪽 [연결 시험][되돌리기][저장]
//     — 카드별 저장 규칙(변경 없으면 되돌리기·저장 비활성).
//  ③ 도구 기본값 · 지침 — 스위치 행 바로 저장, 내 지침 텍스트 칸(모든 대화에 붙음, 칸을 벗어나면 저장).
//  외부 AI 데이터 접근 동의 카드는 ② 개인 키 카드 바로 아래, 스위치 즉시 저장.
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import type { MouseEvent } from 'react'
import { $fetch } from '~/lib/api'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSwitch } from '~/components/ui/Switch'
import { UiSelect } from '~/components/ui/Select'
import { UiInput } from '~/components/ui/Input'
import { UiButton } from '~/components/ui/Button'
import { UiTextarea } from '~/components/ui/Textarea'
import { SettingsHeader } from '~/components/settings/SettingsHeader'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { SettingsRow } from '~/components/settings/SettingsRow'
import { SettingsAiModelChoice, SettingsMaskedKey, SettingsVerifiedMark } from '~/components/settings/SettingsAiParts'

interface MySettings {
  default_model: string
  effective_default_model: 'workspace' | 'workspace_advanced' | 'personal'
  tools: Record<'mail' | 'files' | 'calendar' | 'web', boolean>
  instructions: string
  choices: {
    workspace: { model: string; external: boolean }
    workspace_advanced: { model: string; available: boolean }
    personal: { allowed: boolean; configured: boolean }
  }
  web_search_allowed: boolean
}
interface AiStatus { module_enabled?: boolean; allow_user_keys?: boolean; external?: boolean; external_allow_data?: boolean }
interface MyProvider {
  kind: string; api_key: string; base_url: string; model: string; max_tokens: number; models: string[]
  hasKey: boolean; keyHint: string; verifiedAt: string | null; configured: boolean; editingKey: boolean; testing: boolean; saving: boolean
}
const EMPTY_PROVIDER: MyProvider = { kind: 'openai', api_key: '', base_url: '', model: '', max_tokens: 0, models: [], hasKey: false, keyHint: '', verifiedAt: '', configured: false, editingKey: false, testing: false, saving: false }
const detailOf = (e: unknown) => (e as { data?: { detail?: string } } | null)?.data?.detail

export default function SettingsAiPage() {
  const { t, locale } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('profile.navAi')} | ${appName}` })

  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [my, setMy] = useState<MySettings | null>(null)
  const [consent, setConsentState] = useState(false)
  const [consentSaved, setConsentSaved] = useState(false)
  const [modelSaved, setModelSaved] = useState(false)
  const [toolsSaved, setToolsSaved] = useState(false)
  const [instructions, setInstructions] = useState('')

  function flash(set: (v: boolean) => void) { set(true); setTimeout(() => { set(false) }, 2000) }

  // ── ② 내 API 키 상태 ──
  const AI_PROVIDERS = [
    { value: 'openai', label: 'OpenAI', needsKey: true, needsBase: false },
    { value: 'anthropic', label: 'Anthropic', needsKey: true, needsBase: false },
    { value: 'compatible', label: t('settings.ai.compatible'), needsKey: true, needsBase: true },
    { value: 'ollama', label: t('settings.ai.ollama'), needsKey: false, needsBase: true },
  ]
  const [myp, setMyp] = useState<MyProvider>(EMPTY_PROVIDER)
  const patch = (p: Partial<MyProvider>) => setMyp(x => ({ ...x, ...p }))
  const [snapshot, setSnapshot] = useState('')
  const snapOf = (p: MyProvider) => JSON.stringify([p.kind, p.base_url, p.model])
  const provider = AI_PROVIDERS.find(p => p.value === myp.kind)
  const modelOptions = (() => {
    const list = myp.models.map(m => ({ value: m, label: m }))
    if (myp.model && !myp.models.includes(myp.model)) list.push({ value: myp.model, label: myp.model })
    return list
  })()
  const changes = Number(snapOf(myp) !== snapshot) + Number(!!myp.api_key.trim())
  const showKeyInput = !myp.hasKey || myp.editingKey

  async function loadMyProvider() {
    let next: MyProvider | null = null
    try {
      const r = await $fetch<{ allowed: boolean; provider?: { kind?: string; base_url?: string; model?: string; max_tokens?: number; has_key?: boolean; key_hint?: string; verified_at?: string; configured?: boolean } }>('/api/ai/my-provider', { credentials: 'include' })
      if (r.allowed && r.provider) {
        const p = r.provider
        next = {
          ...myRef.current,
          kind: p.kind || 'openai', base_url: p.base_url || '', model: p.model || '', max_tokens: p.max_tokens ?? 0,
          hasKey: !!p.has_key, keyHint: p.key_hint || '', verifiedAt: p.verified_at || null, configured: !!p.configured,
          api_key: '', editingKey: false, models: p.model ? [p.model] : [],
        }
        setMyp(next)
      }
    } catch { /* 무시 */ }
    setSnapshot(snapOf(next ?? myRef.current))
  }
  // 이벤트 처리기 안에서 "지금" 값(Vue reactive 대응)
  const myRef = useRef(myp)
  myRef.current = myp

  async function load() {
    try {
      const st = await $fetch<AiStatus>('/api/ai/status', { credentials: 'include' })
      setAiStatus(st)
      if (st?.module_enabled) {
        const [c, m] = await Promise.all([
          $fetch<{ consent: boolean }>('/api/ai/consent', { credentials: 'include' }),
          $fetch<MySettings>('/api/ai/my-settings', { credentials: 'include' }),
        ])
        setConsentState(c.consent)
        setMy(m)
        setInstructions(m.instructions || '')
        if (st?.allow_user_keys) await loadMyProvider()
      }
    } catch { /* aiStatus 유지 */ } finally { setLoaded(true) }
  }
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function setConsent(v: boolean) {
    try {
      await $fetch('/api/ai/consent', { method: 'PUT', credentials: 'include', body: { consent: v } })
      setConsentState(v)
      flash(setConsentSaved)
    } catch (e) { addToast('error', detailOf(e) || t('ai.settings.saveFailed')) }
  }

  async function saveMy(body: Partial<{ default_model: string; tools: Record<string, boolean>; instructions: string }>, setSaved: (v: boolean) => void) {
    try {
      setMy(await $fetch<MySettings>('/api/ai/my-settings', { method: 'PUT', credentials: 'include', body }))
      flash(setSaved)
      return true
    } catch (e) { addToast('error', detailOf(e) || t('ai.settings.saveFailed')); return false }
  }

  // ── ① 기본 모델 ──
  const modelChoice = my?.effective_default_model ?? 'workspace'
  function setModelChoice(v: string) { if (v !== my?.effective_default_model) void saveMy({ default_model: v }, setModelSaved) }
  const modelRows = (() => {
    const c = my?.choices
    if (!c) return []
    const rows: { value: string; title: string; desc: string; disabled: boolean }[] = [
      { value: 'workspace', title: t('settings.ai.wsDefault'), desc: c.workspace.external ? t('settings.ai.wsDefaultExternal', { model: c.workspace.model }) : t('settings.ai.wsDefaultLocal'), disabled: false },
    ]
    if (c.workspace_advanced.available) rows.push({ value: 'workspace_advanced', title: t('settings.ai.wsAdvanced'), desc: t('settings.ai.wsAdvancedDesc'), disabled: false })
    if (c.personal.allowed) rows.push({ value: 'personal', title: t('settings.ai.personal'), desc: c.personal.configured ? t('settings.ai.personalDesc') : t('settings.ai.personalNeedKey'), disabled: !c.personal.configured })
    return rows
  })()

  function fmtDay(s: string | null) {
    if (!s) return ''
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale === 'ko' ? 'ko-KR' : 'en-US', { month: '2-digit', day: '2-digit' })
  }
  /** [연결 시험] — 입력 중인 새 값이 있으면 그 값으로 모델 목록만, 아니면 저장된 키로 시험하고 "연결 확인됨" 기록 */
  async function testConnection() {
    patch({ testing: true })
    try {
      const cur = myRef.current
      const dirty = changes > 0
      const body = dirty ? { kind: cur.kind, base_url: cur.base_url, api_key: cur.api_key || undefined } : {}
      const r = await $fetch<{ ok: boolean; models: string[]; verified_at: string | null }>('/api/ai/my-provider/test', { method: 'POST', credentials: 'include', body })
      const models = r.models || []
      const p: Partial<MyProvider> = { models }
      if (models.length && !models.includes(myRef.current.model)) p.model = models[0]
      if (r.verified_at) p.verifiedAt = r.verified_at
      patch(p)
      if (!r.ok) addToast('error', t('settings.ai.testFailed'))
      else if (dirty) addToast('success', t('settings.ai.testOkUnsaved'))
    } catch (e) { addToast('error', detailOf(e) || t('settings.ai.testFailed')) }
    finally { patch({ testing: false }) }
  }
  async function saveProvider() {
    const cur = myRef.current
    if (provider?.needsKey && !cur.hasKey && !cur.api_key.trim()) { addToast('warning', t('ai.settings.needKey')); return }
    if (!cur.model.trim()) { addToast('warning', t('ai.settings.needModel')); return }
    patch({ saving: true })
    try {
      const body: Record<string, unknown> = { kind: cur.kind, model: cur.model.trim(), base_url: cur.base_url.trim(), max_tokens: cur.max_tokens }
      if (cur.api_key.trim()) body.api_key = cur.api_key
      await $fetch('/api/ai/my-provider', { method: 'PUT', credentials: 'include', body })
      await loadMyProvider()
      setMy(await $fetch<MySettings>('/api/ai/my-settings', { credentials: 'include' }))
    } catch (e) { addToast('error', detailOf(e) || t('ai.settings.saveFailed')) }
    finally { patch({ saving: false }) }
  }
  function resetProvider() { void loadMyProvider() }
  async function deleteKey() {
    if (!await confirmBox(t('settings.ai.deleteKeyBody'), { title: t('settings.ai.deleteKeyTitle'), confirmLabel: t('settings.ai.deleteKey'), danger: true })) return
    try {
      await $fetch('/api/ai/my-provider', { method: 'DELETE', credentials: 'include' })
      const next = { ...myRef.current, kind: 'openai', api_key: '', base_url: '', model: '', models: [], hasKey: false, keyHint: '', verifiedAt: null, configured: false, editingKey: false }
      setMyp(next)
      setSnapshot(snapOf(next))
      setMy(await $fetch<MySettings>('/api/ai/my-settings', { credentials: 'include' }))
    } catch (e) { addToast('error', detailOf(e) || t('ai.settings.clearFailed')) }
  }

  // ── ③ 도구 기본값 · 지침 ──
  const TOOL_ROWS = [
    { key: 'mail' as const, title: t('settings.ai.toolMail'), desc: t('settings.ai.toolMailDesc') },
    { key: 'files' as const, title: t('settings.ai.toolFiles'), desc: t('settings.ai.toolFilesDesc') },
    { key: 'calendar' as const, title: t('settings.ai.toolCalendar'), desc: t('settings.ai.toolCalendarDesc') },
    { key: 'web' as const, title: t('settings.ai.toolWeb'), desc: t('settings.ai.toolWebDesc') },
  ]
  function setTool(key: string, v: boolean) { void saveMy({ tools: { [key]: v } }, setToolsSaved) }
  async function saveInstructions() {
    if (!my || instructions.trim() === (my.instructions || '')) return
    await saveMy({ instructions }, setToolsSaved)
  }

  return (
    <>
      <SettingsHeader title="AI" subtitle={t('settings.ai.subtitle')} />

      {!loaded
        ? <UiSkeleton preset="card" framed />
        : !aiStatus?.module_enabled
          ? <UiEmptyState variant="full" icon="sparkles" title={t('ai.settings.moduleOff')} description={t('ai.settings.moduleOffDesc')} />
          : !my
            ? <UiErrorTile placement="panel" title={t('settings.ai.loadError')} onRetry={() => void load()} />
            : (
              <>
                {/* ① 기본 모델 */}
                <SettingsCard title={t('settings.ai.defaultModel')} description={t('settings.ai.defaultModelDesc')} saved={modelSaved}>
                  <SettingsAiModelChoice modelValue={modelChoice} onUpdateModelValue={setModelChoice} rows={modelRows} ariaLabel={t('settings.ai.defaultModel')} />
                </SettingsCard>


                {/* ② 내 API 키 */}
                {aiStatus.allow_user_keys && (
                  <SettingsCard title={t('settings.ai.myKey')} description={t('settings.ai.myKeyDesc')} flush>
                    <div className="grid gap-3 px-5 py-4 sm:grid-cols-[160px_1fr]">
                      <UiSelect modelValue={myp.kind} onUpdateModelValue={v => patch({ kind: String(v) })} label={t('ai.settings.provider')} options={AI_PROVIDERS} />
                      <div className="flex flex-col gap-1.5">
                        {provider?.needsKey && (showKeyInput
                          ? (
                            <UiInput
                              modelValue={myp.api_key}
                              onUpdateModelValue={v => patch({ api_key: v })}
                              type="password"
                              label={t('ai.settings.apiKey')}
                              autocomplete="off"
                              mono
                              placeholder="sk-…"
                            />
                          )
                          : <SettingsMaskedKey label={t('ai.settings.apiKey')} hint={myp.keyHint} onChange={() => patch({ editingKey: true })} />)}
                        {provider?.needsBase && <UiInput modelValue={myp.base_url} onUpdateModelValue={v => patch({ base_url: v })} label={t('ai.settings.endpoint')} hint={t('ai.settings.endpointHint')} mono />}
                        {myp.verifiedAt && !changes && <SettingsVerifiedMark date={fmtDay(myp.verifiedAt)} />}
                      </div>
                      <div className="sm:col-span-2">
                        {myp.models.length
                          ? <UiSelect modelValue={myp.model} onUpdateModelValue={v => patch({ model: String(v) })} label={t('ai.settings.model')} options={modelOptions} />
                          : <UiInput modelValue={myp.model} onUpdateModelValue={v => patch({ model: v })} label={t('ai.settings.model')} placeholder={t('ai.settings.modelPlaceholder')} hint={t('settings.ai.modelHint')} mono />}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border px-5 py-3">
                      {myp.configured || myp.hasKey
                        ? <button type="button" className="relative mr-auto text-[13px] font-semibold text-danger hover:underline after:absolute after:-inset-3 after:content-['']" onClick={() => void deleteKey()}>{t('settings.ai.deleteKey')}</button>
                        : <span className="mr-auto" />}
                      <UiButton variant="outline" size="sm" disabled={myp.testing || (!myp.configured && !changes)} onClick={() => void testConnection()}>{myp.testing ? t('settings.ai.testing') : t('settings.ai.test')}</UiButton>
                      <UiButton variant="outline" size="sm" disabled={!changes || myp.saving} onClick={resetProvider}>{t('settingsCard.reset')}</UiButton>
                      <UiButton size="sm" disabled={!changes || myp.saving} onClick={() => void saveProvider()}>{myp.saving ? t('settingsCard.saving') : t('settingsCard.save')}</UiButton>
                    </div>
                  </SettingsCard>
                )}

                {/* 외부 AI 데이터 동의 — 개인 키 카드 바로 아래 */}
                {aiStatus.external && aiStatus.external_allow_data && (
                  <SettingsCard title={t('settings.ai.consentTitle')} saved={consentSaved}>
                    <UiSwitch modelValue={consent} label={t('ai.settings.consentLabel')} description={t('ai.settings.consentDesc')} className="w-full" onUpdateModelValue={v => void setConsent(v)} />
                  </SettingsCard>
                )}

                {/* ③ 도구 기본값 · 지침 */}
                <SettingsCard title={t('settings.ai.toolsTitle')} description={t('settings.ai.toolsDesc')} saved={toolsSaved} flush>
                  {TOOL_ROWS.map((r) => {
                    const webOff = r.key === 'web' && !my.web_search_allowed
                    return (
                      <SettingsRow key={r.key} layout="inline" className="border-t border-border" title={r.title} description={webOff ? t('settings.ai.toolWebOff') : r.desc}>
                        <UiSwitch
                          modelValue={webOff ? false : my.tools[r.key]}
                          ariaLabel={r.title}
                          disabled={webOff}
                          onUpdateModelValue={v => setTool(r.key, v)}
                        />
                      </SettingsRow>
                    )
                  })}
                  <div className="border-t border-border px-5 py-3.5">
                    <UiTextarea
                      modelValue={instructions}
                      onUpdateModelValue={setInstructions}
                      label={t('settings.ai.instructions')}
                      placeholder={t('settings.ai.instructionsPlaceholder')}
                      rows={3}
                      maxLength={2000}
                      onBlur={() => void saveInstructions()}
                    />
                  </div>
                </SettingsCard>

                {/* ④ 메모리 — 별도 화면 */}
                <SettingsCard title={t('ai.memory.title')} description={t('ai.memory.manageDesc')}>
                  <UiButton as="a" href="/settings/ai/memory" variant="outline" size="sm" iconRight="chevron-right" onClick={(e: MouseEvent) => { e.preventDefault(); void navigateTo('/settings/ai/memory') }}>{t('ai.memory.manage')}</UiButton>
                </SettingsCard>
              </>
            )}
    </>
  )
}
