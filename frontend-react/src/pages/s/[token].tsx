/**
 * 공유 링크 진입점 — `/s/<token>`. 셸 없음(routes.ts layout:false).
 *
 * 화면: 손님 진입 공통 틀(AuthShell) — 브랜드 → 대상 카드 → (표시 이름) → 1차 버튼.
 * 열기 전에 GET /api/wopi/shared/{token}/info(횟수 미집계)로 대상 카드(이름·공유자·권한 칩·만료)를 렌더한다.
 *  - 비밀번호 링크: info 가 requires_password 만 반환한다 → "비밀번호 필요" 결과 틀(입력 1개 + 열기)
 *    → POST /api/files/shared/{token}/unlock → access(1시간). 이후 내려받기·편집기 열기에 access 를 첨부한다.
 *  - 같이 편집 링크(can_edit): 표시 이름(기억) → 문서 열기(POST /api/wopi/shared/{token}/open) → 40px 손님 띠 + 편집기.
 *  - 내려받기 링크: [다운로드](GET /api/files/shared/{token}?access=) — 내려받기 차단이면 [미리보기](?inline=1, 새 탭).
 *    묶음 링크는 zip 하나. 이 경우 화면 문구는 시안에 없어 동일 틀로 구성.
 *    내려받기가 차단되었고 미리보기도 불가한 형식(이전에 생성한 링크 · info.can_preview=false, 비밀번호 링크는 unlock 응답)이면
 *    [미리보기] 대신 "미리 볼 수 없고 내려받기가 막혀 있습니다" 안내 — 새 탭에 서버 오류(JSON)가 표시되던 무효 링크.
 *  - 폴더 링크(info.is_folder): 셸 대신 SharedFolderView(OneDrive식 탐색 — 하위 폴더·파일별 미리보기/받기).
 *    비밀번호 링크는 info 가 내용을 숨기므로, 잠금 해제 후 /list 를 1회 호출하여 성공하면 폴더 화면으로 전환한다.
 * 만료·권한 없음·삭제됨·횟수 초과는 동일 결과 화면 틀.
 */
import { useEffect, useState, type FormEvent, type MouseEvent } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { useHead } from '~/lib/head'
import { useRoute, navigateTo } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useAuth } from '~/composables/useAuth'
import type { EditorSession } from '~/composables/useOfficeEditor'
import { NuxtLink } from '~/components/NuxtLink'
import { AuthShell } from '~/components/auth/AuthShell'
import { AuthHeading } from '~/components/auth/AuthHeading'
import { AuthGuestCard } from '~/components/auth/AuthGuestCard'
import { AuthGuestBand } from '~/components/auth/AuthGuestBand'
import { AuthAlert } from '~/components/auth/AuthAlert'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { FilesFileOfficeEditor } from '~/components/files/FileOfficeEditor'
import { SharedFolderView } from '~/components/files/SharedFolderView'

interface SharedInfo {
  name: string
  size: number | null
  is_office: boolean
  can_edit: boolean
  allow_download: boolean
  requires_password: boolean
  is_multi: boolean
  is_folder?: boolean
  item_count: number
  expires_at: string | null
  downloads_left: number | null
  owner_name: string | null
  exists: boolean
  /** 내려받기 차단 링크에서 표시할 대상의 존재 여부(서버 판정 — 구버전 서버면 필드 없음 → 존재로 간주) */
  can_preview?: boolean
}

type BlockKind = 'expired' | 'denied' | 'gone' | 'unsupported' | 'used'

const pad = (n: number) => String(n).padStart(2, '0')
function formatSize(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i]
}

