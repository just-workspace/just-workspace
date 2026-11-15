/**
 * 공유 모달(Vue components/files/FileShareModal.vue): UiModal 안 "사람·채널 / 링크" 두 탭.
 * 링크 탭: 이 항목(들)의 링크 여러 개(복사 · ⋮ 수정·회수) + 점선 "새 링크" 카드(권한 · 만료 · 비밀번호 · 1회용) → [링크 만들고 복사].
 *   권한 = 보기만·다운로드 허용 / 보기만·다운로드 막음(미리보기만) / 편집 가능(오피스 하나). 만료는 서버 범위(없음·1시간·1일·7일).
 *   여러 항목(같은 루트)은 zip 묶음 링크 1개. 폴더 하나만은 서버가 링크를 못 만든다 → 안내.
 *   링크 수정(⋮ "수정")은 행 아래 펼침 폼(PATCH /share/{id}): 권한(다운로드 허용/막음)·만료·비밀번호(바꾸기·해제)·1회용.
 *   비밀번호·다운로드 막음 링크의 주소는 손님 화면 /s/<token>(비밀번호 입력 → 열기, 막음은 미리보기).
 *   파일 하나가 미리보기 안 되는 형식이면 "다운로드 막음"은 비활성 + 이유(받는 사람이 아무것도 못 보는 죽은 링크가 된다).
 *   판정은 서버(GET /share/preview-kind · 목록의 can_block_download) — 손님 화면과 같은 출처. 서버도 400 으로 거절한다.
 * 사람·채널 탭:
 *   칩 입력(사람 = 아바타 20 + 이름 + 빼기, 채널 = # + 이름) + 권한 120 → 추천 목록(행 40, 채널은 # 타일 24 + "채널 · 멤버 n명")
 *   → "접근 권한이 있는 사람"(행 48: 소유자 / 사람 / 채널 + 권한 드롭다운 32 — 빼기도 여기서)
 *   → [✓ 채팅으로 알리고 메시지 남기기](사람은 DM, 채널은 그 채널) → 바닥 "권한: 보기 · 편집" + [닫기][공유 2명·채널 1].
 *   채널 공유 = 그 채널 멤버 전원(가입·탈퇴 즉시 반영, POST /share-user channel_ids). 예전 "채널로 보내기(파일 복사 첨부)" 칸은
 *   채널 칩 + 채팅 알림으로 대신한다(⋮ "채널로 보내기"는 이 탭을 연다).
 *   남길 말 입력은 시안에 그림이 없어 체크 아래 한 줄 입력으로 — 디자이너 확인 필요.
 * 권한 4단계(시안 바닥 "권한: 보기 · 댓글 · 편집 · 공동 소유"): 새 사람 권한 120 · 행 권한 드롭다운 모두 4단계.
 *   공동 소유 지정·해제는 원 소유자만(다른 사람에겐 그 항목이 비활성 + 이유). 공동 소유자는 공유받은 항목(shared-with-me/..)을
 *   여기서 재공유·권한 변경할 수 있고, 원 소유자가 준 공유·공동 소유 행은 드롭다운이 잠긴다(can_manage=false — 원 소유자 보호).
 *   공동 소유자 화면의 "소유자" 줄은 원 소유자. 공유받은 항목은 공개 링크를 만들 수 없다(링크 탭 = 빈 상태).
 *
 * 이메일로 보내기(시안 없음 — 디자이너 확인 필요): 새 링크 카드 아래 "받는 사람 이메일(선택)" 칩 입력 + 메시지 →
 *   받는 사람이 있으면 1차 버튼이 [링크 만들고 보내기 · n명]. 기존 링크는 ⋮ "이메일로 보내기" → 행 아래 펼침(칩·메시지·보내기 + 보낸 기록).
 *   비밀번호는 메일에 안 들어간다(안내 문구). 외부 주소는 칩·기록에 "외부". 한도 20명/회 · 50명/시간(서버).
 *
 * 채팅 모듈도 이 파일을 import 한다(채널 파일 탭 → initialTab="people").
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { clsx } from 'clsx'
import { useI18n } from '~/i18n'
import { useClickOutside } from '~/lib/dom'
import { useFiles, emailShareLink, fetchLinkPreviewKind, fetchShareLinkEmails, type DirectoryUser, type FileItem, type ShareLinkEmailEntry, type ShareLinkEmailLimits, type ShareLinkEmailResult, type ShareLinkListEntry, type ShareLinkPatch, type ShareRole, type UserShareEntry, type UserShareInfo } from '~/composables/useFiles'
import { chatStore, fetchChannels } from '~/composables/useChat'
import { useAuth } from '~/composables/useAuth'
import { useToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { canBundleLink, expiryLabel, isComposingKey, linkMeta, roleAtLeast, roleLabelKey, roleOf, samePathSet, shareUrl, sharedSubPath, SHARE_EMAIL_MAX, SHARE_ROLES, type FilesTranslate } from '~/lib/files'
import { UiModal } from '~/components/ui/Modal'
import { UiTabs } from '~/components/ui/Tabs'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSelect } from '~/components/ui/Select'
import { UiSwitch } from '~/components/ui/Switch'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiButton } from '~/components/ui/Button'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiInput } from '~/components/ui/Input'
import { UiMenu } from '~/components/ui/Menu'
import { UiBadge } from '~/components/ui/Badge'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { FilesShareEmailInput } from './FileShareEmailInput'
import { writeClipboard } from '~/lib/clipboard'

export interface FilesFileShareModalProps {
  /** 공유할 항목(여럿이면 묶음 링크·일괄 공유) */
  items: FileItem[]
  /** 먼저 보일 탭(기본 사람·채널) */
  initialTab?: 'link' | 'people' | null
  onClose?: () => void
}

type Perm = 'view' | 'view-nodl' | 'edit'
type Pick =
  | { kind: 'user'; id: string; name: string; sub: string; avatar?: string | null }
  | { kind: 'channel'; id: string; name: string; sub: string }

