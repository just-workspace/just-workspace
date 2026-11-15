// Vue 원본: frontend/pages/ai.vue
// AI(코어 일반 AI 화면).
//  데스크톱: 사이드바 236(접기) + 대화 머리 44(제목 · 모델 피커 · 도구 N · 지침 · ⋯) + 본문 680 + 입력.
//  모바일: 대화 목록(자체 머리 + FAB) → 대화(LayoutMobileDetailBar ‹ · 제목/모델·도구 · ⋯, 탭바 숨김).
// 모델·도구 이름은 서버(/api/ai/status) 응답만 보인다.
//
// React 이식 메모: Vue 는 스트리밍 중인 어시스턴트 메시지(reactive)를 제자리에서 고쳤다. 여기서는 같은 객체를
// 고친 뒤 새 객체로 바꿔 넣는다(_uid 로 찾음 — 목록이 비워졌으면 아무 일 없음, Vue 에서 떨어진 객체를 고치는 것과 같다).
// 비동기 처리기는 "지금" 값이 필요해 상태마다 ref 를 같이 둔다(useLive).
//
// 질문 수정 → 답변 버전(◀ n/N ▶, POST /messages/{id}/edit · /versions/{n}) ·
//  임시 대화(입력창 스위치 · 배너 · 사이드바 "임시 대화" · 나가거나 창을 닫으면 DELETE) · 프로젝트(카드·지침·지식 파일·공유) ·
//  메모리 저장 알림 [취소] · 첨부(끌어다 놓기·붙여넣기·고르기, 올리는 중 → 변환 중 → 완료/실패 코드) · 서버 대화 검색.
//
// 프로젝트 편집 창(지식 파일 연결·피커 20개) · 여러 그룹 공유(못 읽는 파일 경고) ·
//  구성원 머리 · 답변에서 빠진 지식 파일 줄 · 공유가 끊긴 프로젝트 · 모바일 목록 묶음 · 이미지 썸네일 ·
//  이미지 못 읽는 모델이면 보내기 막힘 + [이미지 읽는 모델로 바꾸기](설정 › AI 기본 모델) · 보낸 첨부 미리보기 ·
//  질문 수정 때 첨부 유지/빼기 · context_trimmed → 대화 맨 위 "앞부분 N개 메시지는 … 쓰지 않았습니다"(빠진 메시지 흐리게).
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { confirmBox, promptBox } from '~/composables/useDialog'
import { useAuth } from '~/composables/useAuth'
import { useAiLabels } from '~/composables/useAiLabels'
import { useIsMobile } from '~/composables/useIsMobile'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { useOwnMobileHeader } from '~/composables/useOwnMobileHeader'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'
import { UiButton } from '~/components/ui/Button'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiInput } from '~/components/ui/Input'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiModal } from '~/components/ui/Modal'
import { UiSelect } from '~/components/ui/Select'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiTextarea } from '~/components/ui/Textarea'
import { AiComposer, type AiComposerHandle } from '~/components/ai/AiComposer'
import { AiEmptyChat } from '~/components/ai/AiEmptyChat'
import { AiMessageItem } from '~/components/ai/AiMessageItem'
import { AiMobileList } from '~/components/ai/AiMobileList'
import { AiModelPicker } from '~/components/ai/AiModelPicker'
import { AiSidebar } from '~/components/ai/AiSidebar'
import { AiKnowledgeSkipped, AiProjectCard, AiProjectFormModal, AiProjectGone, AiProjectShareModal, type AiProjectFormValue } from '~/components/ai/AiProject'
import type { AiAttachment, AiConv, AiFeedback, AiMemorySaved, AiModelChoice, AiMsg, AiProject, AiProjectFile, AiQuestion, AiStatus } from '~/utils/aiAssist'
import { AI_ATTACH_MAX } from '~/utils/aiAssist'
import { aiUploadAttachment } from '~/utils/aiUpload'
import { apiRawFetch } from '~/lib/api'
import { aiExportFileName, aiExportMarkdown } from '~/utils/aiAssist'
import { writeClipboard } from '~/lib/clipboard'
import type { ApprovalRequest } from '~/utils/approvals'
import { attachWritesToMessages } from '~/utils/approvals'
import { approvalsApi } from '~/composables/useApprovals'
import { aiActiveRunFor, aiMergeRuns, aiPatchRunQuestion, aiPatchRunWrite, aiStreamStore, resumeAiRun, setAiView, startAiRun, stopAiRun, takeAiPendingOpen, useAiRuns } from '~/composables/useAiStreams'
import { AI_OPEN_CONVERSATION_EVENT } from '~/composables/useAiArtifacts'

function errMsg(e: any) { return e?.data?.detail || e?.message || String(e) }

/** 상태 + 그 "지금" 값 ref(설정 즉시 ref 도 바뀐다) */
function useLive<T>(init: T | (() => T)) {
  const [value, setValue] = useState<T>(init)
  const ref = useRef<T>(value)
  const set = useRef((next: T | ((prev: T) => T)) => {
    const v = typeof next === 'function' ? (next as (p: T) => T)(ref.current) : next
    ref.current = v
    setValue(v)
  }).current
  return [value, set, ref] as const
}

const PROVIDERS = [
  { kind: 'local', label: '', desc: '', needsKey: false, needsBase: false },
  { kind: 'openai', label: 'OpenAI', desc: 'GPT 계열 (api.openai.com)', needsKey: true, needsBase: false },
  { kind: 'anthropic', label: 'Anthropic', desc: 'Claude 계열', needsKey: true, needsBase: false },
  { kind: 'compatible', label: 'OpenAI 호환', desc: 'vLLM·LM Studio·Together 등 /v1 호환 엔드포인트', needsKey: true, needsBase: true },
]
function providerLabel(kind: string) { return PROVIDERS.find(p => p.kind === kind)?.label || kind }

// ─────────────────────────── 위저드 (admin · 미설정) ───────────────────────────
// 로컬 LLM 후보 — 자체 호스팅 서버를 순서대로 탐지한다.
// 엔진에 종속되지 않게: llama.cpp(llama-server, OpenAI 호환) → Ollama 순.
const LOCAL_CANDIDATES = [
  { kind: 'compatible', base_url: 'http://host.docker.internal:8080' },
  { kind: 'ollama', base_url: '' },
]

interface Wiz {
  kind: string; base_url: string; api_key: string; model: string; max_tokens: number
  models: string[]; localDetected: boolean; probing: boolean; saving: boolean; showAdvanced: boolean
  /** 'local' 선택 시 실제로 저장될 제공자 — 탐지 결과로 채워진다 */
  localKind: string; localBase: string
}

type Msg = AiMsg & { _uid?: number }
let uidSeq = 0

// 데스크톱 사이드바 접기(이 브라우저에 기억)
const SIDEBAR_KEY = 'ai-sidebar-collapsed'

