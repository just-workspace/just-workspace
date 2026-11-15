/**
 * 비밀번호 규칙 실시간 체크. 백엔드 app/auth/password_policy.py(NIST SP 800-63B-4)와 같은 기준:
 *  - length      8자 이상 (SHALL)                       — 필수
 *  - distinct    아이디·이메일을 빼고도 8자 이상 (문맥 추측 차단) — 필수
 *  - recommended 15자 이상 (SHOULD)                      — 권장(제출 막지 않음)
 * 시안의 "영문·숫자 포함" 은 800-63B-4 가 금지한 구성 규칙(SHALL NOT)이라 넣지 않는다 — 디자이너 확인 필요.
 * 블록리스트·연속 문자 같은 나머지 검사는 서버 응답(폼 상단 타일)으로 보여 준다.
 */
export const PASSWORD_MIN = 8
export const PASSWORD_RECOMMENDED = 15

/** common = 흔한·유출 비밀번호 아님(서버 블록리스트 — POST /api/auth/password-check 응답 뒤에만 통과 표시, 설정 › 보안) */
export type PasswordRuleKey = 'length' | 'distinct' | 'recommended' | 'common'

export interface PasswordRuleResult {
  key: PasswordRuleKey
  ok: boolean
  /** false 면 안내만(권장) */
  required: boolean
  /** 현재 글자 수(length 규칙 표시용) */
  n: number
}

/** 백엔드 _strip_context 와 같은 규칙으로 문맥 문자열(아이디·이메일·로컬파트)을 뺀 나머지. */
export function stripContext(pwLow: string, context: Array<string | null | undefined>): string {
  let out = pwLow
  for (const c of context) {
    if (!c || c.length < 3) continue
    const low = c.toLowerCase()
    out = out.split(low).join('')
    const local = low.split('@')[0]
    if (local.length >= 3) out = out.split(local).join('')
  }
  return out
}

export function checkPasswordRules(
  password: string,
  context: Array<string | null | undefined> = [],
): PasswordRuleResult[] {
  const pw = (password ?? '').normalize('NFKC')
  const n = pw.length
  const low = pw.toLowerCase()
  const hasContext = context.some(c => !!c && c.length >= 3)
  return [
    { key: 'length', ok: n >= PASSWORD_MIN, required: true, n },
    // 문맥 값이 아직 없으면(아이디 미입력) 통과로 본다 — 입력되면 다시 평가
    { key: 'distinct', ok: !hasContext || stripContext(low, context).length >= PASSWORD_MIN, required: true, n },
    { key: 'recommended', ok: n >= PASSWORD_RECOMMENDED, required: false, n },
  ]
}

/** 필수 규칙을 모두 통과했는지(제출 버튼 활성 조건). */
export function passwordRulesPass(results: PasswordRuleResult[]): boolean {
  return results.every(r => !r.required || r.ok)
}
