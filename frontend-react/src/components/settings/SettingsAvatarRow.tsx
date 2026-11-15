/**
 * 계정 카드 맨 위 아바타 줄(시안 PF1) — Vue pages/settings/account.vue 의 인라인 마크업을 이름 붙여 뺀 것.
 * 아바타 64 + 이름 15/600 + 역할 12 muted(+ 오류 12 danger), 오른쪽 [사진 바꾸기](32 테두리) — 숨은 파일 입력을 연다.
 * 카드 본문 패딩을 음수 여백으로 상쇄해 카드 폭 전체에 아래 선을 긋는다(SettingsCard 본문 첫 자식으로 쓴다).
 *
 * @example <SettingsAvatarRow avatarUrl={u.avatar_url} name="홍길동" role="관리자" uploading={false} onFile={upload} />
 */
import { useRef, type ChangeEvent } from 'react'
import { useI18n } from '~/i18n'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiButton } from '~/components/ui/Button'

export interface SettingsAvatarRowProps {
  /** 아바타 이미지 주소 */
  avatarUrl?: string | null
  /** 아바타 alt(표시 이름) */
  alt?: string
  /** 아바타 대체 글자 */
  fallback: string
  /** 이름 줄 */
  name: string
  /** 역할 줄(관리자 · 구성원) */
  role: string
  /** 업로드 오류 문구 */
  error?: string
  /** 업로드 중 — 버튼 비활성 + "올리는 중" */
  uploading?: boolean
  /** 파일 입력 change(파일 고른 뒤). 처리 후 input.value 를 비우는 것은 부모 몫(Vue 와 같음) */
  onFileChange: (e: ChangeEvent<HTMLInputElement>) => void
}

export function SettingsAvatarRow({ avatarUrl, alt, fallback, name, role, error, uploading = false, onFileChange }: SettingsAvatarRowProps) {
  const { t } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="-mx-5 -mt-4 mb-4 flex items-center gap-4 border-b border-border px-5 py-[18px]">
      <UiAvatar src={avatarUrl} alt={alt ?? ''} fallback={fallback} className="h-16 w-16 text-[22px]" />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold text-foreground">{name}</div>
        <div className="text-xs text-muted-foreground">{role}</div>
        {error && <p className="mt-0.5 text-xs text-danger">{error}</p>}
      </div>
      <UiButton variant="outline" size="xs" disabled={uploading} onClick={() => input.current?.click()}>
        {uploading ? t('profile.avatarUploading') : t('settings.account.changePhoto')}
      </UiButton>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={onFileChange} />
    </div>
  )
}

export default SettingsAvatarRow
