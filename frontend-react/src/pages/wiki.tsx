/**
 * 위키.
 * Vue 원본: frontend/pages/wiki.vue
 *  데스크톱 3열: 트리 260 / 본문 680(읽기=편집 폭) / 레일 240(목차·최근 기록). 기록 모드는 레일 대신 버전 패널 320.
 *  커맨드 바 44: 경로(스페이스 › 상위 › 제목) · [편집 E] 또는 [함께 편집 아바타 · ✓ 저장됨] · 공유 · ⋯
 *  편집: 공용 서식 툴바 40 + 실시간 공동 편집(Yjs, WikiCollabEditor — 바인딩은 그대로) + 자동 저장.
 *  기록: v 미리보기 띠(warning 틴트) + 변경 표시(추가 success 밑줄 / 삭제 danger 취소선) + 복원 확인.
 *  새 페이지: 모달 없이 트리 안 인라인 행(현재 페이지 아래 / 노드 + = 하위).
 * 주소: /wiki?space=<id>&page=<id> — 링크 공유·뒤로 가기가 된다.
 *
 * React 이식 메모
 *  - 비동기 처리기(자동 저장·주소 동기화)가 "지금" 값을 읽어야 해서 화면 상태 일부는 useState + ref 거울(useRefState).
 *  - Vue onBeforeRouteLeave(편집 중이면 저장 후 떠나기) → react-router useBlocker(다른 경로로 갈 때만, 쿼리 변경은 제외).
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent, type MutableRefObject } from 'react'
import { useBlocker } from 'react-router'
import DOMPurify from 'dompurify'
import type { Editor } from '@tiptap/react'
import type {} from '@tiptap/extension-image'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch, errorStatus } from '~/lib/api'
import { useHead } from '~/lib/head'
import { useRoute, getAppRouter, parseQuery, routerApi, queryString, type RouteLocationRaw } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useAuth, authStore } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { useIsMobile, isMobileNow } from '~/composables/useIsMobile'
import { useShareUpload } from '~/composables/useShareUpload'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { usePageShortcuts } from '~/composables/useShortcuts'
import {
  useWiki, wikiStore, setCurrentSpace, setCurrentPage, setPageTree, setVersions,
  type WikiPageVersion, type WikiPageDetail,
} from '~/composables/useWiki'
import { extractToc, withHeadingIds, type TocItem } from '~/utils/htmlToc'
import { diffHtml, diffStats } from '~/utils/htmlDiff'
import { stripLayoutStyles } from '~/components/editor/safeHtml'
import { WikiSidebar } from '~/components/wiki/WikiSidebar'
import { WikiCollabEditor, type WikiCollabEditorHandle, type WikiPeer, type WikiCollabState } from '~/components/wiki/WikiCollabEditor'
import { WikiRail } from '~/components/wiki/WikiRail'
import { WikiVersionPanel } from '~/components/wiki/WikiVersionPanel'
import { WikiSpaceSettings } from '~/components/wiki/WikiSpaceSettings'
import type { TreeNode, DropPosition } from '~/components/wiki/WikiPageTreeNode'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiEditorToolbar } from '~/components/ui/EditorToolbar'
import { WikiProofreadButtons, WikiProofreadCard } from '~/components/wiki/WikiProofread'
import { UiSwitch } from '~/components/ui/Switch'
import { UiButton } from '~/components/ui/Button'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import '~/components/wiki/wiki.css'
import { getUiZoom } from '~/composables/useViewport'
import { writeClipboard } from '~/lib/clipboard'

type Mode = 'read' | 'edit' | 'history'
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/** useState + 지금 값 ref(비동기 처리기용) */
function useRefState<T>(init: T): [T, (v: T) => void, MutableRefObject<T>] {
  const [v, setV] = useState<T>(init)
  const ref = useRef<T>(v)
  const set = useRef((nv: T) => { ref.current = nv; setV(nv) }).current
  return [v, set, ref]
}

// ─── 주소 ↔ 상태 ───
const LAST_SPACE = 'wiki:last-space'
function lastSpace(): string | null { try { return localStorage.getItem(LAST_SPACE) } catch { return null } }
/** 지금 주소의 쿼리(Vue 의 route.query 를 처리기 안에서 읽던 것) */
function curQuery() {
  const r = getAppRouter()
  return parseQuery(r ? r.state.location.search : window.location.search)
}
const AUTOSAVE_MS = 4000   // 입력이 멈추고 4초 — 저장마다 버전이 하나씩 쌓이므로(백엔드 갭) 너무 잦지 않게

