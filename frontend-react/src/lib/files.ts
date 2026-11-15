/**
 * 파일 모듈 순수 함수 — 유형 판정·표기·선택 범위. 컴포넌트·테스트가 함께 쓴다.
 *
 * 유형 아이콘 색 체계: 폴더 warning · 문서 primary · 시트 success · 슬라이드 warning ·
 * PDF danger · 이미지/압축 muted. 목록·그리드 동일, aria-label 에 유형 이름.
 */

export type FileKind = 'folder' | 'doc' | 'sheet' | 'slide' | 'pdf' | 'img' | 'zip' | 'file'

interface KindLike { name: string; is_dir?: boolean; mime_type?: string | null }

export function fileKind(item: KindLike): FileKind {
  if (item.is_dir) return 'folder'
  const name = item.name.toLowerCase()
  const mime = item.mime_type || ''
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (/\.(xlsx?|xlsm|csv|ods)$/.test(name) || mime.includes('spreadsheet') || mime.includes('excel')) return 'sheet'
  if (/\.(pptx?|odp)$/.test(name) || mime.includes('presentation')) return 'slide'
  if (/\.(docx?|odt|rtf|hwpx?|md|txt)$/.test(name) || mime.includes('wordprocessing') || mime === 'application/msword') return 'doc'
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|heic|avif)$/.test(name)) return 'img'
  if (/\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/.test(name)) return 'zip'
  return 'file'
}

/** 유형 → [이름 i18n 키, 색 토큰 클래스, 공용 아이콘 이름(utils/icons.ts)]. 모양은 디자인 그대로를 공용 세트로 올렸다. */
export const KIND_META: Record<FileKind, { labelKey: string; tone: string; icon: string }> = {
  folder: { labelKey: 'files.kind.folder', tone: 'text-warning', icon: 'folder' },
  doc: { labelKey: 'files.kind.doc', tone: 'text-primary', icon: 'file-doc' },
  sheet: { labelKey: 'files.kind.sheet', tone: 'text-success', icon: 'file-sheet' },
  slide: { labelKey: 'files.kind.slide', tone: 'text-warning', icon: 'file-slide' },
  pdf: { labelKey: 'files.kind.pdf', tone: 'text-danger', icon: 'file-pdf' },
  img: { labelKey: 'files.kind.img', tone: 'text-muted-foreground', icon: 'file-image' },
  zip: { labelKey: 'files.kind.zip', tone: 'text-muted-foreground', icon: 'file-zip' },
  file: { labelKey: 'files.kind.file', tone: 'text-muted-foreground', icon: 'file' },
}

/** 표기 번역기(i18n t). 주지 않으면 한국어 기본값(테스트·i18n 밖 호출용) */
export type FilesTranslate = (key: string, params?: Record<string, string | number>) => string
const FILES_TEXT_KO: Record<string, string> = {
  'files.expiry.none': '만료 없음',
  'files.expiry.inHour': '{time} (1시간 뒤)',
  'files.expiry.inDays': '{month}월 {day}일 ({days}일 뒤)',
  'files.linkMeta.expired': '만료됨',
  'files.linkMeta.expiresOn': '{md} 만료',
  'files.linkMeta.oneTime': '1회용',
  'files.linkMeta.password': '비밀번호',
  'files.linkMeta.noDownload': '다운로드 막음',
  'files.linkMeta.bundle': '{n}개 묶음',
  'files.linkMeta.downloads': '다운로드 {n}회',
  'files.sidebar.myFiles': '내 파일',
  'files.sidebar.sharedFiles': '공유 파일',
  'files.sidebar.allUsers': '전체 사용자',
}
const koTranslate: FilesTranslate = (key, params) =>
  (FILES_TEXT_KO[key] ?? key).replace(/\{(\w+)\}/g, (_, n: string) => String(params?.[n] ?? ''))

const PREVIEW_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']

