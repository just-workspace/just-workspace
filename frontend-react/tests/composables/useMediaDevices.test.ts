import { describe, it, expect } from 'vitest'

const { normalizeLabel, normalizeDeviceList } = await import('~/composables/useMediaDevices')

function dev(deviceId: string, groupId: string, label: string, kind = 'audioinput'): MediaDeviceInfo {
  return { deviceId, groupId, label, kind, toJSON: () => ({}) } as unknown as MediaDeviceInfo
}

describe('normalizeLabel', () => {
  it('strips the Windows Default/Communications prefix', () => {
    expect(normalizeLabel('Default - Galaxy Buds2 Pro Hands-Free AG Audio'))
      .toBe('Galaxy Buds2 Pro Hands-Free AG Audio')
    expect(normalizeLabel('Communications - 마이크 (Realtek Audio)'))
      .toBe('마이크 (Realtek Audio)')
    expect(normalizeLabel('기본값 - 스피커')).toBe('스피커')
  })

  it('strips the trailing USB id', () => {
    expect(normalizeLabel('HD Webcam C920 (046d:082d)')).toBe('HD Webcam C920')
  })

  it('does both at once and leaves normal labels alone', () => {
    expect(normalizeLabel('Default - Galaxy Buds2 Pro Hands-Free AG Audio (0123:4567)'))
      .toBe('Galaxy Buds2 Pro Hands-Free AG Audio')
    expect(normalizeLabel('Jabra Evolve 65')).toBe('Jabra Evolve 65')
    expect(normalizeLabel('')).toBe('')
  })
})

describe('normalizeDeviceList', () => {
  it('folds default/communications duplicates into the real device', () => {
    const out = normalizeDeviceList([
      dev('default', 'g1', 'Default - Galaxy Buds2 Pro Hands-Free AG Audio'),
      dev('communications', 'g1', 'Communications - Galaxy Buds2 Pro Hands-Free AG Audio'),
      dev('abc123', 'g1', 'Galaxy Buds2 Pro Hands-Free AG Audio'),
      dev('def456', 'g2', '마이크 (Realtek Audio)'),
    ], '마이크')

    expect(out).toHaveLength(2)
    expect(out[0].deviceId).toBe('abc123')      // 가상 항목이 아니라 실제 장치가 남는다
    expect(out[0].isDefault).toBe(true)         // 기본이라는 사실은 물려받는다
    expect(out[0].isBluetooth).toBe(true)
    expect(out[1].deviceId).toBe('def456')
    expect(out[1].isBluetooth).toBe(false)
  })

  it('falls back to a numbered name when the label is empty (permission not granted yet)', () => {
    const out = normalizeDeviceList([dev('x', '', ''), dev('y', '', '')], '카메라')
    expect(out.map(d => d.label)).toEqual(['카메라 1', '카메라 2'])
  })

  it('detects bluetooth from common label hints', () => {
    const out = normalizeDeviceList([
      dev('a', 'ga', 'AirPods Pro'),
      dev('b', 'gb', 'WH-1000XM4 (Bluetooth)'),
      dev('c', 'gc', 'Headset Earphone'),
      dev('d', 'gd', 'Realtek High Definition Audio'),
    ], '마이크')
    expect(out.map(d => d.isBluetooth)).toEqual([true, true, true, false])
  })
})