function slugOf(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '') || 'untitled'
}
function fmtStamp(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function nameOf(a: { display_name: string | null; username: string } | undefined | null) {
  return a ? (a.display_name || a.username) : ''
}

/** 저장된 본문을 읽기 화면에 넣기 전 정화 — 스크립트(DOMPurify) + 자리·겹침 스타일(position:fixed 로 화면 덮기) */
function cleanHtml(html: string): string {
  return stripLayoutStyles(DOMPurify.sanitize(html))
}

interface MenuState { items: UiMenuItem[]; anchor: DOMRect | null; title?: string; align?: 'start' | 'end'; onSelect: (key: string) => void }

export default function WikiPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  const { user } = useAuth()
  const route = useRoute()
  const router = routerApi
  const isMobile = useIsMobile()
  const { upload } = useShareUpload()

  const {
    currentSpace, pageTree, currentPage, versions, searchResults,
    fetchSpaces, fetchSpace, fetchPages, fetchPage,
    createSpace, createPage, deletePage,
    buildTree, searchPages, fetchVersions, fetchMembers,
  } = useWiki()
  const W = () => wikiStore.getState()

  useHead({ title: `${currentPage?.title ?? t('wiki.title')} | ${appName}` })
  useBreadcrumb(currentPage?.title ?? currentSpace?.name ?? null)

  const [mode, setMode, modeRef] = useRefState<Mode>('read')
  const [booting, setBooting, bootingRef] = useRefState(true)
  const [pageLoading, setPageLoading] = useState(false)
  const [pageError, setPageError] = useState(false)

  const tree = useMemo(() => buildTree(pageTree) as TreeNode[], [buildTree, pageTree])
  function canWriteNow(): boolean {
    const s = W()
    const r = s.currentPage?.user_role ?? s.currentSpace?.user_role
    return r === 'writer' || r === 'admin' || !!authStore.getState().user?.is_admin
  }
  function canWriteSpaceNow(): boolean {
    const r = W().currentSpace?.user_role
    return r === 'writer' || r === 'admin' || !!authStore.getState().user?.is_admin
  }
  const canWrite = (() => {
    const r = currentPage?.user_role ?? currentSpace?.user_role
    return r === 'writer' || r === 'admin' || !!user?.is_admin
  })()
  const canWriteSpace = (() => {
    const r = currentSpace?.user_role
    return r === 'writer' || r === 'admin' || !!user?.is_admin
  })()

  function goPage(id: string) {
    void router.push({ query: { space: W().currentSpace?.id, page: id } })
  }
  function goSpace(id: string) {
    void router.push({ query: { space: id } })
  }

  const [memberCount, setMemberCount] = useState<number | null>(null)

  // ─── 편집 · 자동 저장 상태(아래 함수들이 쓴다) ───
  const editorRef = useRef<WikiCollabEditorHandle | null>(null)
  const [collab, setCollab] = useState<WikiCollabState>({ editor: null, connected: false, peers: [] })
  const liveEditorRef = useRef<Editor | null>(null)
  liveEditorRef.current = collab.editor
  const [editTitle, setEditTitle, editTitleRef] = useRefState('')
  const [saveState, setSaveState, saveStateRef] = useRefState<SaveState>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tocTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inflight = useRef<Promise<void> | null>(null)
  const lastSavedHtml = useRef('')
  const lastSavedTitle = useRef('')
  const pendingEditId = useRef<string | null>(null)
  // 편집을 시작할 때(그리고 저장할 때마다) 본 서버 버전 — 저장에 실어 보내 그 사이 남이 고친 것을 덮어쓰지 않게 한다(409)
  const baseVersion = useRef<number | null>(null)
  const saveConflict = useRef(false)
  const startingEdit = useRef(false)
  const openSeq = useRef(0)
  const peersRef = useRef<WikiPeer[]>([])
  peersRef.current = collab.peers
  const [liveHtml, setLiveHtml] = useState('')   // 편집 중 목차용(입력 멈춘 뒤 갱신)

  // ─── 기록 상태 ───
  const [selectedVersion, setSelectedVersion, selectedVersionRef] = useRefState<WikiPageVersion | null>(null)
  const [showChanges, setShowChanges] = useState(true)
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [versionListOpen, setVersionListOpen] = useState(false)   // 모바일 전체 화면 목록

  /** 편집기 본문. 편집기가 없으면 null(Vue: editorRef.value 없음) */
  function editorContent(): string | null {
    if (editorRef.current) return editorRef.current.getContent()
    // 화면이 내려가는 중(ref 는 이미 떨어졌고 편집기는 아직 살아 있음) — Vue onBeforeUnmount 와 같은 순간
    // 편집 불가(= 공동 편집기가 아직 본문 준비 전)면 비어 있으니 저장하지 않는다
    const ed = liveEditorRef.current
    return ed && !ed.isDestroyed && ed.isEditable ? (ed.getHTML() || '') : null
  }

  async function syncFromRoute() {
    const q = curQuery()
    const qSpace = typeof q.space === 'string' ? q.space : null
    const qPage = typeof q.page === 'string' ? q.page : null
    const sid = qSpace || W().currentSpace?.id || lastSpace() || W().spaces[0]?.id
    if (!sid) { setCurrentSpace(null); setCurrentPage(null); return }
    // 편집 중에 다른 문서·스페이스로 가는 길이면 먼저 저장한다. 저장하지 못했고 버리지도 않겠다면 주소를 되돌리고 머문다
    const editing = W().currentPage
    if (modeRef.current === 'edit' && editing && qPage !== editing.id) {
      if (!(await leaveEdit())) {
        void router.replace({ query: { space: editing.space_id, page: editing.id } })
        return
      }
    }
    // 주소에 스페이스가 없으면 채워 둔다(그 사이 이어서 불러온다 — 첫 진입 중엔 주소 감시가 꺼져 있다)
    if (!qSpace) void router.replace({ query: { ...q, space: sid } } as RouteLocationRaw)

    if (W().currentSpace?.id !== sid || !W().pageTree.length) {
      try {
        await fetchSpace(sid)
        await fetchPages(sid)
        try { localStorage.setItem(LAST_SPACE, sid) } catch { /* 저장소 막힘 */ }
        setMemberCount(null)
        fetchMembers(sid).then(m => { setMemberCount(m.length) }).catch(() => {})
      } catch {
        // 지워졌거나 권한이 없는 스페이스 — 첫 스페이스로
        try { localStorage.removeItem(LAST_SPACE) } catch { /* 무시 */ }
        const first = W().spaces.find(s => s.id !== sid)
        if (first) void router.replace({ query: { space: first.id } })
        else { setCurrentSpace(null); setPageTree([]) }
        return
      }
    }

    if (qPage) {
      if (W().currentPage?.id !== qPage) await openPage(qPage)
    } else {
      await finishEdit({ silent: true })
      setCurrentPage(null)
      setMode('read')
    }
  }

  async function openPage(id: string) {
    if (!(await leaveEdit())) return
    // 연달아 다른 문서를 누르면 마지막 것만 반영한다(늦게 온 앞 문서가 주소와 다른 본문을 띄우지 않게)
    const my = ++openSeq.current
    setMode('read')
    setSelectedVersion(null)
    setPageLoading(true)
    setPageError(false)
    try {
      await fetchPage(id)
      if (my !== openSeq.current) return
      setVersions([])
      fetchVersions(id).catch(() => {})
      if (pendingEditId.current === id) { pendingEditId.current = null; void startEdit({ fresh: true }) }
    } catch {
      if (my !== openSeq.current) return
      setPageError(true)
      setCurrentPage(null)
    } finally {
      if (my === openSeq.current) setPageLoading(false)
    }
  }

  // onMounted: 스페이스 → 주소 동기화
  useEffect(() => {
    if (!authStore.getState().user) return
    ;(async () => {
      try { await fetchSpaces() } catch { /* 빈 상태로 */ }
      setCurrentPage(null)
      setPageTree([])   // 지난 방문의 트리는 낡았을 수 있다 — 다시 받는다
      await syncFromRoute()
      setBooting(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // watch(() => [route.query.space, route.query.page])
  const qSpaceVal = queryString(route.query.space)
  const qPageVal = queryString(route.query.page)
  const firstQ = useRef(true)
  useEffect(() => {
    if (firstQ.current) { firstQ.current = false; return }
    if (!bootingRef.current) void syncFromRoute()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qSpaceVal, qPageVal])

  // ─── 경로·메타 ───
  const ancestors = useMemo(() => {
    const out: { id: string; title: string }[] = []
    let pid = currentPage?.parent_id ?? null
    const byId = new Map(pageTree.map(p => [p.id, p]))
    while (pid && out.length < 10) {
      const p = byId.get(pid)
      if (!p) break
      out.unshift({ id: p.id, title: p.title })
      pid = p.parent_id
    }
    return out
  }, [currentPage?.parent_id, pageTree])

  /** "정하늘 작성 · 김서연 외 2명 수정" — 버전 기록의 작성자에서 만든다(v1 = 처음 쓴 사람). */
  const metaPeople = useMemo(() => {
    const page = currentPage
    if (!page) return { creator: '', editor: '', others: 0 }
    const vs = versions
    const first = vs.length ? vs[vs.length - 1] : null
    const creator = first && first.version_number <= 1 ? nameOf(first.author) : ''
    const editors = Array.from(new Set(vs.filter(v => v.version_number > 1).map(v => nameOf(v.author))))
    const latest = vs.length ? nameOf(vs[0].author) : nameOf(page.author)
    const others = editors.filter(n => n !== latest).length
    return { creator, editor: editors.length ? latest : '', others }
  }, [currentPage, versions])

  // ─── 읽기 본문 · 목차 ───
  const readHtml = useMemo(() => {
    const c = currentPage?.content
    return c ? withHeadingIds(cleanHtml(c)) : ''
  }, [currentPage?.content])
  const toc = useMemo<TocItem[]>(
    () => extractToc(mode === 'edit' ? liveHtml : (currentPage?.content ?? '')),
    [mode, liveHtml, currentPage?.content],
  )
  const [activeToc, setActiveToc] = useState(0)
  const articleRef = useRef<HTMLElement | null>(null)

  function headingEls(): HTMLElement[] {
    return Array.from(articleRef.current?.querySelectorAll<HTMLElement>('.wiki-body h1, .wiki-body h2, .wiki-body h3') ?? [])
  }
  function onArticleScroll() {
    const root = articleRef.current
    if (!root) return
    const top = root.getBoundingClientRect().top + 80 * getUiZoom()
    let idx = 0
    headingEls().forEach((el, i) => { if (el.getBoundingClientRect().top <= top) idx = i })
    setActiveToc(idx)
  }
  function jumpTo(item: TocItem) {
    headingEls()[item.index]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setActiveToc(item.index)
  }

  // ─── 편집 · 자동 저장 ───
  const peers: WikiPeer[] = collab.peers
  const connected = collab.connected
  const liveEditor = collab.editor

  /** fresh: 방금 서버에서 받은 문서(새로 만든 직후) — 다시 읽지 않는다 */
  async function startEdit(opts: { fresh?: boolean } = {}) {
    let page = W().currentPage
    if (!page || !canWriteNow() || modeRef.current === 'edit' || startingEdit.current) return
    if (!opts.fresh) {
      // 읽기 화면을 열어 둔 사이 다른 사람이 고쳤을 수 있다 — 옛 본문으로 편집을 시작하면 첫 자동 저장이 그 수정을 덮어쓴다
      const id = page.id
      startingEdit.current = true
      try { await fetchPage(id) } catch { /* 못 읽으면 가진 것으로 시작 — 저장 때 버전 검사(409)가 덮어쓰기를 막는다 */ } finally { startingEdit.current = false }
      page = W().currentPage
      if (!page || page.id !== id || modeRef.current !== 'read') return
    }
    baseVersion.current = page.version
    saveConflict.current = false
    setSelectedVersion(null)
    setEditTitle(page.title)
    lastSavedHtml.current = ''
    lastSavedTitle.current = page.title
    setLiveHtml(page.content)
    setSaveState('idle')
    setMode('edit')
  }

  function onEditorChange() {
    setSaveState('dirty')
    scheduleSave()
    if (tocTimer.current) clearTimeout(tocTimer.current)
    tocTimer.current = setTimeout(() => { setLiveHtml(editorContent() ?? '') }, 600)
  }
  // watch(editTitle) — 입력으로 바뀔 때만 의미가 있다(프로그램 대입은 lastSavedTitle 과 같다)
  function onEditTitle(v: string) {
    setEditTitle(v)
    if (modeRef.current !== 'edit' || !W().currentPage || v === lastSavedTitle.current) return
    setSaveState('dirty')
    scheduleSave()
  }
  function scheduleSave() {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void flushSave() }, AUTOSAVE_MS)
  }

  /** force: 버전 검사 없이 저장(충돌 안내에서 "내 내용으로 저장"을 고른 경우) */
  async function flushSave(opts: { force?: boolean } = {}): Promise<void> {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (inflight.current) { await inflight.current; if (saveStateRef.current !== 'dirty') return }
    const page = W().currentPage
    const html0 = editorContent()
    if (!page || modeRef.current !== 'edit' || html0 === null) return
    const html: string = html0
    const title = editTitleRef.current.trim() || page.title
    if (html === lastSavedHtml.current && title === lastSavedTitle.current) {
      // 저장할 것이 없다 — 앞선 실패 표시도 지운다(되돌려서 같아진 경우. 남겨 두면 떠날 때 "저장 못 함"으로 막힌다)
      if (saveStateRef.current === 'dirty' || saveStateRef.current === 'error') { saveConflict.current = false; setSaveState('saved') }
      return
    }
    const pageId = page.id
    setSaveState('saving')
    let retry = false
    inflight.current = (async () => {
      try {
        const body: Record<string, unknown> = { content: html }
        if (title !== page.title) body.title = title
        if (!opts.force && baseVersion.current != null) body.base_version = baseVersion.current
        const updated = await $fetch<WikiPageDetail>(`/api/wiki/pages/${pageId}`, { method: 'PATCH', body })
        baseVersion.current = updated.version
        saveConflict.current = false
        lastSavedHtml.current = html
        lastSavedTitle.current = title
        setLastSavedAt(new Date())
        const cur = W().currentPage
        if (cur?.id === pageId) setCurrentPage({ ...updated, user_role: cur.user_role })
        const sp = W().currentSpace
        if (body.title && sp) fetchPages(sp.id).catch(() => {})
        // 저장하는 사이 또 바뀌었으면 dirty 유지
        setSaveState((editorContent() ?? html) === html ? 'saved' : 'dirty')
        if (saveStateRef.current === 'dirty') scheduleSave()
      } catch (e) {
        if (errorStatus(e) === 409 && !opts.force) {
          // 내가 본 버전 뒤에 누가 저장했다. 함께 편집 중인 사람(같은 공동 문서를 보고 있다)이 먼저 저장한 것이거나
          // 서버 본문이 내 것과 같으면 충돌이 아니다 — 그 버전을 기준으로 다시 저장한다. 아니면 덮어쓰지 않고 묻는다
          const latest = await $fetch<WikiPageDetail>(`/api/wiki/pages/${pageId}`).catch(() => null)
          if (latest && (latest.content === html || peersRef.current.length > 0) && baseVersion.current !== latest.version) {
            baseVersion.current = latest.version
            retry = true
          } else {
            if (!saveConflict.current) addToast('error', t('wiki.save.conflict', '다른 사람이 이 문서를 먼저 고쳤습니다. 내 변경은 아직 저장되지 않았습니다.'))
            saveConflict.current = true
          }
        }
        if (!retry) setSaveState('error')
      } finally {
        inflight.current = null
      }
    })()
    await inflight.current
    if (retry) await flushSave()
  }

  /** "다시 시도" — 충돌이면 덮어쓸지 먼저 묻는다(상대가 고친 내용은 버전 기록에 남는다) */
  async function retrySave(): Promise<void> {
    if (!saveConflict.current) { await flushSave(); return }
    const ok = await confirmBox(
      t('wiki.save.conflictConfirm', '다른 사람이 이 문서를 먼저 고쳤습니다. 내 내용으로 저장하면 그 수정은 버전 기록에만 남습니다.'),
      { title: t('wiki.save.conflictTitle', '저장 충돌'), danger: true, confirmLabel: t('wiki.save.conflictOverwrite', '내 내용으로 저장') },
    )
    if (ok) await flushSave({ force: true })
  }

  /** 편집 마치기(완료·페이지 이동·떠날 때). 저장 못 하면 머문다. */
  async function finishEdit(opts: { silent?: boolean } = {}): Promise<boolean> {
    if (modeRef.current !== 'edit') return true
    if (saveStateRef.current === 'dirty' || saveStateRef.current === 'error' || saveTimer.current) await flushSave()
    // 충돌이면(다른 사람이 먼저 고침) 덮어쓸지 묻는다 — 조용한 호출(이동 중)은 leaveEdit 가 따로 묻는다
    if (saveStateRef.current === 'error' && saveConflict.current && !opts.silent) await retrySave()
    // 저장하지 못했으면 조용한 호출이어도 읽기로 넘어가지 않는다(편집기가 내려가면 고친 내용이 사라진다)
    if (saveStateRef.current === 'error') {
      if (!opts.silent && !saveConflict.current) addToast('error', t('wiki.save.failed'))
      return false
    }
    setMode('read')
    const id = W().currentPage?.id
    if (id) {
      fetchPage(id).catch(() => {})
      fetchVersions(id).catch(() => {})
    }
    return true
  }

  /** 편집 중인 문서를 떠나도 되나(다른 문서·스페이스·다른 화면). 저장하지 못했으면 버릴지 묻고, 아니라면 머문다. */
  async function leaveEdit(): Promise<boolean> {
    if (modeRef.current !== 'edit') return true
    if (await finishEdit({ silent: true })) return true
    const discard = await confirmBox(
      t('wiki.save.leaveUnsaved', '변경을 저장하지 못했습니다. 저장하지 않고 이동하면 방금 고친 내용이 사라집니다.'),
      { title: t('wiki.save.leaveUnsavedTitle', '저장되지 않은 변경'), danger: true, confirmLabel: t('wiki.save.leaveDiscard', '저장하지 않고 이동') },
    )
    if (!discard) return false
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    saveConflict.current = false
    setSaveState('idle')
    setMode('read')
    return true
  }

  // 지금 함수 묶음(창 리스너·정리에서 부른다)
  const fns = useRef({ flushSave, finishEdit, leaveEdit, startEdit, canWriteNow })
  fns.current = { flushSave, finishEdit, leaveEdit, startEdit, canWriteNow }

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      const s = saveStateRef.current
      if (modeRef.current === 'edit' && (s === 'dirty' || s === 'saving' || s === 'error')) {
        void fns.current.flushSave()
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    // 정리 때 "그때의" 모드·타이머를 읽는다(ref 객체를 잡아 둔다)
    const live = { mode: modeRef, toc: tocTimer, fns }
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      if (live.mode.current === 'edit') void live.fns.current.flushSave()
      if (live.toc.current) clearTimeout(live.toc.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // onBeforeRouteLeave(async () => { await finishEdit({ silent: true }) }) — 다른 경로로 떠날 때만
  const blocker = useBlocker(({ currentLocation, nextLocation }) => modeRef.current === 'edit' && currentLocation.pathname !== nextLocation.pathname)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    // 저장하지 못했고 버리지도 않겠다면 이동을 취소한다(예전엔 그대로 떠나 고친 내용이 사라졌다)
    void fns.current.leaveEdit().then(ok => { if (ok) blocker.proceed?.(); else blocker.reset?.() }, () => blocker.proceed?.())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state])

  const saveLabel = (() => {
    if (!connected && mode === 'edit') return { text: t('wiki.save.reconnecting'), tone: 'text-warning', icon: 'alert-triangle' }
    switch (saveState) {
      case 'saving': return { text: t('wiki.save.saving'), tone: 'text-muted-foreground', icon: '' }
      case 'error': return { text: t('wiki.save.notSaved'), tone: 'text-danger', icon: 'alert-circle' }
      case 'dirty': return { text: '', tone: '', icon: '' }
      case 'saved': return { text: t('wiki.save.saved'), tone: 'text-success', icon: 'check' }
      default: return lastSavedAt ? { text: t('wiki.save.saved'), tone: 'text-success', icon: 'check' } : { text: '', tone: '', icon: '' }
    }
  })()
  const savedTime = lastSavedAt ? `${String(lastSavedAt.getHours()).padStart(2, '0')}:${String(lastSavedAt.getMinutes()).padStart(2, '0')}` : ''
  const peersLabel = t('wiki.save.peers', { names: peers.map(p => p.name).join(', ') })

  // 편집 툴바 — 이미지(내 파일함 위키 첨부 폴더 + 공유 링크)
  const imageInput = useRef<HTMLInputElement | null>(null)
  async function onImagePicked(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    try {
      const up = await upload(file, '위키 첨부')
      const ed = liveEditorRef.current
      if (file.type.startsWith('image/')) ed?.chain().focus().setImage({ src: up.url, alt: up.name }).run()
      else ed?.chain().focus().insertContent(`<a href="${up.url}">${up.name.replace(/</g, '&lt;')}</a> `).run()
    } catch (err: any) {
      addToast('error', err?.data?.detail || t('wiki.uploadError'))
    }
  }

  // E = 편집(읽기 화면, 입력 중이 아닐 때)
  usePageShortcuts(t('wiki.title'), [
    ...(canWrite ? [{ keys: ['E'], label: t('wiki.shortcuts.edit') }] : []),
    { keys: ['→'], label: t('wiki.shortcuts.expand') },
    { keys: ['←'], label: t('wiki.shortcuts.collapse') },
    { keys: ['↵'], label: t('wiki.shortcuts.open') },
  ])
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if ((e.key === 'e' || e.key === 'E') && modeRef.current === 'read' && W().currentPage && fns.current.canWriteNow()) {
        e.preventDefault()
        void fns.current.startEdit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── 기록 ───
  async function openHistory() {
    const page = W().currentPage
    if (!page) return
    if (!(await finishEdit())) return
    setLoadingVersions(true)
    setMode('history')
    setVersionListOpen(true)
    try { await fetchVersions(page.id) } catch { /* 빈 목록 */ }
    setLoadingVersions(false)
    const vs = W().versions
    if (!isMobileNow()) setSelectedVersion(vs[1] ?? vs[0] ?? null)
  }
  function closeHistory() {
    setMode('read')
    setSelectedVersion(null)
    setVersionListOpen(false)
  }
  function pickVersion(v: WikiPageVersion) {
    setSelectedVersion(v)
    setVersionListOpen(false)
  }

  const versionStats = useMemo(() => {
    const out: Record<number, { added: number; removed: number }> = {}
    const vs = versions
    for (let i = 0; i < vs.length && i < 30; i++) {
      const prev = vs[i + 1]
      out[vs[i].version_number] = diffStats(prev ? prev.content : '', vs[i].content)
    }
    return out
  }, [versions])
  const previewHtml = useMemo(() => {
    const v = selectedVersion
    const cur = currentPage
    if (!v || !cur) return ''
    const old = cleanHtml(v.content || '')
    if (!showChanges || v.version_number === cur.version) return withHeadingIds(old)
    return diffHtml(old, cleanHtml(cur.content || '')).html
  }, [selectedVersion, currentPage, showChanges])

  async function restoreSelected() {
    const v = selectedVersionRef.current
    const page = W().currentPage
    if (!v || !page) return
    const ok = await confirmBox(t('wiki.restoreConfirm.message', { from: v.version_number, current: page.version }), { title: t('wiki.restoreConfirm.title'), confirmLabel: t('wiki.restore') })
    if (!ok) return
    try {
      const restored = await $fetch<WikiPageDetail>(`/api/wiki/pages/${page.id}/versions/${v.version_number}/restore`, { method: 'POST' })
      setCurrentPage({ ...restored, user_role: page.user_role })
      const sp = W().currentSpace
      if (sp) fetchPages(sp.id).catch(() => {})
      await fetchVersions(page.id)
      closeHistory()
      addToast('success', `v${v.version_number} ${t('wiki.restored')}`)
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('wiki.restoreError'))
    }
  }

  // ─── 트리: 새 페이지 · 이름 · 이동 · 고정 · 삭제 ───
  /** undefined = 인라인 행 없음, null = 최상위, id = 그 페이지 아래 */
  const [draftParentId, setDraftParentId, draftParentRef] = useRefState<string | null | undefined>(undefined)
  const [renamingId, setRenamingId, renamingRef] = useRefState<string | null>(null)

  function newPageHere() {
    // 상단 + = 현재 페이지 아래(하위). 페이지가 없으면 최상위.
    setDraftParentId(W().currentPage?.id ?? null)
  }
  async function createDraft(parentId: string | null, title: string) {
    // Enter 로 만든 뒤 입력칸이 사라지며 blur 가 또 올 수 있다 — 두 번 만들지 않게
    if (draftParentRef.current !== parentId) return
    setDraftParentId(undefined)
    const sp = W().currentSpace
    if (!sp) return
    const siblings = W().pageTree.filter(p => p.parent_id === parentId)
    const sort = siblings.length ? Math.max(...siblings.map(s => s.sort_order)) + 1 : 0
    try {
      const page = await createPage(sp.id, {
        title, slug: slugOf(title), ...(parentId ? { parent_id: parentId } : {}), sort_order: sort,
      } as any)
      if (page) {
        // 새 페이지는 바로 편집으로 연다(openPage 가 끝나면)
        if (canWriteSpaceNow()) pendingEditId.current = page.id
        goPage(page.id)
      }
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('wiki.createPageError'))
    }
  }

  async function patchPage(id: string, body: Record<string, any>) {
    return await $fetch<WikiPageDetail>(`/api/wiki/pages/${id}`, { method: 'PATCH', body })
  }
  async function renamePage(id: string, title: string) {
    if (renamingRef.current !== id) return   // blur 중복 방지
    setRenamingId(null)
    try {
      const renamed = await patchPage(id, { title })
      const sp = W().currentSpace
      if (sp) await fetchPages(sp.id)
      const cur = W().currentPage
      if (cur?.id === id) {
        // 이름 바꾸기도 버전을 올린다 — 편집 중이면 기준 버전을 맞춰 다음 자동 저장이 충돌로 보이지 않게
        const version = renamed?.version ?? cur.version
        setCurrentPage({ ...cur, title, version })
        if (modeRef.current === 'edit') { setEditTitle(title); lastSavedTitle.current = title; baseVersion.current = version }
      }
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('wiki.renameError'))
    }
  }
  async function togglePin(id: string) {
    const node = W().pageTree.find(p => p.id === id)
    if (!node) return
    try {
      await patchPage(id, { is_pinned: !node.is_pinned })
      const sp = W().currentSpace
      if (sp) await fetchPages(sp.id)
      const cur = W().currentPage
      if (cur?.id === id) setCurrentPage({ ...cur, is_pinned: !node.is_pinned })
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('board.post.pinError'))
    }
  }
  async function removePage(id: string) {
    const all = W().pageTree
    const node = all.find(p => p.id === id)
    const hasKids = all.some(p => p.parent_id === id)
    const msg = hasKids ? t('wiki.deleteConfirm.withChildren', { name: node?.title ?? '' }) : t('wiki.deleteConfirm.plain', { name: node?.title ?? '' })
    if (!await confirmBox(msg, { danger: true, confirmLabel: t('common.delete') })) return
    try {
      if (W().currentPage?.id === id && modeRef.current === 'edit') setMode('read')
      await deletePage(id)
      if (curQuery().page === id) void router.replace({ query: { space: W().currentSpace?.id } })
      addToast('success', t('wiki.pageDeleted'))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('board.comment.deleteError'))
    }
  }

  function isDescendant(id: string, maybeChild: string): boolean {
    const all = W().pageTree
    let cur = all.find(p => p.id === maybeChild)?.parent_id ?? null
    for (let guard = 0; cur && guard < 50; guard++) {
      if (cur === id) return true
      const c: string | null = cur
      cur = all.find(p => p.id === c)?.parent_id ?? null
    }
    return false
  }

  /** 끌어서 옮기기: 위/아래 = 같은 부모의 앞/뒤, 가운데 = 하위로. 형제 순서는 0..n 으로 다시 매긴다. */
  async function movePage({ id, targetId, position }: { id: string; targetId: string; position: DropPosition }) {
    if (id === targetId || isDescendant(id, targetId)) return
    const all = W().pageTree
    const src = all.find(p => p.id === id)
    const target = all.find(p => p.id === targetId)
    const sp = W().currentSpace
    if (!src || !target || !sp) return
    const newParent = position === 'inside' ? target.id : target.parent_id
    // 최상위로 옮기기(newParent=null)는 백엔드가 받는다(update_page 가 명시한 parent_id=null 을 처리) — 아래 PATCH 가 null 을 보낸다
    const siblings = all
      .filter(p => p.parent_id === newParent && p.id !== id)
      .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title))
    let at = siblings.length
    if (position !== 'inside') {
      const ti = siblings.findIndex(s => s.id === targetId)
      at = position === 'before' ? ti : ti + 1
    }
    const ordered = [...siblings.slice(0, at), src, ...siblings.slice(at)]
    try {
      const jobs: Promise<unknown>[] = []
      ordered.forEach((p, i) => {
        const body: Record<string, any> = {}
        if (p.sort_order !== i) body.sort_order = i
        if (p.id === id && p.parent_id !== newParent) body.parent_id = newParent
        if (Object.keys(body).length) jobs.push(patchPage(p.id, body))
      })
      await Promise.all(jobs)
      await fetchPages(sp.id)
      const cur = W().currentPage
      if (cur?.id === id) setCurrentPage({ ...cur, parent_id: newParent })
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('wiki.moveError'))
      fetchPages(sp.id).catch(() => {})
    }
  }

  // ─── 메뉴(트리 노드 ⋯ · 페이지 ⋯ · 스페이스 ▾ · 이동 대상 · 모바일 목차) ───
  const [menu, setMenu, menuRef] = useRefState<MenuState | null>(null)
  function anchorOf(ev: MouseEvent<HTMLElement>): DOMRect | null {
    return (ev.currentTarget as HTMLElement | null)?.getBoundingClientRect() ?? null
  }

  function openNodeMenu(node: TreeNode, ev: MouseEvent<HTMLElement>) {
    const items: UiMenuItem[] = []
    if (isMobileNow()) items.push({ key: 'child', label: t('wiki.tree.addChild'), icon: 'plus' })
    items.push(
      { key: 'rename', label: t('wiki.menu.rename'), icon: 'edit' },
      { key: 'move', label: t('wiki.menu.move'), icon: 'arrow-right' },
      { key: 'pin', label: node.is_pinned ? t('wiki.menu.unpin') : t('wiki.menu.pin'), icon: 'star' },
      { key: 'delete', label: t('common.delete'), icon: 'trash', danger: true, separated: true },
    )
    const anchor = anchorOf(ev)
    setMenu({
      items, anchor, title: node.title,
      onSelect: (k) => {
        if (k === 'child') setDraftParentId(node.id)
        else if (k === 'rename') setRenamingId(node.id)
        else if (k === 'move') openMoveMenu(node.id, anchor)
        else if (k === 'pin') void togglePin(node.id)
        else if (k === 'delete') void removePage(node.id)
      },
    })
  }

  function openMoveMenu(id: string, evAnchor: DOMRect | null) {
    const anchor = menuRef.current?.anchor ?? evAnchor
    const all = W().pageTree
    const src = all.find(p => p.id === id)
    const depthOf = (pid: string | null): number => { let d = 0; let c = pid; while (c && d < 20) { const cc: string = c; c = all.find(p => p.id === cc)?.parent_id ?? null; d++ } return d }
    const flat: UiMenuItem[] = []
    const walk = (nodes: TreeNode[]) => nodes.forEach(n => {
      if (n.id === id || isDescendant(id, n.id)) return
      flat.push({ key: n.id, label: `${'  '.repeat(depthOf(n.parent_id))}${n.title}`, radio: true, checked: src?.parent_id === n.id })
      walk(n.children)
    })
    walk(buildTree(all) as TreeNode[])
    setTimeout(() => {
      setMenu({
        items: flat.length ? flat : [{ key: '-', label: t('wiki.menu.noTarget'), disabled: true }],
        anchor, title: t('wiki.menu.moveTitle'),
        onSelect: (target) => { if (target !== '-') void movePage({ id, targetId: target, position: 'inside' }) },
      })
    })
  }

  function openPageMenu(ev: MouseEvent<HTMLElement>) {
    const page = W().currentPage
    if (!page) return
    const mobile = isMobileNow()
    const items: UiMenuItem[] = []
    if (mobile && toc.length) items.push({ key: 'toc', label: t('wiki.menu.toc'), icon: 'list' })
    items.push({ key: 'history', label: t('wiki.versions.title'), icon: 'clock' })
    if (mobile) items.push({ key: 'share', label: t('board.post.copyLink'), icon: 'link' })
    if (canWriteNow()) {
      items.push(
        { key: 'pin', label: page.is_pinned ? t('wiki.menu.unpin') : t('wiki.menu.pin'), icon: 'star' },
        { key: 'move', label: t('wiki.menu.move'), icon: 'arrow-right' },
        { key: 'delete', label: t('common.delete'), icon: 'trash', danger: true, separated: true },
      )
    }
    const anchor = anchorOf(ev)
    setMenu({
      items, anchor, title: page.title,
      onSelect: (k) => {
        if (k === 'toc') openTocSheet()
        else if (k === 'history') void openHistory()
        else if (k === 'share') void sharePage()
        else if (k === 'pin') void togglePin(page.id)
        else if (k === 'move') openMoveMenu(page.id, anchor)
        else if (k === 'delete') void removePage(page.id)
      },
    })
  }

  function openTocSheet() {
    const list = toc
    setTimeout(() => {
      setMenu({
        items: list.map(h => ({ key: String(h.index), label: `${h.level === 3 ? '   ' : ''}${h.text}` })),
        anchor: null, title: t('wiki.rail.thisPage'),
        onSelect: (k) => { const h = list.find(x => String(x.index) === k); if (h) jumpTo(h) },
      })
    })
  }

  function openSpaceMenu(ev: MouseEvent<HTMLElement>) {
    const items: UiMenuItem[] = W().spaces.map(s => ({ key: s.id, label: s.name, radio: true, checked: s.id === W().currentSpace?.id }))
    items.push({ key: '__new', label: t('wiki.menu.newSpace'), icon: 'plus', separated: true })
    setMenu({
      items, anchor: anchorOf(ev), align: 'start', title: t('wiki.spaces'),
      onSelect: (k) => {
        if (k === '__new') setShowCreateSpace(true)
        else if (k !== W().currentSpace?.id) goSpace(k)
      },
    })
  }

  async function sharePage() {
    const page = W().currentPage
    const sp = W().currentSpace
    if (!page || !sp) return
    const url = `${window.location.origin}/wiki?space=${sp.id}&page=${page.id}`
    try {
      await writeClipboard(url)
      addToast('success', t('wiki.linkCopied'))
    } catch {
      addToast('error', t('board.post.linkCopyError'))
    }
  }

  // ─── 스페이스 만들기 · 설정 ───
  const [showCreateSpace, setShowCreateSpace] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [newSpaceName, setNewSpaceNameState] = useState('')
  const [newSpaceSlug, setNewSpaceSlug] = useState('')
  // watch(newSpaceName, v => newSpaceSlug = slugOf(v))
  function setNewSpaceName(v: string) {
    setNewSpaceNameState(v)
    if (v !== newSpaceName) setNewSpaceSlug(slugOf(v))
  }
  async function handleCreateSpace() {
    if (!newSpaceName.trim()) return
    try {
      const result = await createSpace({ name: newSpaceName.trim(), slug: newSpaceSlug || slugOf(newSpaceName) })
      setShowCreateSpace(false)
      setNewSpaceName('')
      goSpace(result.id)
    } catch (e: any) {
      addToast('error', e?.data?.detail || e.message)
    }
  }
  async function onSpaceDeleted() {
    setShowSettings(false)
    setCurrentSpace(null)
    setPageTree([])
    setCurrentPage(null)
    try { localStorage.removeItem(LAST_SPACE) } catch { /* 무시 */ }
    await fetchSpaces().catch(() => {})
    const first = W().spaces[0]
    void router.replace({ query: first ? { space: first.id } : {} })
  }

  function onSearch(q: string) {
    const sp = W().currentSpace
    if (sp) searchPages(sp.id, q).catch(() => {})
  }

  // 모바일: 트리 ↔ 본문
  const mobileShowsPage = isMobile && !!(currentPage || pageLoading || pageError)
  const mobileParentTitle = ancestors[ancestors.length - 1]?.title ?? currentSpace?.name ?? ''

  if (!user) return null

  const reconnectingText = t('wiki.save.reconnecting')
  const toolbarImage = () => imageInput.current?.click()

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background">
      {/* 트리 */}
      {(!isMobile || !mobileShowsPage) && (
        <WikiSidebar
          className={cn('min-w-0', isMobile ? 'flex-1' : '')}
          space={currentSpace}
          tree={tree}
          pages={pageTree}
          selectedId={currentPage?.id}
          canWrite={canWriteSpace}
          draftParentId={draftParentId}
          renamingId={renamingId}
          memberCount={memberCount}
          searchResults={searchResults}
          mobile={isMobile}
          onSelect={goPage}
          onSpaceMenu={openSpaceMenu}
          onNewPage={newPageHere}
          onAddChild={id => setDraftParentId(id)}
          onMenu={openNodeMenu}
          onRename={renamePage}
          onCancelRename={() => setRenamingId(null)}
          onCreateDraft={createDraft}
          onCancelDraft={() => setDraftParentId(undefined)}
          onMove={movePage}
          onSearch={onSearch}
          onOpenSettings={() => setShowSettings(true)}
          onCreateSpace={() => setShowCreateSpace(true)}
        />
      )}

      {/* 본문 */}
      {(!isMobile || mobileShowsPage) && (
        <main className="flex min-w-0 flex-1 flex-col">
          {/* 모바일 상단 바 */}
          {isMobile ? (
            <LayoutMobileDetailBar
              title={currentPage?.title ?? ''}
              subtitle={mobileParentTitle}
              backLabel={t('wiki.backToList')}
              backTo={`/wiki?space=${currentSpace?.id ?? ''}`}
              actions={(
                <>
                  {currentPage && mode === 'read' && canWrite ? (
                    <button type="button" className="h-11 px-3 text-[15px] font-semibold text-primary" onClick={() => { void startEdit() }}>{t('wiki.edit')}</button>
                  ) : mode === 'edit' ? (
                    <>
                      {saveLabel.text && (
                        <span role="status" className={cn('flex items-center gap-0.5 px-1.5 text-xs font-semibold', saveLabel.tone)}>
                          {saveLabel.icon && <UiIcon name={saveLabel.icon} className="h-3 w-3" strokeWidth={2.6} />}{saveLabel.text === reconnectingText ? t('wiki.disconnected') : saveLabel.text}
                        </span>
                      )}
                      <button type="button" className="h-11 px-3 text-[15px] font-semibold text-primary" onClick={() => { void finishEdit() }}>{t('common.done')}</button>
                    </>
                  ) : null}
                  {currentPage && <UiIconButton label={t('wiki.menu.mobileLabel')} icon="more-horizontal" size="lg" noTooltip onClick={openPageMenu} />}
                </>
              )}
            />
          ) : currentSpace ? (
            /* 데스크톱 커맨드 바 44 — 스페이스가 없으면 그릴 것이 없어 빈 띠가 되므로 숨긴다 */
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card pl-4 pr-2.5 text-[13px]">
              <nav aria-label={t('board.post.breadcrumb')} className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">
                <button type="button" className="shrink-0 hover:text-foreground" onClick={() => { void router.push({ query: { space: currentSpace.id } }) }}>{currentSpace.name}</button>
                {ancestors.map(a => (
                  <Fragment key={a.id}>
                    <UiIcon name="chevron-right" className="h-3.5 w-3.5 shrink-0" />
                    <button type="button" className="min-w-0 truncate hover:text-foreground" onClick={() => goPage(a.id)}>{a.title}</button>
                  </Fragment>
                ))}
                {currentPage && (
                  <>
                    <UiIcon name="chevron-right" className="h-3.5 w-3.5 shrink-0" />
                    <b className="min-w-0 truncate font-semibold text-foreground" aria-current="page">{currentPage.title}</b>
                  </>
                )}
              </nav>

              {currentPage && (
                <>
                  {/* 편집: 함께 편집 아바타 + 저장 상태 */}
                  {mode === 'edit' ? (
                    <>
                      {peers.length > 0 && (
                        <span className="flex shrink-0" role="img" aria-label={peersLabel} title={peersLabel}>
                          {peers.slice(0, 4).map((p, i) => (
                            <span
                              key={p.id}
                              className={cn('grid h-[26px] w-[26px] place-items-center rounded-full bg-muted text-[10px] font-semibold text-foreground', i ? 'ml-0.5' : '')}
                              style={{ boxShadow: `0 0 0 2px hsl(var(--card)), 0 0 0 4px ${p.color}` }}
                            >{p.initial}</span>
                          ))}
                          {peers.length > 4 && <span className="ml-1.5 self-center font-mono text-[11px] text-muted-foreground">+{peers.length - 4}</span>}
                        </span>
                      )}
                      {saveLabel.text && (
                        <span role="status" className={cn('mx-1.5 flex shrink-0 items-center gap-1 text-xs font-semibold', saveLabel.tone)}>
                          {saveLabel.icon && <UiIcon name={saveLabel.icon} className="h-3 w-3" strokeWidth={2.6} />}
                          {saveLabel.text}
                          {saveLabel.icon === 'check' && savedTime && <span className="font-mono font-medium text-muted-foreground">{savedTime}</span>}
                          {saveState === 'error' && <button type="button" className="ml-1 underline" onClick={() => { void retrySave() }}>{t('common.retry')}</button>}
                        </span>
                      )}
                      {/* 화면 안 AI 문서 교정 */}
                      <WikiProofreadButtons editor={liveEditor} title={editTitle} />
                      <button
                        type="button"
                        className="inline-flex h-8 shrink-0 items-center rounded-md border border-border px-3 text-xs text-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => { void finishEdit() }}
                      >{t('common.done')}</button>
                    </>
                  ) : mode === 'read' && canWrite ? (
                    <button
                      type="button"
                      className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                      aria-keyshortcuts="E"
                      onClick={() => { void startEdit() }}
                    >{t('wiki.edit')} <span className="ml-1.5 font-mono opacity-80">E</span></button>
                  ) : null}
                  <button
                    type="button"
                    className="inline-flex h-8 shrink-0 items-center rounded-md border border-border px-3 text-xs text-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => { void sharePage() }}
                  >{t('common.share')}</button>
                  <UiIconButton label={t('wiki.menu.pageMenu')} icon="more-horizontal" aria-haspopup="menu" onClick={openPageMenu} />
                </>
              )}
            </div>
          ) : null}

          {/* 편집 툴바 40 */}
          {mode === 'edit' && !isMobile && (
            <div className="shrink-0 border-b border-border">
              <UiEditorToolbar editor={liveEditor} align="center" onImage={toolbarImage} />
            </div>
          )}

          {/* 기록 미리보기 띠 44 */}
          {mode === 'history' && selectedVersion && (
            <div
              role="status"
              className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-warning/35 bg-warning/10 py-1.5 pl-4 pr-3 text-[13px]"
            >
              <b className="font-semibold text-foreground">v{selectedVersion.version_number} {t('wiki.historyView.preview')}</b>
              <span className="text-muted-foreground"><span className="font-mono">{fmtStamp(selectedVersion.created_at)}</span> · {nameOf(selectedVersion.author)}{showChanges && selectedVersion.version_number !== currentPage?.version && <> · {t('wiki.historyView.comparing')}</>}</span>
              <span className="flex-1" />
              <UiSwitch modelValue={showChanges} onUpdateModelValue={setShowChanges} label={t('wiki.historyView.showChanges')} className="text-xs" />
              {canWrite && selectedVersion.version_number !== currentPage?.version && <UiButton size="xs" onClick={() => { void restoreSelected() }}>{t('wiki.historyView.restoreThis')}</UiButton>}
              {isMobile && <UiButton size="xs" variant="outline" onClick={() => setVersionListOpen(true)}>{t('wiki.historyView.list')}</UiButton>}
              <UiButton size="xs" variant="outline" onClick={closeHistory}>{t('common.close')}</UiButton>
            </div>
          )}

          <div className="flex min-h-0 flex-1">
            {/* 본문 */}
            <article ref={articleRef} className="min-w-0 flex-1 overflow-y-auto px-5 pt-5 md:px-6 md:pt-9" onScroll={onArticleScroll}>
              <div className="mx-auto max-w-reading pb-16">
                {booting || pageLoading ? (
                  <UiSkeleton preset="text" rows={8} />
                ) : pageError ? (
                  <UiErrorTile
                    placement="panel"
                    title={t('wiki.pageError.title')}
                    detail={t('wiki.pageError.detail')}
                    onRetry={() => { const p = queryString(curQuery().page); if (p) void openPage(String(p)) }}
                  />
                ) : currentPage ? (
                  <>
                    {/* 제목 */}
                    {mode === 'edit' ? (
                      <input
                        value={editTitle}
                        onChange={e => onEditTitle(e.target.value)}
                        type="text"
                        autoComplete="off"
                        aria-label={t('wiki.pageTitle')}
                        className="w-full bg-transparent text-2xl font-bold tracking-[-0.02em] text-foreground outline-hidden placeholder:text-muted-foreground md:text-[30px] md:leading-tight"
                        placeholder={t('wiki.titlePlaceholder')}
                      />
                    ) : (
                      <h1 className="break-words text-2xl font-bold tracking-[-0.02em] text-foreground md:text-[30px] md:leading-tight">{currentPage.title}</h1>
                    )}
                    {/* 메타 한 줄 */}
                    <p className="mt-1.5 text-xs text-muted-foreground md:mt-2">
                      {metaPeople.creator && <>{t('wiki.meta.createdBy', { name: metaPeople.creator })} · </>}
                      {metaPeople.editor && <>{metaPeople.others ? t('wiki.meta.editedByMany', { name: metaPeople.editor, n: metaPeople.others }) : t('wiki.meta.editedBy', { name: metaPeople.editor })} · </>}
                      <span className="font-mono">{fmtStamp(currentPage.updated_at)}</span> · <span className="font-mono">v{currentPage.version}</span>
                    </p>

                    {mode === 'edit' ? (
                      /* 편집(실시간 공동 편집) */
                      <div className="wiki-body mt-5 md:mt-7">
                        <WikiCollabEditor
                          ref={editorRef}
                          pageId={currentPage.id}
                          initialContent={currentPage.content}
                          readonly={false}
                          onChange={onEditorChange}
                          onUpdateState={setCollab}
                        />
                        <WikiProofreadCard editor={liveEditor} title={editTitle} />
                      </div>
                    ) : mode === 'history' && selectedVersion ? (
                      /* 기록 미리보기 */
                      <div
                        className="wiki-body wiki-diff prose mt-5 max-w-none break-words text-base leading-[1.75] dark:prose-invert md:mt-7 md:text-[15px]"
                        dangerouslySetInnerHTML={{ __html: previewHtml }}
                      />
                    ) : readHtml ? (
                      /* 읽기 */
                      <div
                        className="wiki-body prose mt-5 max-w-none break-words text-base leading-[1.75] dark:prose-invert md:mt-7 md:text-[15px]"
                        dangerouslySetInnerHTML={{ __html: readHtml }}
                      />
                    ) : (
                      <UiEmptyState
                        variant="inline"
                        icon="file-text"
                        title={t('wiki.emptyPage')}
                        description={canWrite ? t('wiki.emptyPageHint') : undefined}
                        actionLabel={canWrite ? t('wiki.edit') : undefined}
                        onAction={() => { void startEdit() }}
                      />
                    )}
                  </>
                ) : !isMobile ? (
                  currentSpace ? (
                    <UiEmptyState
                      variant="full"
                      icon="book-open"
                      title={pageTree.length ? t('wiki.pickPageLeft') : t('wiki.sidebar.emptyYet')}
                      description={!pageTree.length && canWriteSpace ? t('wiki.sidebar.emptyHint') : undefined}
                      actionLabel={!pageTree.length && canWriteSpace ? t('wiki.createPage') : undefined}
                      onAction={newPageHere}
                    />
                  ) : (
                    <UiEmptyState
                      variant="full"
                      icon="book-open"
                      title={t('wiki.noSpaces.title')}
                      description={t('wiki.noSpaces.desc')}
                      actionLabel={t('wiki.createSpace')}
                      onAction={() => setShowCreateSpace(true)}
                    />
                  )
                ) : null}
              </div>
            </article>

            {/* 오른쪽 레일 240(읽기·편집) */}
            {!isMobile && currentPage && mode !== 'history' && (
              <WikiRail
                className="hidden xl:block"
                toc={toc}
                activeIndex={activeToc}
                versions={versions}
                pageId={currentPage.id}
                spaceName={currentSpace?.name ?? null}
                onJump={jumpTo}
                onHistory={() => { void openHistory() }}
              />
            )}
            {/* 버전 패널 320(기록) — 모바일은 전체 화면 */}
            {currentPage && mode === 'history' && (!isMobile || versionListOpen) && (
              <WikiVersionPanel
                versions={versions}
                selectedNumber={selectedVersion?.version_number ?? null}
                stats={versionStats}
                loading={loadingVersions}
                mobile={isMobile}
                onSelect={pickVersion}
                onClose={() => { if (isMobile && selectedVersion) setVersionListOpen(false); else closeHistory() }}
              />
            )}
          </div>

          {/* 모바일 편집 툴바(키보드 위 한 줄 + Aa) */}
          {isMobile && mode === 'edit' && <UiEditorToolbar editor={liveEditor} variant="mobile" onImage={toolbarImage} />}
        </main>
      )}

      <input ref={imageInput} type="file" className="hidden" accept="image/*,.pdf,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" onChange={onImagePicked} />

      {menu && (
        <UiMenu
          items={menu.items}
          anchor={menu.anchor}
          title={menu.title}
          align={menu.align ?? 'end'}
          width={220}
          dense
          onSelect={menu.onSelect}
          onClose={() => setMenu(null)}
        />
      )}

      {/* 스페이스 만들기 */}
      {showCreateSpace && (
        <UiModal
          size="md"
          title={t('wiki.createSpace')}
          onClose={() => setShowCreateSpace(false)}
          footer={(
            <>
              <UiButton variant="outline" size="sm" onClick={() => setShowCreateSpace(false)}>{t('common.cancel')}</UiButton>
              <UiButton size="sm" disabled={!newSpaceName.trim()} onClick={() => { void handleCreateSpace() }}>{t('common.create')}</UiButton>
            </>
          )}
        >
          <div className="flex flex-col gap-3">
            <UiInput
              modelValue={newSpaceName}
              onUpdateModelValue={setNewSpaceName}
              label={t('wiki.spaceName')}
              data-autofocus
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateSpace() }}
            />
            <UiInput modelValue={newSpaceSlug} onUpdateModelValue={setNewSpaceSlug} label={t('wiki.slug')} mono />
          </div>
        </UiModal>
      )}

      {showSettings && currentSpace && (
        <WikiSpaceSettings
          space={currentSpace}
          onClose={() => setShowSettings(false)}
          onDeleted={() => { void onSpaceDeleted() }}
          onMembers={n => setMemberCount(n)}
        />
      )}
    </div>
  )
}