/**
 * 문구 파일에 아직 없는 키를 쓸 때 — 없으면(t 가 키를 그대로 돌려주면) 기본 문구에 값을 끼워 돌려준다.
 * (이 앱의 t 는 `t(key, '기본 문구')` 만 기본값을 받고, 값이 든 문구에는 기본값을 못 준다.)
 */
export function textOr(t: (key: string, params?: Record<string, string | number>) => string, key: string, fallback: string, params?: Record<string, string | number>): string {
  const v = t(key, params)
  if (v && v !== key) return v
  return fallback.replace(/\{(\w+)\}/g, (_, n: string) => String(params?.[n] ?? ''))
}

/** IME(한글 등) 조합 중에 온 키인가 — 조합 중 Enter 는 글자를 확정하는 키라 확정·선택 동작에 쓰면 안 된다. */
export function isComposingKey(e: { nativeEvent?: { isComposing?: boolean }; keyCode?: number; isComposing?: boolean }): boolean {
  return !!(e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229)
}

/** 클릭 = 열기에서 미리보기 모달로 여는 종류. 오피스는 새 탭, 폴더는 들어가기. */
export function previewKind(item: KindLike): 'image' | 'pdf' | 'text' | null {
  if (item.is_dir) return null
  const mime = item.mime_type || ''
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  const ext = item.name.split('.').pop()?.toLowerCase() || ''
  // 형식(mime)을 모르는 항목은 확장자로 — 공유받음 첫 목록은 mime 을 안 준다. 예전엔 직접 공유받은
  // 이미지·PDF 가 "미리 볼 수 없음"이었다. 서버 미리보기(app/files/preview.py)가 받는 확장자만.
  if (!mime) {
    if (PREVIEW_IMAGE_EXTS.includes(ext)) return 'image'
    if (ext === 'pdf') return 'pdf'
  }
  const textExts = ['txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'py', 'js', 'ts', 'html', 'css', 'sh', 'vue', 'jsx', 'tsx', 'sql', 'go', 'rs', 'java', 'log', 'ini', 'toml', 'cfg', 'conf', 'env']
  return textExts.includes(ext) ? 'text' : null
}

export function formatSize(bytes: number | null | undefined, empty = '—'): string {
  if (!bytes) return empty
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i]
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 목록 표기 "10/15 10:40"(시안 수정 열). */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 모바일 메타 줄 "10/15". */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}

/** 공유 링크 만료 선택지(백엔드 EXPIRES_MAP 범위: 1h·1d·7d·없음) — 라벨에 날짜를 붙인다. */
export const EXPIRY_HOURS: Record<string, number> = { '1h': 1, '1d': 24, '7d': 168 }

export function expiryLabel(key: string, now = new Date(), tr: FilesTranslate = koTranslate): string {
  const h = EXPIRY_HOURS[key]
  if (!h) return tr('files.expiry.none')
  const at = new Date(now.getTime() + h * 3600_000)
  if (h < 24) return tr('files.expiry.inHour', { time: `${pad(at.getHours())}:${pad(at.getMinutes())}` })
  const days = Math.round(h / 24)
  return tr('files.expiry.inDays', { month: at.getMonth() + 1, day: at.getDate(), days })
}

/** 링크 행 메타 "10/20 만료 · 비밀번호 · 다운로드 막음 · 1회용 · 다운로드 14회" */
export function linkMeta(l: { expires_at: string | null; max_downloads: number | null; download_count: number; has_password?: boolean; allow_download?: boolean; paths?: string[]; email_count?: number }, tr: FilesTranslate = koTranslate): string {
  const parts: string[] = []
  if (l.expires_at) {
    const d = new Date(l.expires_at)
    parts.push(d.getTime() < Date.now() ? tr('files.linkMeta.expired') : tr('files.linkMeta.expiresOn', { md: `${d.getMonth() + 1}/${d.getDate()}` }))
  } else parts.push(tr('files.expiry.none'))
  if (l.paths && l.paths.length > 1) parts.push(tr('files.linkMeta.bundle', { n: l.paths.length }))
  if (l.has_password) parts.push(tr('files.linkMeta.password'))
  if (l.allow_download === false) parts.push(tr('files.linkMeta.noDownload'))
  if (l.max_downloads === 1) parts.push(tr('files.linkMeta.oneTime'))
  parts.push(tr('files.linkMeta.downloads', { n: l.download_count }))
  if (l.email_count) parts.push(tr('files.linkMeta.emailed', { n: l.email_count }))
  return parts.join(' · ')
}