const isRole = (v: unknown): v is ShareRole => typeof v === 'string' && (SHARE_ROLES as readonly string[]).includes(v)
const initial = (s: string) => (s || '?').trim().slice(0, 1).toUpperCase()

/** 링크 행 ⋮ 메뉴(Vue 의 v-click-outside 묶음) */
function LinkMenu({ open, onToggle, onDismiss, children, label }: { open: boolean; onToggle: () => void; onDismiss: () => void; children: ReactNode; label: string }) {
  const wrap = useRef<HTMLDivElement | null>(null)
  useClickOutside(wrap, () => { if (open) onDismiss() })
  return (
    // Esc 는 감싸는 칸에서 잡는다 — 메뉴를 연 직후 포커스는 ⋮ 버튼에 있어, 메뉴 칸에만 두면 모달이 받아 공유 창이 통째로 닫혔다
    <div ref={wrap} className="relative" onKeyDown={(e) => { if (open && e.key === 'Escape') { e.stopPropagation(); onDismiss() } }}>
      <UiIconButton label={label} icon="more-vertical" className="h-[30px] w-[30px]" aria-haspopup="menu" aria-expanded={open} onClick={onToggle} />
      {open && (
        <div role="menu" className="absolute right-0 top-full z-dropdown mt-1 w-40 rounded-lg border border-border bg-popover p-1 shadow-md" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDismiss() } }}>
          {children}
        </div>
      )}
    </div>
  )
}