export default function SharedLinkPage() {
  const route = useRoute()
  const { appName } = useSiteConfig()
  const { user } = useAuth()
  const { t } = useI18n()

  const token = String(route.params.token || '')
  const [info, setInfo] = useState<SharedInfo | null>(null)
  const [infoLoading, setInfoLoading] = useState(true)
  const [name, setName] = useState('')
  const [session, setSession] = useState<(EditorSession & { can_edit: boolean; guest_name: string }) | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // 비밀번호 링크
  const [access, setAccess] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [pwError, setPwError] = useState('')
  // 재시도해도 결과가 동일한 상태 → 결과 화면
  const [blocked, setBlocked] = useState<null | { kind: BlockKind; message: string }>(null)
  // 비밀번호 링크 잠금 해제 후 폴더 링크로 확인됨
  const [unlockedFolder, setUnlockedFolder] = useState(false)
  // 비밀번호 링크 잠금 해제 후 서버가 반환한 미리보기 가능 여부(info 는 해제 전이라 확인 불가)
  const [unlockedCanPreview, setUnlockedCanPreview] = useState<boolean | null>(null)

  const isEdit = !!info?.can_edit
  const locked = !!info?.requires_password && !access
  const folderTitle = !!info?.is_folder || unlockedFolder
  useHead({ title: `${folderTitle ? t('share.folder.title') : isEdit || !info ? t('share.title') : t('share.fileTitle')} | ${appName}` })

  function blockFrom(e: any) {
    const status = e?.statusCode || e?.status || 0
    const detail = typeof e?.data?.detail === 'string' ? e.data.detail : ''
    if (status === 410) setBlocked({ kind: 'expired', message: detail })
    else if (status === 403) setBlocked({ kind: 'denied', message: detail })
    else if (status === 404) setBlocked({ kind: 'gone', message: detail })
    else if (status === 400) setBlocked({ kind: 'unsupported', message: detail })
    else return false
    return true
  }

  async function loadInfo() {
    setInfoLoading(true)
    setError('')
    try {
      const i = await $fetch<SharedInfo>(`/api/wopi/shared/${token}/info`)
      setInfo(i)
      if (!i.exists) setBlocked({ kind: 'gone', message: '' })
      else if (i.downloads_left === 0) setBlocked({ kind: 'used', message: '' })
    } catch (e: any) {
      // 만료 링크는 서버가 404 "Link expired"/410 으로 반환한다
      if (!blockFrom(e)) setError(t('share.openFailed'))
    } finally {
      setInfoLoading(false)
    }
  }

  useEffect(() => {
    // 직전에 사용한 이름을 저장한다(매번 재입력하는 불편 방지).
    let n = ''
    try { n = localStorage.getItem('ws_guest_name') || '' } catch { /* noop */ }
    if (!n && user?.display_name) n = user.display_name
    setName(n)
    void loadInfo()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const RESULT = {
    expired: { icon: 'clock', tone: 'warning', title: t('share.result.expired.title'), hint: t('share.result.expired.hint') },
    denied: { icon: 'lock', tone: 'danger', title: t('share.result.denied.title'), hint: t('share.result.denied.hint') },
    gone: { icon: 'trash', tone: 'warning', title: t('share.result.gone.title'), hint: t('share.result.gone.hint') },
    unsupported: { icon: 'file-text', tone: 'warning', title: t('share.result.unsupported.title'), hint: '' },
    used: { icon: 'download', tone: 'warning', title: t('share.result.used.title'), hint: t('share.result.used.hint') },
  } as const

  // ── 대상 카드 ──
  const cardName = !info ? '' : info.name ? info.name : (isEdit ? t('share.lockedDoc') : t('share.lockedFile'))
  const cardMeta = (() => {
    const i = info
    if (!i) return ''
    const parts: string[] = []
    if (i.owner_name) parts.push(t('share.sharedBy', { name: i.owner_name }))
    if (i.is_multi && !i.is_folder && !unlockedFolder) parts.push(t('share.itemCount', { n: i.item_count }))
    else if (i.size) parts.push(formatSize(i.size))
    if (i.expires_at) {
      const d = new Date(i.expires_at)
      parts.push(t('share.until', { md: `${pad(d.getMonth() + 1)}/${pad(d.getDate())}` }))
    }
    if (i.downloads_left !== null && i.downloads_left > 0) parts.push(t('share.downloadsLeft', { n: i.downloads_left }))
    return parts.join(' · ')
  })()
  const badge = (() => {
    const i = info
    if (!i) return { label: '', tone: 'neutral' as const }
    if (i.can_edit) return { label: t('share.canEdit'), tone: 'success' as const }
    if (!i.allow_download) return { label: t('share.previewOnly'), tone: 'warning' as const }
    return { label: t('share.downloadable'), tone: 'primary' as const }
  })()
  const cardIcon = info?.is_folder ? 'folder' : info?.is_multi ? 'file-zip' : isEdit ? 'file-text' : 'file'

  // ── 비밀번호 ──
  async function unlock(e?: FormEvent) {
    e?.preventDefault()
    if (unlocking) return
    setPwError('')
    if (!password) { setPwError(t('share.passwordRequired')); return }
    setUnlocking(true)
    try {
      const r = await $fetch<{ ok: boolean; access: string | null; can_preview?: boolean; exists?: boolean }>(`/api/files/shared/${token}/unlock`, { method: 'POST', body: { password } })
      // 원본이 삭제된 경우 "삭제됨"이 우선한다(존재하지 않는 파일을 "미리 볼 수 없는 형식"으로 안내하지 않는다)
      if (r.exists === false) { setBlocked({ kind: 'gone', message: '' }); setPassword(''); return }
      if (typeof r.can_preview === 'boolean') setUnlockedCanPreview(r.can_preview)
      if (r.access) {
        // 폴더 링크 여부 판정 — 목록 조회에 성공하면 폴더(400 = 파일·묶음 링크)
        try {
          await $fetch(`/api/files/shared/${token}/list?access=${encodeURIComponent(r.access)}`)
          setUnlockedFolder(true)
        } catch { /* 폴더 링크 아님 */ }
      }
      setAccess(r.access || 'none')
      setPassword('')
    } catch (err: any) {
      const status = err?.statusCode || err?.status || 0
      if (status === 401) setPwError(t('share.passwordWrong'))
      else if (!blockFrom(err)) setPwError(t('share.openFailed'))
    } finally {
      setUnlocking(false)
    }
  }
  const accessQuery = access && access !== 'none' ? `access=${encodeURIComponent(access)}` : ''
  const downloadHref = `/api/files/shared/${token}${accessQuery ? `?${accessQuery}` : ''}`
  const previewHref = `/api/files/shared/${token}?inline=1${accessQuery ? `&${accessQuery}` : ''}`

  // ── 같이 편집 ──
  async function enter(e?: FormEvent) {
    e?.preventDefault()
    if (loading) return
    setLoading(true)
    setError('')
    try {
      setSession(await $fetch<any>(`/api/wopi/shared/${token}/open`, {
        method: 'POST',
        body: { name: name.trim(), access: access && access !== 'none' ? access : null },
      }))
      try { localStorage.setItem('ws_guest_name', name.trim()) } catch { /* noop */ }
    } catch (err: any) {
      const status = err?.statusCode || err?.status || 0
      // 비밀번호 접근 키가 만료(1시간)된 경우 재입력을 요구한다
      if (status === 401) { setAccess(null); setPwError(t('share.passwordExpired')) }
      else if (!blockFrom(err)) setError((typeof err?.data?.detail === 'string' && err.data.detail) || t('share.openFailed'))
    } finally {
      setLoading(false)
    }
  }

  // 내려받기 차단 + 미리보기도 불가한 형식 = 표시할 대상 없음(버튼 대신 안내)
  const nothingToSee = !!info && !info.allow_download && !isEdit
    && (info.requires_password ? unlockedCanPreview === false : info.can_preview === false)

  const loginHref = `/login?redirect=${encodeURIComponent(route.fullPath)}`

  // 폴더 링크: OneDrive식 탐색 화면
  const isFolder = !!info && (!!info.is_folder || unlockedFolder)
  if (isFolder && !blocked && !locked && !isEdit) {
    return (
      <SharedFolderView
        token={token}
        access={access && access !== 'none' ? access : null}
        meta={cardMeta}
        onBlocked={blockFrom}
        onLocked={() => { setAccess(null); setUnlockedFolder(false); setPwError(t('share.passwordExpired')) }}
      />
    )
  }

  // 편집 중: 40px 손님 띠 + 편집기
  if (session) {
    return (
      <div className="flex h-dvh flex-col bg-background">
        <AuthGuestBand
          title={session.file_name}
          guestName={session.guest_name}
          meta={session.can_edit ? t('share.canEdit') : t('share.viewOnly')}
          onLeave={() => setSession(null)}
        />
        <div className="min-h-0 flex-1">
          <FilesFileOfficeEditor session={session} filePath={session.file_name} onClose={() => setSession(null)} />
        </div>
      </div>
    )
  }

  return (
    <AuthShell>
      {blocked
        ? (
          // 만료·권한 없음·삭제됨·횟수 초과 — 결과 화면 틀
          <>
            <AuthHeading
              icon={RESULT[blocked.kind].icon}
              tone={RESULT[blocked.kind].tone}
              title={RESULT[blocked.kind].title}
            >
              {blocked.message && blocked.kind !== 'expired' && blocked.kind !== 'gone' ? `${blocked.message}. ` : null}{RESULT[blocked.kind].hint}
            </AuthHeading>
            {!user && (
              <UiButton
                as="a"
                href={loginHref}
                variant="outline"
                size="lg"
                className="w-full bg-card"
                onClick={(e: MouseEvent) => { e.preventDefault(); void navigateTo(loginHref) }}
              >{t('common.login')}</UiButton>
            )}
          </>
        )
        : infoLoading
          ? <UiSkeleton preset="text" rows={3} />
          : !info
            ? (
              // 정보 조회 실패(네트워크 등)
              <>
                <AuthHeading title={t('share.title')} />
                <AuthAlert tone="danger" title={error || t('share.openFailed')} description={t('share.retryLater')} />
                <UiButton size="lg" variant="outline" className="w-full bg-card" onClick={loadInfo}>{t('common.retry')}</UiButton>
              </>
            )
            : locked
              ? (
                // 비밀번호 필요(결과 화면 틀 · 입력 1개 + 열기)
                <>
                  <AuthHeading icon="lock" tone="primary" title={t('share.passwordTitle')} subtitle={t('share.passwordHint')} />
                  <AuthGuestCard name={cardName} meta={cardMeta} icon={cardIcon} badge={badge.label} badgeTone={badge.tone} />
                  <form className="flex flex-col gap-[18px]" noValidate onSubmit={unlock}>
                    <UiPasswordInput
                      id="share-password"
                      modelValue={password}
                      onUpdateModelValue={setPassword}
                      size="lg"
                      label={t('share.passwordLabel')}
                      error={pwError}
                      autocomplete="off"
                      autofocus
                    />
                    <UiButton type="submit" size="lg" className="w-full font-semibold" disabled={unlocking}>
                      {unlocking && <UiIcon name="refresh" className="mr-2 h-4 w-4 animate-spin" />}
                      {unlocking ? t('share.opening') : t('share.unlock')}
                    </UiButton>
                  </form>
                </>
              )
              : isEdit
                ? (
                  // 같이 편집
                  <>
                    <AuthHeading title={t('share.title')} subtitle={t('share.subtitle')} />
                    <AuthGuestCard name={cardName} meta={cardMeta} icon={cardIcon} badge={badge.label} badgeTone={badge.tone} />

                    {error && <AuthAlert tone="danger" title={error} description={t('share.retryLater')} />}
                    {pwError && <AuthAlert tone="danger" title={pwError} />}

                    <form className="flex flex-col gap-[18px]" noValidate onSubmit={enter}>
                      <UiInput
                        id="guest-name"
                        modelValue={name}
                        onUpdateModelValue={setName}
                        size="lg"
                        label={t('share.nameLabel')}
                        hint={t('share.nameHint')}
                        placeholder={t('share.namePlaceholder')}
                        maxLength={20}
                        autocomplete="nickname"
                        autoFocus
                      />
                      <UiButton type="submit" size="lg" className="w-full font-semibold" disabled={loading}>
                        {loading && <UiIcon name="refresh" className="mr-2 h-4 w-4 animate-spin" />}
                        {loading ? t('share.opening') : t('share.open')}
                      </UiButton>
                    </form>

                    {!user && (
                      <p className="text-[13px] text-muted-foreground">
                        {t('share.hasAccount')}{' '}
                        <NuxtLink to={loginHref} className="font-semibold text-primary hover:underline">{t('common.login')}</NuxtLink>
                      </p>
                    )}
                  </>
                )
                : (
                  // 내려받기 링크
                  <>
                    <AuthHeading title={t('share.fileTitle')} subtitle={info.allow_download ? t('share.fileSubtitle') : t('share.previewSubtitle')} />
                    <AuthGuestCard name={cardName} meta={cardMeta} icon={cardIcon} badge={badge.label} badgeTone={badge.tone} />
                    {info.allow_download
                      ? (
                        <UiButton as="a" href={downloadHref} size="lg" icon="download" className="w-full font-semibold">
                          {info.is_multi ? t('share.downloadZip') : t('share.download')}
                        </UiButton>
                      )
                      : nothingToSee
                        ? (
                          <AuthAlert
                            tone="warning"
                            title={t('share.noPreviewBlocked', '이 형식은 미리 볼 수 없고 다운로드가 막혀 있습니다.')}
                            description={t('share.noPreviewBlockedHint', '링크를 보낸 사람에게 다운로드를 허용해 달라고 요청하십시오.')}
                          />
                        )
                        : (
                        <UiButton as="a" href={previewHref} target="_blank" rel="noopener" size="lg" icon="eye" className="w-full font-semibold">
                          {t('share.preview')}
                        </UiButton>
                      )}
                  </>
                )}
    </AuthShell>
  )
}
