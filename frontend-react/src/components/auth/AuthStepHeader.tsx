/**
 * 셋업 단계 머리(Vue components/auth/AuthStepHeader.vue):
 * "단계명  n / 6"(12/600 muted, 숫자 mono) + 4px 진행 바(primary, n/total).
 */
export interface AuthStepHeaderProps {
  label: string
  step: number
  total: number
}

export function AuthStepHeader({ label, step, total }: AuthStepHeaderProps) {
  const pct = Math.round((step / total) * 100)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between text-xs font-semibold text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{step} / {total}</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
        aria-label={`${label} ${step}/${total}`}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default AuthStepHeader
