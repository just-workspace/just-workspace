// handover 17 답 2 — 16번 구현 확인 반영(구독 ⋮ 통일 · 시간대 찾기 칸)
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { i18n } from '~/i18n'
import { UiSelect } from '~/components/ui/Select'
import { subscriptionMenuItems, subscriptionColorOf } from '~/components/settings/SettingsCalendarParts'
import { tzSelectSearch } from '~/utils/timezoneBand'
import { CAT_HEX } from '~/utils/categoryColor'

const t = (k: string, p?: any) => i18n.t(k, p)

describe('구독 ⋮ 메뉴 — 사이드바·설정 같은 한 벌', () => {
  it('지금 새로 고침 · 색 바꾸기 · 공유 · (구분선) 구독 해제(danger)', () => {
    const items = subscriptionMenuItems(t, { color: CAT_HEX[2] })
    expect(items.map(i => i.key)).toEqual(['refresh', 'color', 'share', 'remove'])
    const remove = items[3]
    expect(remove.danger).toBe(true)
    expect(remove.separated).toBe(true)
    expect(remove.label).toBe(t('settings.calendarPrefs.remove'))
    expect(remove.label).not.toBe(t('common.delete'))
    expect(items[1].children?.length).toBe(CAT_HEX.length)
    expect(items[1].children?.find(c => c.checked)?.key).toBe('color:3')
  })
  it('busy 면 새로 고침만 비활성', () => {
    const items = subscriptionMenuItems(t, { color: null }, true)
    expect(items[0].disabled).toBe(true)
    expect(items.slice(1).some(i => i.disabled)).toBe(false)
  })
  it('color:N → 범주 색, 범위 밖은 null', () => {
    expect(subscriptionColorOf('color:1')).toBe(CAT_HEX[0])
    expect(subscriptionColorOf(`color:${CAT_HEX.length + 1}`)).toBeNull()
    expect(subscriptionColorOf('share')).toBeNull()
  })
})

describe('UiSelect search — 시간대 찾기 칸', () => {
  const zones = [
    { value: '', label: '브라우저 따름 · Asia/Seoul' },
    { value: 'Asia/Seoul', label: 'Asia/Seoul (UTC+9)' },
    { value: 'Asia/Shanghai', label: 'Asia/Shanghai (UTC+8)' },
    { value: 'Asia/Ho_Chi_Minh', label: 'Asia/Ho_Chi_Minh (UTC+7)' },
    { value: 'America/New_York', label: 'America/New_York (UTC-4)' },
  ]
  function open(onPick?: (v: string | number | null) => void) {
    render(<UiSelect label="시간대" options={zones} search={tzSelectSearch(t)} onUpdateModelValue={onPick} />)
    fireEvent.click(screen.getByRole('combobox'))
    return screen.getByRole('searchbox') as HTMLInputElement
  }
  const names = () => screen.getAllByRole('option').map(o => o.textContent)

  it('목록 위에 찾기 칸(자리표시 "도시나 시간대 찾기"), 열면 포커스', () => {
    const box = open()
    expect(box.placeholder).toBe(t('common.tzSearch'))
    expect(document.activeElement).toBe(box)
    expect(screen.getAllByRole('option').length).toBe(zones.length)
  })
  it('한글·영문 도시명·IANA 이름으로 찾는다', () => {
    const box = open()
    for (const q of ['베이징', '상하이', 'shanghai', 'Asia/Shang']) {
      fireEvent.change(box, { target: { value: q } })
      expect(names()).toEqual(['Asia/Shanghai (UTC+8)'])
    }
    fireEvent.change(box, { target: { value: '호찌민' } })
    expect(names()).toEqual(['Asia/Ho_Chi_Minh (UTC+7)'])
    fireEvent.change(box, { target: { value: 'new york' } })
    expect(names()).toEqual(['America/New_York (UTC-4)'])
  })
  it('맞는 게 없으면 안내 한 줄, Enter 로 첫 결과 고르기', () => {
    const picked: Array<string | number | null> = []
    const box = open(v => picked.push(v))
    fireEvent.change(box, { target: { value: 'zzzz' } })
    expect(screen.queryAllByRole('option').length).toBe(0)
    expect(screen.getByText(t('ui.select.noMatch'))).toBeTruthy()
    fireEvent.change(box, { target: { value: '서울' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(picked).toEqual(['Asia/Seoul'])
  })
  it('search 없으면 찾기 칸이 없다(기존 그대로)', () => {
    render(<UiSelect label="x" options={zones} />)
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getAllByRole('option').length).toBe(zones.length)
  })
})
