import { describe, it, expect } from 'vitest'
import { parseQuickTask, dueGroupOf, dueLabel, dueLong, groupTasks, compareTasks, resolveAssignee, normalizeTag } from '~/utils/taskQuick'

// 2026-10-15 목요일
const NOW = new Date(2026, 9, 15, 10, 0, 0)

describe('parseQuickTask — 빠른 입력 해석', () => {
  it('시안 예시: 요일 + !우선순위', () => {
    const r = parseQuickTask('회고 자료 준비 금요일 !높음', NOW)
    expect(r.title).toBe('회고 자료 준비')
    expect(r.due).toBe('2026-10-16')
    expect(r.priority).toBe('high')
    expect(r.tokens.map(t => t.kind)).toEqual(['date', 'priority'])
  })
  it('오늘·내일·모레', () => {
    expect(parseQuickTask('a 오늘', NOW).due).toBe('2026-10-15')
    expect(parseQuickTask('a 내일', NOW).due).toBe('2026-10-16')
    expect(parseQuickTask('모레 a', NOW).due).toBe('2026-10-17')
  })
  it('같은 요일은 오늘, 지난 요일은 다음 주', () => {
    expect(parseQuickTask('a 목요일', NOW).due).toBe('2026-10-15')
    expect(parseQuickTask('a 월요일', NOW).due).toBe('2026-10-19')
  })
  it('이번 주·다음 주 요일, 다음 주 단독', () => {
    expect(parseQuickTask('a 이번 주 금요일', NOW).due).toBe('2026-10-16')
    expect(parseQuickTask('a 다음 주 월요일', NOW).due).toBe('2026-10-19')
    expect(parseQuickTask('a 다음주 금요일', NOW).due).toBe('2026-10-23')
    expect(parseQuickTask('a 다음 주', NOW).due).toBe('2026-10-19')
  })
  it('M/D · M월 D일 · YYYY-MM-DD, 지난 날짜는 내년', () => {
    expect(parseQuickTask('a 10/17', NOW).due).toBe('2026-10-17')
    expect(parseQuickTask('a 3/2', NOW).due).toBe('2027-03-02')
    expect(parseQuickTask('a 11월 3일', NOW).due).toBe('2026-11-03')
    expect(parseQuickTask('a 2027-01-05', NOW).due).toBe('2027-01-05')
    expect(parseQuickTask('a 2/30', NOW).due).toBeNull()
  })
  it('단어 경계만 — "오늘의" 는 날짜 아님', () => {
    const r = parseQuickTask('오늘의 회의 정리', NOW)
    expect(r.due).toBeNull()
    expect(r.title).toBe('오늘의 회의 정리')
  })
  it('긴급은 urgent, 모르는 !단어는 제목에 남김', () => {
    expect(parseQuickTask('a !긴급', NOW).priority).toBe('urgent')
    expect(parseQuickTask('a !낮음', NOW).priority).toBe('low')
    const r = parseQuickTask('경고 !중요', NOW)
    expect(r.priority).toBeNull()
    expect(r.title).toBe('경고 !중요')
  })
  it('@담당은 제목에서 빼고, 못 찾았을 때용 제목(titleWithAssignee)을 따로 준다', () => {
    const r = parseQuickTask('리뷰 @정하늘 내일', NOW)
    expect(r.assignee).toBe('정하늘')
    expect(r.title).toBe('리뷰')
    expect(r.titleWithAssignee).toBe('리뷰 @정하늘')
    expect(r.due).toBe('2026-10-16')
  })
})

