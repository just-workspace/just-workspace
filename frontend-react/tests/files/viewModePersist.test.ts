// 파일 그리드/목록 보기는 기기에 기억된다 — 예전엔 새로고침하면 목록으로 돌아갔다
import { describe, it, expect } from 'vitest'
import { filesStore, setViewMode, _resetFilesStore } from '~/composables/useFiles'

describe('files viewMode', () => {
  it('바꾸면 저장되고, 새로 만든 상태(새로고침)도 그 값', () => {
    localStorage.removeItem('files.viewMode')
    setViewMode('grid')
    expect(localStorage.getItem('files.viewMode')).toBe('grid')
    _resetFilesStore()
    expect(filesStore.getState().viewMode).toBe('grid')
    setViewMode('list')
    _resetFilesStore()
    expect(filesStore.getState().viewMode).toBe('list')
  })
})
