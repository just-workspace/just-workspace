// Vue 원본: frontend/tests/lib/channelTabs.test.ts (그대로)
import { describe, it, expect } from 'vitest'
import { fileKindLabel } from '~/composables/useChannelTabs'

describe('fileKindLabel — 채널 파일 탭 종류 타일(시안 PDF·XLS·IMG·ZIP·DOC·MD)', () => {
  it('시안 글자', () => {
    expect(fileKindLabel('배포 체크리스트.pdf')).toBe('PDF')
    expect(fileKindLabel('예산안-v3.xlsx')).toBe('XLS')
    expect(fileKindLabel('ci-fail-screenshot.PNG')).toBe('IMG')
    expect(fileKindLabel('build-logs.zip')).toBe('ZIP')
    expect(fileKindLabel('코드 리뷰 가이드.docx')).toBe('DOC')
    expect(fileKindLabel('release-notes.md')).toBe('MD')
  })
  it('모르는 확장자는 앞 세 글자, 없으면 FILE', () => {
    expect(fileKindLabel('data.parquet')).toBe('PAR')
    expect(fileKindLabel('Makefile')).toBe('FILE')
  })
})
