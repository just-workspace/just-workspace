/**
 * 설정 페이지 머리(헤더형).
 * h1 24/700 −0.02em + 부제 13.5. 모바일(md 미만)에서는 상세 상단 바가 제목을 담당하므로 전체를 숨긴다.
 *
 * @example <SettingsHeader title="계정" subtitle="프로필과 로그인 정보" />
 */
export interface SettingsHeaderProps {
  /** 페이지 제목 */
  title: string
  /** 제목 아래 부제 */
  subtitle?: string
}

export function SettingsHeader({ title, subtitle }: SettingsHeaderProps) {
  return (
    <div className="hidden md:block">
      <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">{title}</h1>
      {subtitle && <p className="mt-1 text-[13.5px] text-muted-foreground">{subtitle}</p>}
    </div>
  )
}

export default SettingsHeader