describe('마감 묶기·표기', () => {
  const t = (due: string | null, status = 'todo') => ({ due_date: due, status })
  it('묶음 키', () => {
    expect(dueGroupOf(t('2026-10-14T00:00:00Z'), NOW)).toBe('overdue')
    expect(dueGroupOf(t('2026-10-15'), NOW)).toBe('today')
    expect(dueGroupOf(t('2026-10-18'), NOW)).toBe('week') // 일요일까지 이번 주
    expect(dueGroupOf(t('2026-10-19'), NOW)).toBe('later')
    expect(dueGroupOf(t(null), NOW)).toBe('none')
    expect(dueGroupOf(t('2026-10-01', 'done'), NOW)).toBe('done')
  })
  it('행 표기', () => {
    expect(dueLabel(t('2026-10-14'), NOW)).toEqual({ text: '어제 · 지남', tone: 'danger' })
    expect(dueLabel(t('2026-10-10'), NOW)).toEqual({ text: '10/10 · 지남', tone: 'danger' })
    expect(dueLabel(t('2026-10-15'), NOW)).toEqual({ text: '오늘', tone: 'warning' })
    expect(dueLabel(t('2026-10-17'), NOW)).toEqual({ text: '10/17 D-2', tone: 'foreground' })
    expect(dueLabel(t('2026-10-18'), NOW)).toEqual({ text: '10/18', tone: 'foreground' })
    expect(dueLabel(t('2026-10-24'), NOW)).toEqual({ text: '10/24', tone: 'muted' })
    expect(dueLabel(t(null), NOW)).toBeNull()
  })
  it('상세 표기', () => {
    expect(dueLong('2026-10-17', NOW)).toEqual({ text: '10/17 (D-2)', tone: 'warning' })
    expect(dueLong('2026-10-12', NOW)?.tone).toBe('danger')
  })
})

describe('정렬·묶기', () => {
  const mk = (id: string, priority: string, due: string | null, created: string, status = 'todo') =>
    ({ id, priority, due_date: due, created_at: created, status })
  const list = [
    mk('a', 'low', '2026-10-15', '2026-10-01'),
    mk('b', 'high', '2026-10-15', '2026-10-02'),
    mk('c', 'medium', null, '2026-10-03'),
    mk('d', 'high', '2026-10-01', '2026-10-04'),
    mk('e', 'medium', '2026-10-16', '2026-10-05', 'done'),
  ]
  it('기본 = 마감 묶기 + 우선순위 정렬', () => {
    const g = groupTasks(list, 'due', 'priority', NOW)
    expect(g.map(x => x.key)).toEqual(['overdue', 'today', 'none', 'done'])
    expect(g[1].items.map(x => x.id)).toEqual(['b', 'a'])
    expect(g[0].tone).toBe('danger')
  })
  it('우선순위 묶기', () => {
    const g = groupTasks(list, 'priority', 'due', NOW)
    expect(g.map(x => x.label)).toEqual(['높음', '보통', '낮음'])
    expect(g[0].items.map(x => x.id)).toEqual(['d', 'b'])
  })
  it('생성순은 최신 먼저', () => {
    expect(compareTasks(list[0], list[1], 'created')).toBeGreaterThan(0)
  })
})

describe('resolveAssignee · normalizeTag', () => {
  const users = [
    { id: '1', username: 'haneul', display_name: '정하늘' },
    { id: '2', username: 'han', display_name: '한지민' },
    { id: '3', username: 'seoyeon', display_name: '김서연' },
  ]
  it('아이디 정확히 > 표시 이름 정확히 > 하나뿐인 앞부분', () => {
    expect(resolveAssignee('han', users)?.id).toBe('2')
    expect(resolveAssignee('정하늘', users)?.id).toBe('1')
    expect(resolveAssignee('seo', users)?.id).toBe('3')
    expect(resolveAssignee('ha', users)).toBeNull() // haneul · han 둘 다
    expect(resolveAssignee('없는사람', users)).toBeNull()
    expect(resolveAssignee(null, users)).toBeNull()
  })
  it('태그 앞 # 와 공백을 뗀다', () => {
    expect(normalizeTag('  #프론트 ')).toBe('프론트')
    expect(normalizeTag('#')).toBe('')
  })
})

describe('우선순위 긴급 정렬·묶기', () => {
  it('긴급이 높음보다 앞, 우선순위 묶기 첫 묶음', () => {
    const a = { priority: 'high', due_date: null, created_at: '2026-10-01', status: 'todo' }
    const b = { priority: 'urgent', due_date: null, created_at: '2026-10-01', status: 'todo' }
    expect(compareTasks(b, a, 'priority')).toBeLessThan(0)
    expect(groupTasks([a, b], 'priority', 'priority', NOW).map(g => g.key)).toEqual(['urgent', 'high'])
  })
})
