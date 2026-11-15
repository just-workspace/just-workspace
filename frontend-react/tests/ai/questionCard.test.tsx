// AI 질문 카드(Claude Code AskUserQuestion · ExitPlanMode) — 고르기·기타·여러 질문 넘기기·넘기기·계획 승인.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { AiQuestion } from '~/utils/aiAssist'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: any }[],
  respond: (_url: string, _opts?: any): any => ({}),
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => { api.calls.push({ url, opts }); return api.respond(url, opts) }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { AiQuestionCard } = await import('~/components/ai/AiQuestionCard')
const { permissionStore } = await import('~/composables/usePermissionMode')
const S = await import('~/composables/useAiStreams')
const { i18n } = await import('~/i18n')
const t = (k: string, v?: Record<string, unknown>) => i18n.t(k, v)

const ASK: AiQuestion = {
  id: 'q_1', kind: 'ask', status: 'pending',
  questions: [
    { question: '어느 형식으로 만들까요?', header: '형식', options: [{ label: 'PDF (추천)', description: '보기 좋음' }, { label: 'DOCX' }] },
    { question: '누구에게 보낼까요?', header: '받는 사람', multiSelect: true, options: [{ label: '팀' }, { label: '고객' }] },
  ],
}

beforeEach(() => {
  api.calls = []
  api.respond = (_u, opts) => ({ question: { ...ASK, status: opts?.body?.skip ? 'skipped' : 'answered' }, mode: null })
  permissionStore.setState({ mode: 'plan', loaded: true })
})

describe('AI 질문 카드 — 질문', () => {
  it('질문 1 고르고 다음 → 질문 2 여러 개 + 기타 → 답하기 = 질문 순서대로 보낸다', async () => {
    const onChange = vi.fn()
    render(<AiQuestionCard q={ASK} onChange={onChange} />)
    expect(screen.getByText('어느 형식으로 만들까요?')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'DOCX' }))
    fireEvent.click(screen.getByRole('button', { name: t('ai.ask.next') }))
    expect(screen.getByText('누구에게 보낼까요?')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '팀' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '고객' }))
    fireEvent.click(screen.getByRole('checkbox', { name: t('ai.ask.other') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('ai.ask.other') }), { target: { value: '본부장' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('ai.ask.submit') })) })
    const c = api.calls.find(x => x.url === '/api/ai/questions/q_1/answer')
    expect(c?.opts?.body).toEqual({ answers: [{ selected: ['DOCX'], other: null }, { selected: ['팀', '고객'], other: '본부장' }] })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'answered' }))
  })

  it('숫자 키로 고른다(단일 선택은 다시 누르면 바뀜)', () => {
    render(<AiQuestionCard q={ASK} />)
    const region = screen.getByRole('region', { name: t('ai.ask.title') })
    fireEvent.keyDown(region, { key: '1' })
    expect(screen.getByRole('radio', { name: 'PDF (추천)' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(region, { key: '2' })
    expect(screen.getByRole('radio', { name: 'PDF (추천)' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('radio', { name: 'DOCX' }).getAttribute('aria-checked')).toBe('true')
  })

  it('넘기기 = skip', async () => {
    render(<AiQuestionCard q={ASK} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('ai.ask.skip') })) })
    expect(api.calls[0].opts?.body).toEqual({ skip: true })
  })

  it('답한 카드는 한 줄 요약', () => {
    render(<AiQuestionCard q={{ ...ASK, status: 'answered', answer: { answers: [
      { question: 'a', selected: ['DOCX'], other: null }, { question: 'b', selected: ['팀'], other: '본부장' }] } }} />)
    expect(document.body.textContent).toContain('DOCX · 팀, 본부장')
    expect(screen.queryByRole('button', { name: t('ai.ask.submit') })).toBeNull()
  })
})

describe('AI 질문 카드 — 계획 승인', () => {
  const PLAN: AiQuestion = { id: 'q_p', kind: 'plan', status: 'pending', plan: '## 계획\n1. 파일 만들기' }

  it('1 = 편집 자동 수락으로 진행 → 권한 모드 칩도 바뀐다', async () => {
    api.respond = () => ({ question: { ...PLAN, status: 'answered', answer: { choice: 'acceptEdits' } }, mode: 'acceptEdits' })
    render(<AiQuestionCard q={PLAN} />)
    expect(document.body.textContent).toContain('파일 만들기')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('ai.ask.planChoice.acceptEdits') })) })
    expect(api.calls[0].opts?.body).toEqual({ choice: 'acceptEdits', feedback: null })
    expect(permissionStore.getState().mode).toBe('acceptEdits')
  })

  it('3 = 계속 계획 + 피드백', async () => {
    render(<AiQuestionCard q={PLAN} />)
    fireEvent.click(screen.getByRole('button', { name: t('ai.ask.planChoice.keep_planning') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('ai.ask.planFeedback') }), { target: { value: '메일은 빼' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('ai.ask.sendFeedback') })) })
    expect(api.calls[0].opts?.body).toEqual({ choice: 'keep_planning', feedback: '메일은 빼' })
  })
})

describe('스트림 question 이벤트', () => {
  it('같은 id 는 덮고, 답한 카드를 재생된 대기로 되돌리지 않는다', () => {
    const a = S.aiApplyEvent({ role: 'assistant', content: '' } as any, 'question', ASK).msg
    expect(a.questions).toHaveLength(1)
    const b = S.aiApplyEvent(a, 'question', { ...ASK, status: 'answered' }).msg
    expect(b.questions![0].status).toBe('answered')
    const c = S.aiApplyEvent(b, 'question', ASK).msg
    expect(c.questions![0].status).toBe('answered')
  })
})