// ─── 공유 링크 이메일로 보내기 — 서버 규칙(app/files/share_email.py)과 같은 한도·형식 ───

/** 한 번에 보낼 수 있는 받는 사람 수 */
export const SHARE_EMAIL_MAX = 20
const EMAIL_RE = /^[^@\s,;<>"']+@[^@\s,;<>"']+\.[^@\s,;<>"']+$/

/** 이메일 형식인가(서버와 같은 규칙) */
export function isEmail(s: string): boolean {
  const v = s.trim()
  return v.length <= 320 && EMAIL_RE.test(v)
}

/** 입력 칸 글자 → 주소 조각(공백·쉼표·세미콜론으로 나눔, 빈 것 제외) */
export function splitEmails(text: string): string[] {
  return text.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
}

/**
 * 칩 목록에 조각들을 더한다 — 형식이 맞는 것은 소문자로(이미 있으면 건너뜀, max 까지), 틀린 것은 bad, 넘친 것은 overflow.
 */
export function addEmails(current: string[], parts: string[], max = SHARE_EMAIL_MAX): { list: string[]; bad: string[]; overflow: number } {
  const list = [...current]
  const bad: string[] = []
  let overflow = 0
  for (const p of parts) {
    if (!isEmail(p)) { bad.push(p); continue }
    const e = p.trim().toLowerCase()
    if (list.includes(e)) continue
    if (list.length >= max) { overflow++; continue }
    list.push(e)
  }
  return { list, bad, overflow }
}

/**
 * 워크스페이스 밖 주소인가(칩 표시용 추정) — 디렉터리 사용자 이메일도 아니고 내 메일 도메인도 아니면 외부.
 * 최종 판정은 서버(발송 기록의 external).
 */
export function isExternalEmail(email: string, knownEmails: Iterable<string>, myEmail?: string | null): boolean {
  const e = email.trim().toLowerCase()
  for (const k of knownEmails) if (k && k.toLowerCase() === e) return false
  const dom = (myEmail || '').toLowerCase().split('@')[1]
  return !(dom && e.split('@')[1] === dom)
}

/**
 * 공유 링크 주소 — 같이 편집 링크는 편집기(/s/), 비밀번호·내려받기 막음 링크도 손님 화면(/s/)으로
 * (비밀번호 입력 → unlock → access, 막음은 미리보기 버튼). 그 밖의 링크는 예전처럼 바로 내려받기.
 */
export function shareUrl(origin: string, token: string, canEdit: boolean, opts: { hasPassword?: boolean; allowDownload?: boolean; isFolder?: boolean } = {}): string {
  // 폴더 링크는 손님 화면에서 둘러본다(바로 zip 이 아니라)
  const guestPage = canEdit || !!opts.hasPassword || opts.allowDownload === false || !!opts.isFolder
  return guestPage ? `${origin}/s/${token}` : `${origin}/api/files/shared/${token}`
}

/** 활동 기록 action → i18n 키(files.activity.*). 모르는 action 은 other. */
const ACTIVITY_ACTIONS = new Set([
  'upload', 'create', 'mkdir', 'copy', 'edit', 'view', 'rename', 'move', 'delete', 'restore', 'purge',
  'share_link', 'share_link_email', 'share_user', 'share_channel', 'link_download', 'version_restore', 'unshare_user', 'comment',
])
export function activityKey(action: string): string {
  return `files.activity.${ACTIVITY_ACTIONS.has(action) ? action : 'other'}`
}

