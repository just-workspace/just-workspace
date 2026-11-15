import { describe, expect, it } from 'vitest'
import { checkPasswordRules, passwordRulesPass, stripContext } from '~/utils/passwordRules'

const byKey = (pw: string, ctx: string[] = []) =>
  Object.fromEntries(checkPasswordRules(pw, ctx).map(r => [r.key, r]))

describe('passwordRules', () => {
  it('8자 미만이면 length 실패, 글자 수를 같이 돌려준다', () => {
    const r = byKey('abcdefg')
    expect(r.length.ok).toBe(false)
    expect(r.length.n).toBe(7)
    expect(r.length.required).toBe(true)
  })

  it('8자 이상이면 length 통과, 15자 이상이면 recommended 통과(권장은 required 가 아님)', () => {
    expect(byKey('correct horse').length.ok).toBe(true)
    expect(byKey('correct horse').recommended.ok).toBe(false)
    expect(byKey('correct horse battery').recommended.ok).toBe(true)
    expect(byKey('correct horse').recommended.required).toBe(false)
  })

  it('아이디·이메일을 빼고 8자가 안 되면 distinct 실패(백엔드 _strip_context 와 동일)', () => {
    expect(byKey('hanul2026!', ['hanul']).distinct.ok).toBe(false)
    expect(byKey('hanul@just.work1', ['hanul@just.work']).distinct.ok).toBe(false)
    expect(byKey('HANUL-sunrise-river', ['hanul']).distinct.ok).toBe(true)
  })

  it('문맥 값이 아직 없거나 3자 미만이면 distinct 는 통과로 본다', () => {
    expect(byKey('whatever-long', []).distinct.ok).toBe(true)
    expect(byKey('whatever-long', ['ab', '']).distinct.ok).toBe(true)
  })

  it('stripContext 는 이메일 로컬파트까지 뺀다', () => {
    expect(stripContext('hanulpass', ['hanul@just.work'])).toBe('pass')
  })

  it('passwordRulesPass 는 필수 규칙만 본다', () => {
    expect(passwordRulesPass(checkPasswordRules('correct horse'))).toBe(true)
    expect(passwordRulesPass(checkPasswordRules('short'))).toBe(false)
    expect(passwordRulesPass(checkPasswordRules('hanul123', ['hanul']))).toBe(false)
  })
})