export function FilesFileShareModal({ items, initialTab = null, onClose }: FilesFileShareModalProps) {
  const {
    createLink, fetchShareLinks, shareLinks, deleteShareLink, updateShareLink, fetchShareInfo, shareWithUsers, updateUserShare, deleteUserShare,
    searchUsers,
  } = useFiles()
  const channels = useStore(chatStore, s => s.channels)
  const { user } = useAuth()
  const { toast, addToast } = useToast()
  const { t, locale } = useI18n()
  const tr: FilesTranslate = (k, p) => t(k, p ?? {})

  const single = items.length === 1 ? items[0] : null
  const paths = items.map(i => i.path)
  const bundle = items.length > 1
  const anyShared = items.some(i => !!sharedSubPath(i.path))
  // 폴더 하나도 링크 가능(받는 쪽은 손님 화면에서 둘러봄). 내 파일·공유 파일 아래만(서버 규칙)
  const linkable = !anyShared && (single ? (!single.is_dir || /^(my|shared)\//.test(single.path)) : canBundleLink(paths))
  const isOffice = /\.(docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(single?.name || '')
  // 사람·채널 공유를 관리할 수 있나 — 내 파일이거나, 공동 소유로 받은 항목
  const allMine = items.every(i => i.path.startsWith('my/') || (!!sharedSubPath(i.path) && roleAtLeast(i.role, 'owner')))
  const title = single ? t('files.shareModal.titleOne', { name: single.name }) : t('files.shareModal.titleMany', { n: items.length })
  const noLinkTitle = anyShared ? t('files.shareModal.noLinkShared') : single?.is_dir ? t('files.shareModal.noLinkFolder') : t('files.shareModal.noLinkMixed')

  // ── 링크 ──
  const links = (shareLinks as ShareLinkListEntry[]).filter(l => samePathSet(l.paths?.length ? l.paths : [l.file_path], paths))
  const [perm, setPerm] = useState<Perm>('view')
  const [expiresIn, setExpiresIn] = useState<string>('7d')
  const [oneTime, setOneTime] = useState(false)
  const [usePassword, setUsePassword] = useState(false)
  const [password, setPassword] = useState('')
  const [creating, setCreating] = useState(false)

  // 파일 하나: 손님 화면에서 미리 볼 수 있는 형식인가(서버 판정). null = 안 됨 → "다운로드 막음" 비활성, undefined = 모름(막지 않는다)
  const [previewKind, setPreviewKind] = useState<string | null | undefined>(undefined)
  const noPreview = !!single && !single.is_dir && previewKind === null
  const noPreviewHint = t('files.shareModal.noPreviewShort', '미리보기 안 되는 형식')
  const noPreviewReason = t('files.shareModal.noPreviewReason', '이 형식은 미리 볼 수 없어 "다운로드 막음"을 쓸 수 없습니다. 막으면 받는 사람이 아무것도 볼 수 없습니다(미리보기는 이미지·PDF·텍스트만).')
  const permOptions = [
    { value: 'view', label: t('files.shareModal.permViewDownload') },
    { value: 'view-nodl', label: t('files.shareModal.permViewNoDownload'), disabled: bundle || noPreview, hint: bundle ? t('files.shareModal.bundleNoPreview') : noPreview ? noPreviewHint : undefined },
    { value: 'edit', label: t('files.links.editable'), disabled: !isOffice, hint: isOffice ? undefined : t('files.shareModal.officeOnly') },
  ]
  const expiryOptions = ['', '1h', '1d', '7d'].map(k => ({ value: k, label: expiryLabel(k, undefined, tr) }))
  const onPermModel = (v: string | number | null) => { if (v === 'view' || v === 'view-nodl' || v === 'edit') setPerm(v) }
  const onExpiryModel = (v: string | number | null) => { setExpiresIn(String(v ?? '')) }
  const passwordError = usePassword && !password.trim() ? t('files.shareModal.passwordRequired') : ''

  async function copy(text: string) {
    try {
      await writeClipboard(text)
      return true
    } catch { return false }
  }
  function urlOf(l: { token: string; can_edit?: boolean; has_password?: boolean; allow_download?: boolean; is_folder?: boolean }) {
    return shareUrl(window.location.origin, l.token, !!l.can_edit, { hasPassword: l.has_password, allowDownload: l.allow_download, isFolder: l.is_folder })
  }

  // ── 이메일로 보내기(R7) ──
  const [newEmails, setNewEmails] = useState<string[]>([])
  const [newEmailMsg, setNewEmailMsg] = useState('')
  const [newEmailPending, setNewEmailPending] = useState(false)
  function mailToast(r: ShareLinkEmailResult) {
    if (r.failed && !r.sent) addToast('error', t('files.shareEmail.failed'))
    else if (r.failed) addToast('warning', t('files.shareEmail.partial', { ok: r.sent, fail: r.failed }))
    else toast({ type: 'success', title: t('files.shareEmail.sent', { n: r.sent }) })
  }

  const [triedCreate, setTriedCreate] = useState(false)
  async function createAndCopy() {
    if (!linkable) return
    setTriedCreate(true)
    if (passwordError || newEmailPending) return
    setCreating(true)
    try {
      const canEdit = !!single && isOffice && perm === 'edit'
      const r = await createLink({
        paths,
        isDir: !!single?.is_dir,
        expiresIn: expiresIn || undefined,
        oneTime,
        canEdit,
        password: usePassword ? password.trim() : undefined,
        allowDownload: perm !== 'view-nodl',
      })
      const url = urlOf({ token: r.token, can_edit: canEdit, has_password: r.has_password ?? usePassword, allow_download: r.allow_download ?? perm !== 'view-nodl', is_folder: r.is_folder })
      if (newEmails.length && r.id) {
        // 받는 사람이 있으면 복사 대신 메일로(링크는 행의 [복사]로 언제든)
        await fetchShareLinks()
        try {
          mailToast(await emailShareLink(r.id, newEmails, newEmailMsg.trim() || undefined))
          setNewEmails([])
          setNewEmailMsg('')
        } catch (e: any) {
          addToast('error', e?.data?.detail || t('files.shareEmail.failed'))
        }
      } else {
        const ok = await copy(url)
        toast({ type: 'success', title: ok ? t('files.shareModal.createdCopied') : t('files.shareModal.created'), description: ok ? (usePassword ? t('files.shareModal.passwordReminder') : undefined) : url })
      }
      setPassword('')
      setUsePassword(false)
      setTriedCreate(false)
      await fetchShareLinks()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.share.createError'))
    } finally {
      setCreating(false)
    }
  }

  async function copyLink(l: ShareLinkListEntry) {
    const ok = await copy(urlOf(l))
    if (ok) toast({ type: 'success', title: t('files.links.copied') })
    else addToast('error', t('files.links.copyError'))
  }

  const [linkMenu, setLinkMenu] = useState<string | null>(null)
  async function revoke(l: ShareLinkListEntry) {
    setLinkMenu(null)
    if (!await confirmBox(t('files.shareModal.revokeConfirm'), { title: t('files.links.revokeTitle'), confirmLabel: t('files.links.revoke'), danger: true })) return
    try {
      await deleteShareLink(l.id)
      toast({ type: 'success', title: t('files.links.revoked') })
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.links.revokeError'))
    }
  }

  // ── 기존 링크 → 이메일로 보내기 + 보낸 기록 ──
  const [mailing, setMailing] = useState<string | null>(null)
  const [mailTo, setMailTo] = useState<string[]>([])
  const [mailMsg, setMailMsg] = useState('')
  const [mailPending, setMailPending] = useState(false)
  const [mailBusy, setMailBusy] = useState(false)
  const [mailLog, setMailLog] = useState<ShareLinkEmailEntry[] | null>(null)
  const [mailLogError, setMailLogError] = useState(false)
  const [mailLimits, setMailLimits] = useState<ShareLinkEmailLimits | null>(null)
  const linkInactive = (l: ShareLinkListEntry) =>
    (!!l.expires_at && new Date(l.expires_at).getTime() < Date.now()) || (!!l.max_downloads && l.download_count >= l.max_downloads)
  async function loadMailLog(id: string) {
    setMailLogError(false)
    try {
      const r = await fetchShareLinkEmails(id)
      setMailLog(r.items)
      setMailLimits(r.limits)
    } catch { setMailLog([]); setMailLogError(true) }
  }
  function startMail(l: ShareLinkListEntry) {
    setLinkMenu(null)
    setEditing(null)
    setMailing(l.id)
    setMailTo([])
    setMailMsg('')
    setMailLog(null)
    setMailLimits(null)
    void loadMailLog(l.id)
  }
  async function sendMail(l: ShareLinkListEntry, e?: FormEvent) {
    e?.preventDefault()
    if (!mailTo.length || mailPending || mailBusy) return
    setMailBusy(true)
    try {
      const r = await emailShareLink(l.id, mailTo, mailMsg.trim() || undefined)
      mailToast(r)
      setMailLog(r.items)
      setMailLimits(r.limits)
      setMailTo([])
      setMailMsg('')
    } catch (err: any) {
      addToast('error', err?.data?.detail || t('files.shareEmail.failed'))
    } finally {
      setMailBusy(false)
    }
  }
  function fmtSent(iso: string | null) {
    if (!iso) return ''
    return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  // ── 링크 수정(PATCH) ──
  const [editing, setEditing] = useState<string | null>(null)
  const [ed, setEd] = useState({ allowDownload: true, expires: 'keep', password: false, newPassword: '', oneTime: false })
  const patchEd = (p: Partial<typeof ed>) => setEd(cur => ({ ...cur, ...p }))
  const editExpiryOptions = [
    { value: 'keep', label: t('files.shareModal.keepExpiry') },
    { value: 'never', label: t('files.expiry.none') },
    ...['1h', '1d', '7d'].map(k => ({ value: k, label: expiryLabel(k, undefined, tr) })),
  ]
  // 허용 → 막음으로 바꿀 수 없는 링크(미리보기 안 되는 파일 하나)는 그 항목만 비활성. 이미 막혀 있던 옛 링크는 그대로 둔다
  const cannotBlock = (l: ShareLinkListEntry) => l.can_block_download === false && l.allow_download !== false
  const editPermOptions = (l: ShareLinkListEntry) => [
    { value: 'dl', label: t('files.shareModal.permViewDownload') },
    { value: 'nodl', label: t('files.shareModal.permViewNoDownload'), disabled: cannotBlock(l), hint: cannotBlock(l) ? noPreviewHint : undefined },
  ]
  const [savingEdit, setSavingEdit] = useState(false)
  function startEdit(l: ShareLinkListEntry) {
    setLinkMenu(null)
    setMailing(null)
    setEditing(l.id)
    setEd({ allowDownload: l.allow_download !== false, expires: 'keep', password: !!l.has_password, newPassword: '', oneTime: l.max_downloads === 1 })
  }
  async function saveEdit(l: ShareLinkListEntry, e?: FormEvent) {
    e?.preventDefault()
    const patch: ShareLinkPatch = {}
    if (!l.can_edit && (l.allow_download !== false) !== ed.allowDownload) patch.allow_download = ed.allowDownload
    if (ed.expires !== 'keep') patch.expires_in = ed.expires
    if (ed.password && ed.newPassword.trim()) patch.password = ed.newPassword.trim()
    else if (!ed.password && l.has_password) patch.password = ''
    else if (ed.password && !l.has_password) { addToast('warning', t('files.shareModal.passwordRequired')); return }
    if ((l.max_downloads === 1) !== ed.oneTime) patch.max_downloads = ed.oneTime ? 1 : 0
    if (!Object.keys(patch).length) { setEditing(null); return }
    setSavingEdit(true)
    try {
      await updateShareLink(l.id, patch)
      toast({ type: 'success', title: t('files.shareModal.linkUpdated') })
      setEditing(null)
    } catch (err: any) {
      addToast('error', err?.data?.detail || t('files.shareModal.linkUpdateError'))
    } finally {
      setSavingEdit(false)
    }
  }

  // ── 사람·채널 ──
  const [shares, setShares] = useState<UserShareEntry[]>([])
  const [shareOwner, setShareOwner] = useState<UserShareInfo['owner']>(null)
  const [directory, setDirectory] = useState<DirectoryUser[]>([])
  const dirUser = (id: string | null) => directory.find(u => u.id === id)
  const nameOf = (id: string | null) => dirUser(id)?.display_name ?? t('files.shareModal.unknownUser')

  const singleRef = useRef(single)
  singleRef.current = single
  const allMineRef = useRef(allMine)
  allMineRef.current = allMine
  async function loadShares() {
    const s = singleRef.current
    if (!s || !allMineRef.current) { setShares([]); return }
    try {
      const info = await fetchShareInfo(s.path)
      setShares(info.shares)
      setShareOwner(info.owner)
    } catch { setShares([]) }
  }
  // 원 소유자인가 — 공동 소유 지정·해제는 원 소유자만
  const isOriginalOwner = items.every(i => i.path.startsWith('my/'))
  // "소유자" 줄: 공유받은 항목이면 원 소유자, 아니면 나
  const ownerRow = (() => {
    const o = shareOwner
    if (!isOriginalOwner && o) return { name: o.display_name || o.username, sub: o.email || o.username, avatar: o.avatar_url ?? null }
    return { name: user?.display_name || user?.username || '', sub: user?.email || '', avatar: user?.avatar_url ?? null }
  })()

  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Pick[]>([])
  const [userResults, setUserResults] = useState<DirectoryUser[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const [newPerm, setNewPerm] = useState<ShareRole>('view')
  const onNewPermModel = (v: string | number | null) => { if (isRole(v)) setNewPerm(v) }
  const permRowOptions = SHARE_ROLES.map(r => ({
    value: r,
    label: t(roleLabelKey(r)),
    disabled: r === 'owner' && !isOriginalOwner,
    hint: r === 'owner' && !isOriginalOwner ? t('files.shareModal.ownerOnlyByOwner') : undefined,
  }))
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstQ = useRef(true)
  // watch(q)
  useEffect(() => {
    if (firstQ.current) { firstQ.current = false; return }
    setActiveIdx(0)
    if (qTimer.current) clearTimeout(qTimer.current)
    const term = q.trim()
    if (!term || term.startsWith('#')) { setUserResults([]); return }
    qTimer.current = setTimeout(async () => {
      try {
        const list = await searchUsers(term)
        setUserResults(list.filter(u => !u.is_self).slice(0, 8))
      } catch { setUserResults([]) }
    }, 250)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (qTimer.current) clearTimeout(qTimer.current) }, [])

  const sharedUserIds = new Set(shares.map(s => s.user_id).filter(Boolean))
  const sharedChannelIds = new Set(shares.map(s => s.channel_id).filter(Boolean))
  const channelMatches = (() => {
    const raw = q.trim()
    if (!raw) return []
    const term = raw.replace(/^#/, '').toLowerCase()
    return channels
      .filter(c => c.type !== 'dm' && !c.is_archived && c.name.toLowerCase().includes(term))
      .filter(c => !picked.some(p => p.kind === 'channel' && p.id === c.id) && !sharedChannelIds.has(c.id))
      .slice(0, 5)
  })()
  const suggestions: Pick[] = (() => {
    const chs: Pick[] = channelMatches.map(c => ({ kind: 'channel', id: c.id, name: c.name, sub: t('files.shareModal.channelMeta', { n: c.member_count }) }))
    const us: Pick[] = q.trim().startsWith('#')
      ? []
      : userResults
        .filter(u => !picked.some(p => p.kind === 'user' && p.id === u.id) && !sharedUserIds.has(u.id) && u.id !== shareOwner?.id)
        .map(u => ({ kind: 'user', id: u.id, name: u.display_name, sub: u.email || u.username, avatar: u.avatar_url }))
    return (q.trim().startsWith('#') ? [...chs, ...us] : [...us, ...chs]).slice(0, 8)
  })()

  const focusInput = useRef(false)
  useEffect(() => {
    if (!focusInput.current) return
    focusInput.current = false
    inputRef.current?.focus()
  })
  function pick(p: Pick) {
    setPicked([...picked, p])
    if (p.kind === 'user' && !directory.some(d => d.id === p.id)) {
      const u = userResults.find(x => x.id === p.id)
      if (u) setDirectory([...directory, u])
    }
    setQ('')
    setUserResults([])
    focusInput.current = true
  }
  function unpick(i: number) {
    setPicked(picked.filter((_, j) => j !== i))
    focusInput.current = true
  }
  function onInputKey(e: KeyboardEvent<HTMLInputElement>) {
    if (isComposingKey(e)) return   // 한글 이름 조합 중 Enter 로 추천이 선택되고 조합 글자가 다시 남던 것
    const list = suggestions
    if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); setActiveIdx((activeIdx + 1) % list.length) }
    else if (e.key === 'ArrowUp' && list.length) { e.preventDefault(); setActiveIdx((activeIdx + list.length - 1) % list.length) }
    else if (e.key === 'Enter' && list.length) { e.preventDefault(); pick(list[Math.min(activeIdx, list.length - 1)]) }
    else if (e.key === 'Backspace' && !q && picked.length) { setPicked(picked.slice(0, -1)) }
  }

  const [notify, setNotify] = useState(true)
  const [note, setNote] = useState('')
  const pickedUsers = picked.filter(p => p.kind === 'user').map(p => p.id)
  const pickedChannels = picked.filter(p => p.kind === 'channel').map(p => p.id)
  const shareLabel = (() => {
    const parts: string[] = []
    if (pickedUsers.length) parts.push(t('files.shareModal.peopleN', { n: pickedUsers.length }))
    if (pickedChannels.length) parts.push(t('files.shareModal.channelsN', { n: pickedChannels.length }))
    return parts.length ? t('files.shareModal.shareWhat', { what: parts.join('·') }) : t('files.shareModal.share')
  })()

  const [busy, setBusy] = useState(false)
  async function submitShare() {
    if (!picked.length || busy) return
    setBusy(true)
    try {
      let notified = 0
      for (const it of items) {
        const r = await shareWithUsers(it.path, pickedUsers, newPerm, {
          channelIds: pickedChannels, notify, message: note.trim() || undefined,
        })
        notified += r?.notified ?? 0
      }
      const names = picked.map(p => (p.kind === 'channel' ? `#${p.name}` : p.name)).join(', ')
      toast({
        type: 'success',
        title: t('files.shareModal.sharedWith', { name: names }),
        description: [
          items.length > 1 ? t('files.shareModal.itemCount', { n: items.length }) : '',
          notified ? t('files.shareModal.notifiedChat') : '',
        ].filter(Boolean).join(' · ') || undefined,
      })
      setPicked([])
      setNote('')
      await loadShares()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.shareModal.shareError'))
    } finally {
      setBusy(false)
    }
  }
  async function changePerm(s: UserShareEntry, v: string | number | null) {
    if (!single) return
    if (v === 'remove') { await removePerson(s); return }
    if (!isRole(v) || v === roleOf(s)) return
    try {
      await updateUserShare(s.id, v)
      await loadShares()
    } catch (e: any) { addToast('error', e?.data?.detail || t('files.shareModal.permError')); await loadShares() }
  }
  async function removePerson(s: UserShareEntry) {
    try {
      await deleteUserShare(s.id)
      await loadShares()
    } catch (e: any) { addToast('error', e?.data?.detail || t('files.shareModal.unshareError')) }
  }
  function shareRowName(s: UserShareEntry) {
    return s.channel_id ? `#${s.channel_name || t('files.shareModal.deletedChannel')}` : nameOf(s.user_id)
  }
  function shareRowSub(s: UserShareEntry) {
    if (s.channel_id) return t('files.shareModal.channelMeta', { n: s.member_count ?? 0 })
    const u = dirUser(s.user_id)
    return u?.email || u?.username || ''
  }

  // ── 탭 ──
  // 기본 탭 = 사람·채널. 링크 탭은 고를 때만 —
  // 링크 탭이 기본이면 같은 자리의 1차 버튼이 '링크 만들고 복사'가 되어, '공유'를 누르려던 손이 링크를 만든다.
  const [tab, setTab] = useState<string | null>(initialTab ?? 'people')
  const tabs = [
    // 시안 "사람·채널 3" = 소유자(나) 포함
    { key: 'people', label: t('files.shareModal.tabPeople'), count: single && allMine ? shares.length + 1 : undefined },
    { key: 'link', label: t('files.shareModal.tabLink'), count: links.length },
  ]

  useEffect(() => {
    void (async () => {
      fetchShareLinks()
      if (single && !single.is_dir && linkable) {
        void fetchLinkPreviewKind(single.path).then((k) => {
          setPreviewKind(k)
          if (k === null) setPerm(p => (p === 'view-nodl' ? 'view' : p))   // 그새 골라 둔 "막음"은 되돌린다
        })
      }
      if (!chatStore.getState().channels.length) fetchChannels().catch(() => {})
      try { setDirectory(await searchUsers('')) } catch { /* 이름 대신 "알 수 없는 사용자" */ }
      loadShares()
      // ⋮ "채널로 보내기"로 열었으면 바로 입력으로
      if (initialTab === 'people') inputRef.current?.focus()
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <UiModal
      title={title}
      size="520"
      onClose={() => onClose?.()}
      footer={(
        <>
          {tab === 'link'
            ? <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">{t('files.shareModal.channelHint')}</span>
            : <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">{t('files.shareModal.permLevels')}</span>}
          <UiButton variant="outline" size="sm" onClick={() => onClose?.()}>{t('common.close')}</UiButton>
          {tab === 'link' && linkable
            ? (
              <UiButton size="sm" disabled={creating || newEmailPending} onClick={createAndCopy}>
                {creating
                  ? t('files.shareModal.creating')
                  : newEmails.length ? t('files.shareEmail.createSend', { n: newEmails.length }) : t('files.shareModal.createCopy')}
              </UiButton>
            )
            : tab !== 'link' && allMine
              ? <UiButton size="sm" disabled={!picked.length || busy} onClick={submitShare}>{shareLabel}</UiButton>
              : null}
        </>
      )}
    >
      <UiTabs modelValue={tab} onUpdateModelValue={setTab} items={tabs} ariaLabel={t('files.shareModal.method')} className="-mx-5 -mt-5 px-4" />

      {tab === 'link'
        ? (
          // 링크
          !linkable
            ? (
              <UiEmptyState
                variant="panel"
                icon="link"
                title={noLinkTitle}
                description={t('files.shareModal.noLinkHint')}
              />
            )
            : (
              <>
                {bundle && <p className="text-xs text-muted-foreground">{t('files.shareModal.bundleHint', { n: items.length })}</p>}
                {links.map(l => (
                  <div key={l.id} className="rounded-md border border-border text-[13px]">
                    <div className="flex items-center gap-2.5 px-3 py-2.5">
                      <UiIcon name="link" className="h-4 w-4 text-primary" />
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold">{l.can_edit ? t('files.shareModal.editLink') : t('files.shareModal.viewLink')}</div>
                        <div className="truncate text-xs text-muted-foreground">{linkMeta(l, tr)}</div>
                      </div>
                      <button type="button" className="inline-flex h-[30px] items-center rounded-sm border border-border px-2.5 text-xs font-semibold hover:bg-accent/40" onClick={() => copyLink(l)}>{t('common.copy')}</button>
                      <LinkMenu
                        open={linkMenu === l.id}
                        label={t('files.shareModal.linkMenu')}
                        onToggle={() => setLinkMenu(linkMenu === l.id ? null : l.id)}
                        onDismiss={() => setLinkMenu(null)}
                      >
                        <button type="button" role="menuitem" className="flex h-9 w-full items-center rounded-sm px-2.5 text-left text-sm hover:bg-accent" onClick={() => startEdit(l)}>{t('files.shareModal.editLinkMenu')}</button>
                        <button type="button" role="menuitem" className="flex h-9 w-full items-center rounded-sm px-2.5 text-left text-sm hover:bg-accent" onClick={() => startMail(l)}>{t('files.shareEmail.menu')}</button>
                        <button type="button" role="menuitem" className="flex h-9 w-full items-center rounded-sm px-2.5 text-left text-sm text-danger hover:bg-danger/10" onClick={() => revoke(l)}>{t('files.links.revokeTitle')}</button>
                      </LinkMenu>
                    </div>
                    {/* 링크 수정 */}
                    {editing === l.id && (
                      <form className="flex flex-col gap-3 border-t border-border p-3.5" onSubmit={e => saveEdit(l, e)}>
                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                          {!l.can_edit && !(l.paths && l.paths.length > 1) && (
                            <UiSelect modelValue={ed.allowDownload ? 'dl' : 'nodl'} onUpdateModelValue={v => patchEd({ allowDownload: v !== 'nodl' })} options={editPermOptions(l)} label={t('files.shareModal.permission')} hint={cannotBlock(l) ? noPreviewReason : undefined} />
                          )}
                          <UiSelect modelValue={ed.expires} onUpdateModelValue={v => patchEd({ expires: String(v ?? 'keep') })} options={editExpiryOptions} label={t('files.shareModal.expiry')} />
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
                          <UiSwitch modelValue={ed.password} onUpdateModelValue={v => patchEd({ password: v })} label={t('files.shareModal.password')} labelFirst={false} />
                          {ed.password && (
                            <UiPasswordInput
                              modelValue={ed.newPassword}
                              onUpdateModelValue={v => patchEd({ newPassword: v })}
                              placeholder={l.has_password ? t('files.shareModal.passwordKeep') : t('files.shareModal.passwordPlaceholder')}
                              autocomplete="new-password"
                              aria-label={t('files.shareModal.password')}
                              className="min-w-0 flex-1"
                            />
                          )}
                          <UiSwitch modelValue={ed.oneTime} onUpdateModelValue={v => patchEd({ oneTime: v })} label={t('files.linkMeta.oneTime')} labelFirst={false} className="sm:ml-auto" />
                        </div>
                        <div className="flex justify-end gap-2">
                          <UiButton variant="outline" size="sm" type="button" onClick={() => setEditing(null)}>{t('common.cancel')}</UiButton>
                          <UiButton size="sm" type="submit" disabled={savingEdit}>{t('common.save')}</UiButton>
                        </div>
                      </form>
                    )}
                    {/* 이메일로 보내기 + 보낸 기록(R7) — 수정 폼과 같은 펼침 문법 */}
                    {mailing === l.id && (
                      <form className="flex flex-col gap-3 border-t border-border p-3.5" onSubmit={e => sendMail(l, e)} aria-label={t('files.shareEmail.panelTitle')}>
                        {linkInactive(l)
                          ? <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">{t('files.shareEmail.inactive')}</p>
                          : (
                            <>
                              <FilesShareEmailInput
                                modelValue={mailTo}
                                onUpdateModelValue={setMailTo}
                                onPendingChange={setMailPending}
                                directory={directory}
                                label={t('files.shareEmail.label')}
                                hint={mailLimits ? t('files.shareEmail.remaining', { n: mailLimits.remaining }) : t('files.shareEmail.hint', { n: SHARE_EMAIL_MAX })}
                                disabled={mailBusy}
                              />
                              {mailTo.length > 0 && (
                                <UiInput label={t('files.shareEmail.messageLabel')} modelValue={mailMsg} onUpdateModelValue={setMailMsg} placeholder={t('files.shareEmail.messagePlaceholder')} maxLength={1000} />
                              )}
                              {l.has_password && (
                                <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                                  <UiIcon name="lock" className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('files.shareEmail.passwordNote')}
                                </p>
                              )}
                            </>
                          )}
                        <div className="flex flex-col">
                          <div className="text-xs font-semibold text-muted-foreground">{t('files.shareEmail.logTitle')}</div>
                          {mailLog === null
                            ? <UiSkeleton preset="list" rows={2} />
                            : mailLogError
                              ? <p className="py-2 text-xs text-danger">{t('files.shareEmail.logError')}</p>
                              : !mailLog.length
                                ? <p className="py-2 text-xs text-muted-foreground">{t('files.shareEmail.logEmpty')}</p>
                                : (
                                  <ul className="max-h-48 overflow-y-auto">
                                    {mailLog.map(m => {
                                      const u = directory.find(d => d.id === m.user_id)
                                      return (
                                        <li key={m.id} className="flex min-h-10 items-center gap-2.5 border-b border-border/60 py-1 text-[13px] last:border-b-0">
                                          <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5">
                                              <span className="truncate">{u ? `${u.display_name} · ${m.email}` : m.email}</span>
                                              {m.external && <UiBadge tone="warning" tint size={18} className="shrink-0" title={t('files.shareEmail.externalTitle')}>{t('files.shareEmail.external')}</UiBadge>}
                                              {!m.ok && <UiBadge tone="danger" tint size={18} className="shrink-0">{t('files.shareEmail.logFailed')}</UiBadge>}
                                            </div>
                                            {m.sent_by !== user?.id && m.sent_by_name && (
                                              <div className="truncate text-xs text-muted-foreground">{t('files.shareEmail.logBy', { name: m.sent_by_name })}</div>
                                            )}
                                          </div>
                                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fmtSent(m.created_at)}</span>
                                        </li>
                                      )
                                    })}
                                  </ul>
                                )}
                        </div>
                        <div className="flex justify-end gap-2">
                          <UiButton variant="outline" size="sm" type="button" onClick={() => setMailing(null)}>{t('common.close')}</UiButton>
                          {!linkInactive(l) && (
                            <UiButton size="sm" type="submit" disabled={!mailTo.length || mailPending || mailBusy}>
                              {mailBusy ? t('files.shareEmail.sending') : t('files.shareEmail.send', { n: mailTo.length })}
                            </UiButton>
                          )}
                        </div>
                      </form>
                    )}
                  </div>
                ))}

                <div className="flex flex-col gap-3 rounded-md border border-dashed border-border p-3.5">
                  <div className="text-[13px] font-semibold">{bundle ? t('files.shareModal.newBundleLink', { n: items.length }) : t('files.shareModal.newLink')}</div>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <UiSelect modelValue={perm} onUpdateModelValue={onPermModel} options={permOptions} label={t('files.shareModal.permission')} />
                    <UiSelect modelValue={expiresIn} onUpdateModelValue={onExpiryModel} options={expiryOptions} label={t('files.shareModal.expiry')} />
                  </div>
                  {noPreview && (
                    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground" data-testid="share-no-preview-reason">
                      <UiIcon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />{noPreviewReason}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
                    <UiSwitch modelValue={usePassword} onUpdateModelValue={setUsePassword} label={t('files.shareModal.password')} labelFirst={false} />
                    {usePassword && (
                      <UiPasswordInput
                        modelValue={password}
                        onUpdateModelValue={setPassword}
                        placeholder={t('files.shareModal.passwordPlaceholder')}
                        autocomplete="new-password"
                        aria-label={t('files.shareModal.password')}
                        error={triedCreate ? passwordError : ''}
                        className="min-w-0 flex-1"
                      />
                    )}
                    <UiSwitch modelValue={oneTime} onUpdateModelValue={setOneTime} label={t('files.linkMeta.oneTime')} labelFirst={false} className="sm:ml-auto" />
                  </div>
                  {/* 받는 사람 이메일(선택, R7) */}
                  <FilesShareEmailInput
                    modelValue={newEmails}
                    onUpdateModelValue={setNewEmails}
                    onPendingChange={setNewEmailPending}
                    directory={directory}
                    label={t('files.shareEmail.label')}
                    hint={t('files.shareEmail.hint', { n: SHARE_EMAIL_MAX })}
                    disabled={creating}
                  />
                  {newEmails.length > 0 && (
                    <UiInput label={t('files.shareEmail.messageLabel')} modelValue={newEmailMsg} onUpdateModelValue={setNewEmailMsg} placeholder={t('files.shareEmail.messagePlaceholder')} maxLength={1000} />
                  )}
                  {newEmails.length > 0 && usePassword && (
                    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                      <UiIcon name="lock" className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('files.shareEmail.passwordNote')}
                    </p>
                  )}
                </div>
              </>
            )
        )
        : (
          // 사람·채널(D3a)
          !allMine
            ? <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">{t('files.shareModal.onlyMine')}</p>
            : (
              <>
                <div className="flex gap-2">
                  {/* 칩 입력 */}
                  <div
                    className="flex min-h-10 min-w-0 flex-1 cursor-text flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-[5px] text-[13px] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30"
                    onClick={() => inputRef.current?.focus()}
                  >
                    {picked.map((p, i) => (
                      <span key={`${p.kind}:${p.id}`} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-primary/[0.13] pl-1">
                        {p.kind === 'user'
                          ? <UiAvatar src={p.avatar} fallback={initial(p.name)} className="h-5 w-5" textSize={9} />
                          : <span className="grid h-5 w-5 place-items-center rounded-full bg-muted font-mono text-[10px] font-bold" aria-hidden="true">#</span>}
                        <span className="max-w-[160px] truncate">{p.name}</span>
                        <button
                          type="button"
                          aria-label={t('files.shareModal.unpick', { name: p.name })}
                          className="relative grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-1.5 before:content-['']"
                          onClick={(e) => { e.stopPropagation(); unpick(i) }}
                        ><UiIcon name="close" strokeWidth={2.4} className="h-3 w-3" /></button>
                      </span>
                    ))}
                    <input
                      ref={inputRef}
                      value={q}
                      onChange={e => setQ(e.target.value)}
                      type="text"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-controls="share-suggest"
                      aria-expanded={suggestions.length > 0}
                      aria-activedescendant={suggestions.length ? `share-sug-${activeIdx}` : undefined}
                      aria-label={t('files.shareModal.addPeopleOrChannel')}
                      placeholder={picked.length ? '' : t('files.shareModal.peoplePlaceholder')}
                      className="h-7 min-w-[80px] flex-1 bg-transparent outline-hidden placeholder:text-muted-foreground"
                      onKeyDown={onInputKey}
                    />
                  </div>
                  <UiSelect modelValue={newPerm} onUpdateModelValue={onNewPermModel} options={permRowOptions} aria-label={t('files.shareModal.newPersonPerm')} className="w-[120px] shrink-0" />
                </div>
                {/* 추천 */}
                {suggestions.length > 0 && (
                  <ul
                    id="share-suggest"
                    role="listbox"
                    aria-label={t('files.shareModal.suggest')}
                    className="-mt-1.5 overflow-hidden rounded-md border border-border bg-background text-[13px]"
                  >
                    {suggestions.map((sg, i) => (
                      <li
                        id={`share-sug-${i}`}
                        key={`${sg.kind}:${sg.id}`}
                        role="option"
                        aria-selected={i === activeIdx}
                        className={clsx('flex h-10 cursor-pointer items-center gap-2.5 px-3', i === activeIdx ? 'bg-primary/[0.13]' : 'hover:bg-accent/40')}
                        onMouseDown={(e) => { e.preventDefault(); pick(sg) }}
                        onMouseEnter={() => setActiveIdx(i)}
                      >
                        {sg.kind === 'channel'
                          ? (
                            <>
                              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] bg-muted font-mono text-xs font-bold" aria-hidden="true">#</span>
                              <b className="truncate font-semibold">{sg.name}</b>
                            </>
                          )
                          : (
                            <>
                              <UiAvatar src={sg.avatar} fallback={initial(sg.name)} className="h-6 w-6 shrink-0" textSize={10} />
                              <span className="truncate">{sg.name}</span>
                            </>
                          )}
                        <span className="min-w-0 truncate text-muted-foreground">{sg.sub}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {/* 접근 권한이 있는 사람: 행 min-h-12 · 아바타 28 · 이름 600 + 보조 12 muted
                    · 잠긴 행 = lock + 권한 글자, 바꿀 수 있는 행 = [권한 ▾](ghost xs) → UiMenu(머리글 · 체크 · 공동 소유 · 빼기) */}
                {single && (
                  <div className="flex flex-col">
                    <div className="flex min-h-12 items-center gap-3 border-b border-border/60 py-1.5 text-[13px]">
                      <UiAvatar src={ownerRow.avatar} fallback={initial(ownerRow.name)} className="h-7 w-7" textSize={11} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">{isOriginalOwner ? t('files.shareModal.meSuffix', { name: ownerRow.name }) : ownerRow.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{ownerRow.sub}</div>
                      </div>
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><UiIcon name="lock" className="h-3.5 w-3.5" />{t('files.shareModal.owner')}</span>
                    </div>
                    {shares.map(sh => {
                      const nm = shareRowName(sh)
                      const label = sh.user_id && sh.user_id === user?.id ? t('files.shareModal.meSuffix', { name: nm }) : nm
                      const cur = roleOf(sh)
                      return (
                        <div key={sh.id} className="flex min-h-12 items-center gap-3 border-b border-border/60 py-1.5 text-[13px]">
                          {sh.channel_id
                            ? <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted font-mono text-xs font-semibold" aria-hidden="true">#</span>
                            : <UiAvatar src={dirUser(sh.user_id)?.avatar_url} fallback={initial(nameOf(sh.user_id))} className="h-7 w-7" textSize={11} />}
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-semibold">{label}</div>
                            <div className="truncate text-xs text-muted-foreground">{shareRowSub(sh)}</div>
                          </div>
                          {sh.can_manage === false
                            ? (
                              <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={t('files.shareModal.protectedRow')}>
                                <UiIcon name="lock" className="h-3.5 w-3.5" />{t(roleLabelKey(cur))}
                              </span>
                            )
                            : (
                              <UiMenu
                                label={t('files.shareModal.permMenu', { name: nm })}
                                align="end"
                                width={248}
                                items={[
                                  { key: 'h', heading: true, label: t('files.shareModal.permHeading', { name: nm }) },
                                  { key: 'view', label: t(roleLabelKey('view')), icon: 'eye', radio: true, checked: cur === 'view' },
                                  { key: 'comment', label: t(roleLabelKey('comment')), icon: 'chat', radio: true, checked: cur === 'comment' },
                                  { key: 'edit', label: t(roleLabelKey('edit')), icon: 'edit', radio: true, checked: cur === 'edit' },
                                  isOriginalOwner
                                    ? { key: 'owner', label: t('files.shareModal.coOwnerAssign'), icon: 'users', radio: true, checked: cur === 'owner' }
                                    : { key: 'owner', label: t('files.shareModal.coOwnerAssign'), icon: 'users', disabled: true, badge: t('files.shareModal.ownerOnlyBadge') },
                                  { key: 'remove', label: t('files.shareModal.removeFromShare'), icon: 'close', danger: true, separated: true },
                                ]}
                                onSelect={(k) => { void changePerm(sh, k) }}
                                trigger={({ toggle, open, controls }) => (
                                  <UiButton variant="ghost" size="xs" aria-haspopup="menu" aria-expanded={open} aria-controls={controls} aria-label={t('files.shareModal.personPerm', { name: nm })} iconRight="chevron-down" onClick={toggle}>
                                    {t(roleLabelKey(cur))}
                                  </UiButton>
                                )}
                              />
                            )}
                        </div>
                      )
                    })}
                  </div>
                )}
                {single && shares.some(sh => sh.can_manage === false) && (
                  <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                    <UiIcon name="lock" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t('files.shareModal.lockedNote', { name: ownerRow.name })}
                  </p>
                )}

                <UiCheckbox modelValue={notify} onUpdateModelValue={setNotify} label={t('files.shareModal.notifyChat')} className="text-[13px]" />
                <UiInput
                  label={t('files.shareModal.noteLabel')}
                  modelValue={note}
                  onUpdateModelValue={setNote}
                  placeholder={t('files.shareModal.noteExample')}
                  hint={t('files.shareModal.noteHint')}
                  maxLength={2000}
                  disabled={!notify}
                />
              </>
            )
        )}
    </UiModal>
  )
}

export default FilesFileShareModal