export default function Page() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `AI | ${appName}` })
  const { user } = useAuth()
  const { labelledGroups } = useAiLabels()
  const tRef = useRef(t)
  tRef.current = t

  const [status, setStatus, statusRef] = useLive<AiStatus | null>(null)
  const [loading, setLoading] = useState(true)

  async function loadStatus() {
    setLoading(true)
    try {
      setStatus(await $fetch<AiStatus>('/api/ai/status', { credentials: 'include' }))
    } catch (e: any) {
      addToast('error', tRef.current('ai.errors.status', { msg: errMsg(e) }))
    } finally {
      setLoading(false)
    }
  }

  /** 화면을 로딩으로 바꾸지 않고 상태만 다시 읽는다(모델 바꾼 뒤) */
  async function refreshStatus() {
    try { setStatus(await $fetch<AiStatus>('/api/ai/status', { credentials: 'include' })) } catch { /* 그대로 */ }
  }

  // K1 — 고를 수 있는 모델 중 이미지를 읽는 것(설정 › AI 기본 모델과 같은 선택지)
  const [modelChoices, setModelChoices] = useState<AiModelChoice[]>([])
  async function loadModelChoices() {
    try {
      const r = await $fetch<{ choices: AiModelChoice[] }>('/api/ai/model-choices', { credentials: 'include' })
      setModelChoices(r?.choices || [])
    } catch { setModelChoices([]) }
  }
  const visionChoice = modelChoices.find(c => c.available && c.vision && !c.current) || null

  const view = (() => {
    if (loading || !status) return 'loading'
    const s = status
    if (!s.configured) return s.is_admin ? 'setup' : 'needs-admin'
    if (!s.module_enabled) return s.is_admin ? 'enable' : 'needs-admin'
    return 'chat'
  })()

  // ── 위저드 ──
  const [wiz, setWizState] = useState<Wiz>({
    kind: 'local', base_url: '', api_key: '', model: '', max_tokens: 0,
    models: [], localDetected: false, probing: false, saving: false, showAdvanced: false,
    localKind: '', localBase: '',
  })
  const wizRef = useRef(wiz)
  const patchWiz = (p: Partial<Wiz>) => { wizRef.current = { ...wizRef.current, ...p }; setWizState(wizRef.current) }

  /** wiz.kind='local' 은 UI 전용 가상값 → 실제 요청에 쓸 (kind, base_url) 로 변환 */
  function effectiveProvider() {
    const w = wizRef.current
    if (w.kind === 'local') return { kind: w.localKind || 'compatible', base_url: w.localBase }
    return { kind: w.kind, base_url: w.base_url }
  }
  const curProvider = PROVIDERS.find(p => p.kind === wiz.kind)!

  async function probeModels() {
    patchWiz({ probing: true })
    try {
      const r = await $fetch<{ models: string[] }>('/api/ai/probe-models', {
        method: 'POST', credentials: 'include',
        body: { ...effectiveProvider(), api_key: wizRef.current.api_key },
      })
      const models = r.models || []
      patchWiz({ models })
      if (models.length && !models.includes(wizRef.current.model)) patchWiz({ model: models[0] })
      if (!models.length) addToast('info', tRef.current('ai.setup.noModels'))
    } catch (e: any) {
      addToast('error', tRef.current('ai.setup.probeFailed', { msg: errMsg(e) }))
    } finally { patchWiz({ probing: false }) }
  }

  async function initWizard() {
    patchWiz({ probing: true, localDetected: false })
    try {
      for (const cand of LOCAL_CANDIDATES) {
        try {
          const r = await $fetch<{ models: string[] }>('/api/ai/probe-models', {
            method: 'POST', credentials: 'include', body: cand,
          })
          if (r.models?.length) {
            patchWiz({
              localDetected: true, localKind: cand.kind, localBase: cand.base_url,
              kind: 'local', models: r.models, model: r.models[0],
            })
            break
          }
        } catch { /* 다음 후보 */ }
      }
      if (!wizRef.current.localDetected) patchWiz({ kind: 'openai' })
    } finally { patchWiz({ probing: false }) }
  }
  useEffect(() => { if (view === 'setup') void initWizard() }, [view]) // eslint-disable-line react-hooks/exhaustive-deps
  // watch(() => wiz.kind) — 첫 실행 없음
  const kindSeen = useRef(false)
  useEffect(() => {
    if (!kindSeen.current) { kindSeen.current = true; return }
    // 로컬은 initWizard 가 이미 탐지해 둔 결과가 있다. 그대로 비우면 다른
    // 제공자를 눌렀다 돌아왔을 때 사용자가 다시 '모델 불러오기' 를 눌러야 한다.
    if (wiz.kind === 'local' && wizRef.current.localDetected) { void probeModels(); return }
    patchWiz({ models: [], model: '' })
  }, [wiz.kind]) // eslint-disable-line react-hooks/exhaustive-deps

  const canSave = !!wiz.model.trim() && (!curProvider.needsKey || !!wiz.api_key.trim())

  async function saveConfig() {
    const w = wizRef.current
    const cp = PROVIDERS.find(p => p.kind === w.kind)!
    const ok = !!w.model.trim() && (!cp.needsKey || !!w.api_key.trim())
    if (!ok) { addToast('warning', cp.needsKey ? t('ai.setup.needModelKey') : t('ai.setup.needModel')); return }
    patchWiz({ saving: true })
    try {
      await $fetch('/api/ai/config', {
        method: 'PUT', credentials: 'include',
        body: { ...effectiveProvider(), model: w.model.trim(), api_key: w.api_key, max_tokens: w.max_tokens },
      })
      addToast('success', t('ai.setup.saved'))
      await loadStatus()
      if (statusRef.current?.module_enabled) await loadConversations()
    } catch (e: any) {
      addToast('error', t('ai.errors.save', { msg: errMsg(e) }))
    } finally { patchWiz({ saving: false }) }
  }

  function enableModule() {
    // 모듈 활성화는 '모듈 관리'로 일원화 — 여기선 이동만
    void navigateTo('/admin/modules')
  }

  // 사후 설정은 관리(/admin/ai)·개인 설정(/settings/ai)으로 일원화 — 사이드바 아래 링크

  // ─────────────────────────── 채팅 ───────────────────────────
  const isMobile = useIsMobile()
  const isMobileRef = useRef(isMobile)
  isMobileRef.current = isMobile
  const [conversations, setConversations, convsRef] = useLive<AiConv[]>([])
  // 임시 대화·프로젝트·첨부
  const [tempConvs, setTempConvs, tempConvsRef] = useLive<AiConv[]>([])
  const [projects, setProjects] = useState<AiProject[]>([])
  const [project, setProject, projectRef] = useLive<AiProject | null>(null)
  const [tempMode, setTempMode, tempModeRef] = useLive(false)
  const [attachments, setAttachments, attachmentsRef] = useLive<AiAttachment[]>([])
  const [projectModal, setProjectModal] = useState<null | 'create' | 'edit' | 'share' | 'files'>(null)
  // 공유가 끊긴 프로젝트(구성원 쪽, 그 프로젝트 id)
  const [projectGone, setProjectGone] = useState<string | null>(null)
  // 이번 답에서 길이 때문에 뺀 앞부분(대화 id 별)
  const [trimmed, setTrimmed] = useState<{ convId: string; dropped: number; window: number } | null>(null)
  const [activeId, setActiveId, activeIdRef] = useLive<string | null>(null)
  const [messages, setMessages, messagesRef] = useLive<Msg[]>([])
  const [input, setInput] = useState('')
  const inputRef = useRef(input)
  inputRef.current = input
  const [sending, setSending] = useLive(false)
  const msgBox = useRef<HTMLDivElement | null>(null)
  const composer = useRef<AiComposerHandle | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [showSystemPrompt, setShowSystemPrompt] = useState(false)
  const activeConv = conversations.find(c => c.id === activeId) || tempConvs.find(c => c.id === activeId) || null
  const isTemp = !!activeConv?.temporary || (tempMode && !activeId)
  const systemPrompt = activeConv?.system_prompt || ''
  function setSystemPrompt(v: string) {
    const id = activeIdRef.current
    if (!id) return
    setConversations(list => list.map(c => (c.id === id ? { ...c, system_prompt: v } : c)))
    setTempConvs(list => list.map(c => (c.id === id ? { ...c, system_prompt: v } : c)))
  }

  // 상단바 3단 경로: 워크스페이스 / AI / 대화 제목
  useBreadcrumb(view === 'chat' ? (activeId ? (activeConv?.title || t('ai.untitled')) : isTemp ? t('ai.temp.crumb') : (project?.name || '')) : '')
  // 모바일 대화 목록은 자체 머리 — 대화 화면은 LayoutMobileDetailBar 가 스스로 선언한다
  useOwnMobileHeader(view === 'chat' && isMobile && !activeId && !project)

  const [collapsed, setCollapsedState] = useState(false)
  useEffect(() => { try { setCollapsedState(localStorage.getItem(SIDEBAR_KEY) === '1') } catch { /* 저장소 막힘 */ } }, [])
  function setCollapsed(v: boolean) {
    setCollapsedState(v)
    try { localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0') } catch { /* 저장소 막힘 */ }
  }

  // nextTick 대응 — 다음 커밋 뒤 포커스·스크롤
  const pendingFocus = useRef(false)
  const pendingScroll = useRef(false)
  const [, setTick] = useState(0)
  function focusComposerSoon() { pendingFocus.current = true; setTick(x => x + 1) }

  // 주소의 ?c=<id>(결과물 토스트 [대화로 가기])는 들어왔을 때 한 번만 따른다 — 목록을 다시 읽을 때마다
  // 따르면 다른 대화에서 답변이 끝날 때마다 그 대화로 끌려갔다.
  const urlOpenTaken = useRef(false)
  /** auto=false: 목록만 새로 읽는다(답변이 끝난 뒤 제목·순서 갱신) — 보고 있던 화면을 바꾸지 않는다 */
  async function loadConversations(auto = true) {
    try {
      const r = await $fetch<{ conversations: AiConv[]; temporary?: AiConv[] }>('/api/ai/conversations', { credentials: 'include' })
      setConversations(r.conversations || [])
      setTempConvs(r.temporary || [])
      void loadProjects()
      // 모바일에선 첫 대화를 자동 선택하지 않는다 — 목록 상태(하단 탭바 노출)로 진입해
      // 다른 모듈로 이동할 수 있어야 한다. 데스크톱은 편의상 자동 선택.
      // 토스트 [대화로 가기] — 저장소 대기값(스트림 완료) 또는 /ai?c=<id>(결과물 완료)
      const fromUrl = !urlOpenTaken.current && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('c') : null
      urlOpenTaken.current = true
      const want = takeAiPendingOpen() || fromUrl
      if (want && convsRef.current.some(c => c.id === want)) void selectConv(want)
      // 새 대화 화면에서 입력하는 중에 다른 대화의 답변이 끝나도 첫 대화로 끌려가지 않게 — 자동 선택은 처음 들어올 때만
      else if (auto && !activeIdRef.current && !projectRef.current && !tempModeRef.current && convsRef.current.length && !isMobileRef.current) {
        void selectConv(convsRef.current[0].id)
      }
    } catch (e: any) { addToast('error', tRef.current('ai.errors.list', { msg: errMsg(e) })) }
  }

  async function loadProjects() {
    try {
      const r = await $fetch<{ projects: AiProject[] }>('/api/ai/projects', { credentials: 'include' })
      setProjects(r?.projects || [])
    } catch { /* 프로젝트 없이도 대화는 된다 */ }
  }

  /** 임시 대화를 떠나면 지운다(시안 "창 닫으면 삭제") */
  function leaveTemp(nextId: string | null) {
    const cur = activeIdRef.current
    const c = tempConvsRef.current.find(x => x.id === cur)
    if (!c || c.id === nextId) return
    setTempConvs(list => list.filter(x => x.id !== c.id))
    void $fetch(`/api/ai/conversations/${c.id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
  }

  async function selectConv(id: string) {
    leaveTemp(id)
    const conv = convsRef.current.find(c => c.id === id) || tempConvsRef.current.find(c => c.id === id)
    setTempMode(!!conv?.temporary)
    const pid = conv?.project_id || null
    if (pid !== (projectRef.current?.id ?? null)) setProject(pid ? (projects.find(p => p.id === pid) || null) : null)
    if (pid) void refreshProject(pid)
    // 새 대화의 메시지가 오기 전까지 이전 대화 메시지가 남아 있으면, 그 사이 누른 [다시 만들기]·[이어서 받기]가
    // 새 대화(activeId)에 걸린다 — 먼저 비운다
    if (activeIdRef.current !== id) setMessages([])
    setActiveId(id)
    setShowSystemPrompt(false)
    setPickerOpen(false)
    try {
      const r = await $fetch<{ messages: AiMsg[] }>(`/api/ai/conversations/${id}/messages`, { credentials: 'include' })
      if (activeIdRef.current !== id) return
      setMessages(aiMergeRuns(resumeStreaming(id, r.messages || []), aiStreamStore.getState().runs))
      scrollDown(true)
      // 이 대화에서 나온 승인 카드 복원(실패해도 대화는 그대로 보인다)
      approvalsApi.byConversation(id).then((res) => {
        if (activeIdRef.current !== id || !res?.items?.length) return
        setMessages(list => attachWritesToMessages(list, res.items))
      }).catch(() => {})
    } catch (e: any) { addToast('error', tRef.current('ai.errors.load', { msg: errMsg(e) })) }
  }

  // 완료 토스트 [대화로 가기](AI 화면에 있을 때)
  useEffect(() => {
    const on = (e: Event) => { const id = (e as CustomEvent<string>).detail; if (id) void selectConv(id) }
    window.addEventListener(AI_OPEN_CONVERSATION_EVENT, on)
    return () => window.removeEventListener(AI_OPEN_CONVERSATION_EVENT, on)
  })

  /** 모바일 ‹ — 목록으로 */
  function closeConv() {
    leaveTemp(null)
    setTempMode(false)
    if (!activeIdRef.current) setProject(null)  // 프로젝트 화면에서 ‹ = 목록으로
    setProjectGone(null)
    setActiveId(null)
    setMessages([])
    setPickerOpen(false)
  }

  /** 새 대화 화면(서버 대화는 첫 질문을 보낼 때 만든다 — 빈 대화가 쌓이지 않게) */
  function startNewChat(opts: { temporary?: boolean; keepProject?: boolean } = {}) {
    leaveTemp(null)
    setTempMode(!!opts.temporary)
    if (!opts.keepProject || opts.temporary) setProject(null)
    setActiveId(null)
    setMessages([])
    focusComposerSoon()
  }

  async function newConversation() {
    try {
      const temporary = tempModeRef.current
      const projectId = temporary ? null : (projectRef.current?.id ?? null)
      const c = await $fetch<AiConv>('/api/ai/conversations', {
        method: 'POST', credentials: 'include',
        body: { title: tRef.current('ai.untitled'), temporary, project_id: projectId },
      })
      if (c.temporary) setTempConvs(list => [c, ...list])
      else setConversations(list => [c, ...list])
      if (projectId) setProjects(list => list.map(p => (p.id === projectId ? { ...p, conversation_count: p.conversation_count + 1 } : p)))
      setActiveId(c.id)
      setMessages([])
      focusComposerSoon()
    } catch (e: any) { addToast('error', tRef.current('ai.errors.create', { msg: errMsg(e) })) }
  }

  async function deleteConversation(c: AiConv) {
    const ok = await confirmBox(t('ai.remove.message', { title: c.title || t('ai.untitled') }), {
      title: t('ai.remove.title'), confirmLabel: t('ai.remove.confirm'), danger: true,
    })
    if (!ok) return
    try {
      await $fetch(`/api/ai/conversations/${c.id}`, { method: 'DELETE', credentials: 'include' })
      setConversations(list => list.filter(x => x.id !== c.id))
      setTempConvs(list => list.filter(x => x.id !== c.id))
      if (activeIdRef.current === c.id) {
        setActiveId(null); setMessages([])
        if (convsRef.current.length && !isMobileRef.current) void selectConv(convsRef.current[0].id)
      }
    } catch (e: any) { addToast('error', t('ai.errors.delete', { msg: errMsg(e) })) }
  }

  async function renameConversation(c: AiConv) {
    const v = await promptBox(t('ai.rename.message'), {
      title: t('ai.rename.title'), confirmLabel: t('ai.rename.confirm'), defaultValue: c.title,
    })
    const title = (v ?? '').trim()
    if (!title || title === c.title) return
    try {
      await $fetch(`/api/ai/conversations/${c.id}`, { method: 'PATCH', credentials: 'include', body: { title } })
      setConversations(list => list.map(x => (x.id === c.id ? { ...x, title } : x)))
      setTempConvs(list => list.map(x => (x.id === c.id ? { ...x, title } : x)))
    } catch (e: any) { addToast('error', t('ai.errors.rename', { msg: errMsg(e) })) }
  }

  async function setTools(next: boolean) {
    const c = convsRef.current.find(x => x.id === activeIdRef.current) || tempConvsRef.current.find(x => x.id === activeIdRef.current)
    if (!c || c.tools_enabled === next) return
    try {
      await $fetch(`/api/ai/conversations/${c.id}`, { method: 'PATCH', credentials: 'include', body: { tools_enabled: next } })
      setConversations(list => list.map(x => (x.id === c.id ? { ...x, tools_enabled: next } : x)))
      setTempConvs(list => list.map(x => (x.id === c.id ? { ...x, tools_enabled: next } : x)))
      if (next && statusRef.current?.needs_consent) addToast('info', t('ai.toast.consentNeeded'))
    } catch (e: any) { addToast('error', t('ai.errors.setting', { msg: errMsg(e) })) }
  }

  async function saveSystemPrompt() {
    const c = convsRef.current.find(x => x.id === activeIdRef.current) || tempConvsRef.current.find(x => x.id === activeIdRef.current)
    if (!c) return
    try {
      await $fetch(`/api/ai/conversations/${c.id}`, { method: 'PATCH', credentials: 'include', body: { system_prompt: c.system_prompt || '' } })
      addToast('success', t('ai.toast.promptSaved'))
      setShowSystemPrompt(false)
    } catch (e: any) { addToast('error', t('ai.errors.save', { msg: errMsg(e) })) }
  }

  async function giveConsent() {
    try {
      await $fetch('/api/ai/consent', { method: 'PUT', credentials: 'include', body: { consent: true } })
      if (statusRef.current) setStatus({ ...statusRef.current, needs_consent: false })
      addToast('success', t('ai.toast.consentSaved'))
    } catch (e: any) { addToast('error', t('ai.errors.consent', { msg: errMsg(e) })) }
  }

  async function copyMsg(text: string) {
    try {
      await writeClipboard(text)
      addToast('success', t('ai.toast.copied'))
    } catch {
      // http 같은 비보안 컨텍스트에서는 clipboard API 가 막힌다. 조용히 넘기면
      // 눌렀는데 아무 일도 안 일어난 것처럼 보인다.
      addToast('error', t('ai.toast.copyFailed'))
    }
  }

  /** 대화 내보내기(마크다운 파일) — 브라우저에서 만든다 */
  function exportConversation() {
    const c = activeConv; if (!c) return
    const md = aiExportMarkdown(c.title || t('ai.untitled'), messagesRef.current, { user: t('ai.you'), assistant: t('ai.assistant') })
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url; a.download = aiExportFileName(c.title || t('ai.untitled'))
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const convMenu: UiMenuItem[] = [
    { key: 'export', label: t('ai.menu.export'), icon: 'download', disabled: !messages.length },
    { key: 'share', label: t('ai.menu.share'), icon: 'share', disabled: true, badge: t('ai.menu.soon') },
    { key: 'rename', label: t('ai.menu.rename'), icon: 'edit' },
    { key: 'delete', label: t('ai.menu.delete'), icon: 'trash', danger: true, separated: true },
  ]
  function onConvMenu(key: string) {
    const c = activeConv; if (!c) return
    if (key === 'export') exportConversation()
    else if (key === 'rename') void renameConversation(c)
    else if (key === 'delete') void deleteConversation(c)
  }

  // ── 모델 피커(데스크톱 팝오버 · 모바일 바닥 시트) ──
  const [pickerOpen, setPickerOpen, pickerOpenRef] = useLive(false)
  const pickerEl = useRef<HTMLDivElement | null>(null)
  const pickerTriggers = useRef<HTMLDivElement | null>(null)
  const toolCount = activeConv?.tools_enabled ? labelledGroups(status?.tools ?? []).length : 0
  useEffect(() => {
    function onDocPointer(e: PointerEvent) {
      if (!pickerOpenRef.current || isMobileRef.current) return
      const tgt = e.target as Node
      if (pickerEl.current?.contains(tgt) || pickerTriggers.current?.contains(tgt)) return
      setPickerOpen(false)
    }
    function onDocKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && pickerOpenRef.current && !isMobileRef.current) { e.preventDefault(); setPickerOpen(false) }
    }
    document.addEventListener('pointerdown', onDocPointer)
    document.addEventListener('keydown', onDocKey)
    return () => { document.removeEventListener('pointerdown', onDocPointer); document.removeEventListener('keydown', onDocKey) }
  }, [pickerOpenRef, setPickerOpen])

  // ── 스크롤 ──
  const [atBottom, setAtBottom, atBottomRef] = useLive(true)
  function onScroll() {
    const el = msgBox.current; if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }
  function scrollDown(force = false) {
    if (!force && !atBottomRef.current) return
    pendingScroll.current = true
    setTick(x => x + 1)
  }
  // nextTick 뒤 일(스크롤·포커스) — 매 커밋 뒤 확인
  useLayoutEffect(() => {
    if (pendingScroll.current) {
      pendingScroll.current = false
      if (msgBox.current) { msgBox.current.scrollTop = msgBox.current.scrollHeight; setAtBottom(true) }
    }
    if (pendingFocus.current) {
      pendingFocus.current = false
      composer.current?.focus()
    }
  })

  /** [멈춤] — 이 대화에서 받는 중인 답변만(서버 작업도 멈춘다). 페이지를 떠나는 것으로는 멈추지 않는다 */
  function stop() {
    const run = aiActiveRunFor(activeIdRef.current)
    if (run) stopAiRun(run.key)
  }

  // 답변 스트림은 전역 저장소(useAiStreams)가 든다 — 다른 화면으로 가도 계속 받고, 돌아오면 이어 보인다.
  // 여기서는 저장소의 최신 답변을 화면 목록에 덮기만 한다.
  const runs = useAiRuns()
  const convBusy = Object.values(runs).some(r => r.active && r.convId === activeId)
  const busy = sending || convBusy
  const busyRef = useRef(busy)
  busyRef.current = busy
  useEffect(() => aiStreamStore.subscribe((st, prev) => {
    if (st.runs === prev.runs) return
    setMessages(list => aiMergeRuns(list, st.runs))
    scrollDown()
  }), []) // eslint-disable-line react-hooks/exhaustive-deps
  // 받는 중인 답변이 context_trimmed 를 받으면(저장소가 msg.trimmed 로 남김) 대화 맨 위 안내
  useEffect(() => {
    const last = [...messages].reverse().find(m => m.role === 'assistant' && (m as any).trimmed)
    const tr = last ? (last as any).trimmed as { dropped: number; window: number } : null
    if (tr && activeIdRef.current) setTrimmed({ convId: activeIdRef.current, dropped: tr.dropped, window: tr.window })
  }, [messages])
  // 보고 있는 대화(완료 토스트는 다른 곳에 있을 때만) · [대화로 가기]
  useEffect(() => { setAiView(true, activeId) }, [activeId])
  useEffect(() => () => setAiView(false, null), [])
  useEffect(() => aiStreamStore.subscribe((st, prev) => {
    if (st.pendingOpen && st.pendingOpen !== prev.pendingOpen && convsRef.current.length) {
      const id = takeAiPendingOpen()
      if (id) void selectConv(id)
    }
  }), []) // eslint-disable-line react-hooks/exhaustive-deps

  /** 저장된 목록에서 생성 중인 답변 → 이어 받기(이미 받고 있으면 그 내용) */
  function resumeStreaming(convId: string, list: AiMsg[]): Msg[] {
    return list.map(m => (m.role === 'assistant' && m.id && (m as any).status === 'streaming' ? resumeAiRun(convId, m) : m))
  }

  // SSE 스트림 — send/regenerate/continue/edit 공용. 응답 상태 코드를 돌려준다(이어 받기 409 처리용)
  async function streamRequest(url: string, body: any | null, asst: Msg, userUid?: number): Promise<number> {
    const convId = activeIdRef.current || ''
    const p = startAiRun({
      convId, url, body, msg: asst,
      // 방금 보낸 질문에 서버 id 를 단다(수정·버전 단추)
      onParentId: pid => setMessages(list => list.map(m => (m._uid === userUid && !m.id ? { ...m, id: pid } : m))),
    })
    // 저장소에 올라간 순간부터 "받는 중"은 저장소가 안다 — 다른 대화로 옮겨도 막히지 않게 바로 푼다
    setSending(false)
    try {
      const code = await p
      if (mounted.current) void loadConversations(false)
      return code
    } finally {
      if (mounted.current) { scrollDown(); focusComposerSoon() }
    }
  }

  function newAssistant(): Msg {
    const now = new Date().toISOString()
    return {
      role: 'assistant', content: '', streaming: true, tools: [], steps: [], citations: [],
      model: statusRef.current?.model || undefined, ai_generated: true, created_at: now, started_at: now,
      _uid: ++uidSeq,
    }
  }

  async function send(preset?: string) {
    // onClick={send} 처럼 쓰면 이벤트가 첫 인자로 온다 — 문자열일 때만 프리셋으로 본다(Vue 와 같은 방어).
    const raw = typeof preset === 'string' ? preset : inputRef.current
    const text = (raw ?? '').trim()
    const atts = typeof preset === 'string' ? [] : attachmentsRef.current
    if (atts.some(a => a.status === 'uploading' || a.status === 'converting')) { addToast('info', tRef.current('ai.attach.waiting')); return }
    const ready = atts.filter(a => a.status === 'ready' && a.id)
    if ((!text && !ready.length) || busyRef.current) return
    if (ready.some(a => a.kind === 'image') && statusRef.current?.vision === false) { addToast('warning', tRef.current('ai.attach.noVision')); return }
    if (!activeIdRef.current) { await newConversation(); if (!activeIdRef.current) return }
    const convId = activeIdRef.current
    setInput('')
    if (typeof preset !== 'string') { revokePreviews(attachmentsRef.current); setAttachments([]) }
    await postQuestion(convId, text, ready)
  }

  /** 질문 한 개를 화면에 올리고 /chat 으로 보낸다(보내기 · 저장 전에 실패한 질문 다시 보내기 공용) */
  async function postQuestion(convId: string, text: string, ready: AiAttachment[]) {
    setSending(true)
    const asst = newAssistant()
    const userUid = ++uidSeq
    setMessages(list => [...list, { role: 'user', content: text, created_at: new Date().toISOString(), attachments: ready, _uid: userUid }, { ...asst, tools: [] }])
    scrollDown(true)
    await streamRequest(`/api/ai/conversations/${convId}/chat`, ready.length ? { content: text, attachment_ids: ready.map(a => a.id) } : { content: text }, asst, userUid)
  }

  /** 첨부 받기 — 한도 넘으면 바로 실패 칩, 아니면 올리는 중 → 변환 중 → 완료/실패 */
  function addFiles(files: File[]) {
    const max = statusRef.current?.attachment_max_bytes || AI_ATTACH_MAX
    const room = 10 - attachmentsRef.current.length
    if (files.length > room) addToast('warning', tRef.current('ai.attach.tooMany', { n: '10' }))
    for (const f of files.slice(0, Math.max(0, room))) {
      const key = `k${++uidSeq}`
      if (f.size > max) {
        setAttachments(l => [...l, { key, id: null, name: f.name, size: f.size, status: 'failed', error_code: 'too_large' }])
        continue
      }
      const isImage = f.type.startsWith('image/')
      let preview: string | undefined
      try { preview = isImage && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(f) : undefined } catch { preview = undefined }
      setAttachments(l => [...l, { key, id: null, name: f.name, size: f.size, status: 'uploading', kind: isImage ? 'image' : 'document', preview }])
      const patch = (p: Partial<AiAttachment>) => setAttachments(l => l.map(a => (a.key === key ? { ...a, ...p } : a)))
      void aiUploadAttachment(f, activeIdRef.current, st => patch({ status: st })).then(res => patch({ ...res, key }))
    }
  }

  function revokePreviews(list: AiAttachment[]) {
    for (const a of list) if (a.preview) { try { URL.revokeObjectURL(a.preview) } catch { /* 없음 */ } }
  }

  function removeAttachment(a: AiAttachment) {
    setAttachments(l => l.filter(x => x !== a && (!a.key || x.key !== a.key)))
    revokePreviews([a])
    if (a.id && a.status === 'ready') void $fetch(`/api/ai/attachments/${a.id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
  }

  // ── 입력창 밖에 놓은 파일 ──
  function dragHasFiles(e: DragEvent) {
    return Array.from(e.dataTransfer?.types || []).includes('Files')
  }
  /** 파일 끌기는 화면 어디서든 브라우저 기본 동작(그 파일 열기)을 막는다 */
  function onStrayDrag(e: DragEvent) {
    if (dragHasFiles(e)) e.preventDefault()
  }
  /** 대화 영역(메시지 쪽)에 놓아도 첨부로 받는다 — 입력창이 이미 받았거나(defaultPrevented) 창(포털) 안이면 그대로 둔다 */
  function onChatDrop(e: DragEvent) {
    if (!dragHasFiles(e) || e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return
    e.preventDefault()
    const files = Array.from(e.dataTransfer?.files || [])
    if (files.length) addFiles(files)
  }

  /** K1 [이미지 빼기] — 첨부한 이미지 모두 */
  function removeImages() {
    for (const a of attachmentsRef.current.filter(x => x.kind === 'image')) removeAttachment(a)
  }

  /** K1 [이미지 읽는 모델로 바꾸기] — 설정 › AI 기본 모델을 vision 지원 선택지로 */
  async function switchToVisionModel() {
    const c = visionChoice
    if (!c) return
    try {
      await $fetch('/api/ai/my-settings', { method: 'PUT', credentials: 'include', body: { default_model: c.key } })
      await refreshStatus()
      await loadModelChoices()
      addToast('success', tRef.current('ai.attach.switched', { model: c.model }))
    } catch (e: any) { addToast('error', tRef.current('ai.errors.setting', { msg: errMsg(e) })) }
  }

  /** 서버 기록으로 다시 맞춘다 — 화면에만 있는 승인 카드·메모리 알림은 답변 id 로 옮겨 붙인다 */
  async function syncMessages(convId: string) {
    try {
      const r = await $fetch<{ messages: AiMsg[] }>(`/api/ai/conversations/${convId}/messages`, { credentials: 'include' })
      if (activeIdRef.current !== convId) return
      const prev = new Map(messagesRef.current.filter(m => m.id).map(m => [m.id as string, m]))
      setMessages((r.messages || []).map((m) => {
        const old = prev.get(m.id || '')
        return old ? { ...m, writes: old.writes, memories: old.memories } : m
      }))
    } catch { /* 화면 그대로 */ }
  }

  /** 질문 수정 → 새 버전. 그 뒤 메시지는 옛 가지로 숨고 새 답을 받는다 */
  async function editQuestion(msg: Msg, text: string, keepIds?: string[]) {
    const convId = activeIdRef.current
    if (!convId || !msg.id || busyRef.current) return
    const list = messagesRef.current
    const idx = list.findIndex(m => m.id === msg.id)
    if (idx < 0) return
    // 새 파일은 입력창의 파일 첨부로 올린 것
    const staged = attachmentsRef.current
    if (staged.some(a => a.status === 'uploading' || a.status === 'converting')) { addToast('info', tRef.current('ai.attach.waiting')); return }
    const fresh = staged.filter(a => a.status === 'ready' && a.id)
    if (fresh.some(a => a.kind === 'image') && statusRef.current?.vision === false) { addToast('warning', tRef.current('ai.attach.noVision')); return }
    setSending(true)
    if (fresh.length) { revokePreviews(staged); setAttachments([]) }
    const asst = newAssistant()
    const total = (msg.versions?.length || 1) + 1
    const userUid = ++uidSeq
    const kept = keepIds ? (msg.attachments ?? []).filter(a => a.id && keepIds.includes(a.id)) : (msg.attachments ?? [])
    const edited: Msg = { role: 'user', content: text, created_at: new Date().toISOString(), attachments: [...kept, ...fresh],
      versions: [...(msg.versions || [{ id: msg.id }]), { id: '' }], active_version: total, _uid: userUid }
    setMessages([...list.slice(0, idx), edited, { ...asst, tools: [] }])
    scrollDown(true)
    const body: Record<string, unknown> = { content: text }
    if (keepIds) body.keep_attachment_ids = keepIds
    if (fresh.length) body.attachment_ids = fresh.map(a => a.id)
    await streamRequest(`/api/ai/messages/${encodeURIComponent(msg.id)}/edit`, body, asst, userUid)
    await syncMessages(convId)
  }

  /** ◀ ▶ 버전 넘기기 */
  async function switchVersion(msg: Msg, n: number) {
    const convId = activeIdRef.current
    if (!convId || !msg.id || busyRef.current) return
    try {
      const r = await $fetch<{ messages: AiMsg[] }>(`/api/ai/messages/${encodeURIComponent(msg.id)}/versions/${n}`, { method: 'POST', credentials: 'include' })
      if (activeIdRef.current === convId) setMessages(r.messages || [])
    } catch (e: any) { addToast('error', tRef.current('ai.versions.switchFailed', { msg: errMsg(e) })) }
  }

  /** 메모리 저장 취소 = 그 항목 지우기 */
  async function undoMemory(asstUid: number | undefined, m: AiMemorySaved) {
    try {
      await $fetch(`/api/ai/memory/${encodeURIComponent(m.id)}`, { method: 'DELETE', credentials: 'include' })
      setMessages(list => list.map(x => (x._uid === asstUid || x.memories?.some(y => y.id === m.id)
        ? { ...x, memories: x.memories?.map(y => (y.id === m.id ? { ...y, cancelled: true } : y)) }
        : x)))
    } catch (e: any) { addToast('error', tRef.current('ai.memory.error', { msg: errMsg(e) })) }
  }

  // ── 임시 대화 스위치 ──
  function toggleTemporary(v: boolean) {
    if (v === isTempRef.current) return
    startNewChat({ temporary: v })
  }
  const isTempRef = useRef(isTemp)
  isTempRef.current = isTemp

  // 창을 닫거나 다른 화면으로 가면 임시 대화를 지운다(서버도 24시간 뒤 정리)
  useEffect(() => {
    function onHide() {
      const c = tempConvsRef.current.find(x => x.id === activeIdRef.current)
      if (c) void apiRawFetch(`/api/ai/conversations/${c.id}`, { method: 'DELETE', credentials: 'include', keepalive: true }).catch(() => {})
    }
    window.addEventListener('pagehide', onHide)
    return () => { window.removeEventListener('pagehide', onHide); onHide() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 프로젝트 ──
  async function refreshProject(id: string) {
    try {
      const p = await $fetch<AiProject>(`/api/ai/projects/${id}`, { credentials: 'include' })
      if (!projectRef.current || projectRef.current.id === id) setProject(p)
      setProjects(list => list.map(x => (x.id === id ? { ...x, ...p } : x)))
      setProjectGone(g => (g === id ? null : g))
    } catch (e: any) {
      // 공유받은 프로젝트가 더는 안 보임 = 공유가 끊김. 서버는 내 대화를 '최근 대화'로 옮겨 둔다
      const wasMember = (projectRef.current?.id === id && projectRef.current.role === 'member')
      if (wasMember && (e?.status === 404 || e?.statusCode === 404 || e?.response?.status === 404 || /404|찾을 수 없/.test(String(e?.data?.detail || e?.message || '')))) {
        setProjectGone(id)
        setProjects(list => list.filter(x => x.id !== id))
        void loadConversations()
      }
    }
  }

  function openProject(id: string) {
    leaveTemp(null)
    setTempMode(false)
    setActiveId(null)
    setMessages([])
    setProjectGone(null)
    setProject(projects.find(p => p.id === id) || null)
    void refreshProject(id)
    focusComposerSoon()
  }

  async function projectCall<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try { return await fn() } catch (e: any) { addToast('error', tRef.current('ai.project.error', { msg: errMsg(e) })); return undefined }
  }

  async function createProject(v: AiProjectFormValue) {
    let p = await projectCall(() => $fetch<AiProject>('/api/ai/projects', { method: 'POST', credentials: 'include', body: { name: v.name, instructions: v.instructions } }))
    if (!p) return
    if (v.addPaths.length) {
      const id = p.id
      p = (await projectCall(() => $fetch<AiProject>(`/api/ai/projects/${id}/files`, { method: 'POST', credentials: 'include', body: { paths: v.addPaths } }))) || p
    }
    const made = p
    setProjects(list => [made, ...list])
    setProjectModal(null)
    openProject(made.id)
    setProject(made)
  }

  /** J1 편집 창 저장 — 이름·지침, 뺀 파일, 새로 연결한 파일을 차례로 */
  async function saveProjectForm(v: AiProjectFormValue) {
    const cur = projectRef.current; if (!cur) return
    let last: AiProject | undefined
    if (v.name !== cur.name || v.instructions !== cur.instructions) {
      last = await projectCall(() => $fetch<AiProject>(`/api/ai/projects/${cur.id}`, { method: 'PATCH', credentials: 'include', body: { name: v.name, instructions: v.instructions } }))
      if (!last) return
    }
    for (const fid of v.removeIds) {
      const r = await projectCall(() => $fetch<AiProject>(`/api/ai/projects/${cur.id}/files/${fid}`, { method: 'DELETE', credentials: 'include' }))
      if (!r) return
      last = r
    }
    if (v.addPaths.length) {
      const r = await projectCall(() => $fetch<AiProject>(`/api/ai/projects/${cur.id}/files`, { method: 'POST', credentials: 'include', body: { paths: v.addPaths } }))
      if (!r) return
      last = r
    }
    if (last) {
      const p = last
      setProject(p)
      setProjects(list => list.map(x => (x.id === p.id ? { ...x, ...p } : x)))
    }
    setProjectModal(null)
  }

  async function patchProject(body: Record<string, unknown>) {
    const cur = projectRef.current; if (!cur) return
    const p = await projectCall(() => $fetch<AiProject>(`/api/ai/projects/${cur.id}`, { method: 'PATCH', credentials: 'include', body }))
    if (!p) return
    setProject(p)
    setProjects(list => list.map(x => (x.id === p.id ? p : x)))
    setProjectModal(null)
  }

  async function removeProjectFile(f: AiProjectFile) {
    const cur = projectRef.current; if (!cur) return
    const p = await projectCall(() => $fetch<AiProject>(`/api/ai/projects/${cur.id}/files/${f.id}`, { method: 'DELETE', credentials: 'include' }))
    if (p) setProject(p)
  }

  async function onProjectMenu(key: 'rename' | 'share' | 'delete') {
    const cur = projectRef.current; if (!cur) return
    if (key === 'share') { setProjectModal('share'); return }
    if (key === 'rename') {
      const v = await promptBox(t('ai.project.nameLabel'), { title: t('ai.project.rename'), confirmLabel: t('ai.project.save'), defaultValue: cur.name })
      if (v && v.trim() && v.trim() !== cur.name) await patchProject({ name: v.trim() })
      return
    }
    const ok = await confirmBox(t('ai.project.deleteMessage', { name: cur.name }), { title: t('ai.project.deleteTitle'), confirmLabel: t('ai.project.deleteConfirm'), danger: true })
    if (!ok) return
    const done = await projectCall(() => $fetch(`/api/ai/projects/${cur.id}`, { method: 'DELETE', credentials: 'include' }))
    if (done === undefined) return
    setProjects(list => list.filter(x => x.id !== cur.id))
    setConversations(list => list.map(c => (c.project_id === cur.id ? { ...c, project_id: null } : c)))
    setProject(null)
  }

  /** 추천 카드: 끝이 열린 문장(공백으로 끝남)은 입력에 넣고, 아니면 바로 보낸다 */
  function pickSuggestion(prompt: string) {
    if (/\s$/.test(prompt)) { setInput(prompt); focusComposerSoon(); return }
    void send(prompt)
  }

  async function regenerate() {
    if (busyRef.current || !activeIdRef.current) return
    const convId = activeIdRef.current
    // 끝의 assistant 메시지 제거(백엔드도 동일하게 삭제) 후 재생성
    const before = messagesRef.current
    const list = [...before]
    while (list.length && list[list.length - 1].role === 'assistant') list.pop()
    setMessages(list)
    if (!list.some(m => m.role === 'user')) return
    // 마지막 질문에 서버 id 가 없다 = 보내기가 저장 전에 실패했을 수 있다(한도 429·첨부 만료·이미지 못 읽는 모델·네트워크).
    // 그 상태로 /regenerate 를 부르면 서버는 그 질문을 모르니 "이전 질문의 답"을 지우고 다시 만든다 — 이전 답변이 사라지고
    // 이 질문 아래 엉뚱한 답이 붙었다. 서버 기록에 이 질문이 없으면 같은 질문을 다시 보낸다.
    const lastQ = list[list.length - 1]
    if (lastQ.role === 'user' && !lastQ.id) {
      setSending(true)
      let saved: boolean
      try {
        const r = await $fetch<{ messages: AiMsg[] }>(`/api/ai/conversations/${convId}/messages`, { credentials: 'include' })
        const users = (l: { role: string }[]) => l.filter(m => m.role === 'user').length
        saved = users(r.messages || []) >= users(list)
      } catch (e: any) {
        // 기록을 못 읽으면 어느 쪽인지 모른다 — 이전 답변을 지울 수 있는 /regenerate 는 부르지 않는다
        setSending(false)
        if (activeIdRef.current === convId) setMessages(before)
        addToast('error', tRef.current('ai.errors.load', { msg: errMsg(e) }))
        return
      }
      if (activeIdRef.current !== convId) { setSending(false); return }
      if (!saved) {
        const ready = (lastQ.attachments ?? []).filter(a => a.id)
        if (!(lastQ.content || '').trim() && !ready.length) { setSending(false); return }
        setMessages(list.slice(0, -1))
        await postQuestion(convId, lastQ.content || '', ready)
        return
      }
    }
    setSending(true)
    const asst = newAssistant()
    setMessages([...list, { ...asst, tools: [] }])
    scrollDown(true)
    await streamRequest(`/api/ai/conversations/${convId}/regenerate`, null, asst)
  }

  /** 끊기거나 멈춘 마지막 답변 이어서 받기 — 같은 메시지 뒤에 붙는다 */
  async function continueAnswer() {
    const convId = activeIdRef.current
    if (busyRef.current || !convId) return
    const list = messagesRef.current
    const idx = list.length - 1
    const prev = list[idx]
    if (!prev || prev.role !== 'assistant') return
    setSending(true)
    const asst: Msg = { ...prev, streaming: true, stopped: false, error: undefined, status: undefined, writes: prev.writes, _uid: ++uidSeq }
    setMessages(l => l.map((m, i) => (i === idx ? asst : m)))
    scrollDown(true)
    const code = await streamRequest(`/api/ai/conversations/${convId}/continue`, null, asst)
    // 이미 끝났거나 이어 받을 게 없음 — 서버 기록으로 다시 맞춘다
    if (code === 409 && activeIdRef.current === convId) {
      try {
        const r = await $fetch<{ messages: AiMsg[] }>(`/api/ai/conversations/${convId}/messages`, { credentials: 'include' })
        // 받는 사이 다른 대화로 옮겼으면 덮지 않는다
        if (activeIdRef.current === convId) setMessages(resumeStreaming(convId, r.messages || []))
      } catch { /* 화면 그대로 */ }
    }
  }

  /** 피드백 저장 결과를 메시지에 반영 */
  function setFeedback(id: string | undefined, fb: AiFeedback | null) {
    if (!id) return
    setMessages(list => list.map(m => (m.id === id ? { ...m, feedback: fb } : m)))
  }

  /** 승인 카드가 바뀐 요청을 알려 옴 — 메시지 안 사본도 맞춘다(다시 그려도 상태 유지) */
  function updateWrite(req: ApprovalRequest) {
    aiPatchRunWrite(req)
    setMessages(list => list.map(m => (m.writes?.some(w => w.id === req.id)
      ? { ...m, writes: m.writes.map(w => (w.id === req.id ? req : w)) }
      : m)))
  }

  /** AI 질문 카드에 답함 — 메시지 안 사본과 받는 중인 run 사본을 같이 맞춘다 */
  function updateQuestion(q: AiQuestion) {
    aiPatchRunQuestion(q)
    setMessages(list => list.map(m => (m.questions?.some(x => x.id === q.id)
      ? { ...m, questions: m.questions.map(x => (x.id === q.id ? q : x)) }
      : m)))
  }

  /** 대화로 고치기·다시 제안 — 문장을 입력 칸에 넣는다(보내기는 사용자가) */
  function composeFromCard(text: string) {
    setInput(text)
    focusComposerSoon()
  }

  function editUser(text: string) {  // 서버 id 가 없는 질문(받는 중) — 입력칸으로
    setInput(text)
    focusComposerSoon()
  }

  const lastAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return i
    return -1
  })()

  const userName = user?.display_name || user?.username || t('ai.you')
  const skippedFiles = (project && activeConv?.project_id === project.id && !isTemp)
    ? (project.files ?? []).filter(f => f.readable === false)
    : []
  const trimInfo = trimmed && trimmed.convId === activeId ? trimmed : null

  // onMounted(loadStatus)
  useEffect(() => { void loadStatus() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // 모델 선택지(이미지 읽는 모델로 바꾸기) — 채팅 화면이 열리면 한 번
  useEffect(() => { if (view === 'chat') void loadModelChoices() }, [view]) // eslint-disable-line react-hooks/exhaustive-deps
  // watch(view, v => v === 'chat' && !conversations.length && loadConversations())
  const viewSeen = useRef(false)
  useEffect(() => {
    if (!viewSeen.current) { viewSeen.current = true; return }
    if (view === 'chat' && !convsRef.current.length) void loadConversations()
  }, [view]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-full overflow-y-auto">
      {view === 'loading' ? (
        // 로딩
        <div className="mx-auto max-w-[680px] px-4 py-10">
          <UiSkeleton preset="text" />
        </div>
      ) : view === 'needs-admin' ? (
        // 관리자 미설정 안내
        <div className="flex h-full">
          <UiEmptyState variant="full" icon="sparkles" title={t('ai.gate.needsAdminTitle')} description={t('ai.gate.needsAdminDesc')} />
        </div>
      ) : view === 'enable' ? (
        // admin: 설정됐으나 모듈 off
        <div className="flex h-full items-center justify-center p-6">
          <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border border-border bg-card p-7 text-center">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-muted text-foreground"><UiIcon name="sparkles" className="h-5 w-5" /></span>
            <p className="text-[15px] font-semibold text-foreground">{t('ai.gate.enableTitle')}</p>
            <p className="text-[13px] leading-relaxed text-muted-foreground">{providerLabel(status?.provider_kind || '')} · <span className="font-mono">{status?.model}</span></p>
            <UiButton onClick={enableModule} className="mt-1">{t('ai.gate.enableAction')}</UiButton>
          </div>
        </div>
      ) : view === 'setup' ? (
        // ───────── 위저드 ─────────
        <div className="max-w-2xl mx-auto px-4 py-6 lg:px-7 lg:py-7">
          <div className="mb-6 flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('ai.setup.title')}</h1>
            <p className="text-[13.5px] text-muted-foreground">{t('ai.setup.subtitle')}</p>
          </div>
          {wiz.probing && !wiz.localDetected && !wiz.models.length && (
            <div className="mb-4 text-sm text-muted-foreground" role="status">{t('ai.setup.detecting')}</div>
          )}
          <div className={cn('rounded-lg border p-5 mb-4 text-sm text-foreground flex items-start gap-2.5', wiz.localDetected ? 'border-success/40 bg-success/[0.06]' : 'border-warning/40 bg-warning/[0.06]')}>
            <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', wiz.localDetected ? 'bg-success' : 'bg-warning')} />
            <span>{wiz.localDetected ? t('ai.setup.detected') : t('ai.setup.notDetected')}</span>
          </div>
          <div className="space-y-2 mb-4">
            {PROVIDERS.map(p => (
              <label
                key={p.kind}
                className={cn('flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors', wiz.kind === p.kind ? 'border-primary bg-primary/[0.13]' : 'border-border hover:bg-accent/40')}
              >
                <input
                  type="radio"
                  value={p.kind}
                  checked={wiz.kind === p.kind}
                  onChange={() => patchWiz({ kind: p.kind })}
                  className="mt-1 accent-primary"
                  disabled={p.kind === 'local' && !wiz.localDetected}
                />
                <div>
                  <div className="font-medium text-sm text-foreground">{p.kind === 'local' ? t('ai.setup.localLabel') : p.label}
                    {p.kind === 'local' && (
                      <>
                        {' '}
                        <span className={cn('text-xs', wiz.localDetected ? 'text-success' : 'text-muted-foreground')}>{wiz.localDetected ? t('ai.setup.found') : t('ai.setup.notFound')}</span>
                      </>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{p.kind === 'local' ? t('ai.setup.localDesc') : p.desc}</div>
                </div>
              </label>
            ))}
          </div>
          <div className="space-y-3 mb-4">
            {curProvider.needsKey && (
              <UiInput modelValue={wiz.api_key} onUpdateModelValue={v => patchWiz({ api_key: v })} type="password" label={t('ai.setup.apiKey')} autocomplete="off" placeholder="sk-…" />
            )}
            {curProvider.needsBase && (
              <UiInput modelValue={wiz.base_url} onUpdateModelValue={v => patchWiz({ base_url: v })} label={t('ai.setup.endpoint')} hint={t('ai.setup.endpointHint')} placeholder={t('ai.setup.endpointPlaceholder')} autocomplete="off" mono />
            )}
            <div className="flex items-end gap-2">
              {!wiz.models.length
                ? <UiInput modelValue={wiz.model} onUpdateModelValue={v => patchWiz({ model: v })} label={t('ai.setup.model')} placeholder={t('ai.setup.modelPlaceholder')} autocomplete="off" mono className="flex-1" />
                : <UiSelect modelValue={wiz.model} onUpdateModelValue={v => patchWiz({ model: String(v ?? '') })} label={t('ai.setup.model')} options={wiz.models.map(m => ({ value: m, label: m }))} className="flex-1" />}
              <UiButton variant="outline" onClick={() => { void probeModels() }} disabled={wiz.probing} className="whitespace-nowrap">
                {wiz.probing ? '…' : t('ai.setup.loadModels')}
              </UiButton>
            </div>
            <button onClick={() => patchWiz({ showAdvanced: !wiz.showAdvanced })} type="button" aria-expanded={wiz.showAdvanced} className="inline-flex min-h-10 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <UiIcon name={wiz.showAdvanced ? 'chevron-down' : 'chevron-right'} className="h-3.5 w-3.5" />{t('ai.setup.advanced')}
            </button>
            {wiz.showAdvanced && (
              <UiInput modelValue={wiz.max_tokens} onUpdateModelValue={v => patchWiz({ max_tokens: Number(v) || 0 })} type="number" label={t('ai.setup.maxTokens')} mono min="0" max="128000" className="w-40" />
            )}
          </div>
          <UiButton onClick={() => { void saveConfig() }} disabled={!canSave || wiz.saving} className="w-full">
            {wiz.saving ? t('ai.setup.saving') : t('ai.setup.submit')}
          </UiButton>
        </div>
      ) : (
        // ───────── 채팅 ─────────
        // 파일을 입력창 밖(대화 목록·빈 곳)에 놓으면 브라우저가 그 파일을 열어 화면을 떠났다 — 기본 동작을 막는다
        <div className="relative flex h-full overflow-hidden" onDragOver={onStrayDrag} onDrop={onStrayDrag}>
          {isMobile && !activeId && !project ? (
            // 모바일 대화 목록
            <AiMobileList
              className="min-w-0 flex-1"
              conversations={conversations}
              projects={projects}
              temporary={tempConvs}
              onOpenProject={openProject}
              onSelect={id => { void selectConv(id) }}
              onCreate={() => { void newConversation() }}
              onRename={c => { void renameConversation(c) }}
              onRemove={c => { void deleteConversation(c) }}
            />
          ) : (
            <>
              {!isMobile && !collapsed && (
                <AiSidebar
                  conversations={conversations}
                  temporary={tempConvs}
                  projects={projects}
                  activeProjectId={project?.id ?? null}
                  onOpenProject={openProject}
                  onCreateProject={() => setProjectModal('create')}
                  activeId={activeId}
                  isAdmin={status?.is_admin}
                  allowUserKeys={status?.allow_user_keys}
                  onSelect={id => { void selectConv(id) }}
                  onCreate={() => startNewChat()}
                  onCollapse={() => setCollapsed(true)}
                  onRename={c => { void renameConversation(c) }}
                  onRemove={c => { void deleteConversation(c) }}
                />
              )}

              <section className="relative flex min-w-0 flex-1 flex-col bg-background" onDrop={onChatDrop}>
                {isMobile ? (
                  // 모바일 대화 머리
                  <LayoutMobileDetailBar
                    title={activeConv?.title || (!activeId && project ? project.name : t('ai.untitled'))}
                    backLabel={t('ai.header.back')}
                    navigate={false}
                    onBack={closeConv}
                    titleSlot={(
                      <>
                        <h1 className="truncate text-base font-semibold text-foreground">{activeConv?.title || (!activeId && project ? project.name : t('ai.untitled'))}</h1>
                        <button type="button" className="flex max-w-full items-center gap-1 truncate text-xs text-muted-foreground" aria-haspopup="dialog" aria-label={t('ai.picker.label')} onClick={() => setPickerOpen(true)}>
                          <span className="truncate">{status?.model}</span><UiIcon name="chevron-down" className="h-3 w-3 shrink-0" /><span aria-hidden="true">·</span><span className="shrink-0">{t('ai.header.tools')} {toolCount}</span>
                        </button>
                      </>
                    )}
                    actions={(
                      <UiMenu items={convMenu} label={t('ai.header.mobileMenu')} title={activeConv?.title || t('ai.untitled')} triggerSize="lg" className="text-muted-foreground" onSelect={onConvMenu} />
                    )}
                  />
                ) : (
                  // 데스크톱 대화 머리
                  <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card pl-4 pr-2.5 text-[13px]">
                    {collapsed && (
                      <UiIconButton label={t('ai.sidebar.expand')} icon="panel-left" size="sm" className="-ml-2 text-muted-foreground" onClick={() => setCollapsed(false)} />
                    )}
                    <b className="min-w-0 truncate font-semibold text-foreground">{activeConv?.title || t('ai.untitled')}</b>
                    <span className="flex-1" />
                    <div ref={pickerTriggers} className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-haspopup="listbox"
                        aria-expanded={pickerOpen}
                        className="inline-flex h-8 max-w-[240px] items-center gap-1.5 rounded-[10px] border border-border px-2.5 text-xs font-semibold text-foreground hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setPickerOpen(!pickerOpenRef.current)}
                      >
                        <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', status?.external ? 'bg-warning' : 'bg-success')} />
                        <span className="truncate">{status?.model}</span>
                        <UiIcon name="chevron-down" className="h-3 w-3 shrink-0" />
                      </button>
                      <button
                        type="button"
                        disabled={!activeConv}
                        className="inline-flex h-8 items-center gap-1 rounded-[10px] border border-border px-2.5 text-xs text-foreground hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        onClick={() => setPickerOpen(!pickerOpenRef.current)}
                      >{t('ai.header.tools')} <span className="font-mono">{toolCount}</span></button>
                    </div>
                    <button
                      type="button"
                      disabled={!activeConv}
                      aria-pressed={showSystemPrompt}
                      className={cn('inline-flex h-8 items-center rounded-[10px] border border-border px-2.5 text-xs text-foreground hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50', showSystemPrompt ? 'bg-accent/40' : '')}
                      onClick={() => setShowSystemPrompt(v => !v)}
                    >{t('ai.header.instructions')}</button>
                    {activeConv && (
                      <UiMenu items={convMenu} label={t('ai.header.menu')} triggerSize="sm" className="text-muted-foreground" onSelect={onConvMenu} />
                    )}

                    {/* 모델 피커 팝오버: top 44 · right 120 · 320 · r12 · card · shadow-lg */}
                    {pickerOpen && status && (
                      <div
                        ref={pickerEl}
                        className="absolute right-[120px] top-11 z-30 w-80 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
                      >
                        <AiModelPicker status={status} toolsEnabled={!!activeConv?.tools_enabled} onToggleTools={v => { void setTools(v) }} onClose={() => setPickerOpen(false)} />
                      </div>
                    )}
                  </div>
                )}

                {/* 동의 배너 */}
                {status?.needs_consent && activeConv?.tools_enabled && (
                  <div className="px-4 py-2.5 bg-warning/[0.08] border-b border-warning/35 text-sm text-foreground flex items-center justify-between gap-2" role="status">
                    <span>{t('ai.consent.banner')}</span>
                    <UiButton size="sm" className="shrink-0" onClick={() => { void giveConsent() }}>{t('ai.consent.agree')}</UiButton>
                  </div>
                )}

                {/* 임시 대화 배너 */}
                {isTemp && (
                  <div role="status" className="flex items-center gap-2.5 border-b border-border bg-secondary px-4 py-2.5 text-[13px] text-foreground md:px-6">
                    <UiIcon name="eye-off" className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1">{t('ai.temp.banner')}</span>
                  </div>
                )}

                {/* 지침(시스템 프롬프트) */}
                {showSystemPrompt && activeConv && (
                  <div className="border-b border-border bg-card px-4 py-3">
                    <UiTextarea modelValue={systemPrompt} onUpdateModelValue={setSystemPrompt} label={t('ai.prompt.label')} placeholder={t('ai.prompt.placeholder')} rows={2} />
                    <div className="mt-2 flex justify-end">
                      <UiButton size="sm" onClick={() => { void saveSystemPrompt() }}>{t('ai.prompt.save')}</UiButton>
                    </div>
                  </div>
                )}

                {/* 메시지 */}
                <div className="relative min-h-0 flex-1">
                  <div ref={msgBox} className="absolute inset-0 overflow-y-auto" onScroll={onScroll}>
                    {!messages.length && project && !isTemp && projectGone === project.id ? (
                      <div className="mx-auto flex max-w-[760px] flex-col gap-5 p-4 md:px-6 md:pt-8">
                        <AiProjectGone />
                      </div>
                    ) : !messages.length && project && !isTemp ? (
                      <div className="mx-auto flex max-w-[760px] flex-col gap-5 p-4 md:px-6 md:pt-8">
                        <AiProjectCard
                          project={project}
                          onEditInstructions={() => setProjectModal('edit')}
                          onAddFiles={() => setProjectModal('files')}
                          onRemoveFile={f => { void removeProjectFile(f) }}
                          onMenu={k => { void onProjectMenu(k) }}
                        />
                        <p className="m-0 pt-4 text-center text-xl font-semibold text-foreground">{t('ai.project.greeting', { name: project.name })}</p>
                        {conversations.some(c => c.project_id === project.id) && (
                          <div className="flex flex-col gap-1">
                            <span className="px-1 text-xs font-semibold text-muted-foreground">{t('ai.project.conversations')}</span>
                            {conversations.filter(c => c.project_id === project.id).map(c => (
                              <button key={c.id} type="button" className="flex h-10 items-center gap-2 rounded-lg px-3 text-left text-[13.5px] text-foreground hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { void selectConv(c.id) }}>
                                <UiIcon name="message-square" className="h-4 w-4 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate">{c.title || t('ai.untitled')}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : !messages.length && isTemp ? (
                      <div className="flex h-full items-center justify-center p-6">
                        <p className="m-0 text-center text-xl font-semibold text-foreground">{t('ai.temp.greeting')}</p>
                      </div>
                    ) : !messages.length ? (
                      <AiEmptyChat status={status} toolsEnabled={!!activeConv?.tools_enabled} onPick={pickSuggestion} />
                    ) : (
                      <div className="mx-auto flex max-w-[680px] flex-col gap-[18px] p-4 md:gap-[22px] md:px-6 md:pb-6 md:pt-6">
                        {trimInfo && (
                          // 대화 맨 위 고정 한 줄. 빠진 메시지는 흐리게(숨기지 않음)
                          <div role="status" className="sticky top-0 z-10 -mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-2 text-[12.5px] text-foreground">
                            <UiIcon name="info" className="h-3.5 w-3.5 shrink-0" />
                            <span className="min-w-0 flex-[1_1_320px]">
                              {t('ai.trimmed.pre')}<span className="font-mono">{trimInfo.dropped}</span>{t('ai.trimmed.post')}
                            </span>
                            <button type="button" className="text-[12.5px] text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { if (msgBox.current) msgBox.current.scrollTop = 0 }}>{t('ai.trimmed.show')}</button>
                            <button type="button" className="text-[12.5px] text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" onClick={() => startNewChat({ keepProject: true })}>{t('ai.trimmed.newChat')}</button>
                          </div>
                        )}
                        {messages.map((m, i) => (
                          <div key={m.id || (m._uid ? `u${m._uid}` : i)} className={cn('flex flex-col gap-2', trimInfo && i < trimInfo.dropped && 'opacity-50')} data-trimmed={trimInfo && i < trimInfo.dropped ? 'true' : undefined}>
                          {i === lastAssistantIdx && !!skippedFiles.length && <AiKnowledgeSkipped files={skippedFiles} />}
                          <AiMessageItem
                            msg={m}
                            vision={status?.vision !== false}
                            userName={userName}
                            userAvatar={user?.avatar_url}
                            last={i === lastAssistantIdx}
                            busy={busy}
                            onCopy={text => { void copyMsg(text) }}
                            onRegenerate={() => { void regenerate() }}
                            onContinue={() => { void continueAnswer() }}
                            onStop={stop}
                            onFeedback={fb => setFeedback(m.id, fb)}
                            onEdit={editUser}
                            onEditSubmit={(text, keep) => { void editQuestion(m, text, keep) }}
                            onSwitchVersion={n => { void switchVersion(m, n) }}
                            onMemoryUndo={mem => { void undoMemory(m._uid, mem) }}
                            onWriteChange={updateWrite}
                            onQuestionChange={updateQuestion}
                            onWriteCompose={composeFromCard}
                          />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* 맨 아래로 */}
                  {!atBottom && !!messages.length && (
                    <UiIconButton
                      label={t('ai.message.scrollDown')}
                      icon="arrow-down"
                      variant="outline"
                      className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
                      onClick={() => scrollDown(true)}
                    />
                  )}
                </div>

                <AiComposer
                  ref={composer}
                  permissionMode
                  conversationId={activeId}
                  modelValue={input}
                  onUpdateModelValue={setInput}
                  busy={busy}
                  onSend={() => { void send() }}
                  onStop={stop}
                  attachments={attachments}
                  onFiles={addFiles}
                  onRemoveAttachment={removeAttachment}
                  vision={status?.vision !== false}
                  modelName={status?.model}
                  onSwitchVisionModel={visionChoice ? () => { void switchToVisionModel() } : undefined}
                  onRemoveImages={removeImages}
                  maxBytes={status?.attachment_max_bytes || AI_ATTACH_MAX}
                  temporary={isTemp}
                  onToggleTemporary={(!activeConv || activeConv.temporary || !messages.length) && !project ? toggleTemporary : undefined}
                />
              </section>
            </>
          )}

          {/* 프로젝트 창 */}
          {projectModal === 'create' && (
            <AiProjectFormModal title={t('ai.project.createTitle')} onSubmit={createProject} onClose={() => setProjectModal(null)} />
          )}
          {(projectModal === 'edit' || projectModal === 'files') && project && (
            <AiProjectFormModal
              title={t('ai.project.editTitle')}
              initial={{ name: project.name, instructions: project.instructions, files: project.files }}
              startPicking={projectModal === 'files'}
              onSubmit={saveProjectForm}
              onClose={() => setProjectModal(null)}
            />
          )}
          {projectModal === 'share' && project && (
            <AiProjectShareModal project={project} onSubmit={gids => patchProject({ share_group_ids: gids })} onClose={() => setProjectModal(null)} />
          )}

          {/* 모바일 모델 피커: 바닥 시트 */}
          {pickerOpen && isMobile && status && (
            <UiModal title={t('ai.picker.label')} flush onClose={() => setPickerOpen(false)}>
              <AiModelPicker status={status} toolsEnabled={!!activeConv?.tools_enabled} className="pb-3" onToggleTools={v => { void setTools(v) }} onClose={() => setPickerOpen(false)} />
            </UiModal>
          )}
        </div>
      )}
    </div>
  )
}
