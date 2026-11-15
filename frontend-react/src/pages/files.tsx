/**
 * 파일(Vue pages/files.vue).
 * 데스크톱: 사이드바 236 · 커맨드 바 44(경로 바 안, 선택 모드로 변신) · 목록/그리드 · 상세 패널 320.
 * 모바일: 상단 56(‹ 상위 · 이름 · 검색 · ⋯ 보기·정렬) · 행 56 + ⋮ 40 상시 · FAB 56 · 선택 바/전송 카드는 탭바 위 8.
 * 클릭 = 열기(이미지·PDF·텍스트 미리보기 모달, 오피스 새 탭, 폴더 들어가기), 상세 = ⋮ "상세 정보" 또는 Space.
 * 공유받은 항목: 미리보기·오피스도 같은 규칙(서버가 권한대로 보기/편집), ⋮ 메뉴·상세 패널(댓글 탭)도 공유받음 화면에서 연다.
 *   공동 소유면 공유·이동(같은 공유 폴더 안)·이름 바꾸기(입력 대화상자)·휴지통(원 소유자 휴지통)까지.
 * 모바일 머리는 FileMobileHeader — 공용 상단바는 쓰지 않는다(routes.ts ownMobileHeader).
 */
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type MouseEvent } from 'react'
import { aiArtifactError, aiZipAndDownload } from '~/utils/aiArtifacts'
import { addTransfer, finishTransfer, updateProgress } from '~/composables/useTransfers'
import { clsx } from 'clsx'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { useHead } from '~/lib/head'
import { useRoute, queryString } from '~/lib/router'
import { sharedSubPath, textOr, type FileAction } from '~/lib/files'
import { useFiles, filesStore, type DeleteItemsError, type FileItem } from '~/composables/useFiles'
import { useTransfers } from '~/composables/useTransfers'
import { useAuth } from '~/composables/useAuth'
import { useIsMobile } from '~/composables/useIsMobile'
import { useToast } from '~/composables/useToast'
import { confirmBox, promptBox } from '~/composables/useDialog'
import { useSiteConfig, useZoneInstalled } from '~/composables/useSiteConfig'
import { useDesktopShell } from '~/composables/useDesktopShell'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { useStorageStatus, useStorageWatch } from '~/composables/useStorageStatus'
import { UiIcon } from '~/components/ui/Icon'
import { UiFab } from '~/components/ui/Fab'
import { UiActionSheet } from '~/components/ui/ActionSheet'
import { UiSegment } from '~/components/ui/Segment'
import { FilesFileSidebar } from '~/components/files/FileSidebar'
import { FilesFileMobileHeader } from '~/components/files/FileMobileHeader'
import { FilesFileCommandBar } from '~/components/files/FileCommandBar'
import { FilesFileList } from '~/components/files/FileList'
import { FilesFileGridView } from '~/components/files/FileGridView'
import { FilesFileDetailPanel, type FileDetailTab } from '~/components/files/FileDetailPanel'
import { FilesFileTrashView } from '~/components/files/FileTrashView'
import { FilesFileLinksView } from '~/components/files/FileLinksView'
import { FilesFileSharedView } from '~/components/files/FileSharedView'
import { FilesFileQuickView } from '~/components/files/FileQuickView'
import { FilesFileMobileSelectBar } from '~/components/files/FileMobileSelectBar'
import { FilesTransferPanel } from '~/components/files/TransferPanel'
import { FilesFileContextMenu } from '~/components/files/FileContextMenu'
import { FilesFilePreviewModal } from '~/components/files/FilePreviewModal'
import { FilesFileShareModal } from '~/components/files/FileShareModal'
import { FilesFileMoveDialog } from '~/components/files/FileMoveDialog'
import { FilesFileTypeIcon } from '~/components/files/FileTypeIcon'
import { FilesFileStorageDown } from '~/components/files/FileStorageDown'
import { getUiZoom } from '~/composables/useViewport'

const SHELL_VIEWS = ['trash', 'links', 'shared-with-me', 'recent', 'starred'] as const
type ShellView = typeof SHELL_VIEWS[number]
const isShellView = (v: unknown): v is ShellView => typeof v === 'string' && (SHELL_VIEWS as readonly string[]).includes(v)

const SORTS = [
  { field: 'name', labelKey: 'files.list.nameColumn' },
  { field: 'modified_at', labelKey: 'files.page.sortModified' },
  { field: 'size', labelKey: 'files.list.sizeColumn' },
] as const

