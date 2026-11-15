// 메일 작성 본문 편집기(TipTap v3) — 툴바 서식, setContent 의 update 방출(v3 서명), 자리표시
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async () => ({})
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { MailComposeEditor } = await import('~/components/mail/MailComposeEditor')

describe('MailComposeEditor', () => {
  it('빈 본문엔 자리표시(data-placeholder), 툴바 굵게·밑줄은 StarterKit v3 내장 확장으로 동작', async () => {
    const onHtml = vi.fn()
    let handle: any = null
    render(<MailComposeEditor ref={h => { handle = h }} placeholder="내용을 입력하세요" onUpdateHtml={onHtml} />)
    const empty = document.querySelector('.mail-compose-editor .ProseMirror p.is-editor-empty')
    expect(empty?.getAttribute('data-placeholder')).toBe('내용을 입력하세요')
    await act(async () => { handle.setContent('<p>본문</p>') })
    expect(onHtml).toHaveBeenLastCalledWith('<p>본문</p>')   // v3: setContent(content, { emitUpdate: true })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '굵게 (Ctrl B)' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '밑줄' })) })
    expect(screen.getByRole('button', { name: '굵게 (Ctrl B)' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '밑줄' }).getAttribute('aria-pressed')).toBe('true')
    // 저장된 HTML 안에 포함된 링크(v2 와 같은 꼴)는 그대로 읽힌다
    await act(async () => { handle.setContent('<p><a href="https://example.com">링크</a> <u>밑줄</u></p>') })
    expect(onHtml).toHaveBeenLastCalledWith(expect.stringContaining('href="https://example.com"'))
    expect(onHtml).toHaveBeenLastCalledWith(expect.stringContaining('<u>밑줄</u>'))
  })
})
