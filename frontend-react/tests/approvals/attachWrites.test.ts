import { describe, expect, it } from 'vitest'
import { attachWritesToMessages } from '~/utils/approvals'

const req = (id: string, created_at: string) => ({ id, created_at } as any)

describe('attachWritesToMessages — 대화 다시 열 때 승인 카드 복원', () => {
  const msgs: Array<{ role: string; content: string; created_at: string; writes?: any[] }> = [
    { role: 'user', content: 'a', created_at: '2026-11-05T10:00:00Z' },
    { role: 'assistant', content: 'b', created_at: '2026-11-05T10:00:30Z' },
    { role: 'user', content: 'c', created_at: '2026-11-05T10:05:00Z' },
    { role: 'assistant', content: 'd', created_at: '2026-11-05T10:05:40Z' },
  ]

  it('요청 시각 바로 뒤의 답변에 붙인다', () => {
    const out = attachWritesToMessages(msgs, [req('w1', '2026-11-05T10:00:10Z'), req('w2', '2026-11-05T10:05:20Z')])
    expect(out[1].writes?.map((w: any) => w.id)).toEqual(['w1'])
    expect(out[3].writes?.map((w: any) => w.id)).toEqual(['w2'])
  })

  it('뒤에 답변이 없으면 마지막 답변, 중복은 한 번만', () => {
    const out = attachWritesToMessages(msgs, [req('w3', '2026-11-05T11:00:00Z'), req('w3', '2026-11-05T11:00:00Z')])
    expect(out[3].writes?.map((w: any) => w.id)).toEqual(['w3'])
  })

  it('요청이 없으면 원본 그대로', () => {
    expect(attachWritesToMessages(msgs, [])).toBe(msgs)
  })
})
