import { describe, it, expect } from 'vitest'
import { ICON_PATHS, iconPaths, moduleIconName } from '~/utils/icons'

describe('아이콘 세트', () => {
  it('서버 registry·플러그인 manifest 가 주는 이름은 전부 그림이 있다', () => {
    // backend/app/modules/registry.py 의 icon + plugins/*/manifest.json + loader 기본값(puzzle)
    const names = ['mail', 'message-square', 'sparkles', 'video', 'folder', 'calendar', 'users', 'git-branch',
      'clipboard-list', 'check-square', 'book-open', 'edit-3', 'puzzle', 'image', 'clapperboard', 'music', 'home', 'settings', 'user']
    for (const n of names) expect(ICON_PATHS[n], n).toBeTruthy()
  })
  it('lucide 별칭은 같은 뜻 그림으로', () => {
    expect(iconPaths('pencil')).toBe(ICON_PATHS['edit-3'])
    expect(iconPaths('film')).toBe(ICON_PATHS.clapperboard)
    // 마술봉은 전용 아이콘 사용(기존에는 sparkles 로 대체)
    expect(iconPaths('wand')).toBe(ICON_PATHS.wand)
    expect(iconPaths('wand-2')).toBe(ICON_PATHS.wand)
    expect(ICON_PATHS.wand).not.toBe(ICON_PATHS.sparkles)
  })
  it('모르는 이름: 기본은 점, 모듈은 플러그인 조각', () => {
    expect(iconPaths('no-such-icon')).toBe(ICON_PATHS.dot)
    expect(iconPaths('no-such-icon', 'puzzle')).toBe(ICON_PATHS.puzzle)
    expect(moduleIconName('no-such-icon')).toBe('puzzle')
    expect(moduleIconName(undefined)).toBe('puzzle')
    expect(moduleIconName('edit-2')).toBe('edit-3')
    expect(moduleIconName('mail')).toBe('mail')
  })
})