export default function FilesPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  // 데스크톱 셸이 위치 목록을 그린다.
  const { navOwnedByShell } = useDesktopShell()
  useHead({ title: `${t('nav.files')} | ${appName}` })

  const {
    viewMode,
    setViewMode,
    selectedItems,
    setSelectedItems,
    sortedItems,
    fetchFiles,
    fetchStorageInfo,
    downloadFile,
    downloadMultiple,
    deleteItems,
    renameItem,
    createFolder,
    uploadFiles,
    isOfficeFile,
    currentPath,
    breadcrumbs,
    navigateTo: openFolder,
    enterFolder,
    openFileLocation,
    searchActive,
    exitSearch,
    view,
    setView,
    setInlineEdit,
    moveItems,
    emptyTrash,
    trashItems,
    sortField,
    sortDir,
    toggleSort,
    markRecent,
    setStar,
    refreshSharedView,
    sharedBrowse,
  } = useFiles()
  const { transfers } = useTransfers()
  const { user } = useAuth()
  // 저장소가 끊기면 목록·올리기 대신 끊김 안내만 보인다(돌아오면 스스로 풀린다)
  useStorageWatch(true)
  const { down: storageDown } = useStorageStatus()
  const wasStorageDown = useRef(false)
  useEffect(() => {
    if (storageDown) { wasStorageDown.current = true; return }
    if (!wasStorageDown.current) return
    wasStorageDown.current = false
    // 끊긴 동안 못 읽은 목록·사용량을 새로 받는다
    void fetchFiles()
    void fetchStorageInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageDown])
  const route = useRoute()
  const isMobile = useIsMobile()
  const { toast, addToast } = useToast()

  // 3단 경로의 "위치"(상단바) — 현재 폴더 또는 뷰 이름
  const VIEW_LABEL: Record<string, string> = { 'shared-with-me': t('files.view.sharedWithMe'), recent: t('files.sidebar.recent'), starred: t('files.sidebar.starred'), links: t('files.share.linkLabel'), trash: t('files.view.trash') }
  useBreadcrumb(view !== 'files' ? VIEW_LABEL[view] : (breadcrumbs.at(-1)?.label ?? ''))

  /**
   * 셸이 고른 위치로 이동한다.
   *
   * 셸은 위치 열을 자기가 그리고 `?path=my|shared|my/<폴더>` 로 넘긴다. 이걸 읽지
   * 않으면 공유 파일을 눌러도 내 파일이 그대로 남는다. `?view=trash|links|shared-with-me` 는 시안 뷰.
   */
  const qPath = queryString(route.query.path)
  const qView = queryString(route.query.view)
  const firstScope = useRef(true)
  useEffect(() => {
    if (firstScope.current) { firstScope.current = false; return }
    if (isShellView(qView)) { setView(qView); return }
    if (qPath) openFolder(qPath)
  }, [qPath, qView]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 모달·패널 상태 ──
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null)
  const [shareTargets, setShareTargets] = useState<FileItem[] | null>(null)
  /** 공유 모달을 열 때 먼저 보일 탭(채널로 보내기 = 사람·채널 탭) */
  const [shareTab, setShareTab] = useState<'link' | 'people' | null>(null)
  const [moveTargets, setMoveTargets] = useState<string[] | null>(null)
  const [contextMenu, setContextMenu] = useState<{ item: FileItem; x: number; y: number } | null>(null)
  const [detailItem, setDetailItem] = useState<FileItem | null>(null)
  const [detailTab, setDetailTab] = useState<FileDetailTab>('info')
  const [showViewSheet, setShowViewSheet] = useState(false)
  const [showNewSheet, setShowNewSheet] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const mobileUpload = useRef<HTMLInputElement | null>(null)

  const anyModal = !!(previewFile || shareTargets || moveTargets || contextMenu || showViewSheet || showNewSheet)

  // 상세 패널의 항목은 목록이 새로 고쳐지면(이름 바꾸기 등) 새 객체로 바꿔 둔다
  useEffect(() => {
    setDetailItem((cur) => {
      if (!cur) return cur
      const same = sortedItems.find(i => i.path === cur.path)
      return same ?? cur
    })
  }, [sortedItems])

  // Esc = 선택 해제(시안 "선택 해제 (Esc)") — 모달·메뉴가 열려 있으면 그쪽이 먼저 받는다
  const keyState = useRef({ anyModal, isMobile, detailItem })
  keyState.current = { anyModal, isMobile, detailItem }
  useEffect(() => {
    // 셸이 위치를 지정했으면 그쪽으로 연다. 셸은 매번 전체 로드라 여기가 주 경로다.
    const v = qView
    if (isShellView(v)) setView(v)
    else {
      if (filesStore.getState().view !== 'files') setView('files')
      fetchFiles(qPath || undefined)
    }
    fetchStorageInfo()
    function onPageKey(e: KeyboardEvent) {
      const k = keyState.current
      if (e.key !== 'Escape' || k.anyModal || filesStore.getState().inlineEdit) return
      if (filesStore.getState().selectedItems.size) { setSelectedItems(new Set()); return }
      if (k.detailItem && !k.isMobile) setDetailItem(null)
    }
    document.addEventListener('keydown', onPageKey)
    return () => {
      document.removeEventListener('keydown', onPageKey)
      setInlineEdit(null)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 열기 ──
  function openItem(item: FileItem) {
    if (item.is_dir) {
      if (filesStore.getState().searchActive) enterFolder(item)
      else openFolder(item.path)
      return
    }
    // 공유받은 항목도 같은 길 — 미리보기·다운로드·오피스 API 가 shared-with-me/ 경로를 권한대로 받는다
    markRecent(item.path)
    if (docsOn && isOfficeFile(item.name)) { openInlineEditor(item); return }
    // 이미지·PDF·텍스트는 미리보기, 그 밖은 미리보기 모달의 "미리 볼 수 없음 + 다운로드"
    setPreviewFile(item)
  }

  // 문서 편집기는 문서 구역 것 — 설치되지 않았으면 "새 문서"·편집으로 열기를 숨기고 오피스 파일은 미리보기(내려받기)로 연다
  const docsOn = useZoneInstalled('docs')

  // 새 Office 문서 — 빈 docx/xlsx/pptx 를 만들어 바로 OnlyOffice 로 연다.
  // 이름을 먼저 묻지 않는다(제목은 편집기에서 "다른 이름으로" 또는 파일 목록에서 바꾼다).
  // 만드는 일은 새 탭(/office/open?new=)이 한다 — 돌아오면 목록을 새로 읽는다.
  function handleNewDoc(kind: 'doc' | 'sheet' | 'slide' = 'doc') {
    if (openOfficeTab(`/office/open?new=${kind}&dir=${encodeURIComponent(filesStore.getState().currentPath || 'my')}`)) {
      window.addEventListener('focus', () => fetchFiles(), { once: true })
    }
  }

  /**
   * 오피스 문서는 새 탭에서 편집(인라인 iframe 은 해상도 손실). 새 탭은 앱 페이지 /office/open 이
   * "여는 중" 화면(10초 넘으면 미리보기로 열기)을 그리고 편집기로 넘어간다.
   * 클릭 제스처 안에서 바로 주소로 열어 팝업 차단을 피한다.
   */
  function openOfficeTab(url: string): boolean {
    const win = window.open(url, '_blank')
    if (!win) { addToast('error', t('files.page.popupBlocked')); return false }
    return true
  }
  function openInlineEditor(target: Pick<FileItem, 'path' | 'name'>) {
    openOfficeTab(`/office/open?path=${encodeURIComponent(target.path)}`)
  }

  // ── 메뉴(⋮·우클릭·길게 누르기 후 ⋮) ──
  function openMenu(e: MouseEvent, item: FileItem) {
    let x = e.clientX
    let y = e.clientY
    if (!x && !y) {   // 키보드로 ⋮ 를 누른 경우 — 버튼 아래에
      const r = (e.target as HTMLElement | null)?.closest('button')?.getBoundingClientRect()
      // 사각형은 화면 좌표(배율 적용 뒤)라 메뉴 폭·간격도 배율만큼
      const z = getUiZoom()
      if (r) { x = r.right - 224 * z; y = r.bottom + 4 * z }
    }
    setContextMenu({ item, x, y })
  }

  // ── 공유받은 항목(공동 소유) 동작 — 목록 대신 공유받음 화면을 다시 읽는다 ──
  async function renameShared(item: FileItem) {
    const name = await promptBox(t('files.rename.prompt'), { title: t('files.action.rename'), defaultValue: item.name, confirmLabel: t('common.save') })
    if (!name || !name.trim() || name.trim() === item.name) return
    try {
      await $fetch('/api/files/rename', { method: 'PATCH', body: { path: item.path, new_name: name.trim() } })
      setDetailItem(cur => (cur?.path === item.path ? null : cur))
      await refreshSharedView()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.rename.error'))
    }
  }
  async function deleteShared(item: FileItem) {
    if (!await confirmBox(t('files.page.trashConfirmShared', { name: item.name }), { title: t('files.action.toTrash'), confirmLabel: t('files.action.toTrash'), danger: true })) return
    try {
      await $fetch('/api/files/delete', { method: 'DELETE', params: { path: item.path } })
      setDetailItem(cur => (cur?.path === item.path ? null : cur))
      toast({ type: 'success', title: t('files.page.trashedShared') })
      await refreshSharedView()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.delete.error'))
    }
  }
  // 이동 대화상자 루트 — 공유받은 항목은 그 공유 폴더 안에서만(서버도 같은 소유자 영역만 허용)
  const moveRoots = (() => {
    const first = moveTargets?.[0]
    const sp = first ? sharedSubPath(first) : null
    if (!sp) return undefined
    const b = sharedBrowse
    const name = b && b.shareId === sp.shareId ? b.rootName : (first?.split('/').pop() || '')
    return [{ path: `shared-with-me/${sp.shareId}`, name }]
  })()
  function onMoveDone() {
    setSelectedItems(new Set())
    if (filesStore.getState().view === 'shared-with-me') void refreshSharedView()
  }

  function onMenuAction(key: FileAction, item: FileItem) {
    if (sharedSubPath(item.path)) {
      if (key === 'rename') { renameShared(item); return }
      if (key === 'delete') { deleteShared(item); return }
    }
    switch (key) {
      case 'open': openItem(item); break
      case 'share': setShareTab(null); setShareTargets([item]); break
      case 'channel': setShareTab('people'); setShareTargets([item]); break
      case 'star': toggleStar(item); break
      case 'move': setMoveTargets([item.path]); break
      case 'rename': startRename(item); break
      case 'versions': setDetailItem(item); setDetailTab('versions'); break
      case 'download': downloadFile(item.path, item.is_dir); break
      case 'detail': setDetailItem(item); setDetailTab('info'); break
      case 'location': openFileLocation(item); break
      case 'delete': deleteOne(item); break
    }
  }

  async function toggleStar(item: FileItem) {
    const on = !item.is_starred
    try {
      await setStar(item.path, on)
      setDetailItem(cur => (cur?.path === item.path ? { ...cur, is_starred: on } : cur))
      addToast('success', on ? t('files.star.added') : t('files.star.removed'))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.star.error'))
    }
  }

  async function deleteOne(item: FileItem) {
    if (!await confirmBox(t('files.page.trashConfirmOne', { name: item.name }), { title: t('files.action.toTrash'), confirmLabel: t('files.action.toTrash'), danger: true })) return
    try {
      await deleteItems([item.path])
      setDetailItem(cur => (cur?.path === item.path ? null : cur))
      toast({ type: 'success', title: t('files.page.trashed'), action: { label: t('files.page.viewTrash'), onClick: () => setView('trash') } })
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.delete.error'))
    }
  }

  // ── 이름 입력: 목록 맨 위 인라인 행 ──
  function startNewFolder() {
    if (filesStore.getState().searchActive) exitSearch()
    if (filesStore.getState().view !== 'files') setView('files')
    setInlineEdit({ kind: 'new-folder' })
  }
  function startRename(item: FileItem) {
    setInlineEdit({ kind: 'rename', path: item.path })
  }
  async function commitNewFolder(name: string) {
    try {
      await createFolder(name)
      setInlineEdit(null)
    } catch (e: any) {
      setInlineEdit(null)
      addToast('error', e?.data?.detail || t('files.newFolder.createError'))
    }
  }
  async function commitRename(item: FileItem, name: string) {
    try {
      await renameItem(item.path, name)
      setInlineEdit(null)
      setDetailItem(cur => (cur?.path === item.path ? null : cur))
    } catch (e: any) {
      setInlineEdit(null)
      addToast('error', e?.data?.detail || t('files.rename.error'))
    }
  }

  // ── 선택 모드 일괄 동작 ──
  function selectedList() { return sortedItems.filter(i => selectedItems.has(i.path)) }
  function bulkShare() { const l = selectedList(); if (l.length) { setShareTab(null); setShareTargets([...l]) } }
  function bulkMove() { if (selectedItems.size) setMoveTargets([...selectedItems]) }
  async function bulkDownload() {
    const paths = [...selectedItems]
    if (!paths.length) return
    // 1개면 그대로, 여러 개면 zip 하나로 묶어 다운로드
    if (paths.length === 1) {
      const item = sortedItems.find(i => i.path === paths[0])
      downloadFile(paths[0], item?.is_dir ?? false)
    } else {
      await downloadMultiple(paths)
    }
  }
  /** 서버에서 압축(파일 수·크기 상한, 권한 재검사, 진행률) → 내려받기. zip 은 내 파일 › AI 결과물에도 남는다 */
  async function zipDownload(body: { paths?: string[]; query?: string }, label: string) {
    try {
      const job = await aiZipAndDownload(body, label, { addTransfer, updateProgress, finishTransfer })
      toast({ type: job.failed ? 'warning' : 'success', title: t(job.failed ? 'files.zip.donePartial' : 'files.zip.done', { n: job.ok, failed: job.failed }), description: job.zip?.saved_label ? t('files.zip.savedTo', { folder: job.zip.saved_label }) : undefined })
    } catch (e: any) {
      addToast('error', aiArtifactError(e).message || t('files.zip.failed'))
    }
  }
  function bulkZip() { const paths = [...selectedItems]; if (paths.length) void zipDownload({ paths }, t('files.zip.transfer', { n: paths.length })) }
  function searchZip() { const q = filesStore.getState().searchQuery; if (q) void zipDownload({ query: q }, t('files.zip.transferSearch', { q })) }
  async function bulkDelete() {
    const paths = [...selectedItems]
    if (!paths.length) return
    if (!await confirmBox(t('files.page.trashConfirmMany', { n: paths.length }), { title: t('files.action.toTrash'), confirmLabel: t('files.action.toTrash'), danger: true })) return
    try {
      await deleteItems(paths)
      setSelectedItems(new Set())
      toast({ type: 'success', title: t('files.page.trashedMany', { n: paths.length }), action: { label: t('files.page.viewTrash'), onClick: () => setView('trash') } })
    } catch (e: any) {
      // 일부만 실패 — 지워진 것은 목록에서 빠졌고(deleteItems 가 새로 읽는다) 못 지운 것만 선택으로 남긴다
      const err = e as Partial<DeleteItemsError>
      if (Array.isArray(err.failed) && err.failed.length) {
        setSelectedItems(new Set(err.failed))
        const names = err.failed.map(p => p.split('/').pop() || p).join(', ')
        addToast('error', textOr(t, 'files.delete.partial', '{n}개를 지우지 못했습니다: {list}', { n: err.failed.length, list: names })
          + (err.data?.detail ? ` (${err.data.detail})` : ''))
        return
      }
      addToast('error', e?.data?.detail || t('files.delete.error'))
    }
  }

  // ── 끌어다 놓기 이동 ──
  async function onDropMove(paths: string[], dst: string) {
    const failed = await moveItems(paths, dst)
    setSelectedItems(new Set())
    const name = dst.split('/').pop() || dst
    if (failed.length) addToast('error', t('files.move.moveFailed', { n: failed.length, list: failed.join(', ') }))
    else toast({ type: 'success', title: t('files.page.movedMany', { n: paths.length, name: name === 'my' ? t('files.sidebar.myFiles') : name === 'shared' ? t('files.sidebar.sharedFiles') : name }) })
  }

  // ── 업로드: 바깥 파일 끌어다 놓기(전송 패널에 진행) ──
  const dropTargetName = breadcrumbs.at(-1)?.label ?? ''
  function hasFiles(e: DragEvent) { return !!e.dataTransfer?.types.includes('Files') }
  function handleDragOver(e: DragEvent) {
    if (!hasFiles(e) || view !== 'files') return
    e.preventDefault()
    setIsDragOver(true)
  }
  function handleDragLeave(e: DragEvent) {
    if (e.currentTarget === e.target || !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setIsDragOver(false)
  }
  async function handleDrop(e: DragEvent) {
    if (!hasFiles(e)) return
    e.preventDefault()
    setIsDragOver(false)
    if (storageDown) return
    // 폴더는 끌어다 놓아 올릴 수 없다(파일 목록에 폴더가 크기 0짜리로 섞여 "네트워크 오류"로 실패했다) — 빼고 알린다.
    // 항목 판정(webkitGetAsEntry)은 이 이벤트 안에서만 읽을 수 있어 먼저 다 읽어 둔다.
    const items = Array.from(e.dataTransfer?.items || [])
    let files = Array.from(e.dataTransfer?.files || [])
    let folders = 0
    if (items.length && items.some(i => typeof i.webkitGetAsEntry === 'function')) {
      files = []
      for (const it of items) {
        if (it.kind !== 'file') continue
        if (it.webkitGetAsEntry?.()?.isDirectory) { folders++; continue }
        const file = it.getAsFile()
        if (file) files.push(file)
      }
    }
    if (folders) addToast('warning', textOr(t, 'files.upload.folderDropUnsupported', '폴더는 끌어다 놓아 올릴 수 없습니다. 폴더 안의 파일을 골라 올려 주세요'))
    if (files.length) await uploadFiles(files)
  }
  function onMobilePick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const files = Array.from(input.files || [])
    if (files.length) uploadFiles(files)
    input.value = ''
  }

  async function onEmptyTrash() {
    if (!await confirmBox(t('files.page.emptyTrashConfirm', { n: trashItems.length }), { title: t('files.trash.empty'), confirmLabel: t('files.page.deleteForever'), danger: true })) return
    try {
      await emptyTrash()
      toast({ type: 'success', title: t('files.page.trashEmptied') })
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.page.emptyTrashError'))
    }
  }

  // ── 모바일 시트 ──
  const mobileSelecting = isMobile && view === 'files' && selectedItems.size > 0
  const showFab = view === 'files' && !mobileSelecting && !transfers.length && !detailItem && !currentPath.startsWith('users')

  const VIEW_ROWS: { key: string; label: string; path?: string; view?: ShellView }[] = [
    { key: 'my', label: t('files.sidebar.myFiles'), path: 'my' },
    { key: 'shared-with-me', label: t('files.view.sharedWithMe'), view: 'shared-with-me' },
    { key: 'shared', label: t('files.sidebar.sharedFiles'), path: 'shared' },
    { key: 'recent', label: t('files.sidebar.recent'), view: 'recent' },
    { key: 'starred', label: t('files.sidebar.starred'), view: 'starred' },
    { key: 'links', label: t('files.share.linkLabel'), view: 'links' },
    { key: 'trash', label: t('files.view.trash'), view: 'trash' },
  ]
  if (user?.is_admin) VIEW_ROWS.push({ key: 'users', label: t('files.sidebar.allUsers'), path: 'users' })
  function rowActive(r: { path?: string; view?: string }) {
    if (r.view) return view === r.view
    return view === 'files' && (currentPath === r.path || currentPath.startsWith(r.path + '/'))
  }
  function goRow(r: { path?: string; view?: ShellView }) {
    setShowViewSheet(false)
    if (r.view) setView(r.view)
    else if (r.path) openFolder(r.path)
  }
  const onViewModel = (v: string | number | null) => { if (v === 'list' || v === 'grid') setViewMode(v) }
  const viewItems = [{ value: 'list', label: t('files.commandBar.list'), icon: 'list' }, { value: 'grid', label: t('files.commandBar.grid'), icon: 'grid' }]

  function newFromSheet(kind: 'upload' | 'folder' | 'doc' | 'sheet' | 'slide') {
    setShowNewSheet(false)
    if (kind === 'upload') mobileUpload.current?.click()
    else if (kind === 'folder') startNewFolder()
    else handleNewDoc(kind)
  }

  const openDetail = (i: FileItem) => { setDetailItem(i); setDetailTab('info') }
  const openShareFor = (i: FileItem) => { setShareTab(null); setShareTargets([i]) }

  if (storageDown) return <FilesFileStorageDown admin={!!user?.is_admin} />

  return (
    <div
      className="relative flex h-full overflow-hidden"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 사이드바(데스크톱) */}
      {!navOwnedByShell && <FilesFileSidebar className="hidden md:flex" onDropMove={onDropMove} />}

      {/* 본문 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <FilesFileMobileHeader onOpenViewSheet={() => setShowViewSheet(true)} />
        <FilesFileCommandBar
          className="hidden md:flex"
          onUpload={uploadFiles}
          onNewFolder={startNewFolder}
          onNewDoc={() => handleNewDoc('doc')}
          onNewSheet={() => handleNewDoc('sheet')}
          onNewSlide={() => handleNewDoc('slide')}
          onBulkShare={bulkShare}
          onBulkMove={bulkMove}
          onBulkDownload={bulkDownload}
          onBulkZip={bulkZip}
          onSearchZip={searchZip}
          onBulkDelete={bulkDelete}
          onEmptyTrash={onEmptyTrash}
          onDropMove={onDropMove}
        />

        <div className="relative flex min-h-0 flex-1">
          {/* 바깥 파일 끌어다 놓기(D3b): 목록 위 점선 2px primary · rounded 16 · primary/0.08 · 15/600 */}
          {isDragOver && (
            <div
              className="pointer-events-none absolute inset-3 z-dropdown flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/[0.08] px-6 text-center text-[15px] font-semibold text-primary md:inset-6"
              aria-live="polite"
            >{dropTargetName ? t('files.upload.dropInto', { name: dropTargetName }) : t('files.upload.dropHere')}</div>
          )}
          {view === 'files'
            ? (
              <>
                {viewMode === 'list'
                  ? (
                    <FilesFileList
                      onOpen={openItem}
                      onMenu={openMenu}
                      onDetail={openDetail}
                      onDropMove={onDropMove}
                      onCommitNewFolder={commitNewFolder}
                      onCommitRename={commitRename}
                    />
                  )
                  : (
                    <FilesFileGridView
                      onOpen={openItem}
                      onMenu={openMenu}
                      onDetail={openDetail}
                      onDropMove={onDropMove}
                      onCommitNewFolder={commitNewFolder}
                      onCommitRename={commitRename}
                    />
                  )}
                {detailItem && (
                  <FilesFileDetailPanel
                    tab={detailTab}
                    onUpdateTab={setDetailTab}
                    item={detailItem}
                    onClose={() => setDetailItem(null)}
                    onShare={openShareFor}
                    onStar={toggleStar}
                  />
                )}
              </>
            )
            : view === 'trash'
              ? <FilesFileTrashView />
              : view === 'links'
                ? <FilesFileLinksView />
                : view === 'shared-with-me'
                  ? (
                    <>
                      <FilesFileSharedView onOpen={openItem} onMenu={openMenu} />
                      {detailItem && sharedSubPath(detailItem.path) && (
                        <FilesFileDetailPanel
                          tab={detailTab}
                          onUpdateTab={setDetailTab}
                          item={detailItem}
                          onClose={() => setDetailItem(null)}
                          onShare={openShareFor}
                          onStar={toggleStar}
                          onRenamed={(it) => { setDetailItem(it); void refreshSharedView() }}
                        />
                      )}
                    </>
                  )
                  : view === 'recent' || view === 'starred'
                    ? <FilesFileQuickView kind={view} onOpen={openItem} />
                    : null}
        </div>
      </div>

      {/* 모바일 떠 있는 요소(탭바 위 8부터 쌓음) */}
      {mobileSelecting && (
        <FilesFileMobileSelectBar
          onShare={bulkShare}
          onMove={bulkMove}
          onDownload={bulkDownload}
          onDelete={bulkDelete}
        />
      )}
      {showFab && <UiFab label={t('files.page.uploadOrNew')} onClick={() => setShowNewSheet(true)} />}
      <input ref={mobileUpload} type="file" multiple className="hidden" tabIndex={-1} aria-hidden="true" onChange={onMobilePick} />

      {/* 전송 진행: 선택 여부와 무관하게 항상 떠 있어야 한다. */}
      <FilesTransferPanel raised={mobileSelecting} />

      {/* 메뉴·모달 */}
      {contextMenu && (
        <FilesFileContextMenu
          item={contextMenu.item}
          x={contextMenu.x}
          y={contextMenu.y}
          inSearch={searchActive}
          onClose={() => setContextMenu(null)}
          onAction={onMenuAction}
        />
      )}
      {previewFile && (
        <FilesFilePreviewModal
          item={previewFile}
          onClose={() => setPreviewFile(null)}
          onOpenEditor={(item) => { setPreviewFile(null); openInlineEditor(item) }}
        />
      )}
      {shareTargets && <FilesFileShareModal items={shareTargets} initialTab={shareTab} onClose={() => setShareTargets(null)} />}
      {moveTargets && <FilesFileMoveDialog paths={moveTargets} roots={moveRoots} onClose={() => setMoveTargets(null)} onDone={onMoveDone} />}

      {/* 모바일: 보기·정렬(⋯) */}
      {showViewSheet && (
        <UiActionSheet label={t('files.mobile.viewSort')} onClose={() => setShowViewSheet(false)}>
          <div className="px-4 pb-1 text-xs font-semibold text-muted-foreground">{t('files.detail.location')}</div>
          {VIEW_ROWS.map(r => (
            <button
              key={r.key}
              type="button"
              className={clsx('flex h-12 w-full items-center gap-3.5 px-4 text-left text-[15px]', rowActive(r) ? 'font-semibold text-foreground' : '')}
              aria-current={rowActive(r) ? 'page' : undefined}
              onClick={() => goRow(r)}
            >
              <span className="flex-1">{r.label}</span>
              {rowActive(r) && <UiIcon name="check" className="h-[18px] w-[18px] text-primary" />}
            </button>
          ))}
          {view === 'files' && (
            <>
              <div className="mt-2 border-t border-border px-4 pb-2 pt-3 text-xs font-semibold text-muted-foreground">{t('files.commandBar.view')}</div>
              <div className="px-4 pb-2"><UiSegment modelValue={viewMode} onUpdateModelValue={onViewModel} items={viewItems} size="lg" grow ariaLabel={t('files.commandBar.view')} /></div>
              <div className="mt-1 border-t border-border px-4 pb-1 pt-3 text-xs font-semibold text-muted-foreground">{t('files.page.sort')}</div>
              {SORTS.map(s => (
                <button
                  key={s.field}
                  type="button"
                  className="flex h-12 w-full items-center gap-3.5 px-4 text-left text-[15px]"
                  aria-pressed={sortField === s.field}
                  onClick={() => toggleSort(s.field)}
                >
                  <span className={clsx('flex-1', sortField === s.field ? 'font-semibold' : '')}>{t(s.labelKey)}</span>
                  {sortField === s.field && (
                    <span className="flex items-center gap-1 text-xs text-primary">
                      {sortDir === 'asc' ? t('files.page.ascending') : t('files.page.descending')}
                      <UiIcon name={sortDir === 'asc' ? 'chevron-up' : 'chevron-down'} className="h-3.5 w-3.5" strokeWidth={2.6} />
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
          {view === 'trash' && trashItems.length > 0 && (
            <button
              type="button"
              className="mt-2 flex h-12 w-full items-center gap-3.5 border-t border-border px-4 text-left text-[15px] text-danger"
              onClick={() => { setShowViewSheet(false); onEmptyTrash() }}
            >{t('files.trash.empty')}</button>
          )}
        </UiActionSheet>
      )}

      {/* 모바일: FAB → 새로 만들기 */}
      {showNewSheet && (
        <UiActionSheet label={t('files.page.uploadOrNew')} onClose={() => setShowNewSheet(false)}>
          <button type="button" className="flex h-12 w-full items-center gap-3.5 px-4 text-left text-[15px]" onClick={() => newFromSheet('upload')}>
            <UiIcon name="upload" className="h-5 w-5 text-muted-foreground" />{t('files.page.uploadFiles')}
          </button>
          <button type="button" className="flex h-12 w-full items-center gap-3.5 px-4 text-left text-[15px]" onClick={() => newFromSheet('folder')}>
            <FilesFileTypeIcon kind="folder" className="h-5 w-5" />{t('files.commandBar.newFolder')}
          </button>
          {docsOn && <>
          <button type="button" className="flex h-12 w-full items-center gap-3.5 px-4 text-left text-[15px]" onClick={() => newFromSheet('doc')}>
            <FilesFileTypeIcon kind="doc" className="h-5 w-5" />{t('files.commandBar.newDoc')}
          </button>
          <button type="button" className="flex h-12 w-full items-center gap-3.5 px-4 text-left text-[15px]" onClick={() => newFromSheet('sheet')}>
            <FilesFileTypeIcon kind="sheet" className="h-5 w-5" />{t('files.commandBar.newSheet')}
          </button>
          <button type="button" className="flex h-12 w-full items-center gap-3.5 px-4 text-left text-[15px]" onClick={() => newFromSheet('slide')}>
            <FilesFileTypeIcon kind="slide" className="h-5 w-5" />{t('files.commandBar.newSlide')}
          </button>
          </>}
        </UiActionSheet>
      )}
    </div>
  )
}
