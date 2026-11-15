import { describe, it, expect } from 'vitest'
import { aiConvGroup, aiToolGroupKey, aiToolGroups, aiParseSse, aiExportMarkdown, aiExportFileName } from '~/utils/aiAssist'

describe('aiConvGroup', () => {
  const now = new Date(2026, 9, 15, 12, 0, 0)
  it('오늘 · 이번 주 · 이전', () => {
    expect(aiConvGroup(new Date(2026, 9, 15, 8).toISOString(), now)).toBe('today')
    expect(aiConvGroup(new Date(2026, 9, 12, 8).toISOString(), now)).toBe('week')
    expect(aiConvGroup(new Date(2026, 8, 1).toISOString(), now)).toBe('earlier')
  })
  it('시각 없음·잘못된 값은 이전', () => {
    expect(aiConvGroup(null, now)).toBe('earlier')
    expect(aiConvGroup('nope', now)).toBe('earlier')
  })
})

describe('aiToolGroups', () => {
  it('접두사로 묶고 서버 순서를 지킨다', () => {
    expect(aiToolGroupKey('mail_search')).toBe('mail')
    expect(aiToolGroupKey('plain')).toBe('plain')
    expect(aiToolGroups(['mail_search', 'files_read', 'mail_read', 'web_search'])).toEqual([
      { key: 'mail', tools: ['mail_search', 'mail_read'] },
      { key: 'files', tools: ['files_read'] },
      { key: 'web', tools: ['web_search'] },
    ])
    expect(aiToolGroups([])).toEqual([])
  })
})

describe('aiParseSse', () => {
  it('끝난 이벤트만 꺼내고 반쪽은 남긴다', () => {
    const buf = 'event: token\ndata: {"text":"안"}\n\nevent: tool_call\ndata: {"name":"mail_search"}\n\nevent: tok'
    const { events, rest } = aiParseSse(buf)
    expect(events).toEqual([
      { event: 'token', data: { text: '안' } },
      { event: 'tool_call', data: { name: 'mail_search' } },
    ])
    expect(rest).toBe('event: tok')
  })
  it('JSON 이 아니면 빈 객체, event 없으면 message', () => {
    expect(aiParseSse('data: oops\n\n').events).toEqual([{ event: 'message', data: {} }])
  })
})

describe('aiExport', () => {
  it('마크다운 — 사용자/어시스턴트만', () => {
    const md = aiExportMarkdown('제목', [
      { role: 'user', content: '질문 ' },
      { role: 'system', content: 'x' },
      { role: 'assistant', content: '답' },
    ], { user: '나', assistant: '어시스턴트' })
    expect(md).toBe('# 제목\n\n## 나\n\n질문\n\n## 어시스턴트\n\n답\n')
  })
  it('파일 이름에서 예약 문자 제거', () => {
    expect(aiExportFileName('a/b:c?')).toBe('a b c.md')
    expect(aiExportFileName('  ')).toBe('conversation.md')
  })
})