/** 공유 권한 4단계 순서 — 보기 < 댓글 < 편집 < 공동 소유 */
export const SHARE_ROLES = ['view', 'comment', 'edit', 'owner'] as const
export type ShareRoleName = typeof SHARE_ROLES[number]
/** role 이 need 이상인가. 공유가 아닌 내 항목(role 없음)은 소유자로 본다. */
export function roleAtLeast(role: ShareRoleName | null | undefined, need: ShareRoleName): boolean {
  const r = role ?? 'owner'
  return SHARE_ROLES.indexOf(r) >= SHARE_ROLES.indexOf(need)
}
/** 예전 서버 응답(role 없음)은 can_write 로 */
export function roleOf(e: { role?: ShareRoleName | null; can_write?: boolean }): ShareRoleName {
  return e.role ?? (e.can_write ? 'edit' : 'view')
}
/** 권한 이름 i18n 키 */
export function roleLabelKey(role: ShareRoleName): string {
  return `files.shareModal.role.${role}`
}

/** 'shared-with-me/<share_id>/<하위경로>' → { shareId, sub }. 아니면 null. */
export function sharedSubPath(path: string): { shareId: string; sub: string } | null {
  if (!path.startsWith('shared-with-me/')) return null
  const rest = path.slice('shared-with-me/'.length)
  const [shareId, ...sub] = rest.split('/')
  return shareId ? { shareId, sub: sub.join('/') } : null
}

/** 여러 항목 묶음 링크 — 같은 루트(my/ 또는 shared/)에서만 만들 수 있다(서버 규칙). */
export function canBundleLink(paths: string[]): boolean {
  if (paths.length < 2) return false
  const root = paths[0].split('/', 1)[0]
  return (root === 'my' || root === 'shared') && paths.every(p => p.split('/', 1)[0] === root)
}

/** 같은 항목 묶음의 링크인지(순서 무관) */
export function samePathSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every(p => s.has(p))
}

/**
 * Shift 클릭 범위 선택: 순서 목록에서 anchor~target 사이 경로. anchor 가 목록에 없으면 target 하나.
 */
export function rangeBetween(order: string[], anchor: string | null, target: string): string[] {
  const b = order.indexOf(target)
  if (b < 0) return []
  const a = anchor ? order.indexOf(anchor) : -1
  if (a < 0) return [target]
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return order.slice(lo, hi + 1)
}

/** 이동 대상 판정: 자기 자신·자기 하위로는 못 옮기고, 이미 그 폴더에 있으면 의미 없다. */
export function canMoveInto(srcPaths: string[], dst: string): boolean {
  if (!dst) return false
  return srcPaths.every((p) => {
    if (dst === p || dst.startsWith(p + '/')) return false
    const parent = p.split('/').slice(0, -1).join('/')
    return parent !== dst
  })
}

/** 루트 이름 i18n 키(셸·브레드크럼과 같은 표기). */
export const ROOT_LABELS: Record<string, string> = { my: 'files.sidebar.myFiles', shared: 'files.sidebar.sharedFiles', users: 'files.sidebar.allUsers' }

/** "my/프로젝트/2026" → 위치 표기 "내 파일 / 프로젝트" (마지막 조각 제외 = 들어 있는 폴더) */
export function parentLabel(path: string, tr: FilesTranslate = koTranslate): string {
  const parts = path.split('/').filter(Boolean).slice(0, -1)
  return parts.map((p, i) => (i === 0 && ROOT_LABELS[p] ? tr(ROOT_LABELS[p]) : p)).join(' / ')
}

/** 앱 안 끌어다 놓기(이동) 데이터 형식. 바깥 파일 끌기(Files)와 구분한다. */
export const DRAG_MIME = 'application/x-jw-files'

/** 파일 액션 메뉴 항목(데스크톱 드롭다운·모바일 시트 공통). */
export type FileAction = 'open' | 'share' | 'channel' | 'star' | 'move' | 'rename' | 'versions' | 'download' | 'detail' | 'location' | 'delete'
