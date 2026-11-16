// 승인 카드 경고 — 자동 수락·허용 규칙임에도 확인을 요청하는 사유 한 줄(서버 ask_reason = 타인에게 노출되는 쓰기 관문).
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ApprovalRequest } from '~/utils/approvals'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { ApprovalExternalWarning } from '~/components/approvals/ApprovalParts'
import { ApprovalCard } from '~/components/approvals/ApprovalCard'

const REASON = /다른 사람에게 표시되는 작업은 자동 수락·허용 규칙이 있어도 묻습니다/

function req(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const now = new Date().toISOString()
  return {
    id: 'wr_1', tool: 'chat_send_message', title: '채팅 보내기', risk: 'low', status: 'pending', source: 'ai',
    conversation_id: 'c1', after_untrusted: true, args: { channel_id: 'ch1', content: '안녕' }, preview: [], editable: [],
    read_external: { kind: 'workspace', at: now, from: null, subject: null, label: '게시글' },
    created_at: now, expires_at: now, server_now: now,
    ...over,
  }
}

describe('승인 카드 선택지 — 관문 카드', () => {
  const card = (r: ApprovalRequest) => {
    const router = createMemoryRouter([{ path: '*', element: <ApprovalCard request={r} userName="검수" /> }], { initialEntries: ['/ai'] })
    return render(<RouterProvider router={router} />)
  }
  const keysOf = () => screen.getAllByRole('button').map(b => b.getAttribute('aria-keyshortcuts') || '').filter(k => /^\d$/.test(k))
  const future = () => ({ expires_at: new Date(Date.now() + 300_000).toISOString() })

  it('관문으로 묻는 카드에는 "다시 묻지 않기"(2·3)가 없다 — 규칙을 남겨도 이 대화에서는 계속 묻기 때문', () => {
    card(req({ ...future(), ask_reason: 'visible_after_untrusted' }))
    expect(keysOf()).toEqual(['1', '4'])
    expect(screen.getByText(REASON)).toBeTruthy()
  })

  it('평소 카드는 1~4 그대로', () => {
    card(req({ ...future(), after_untrusted: false, read_external: null }))
    expect(keysOf()).toEqual(['1', '2', '3', '4'])
  })
})

describe('승인 카드 — 외부 내용을 읽은 뒤의 남에게 보이는 쓰기', () => {
  it('ask_reason 이 오면 왜 묻는지 한 줄을 보인다', () => {
    render(<ApprovalExternalWarning req={req({ ask_reason: 'visible_after_untrusted' })} compact />)
    expect(screen.getByText(REASON)).toBeTruthy()
  })

  it('ask_reason 이 없으면(기본 모드의 평소 경고) 그 줄은 없다', () => {
    render(<ApprovalExternalWarning req={req()} compact />)
    expect(screen.getByRole('note')).toBeTruthy()
    expect(screen.queryByText(REASON)).toBeNull()
  })
})
