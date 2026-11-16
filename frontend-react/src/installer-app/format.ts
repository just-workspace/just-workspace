/**
 * 표시용 변환 — 메모리·용량·포트. 문구는 생성하지 않는다(숫자와 기호만).
 */
import type { ZoneRow, ZonesResponse } from './api/types'

/** 소수 첫째 자리까지 표기, 끝의 .0 은 제거 */
export function trim1(n: number): string {
  return String(Math.round(n * 10) / 10)
}

/** 구역의 권장 메모리(MB, 1000 단위로 선언됨) → GB 숫자 */
export function zoneGb(mb: number): number {
  return Math.round(mb / 100) / 10
}

/** 서버 메모리(MiB) → GB 숫자 */
export function serverGb(mb: number): number {
  return Math.round((mb / 1024) * 10) / 10
}

export function bytesText(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${i === 0 ? String(v) : trim1(v)} ${units[i]}`
}

export interface Port { port: string; proto: 'tcp' | 'udp' }

/** '7882-7892/udp' → { port: '7882-7892', proto: 'udp' } */
export function parsePort(spec: string): Port {
  const [port, proto = 'tcp'] = spec.split('/')
  return { port, proto: proto.toLowerCase() === 'udp' ? 'udp' : 'tcp' }
}

/**
 * 한 줄 포트 표기. 종류가 혼재하면 항목마다 종류를 표기하고('TCP 7881 · UDP 3478'),
 * 한 종류뿐이면 TCP 는 숫자만('25 · 465'), UDP 는 종류를 표기한다.
 */
export function portsLine(specs: string[]): string {
  const ports = specs.map(parsePort)
  const mixed = new Set(ports.map(p => p.proto)).size > 1
  return ports.map(p => (mixed || p.proto === 'udp' ? `${p.proto.toUpperCase()} ${p.port}` : p.port)).join(' · ')
}

/** 선택한 구역의 권장 메모리 합계(MB) — 기본 구역 포함 */
export function recommendMb(catalog: ZonesResponse, selected: string[]): number {
  const on = new Set(selected)
  let total = catalog.core.memory_mb.recommend
  for (const z of [...catalog.zones, ...catalog.addons]) if (on.has(z.id)) total += z.memory_mb.recommend
  return total
}

/** 현재 선택한 구역과 일치하는 프리셋. 일치 항목이 없으면 null(직접 선택) */
export function matchPreset(catalog: ZonesResponse, zones: string[]): string | null {
  const key = [...zones].sort().join(',')
  for (const [name, ids] of Object.entries(catalog.presets)) {
    if ([...ids].sort().join(',') === key) return name
  }
  return null
}

export interface PortRow { spec: string; port: string; proto: 'tcp' | 'udp'; zone: string }

/**
 * 개방해야 할 포트 — 기본 구역 + 선택한 구역. 회의 구역의 중계(3478)와 무손실 오디오(4433)는 활성화한 경우에만 포함한다.
 * zone 은 구역 id(기본 구역은 core 의 id).
 */
export function openPorts(catalog: ZonesResponse, selected: string[], opts: { turn: boolean; lossless: boolean }): PortRow[] {
  const on = new Set(selected)
  const rows: PortRow[] = []
  const push = (z: Pick<ZoneRow, 'id' | 'ports'>) => {
    for (const spec of z.ports) {
      if (z.id === 'meetings' && spec === '3478/udp' && !opts.turn) continue
      if (z.id === 'meetings' && spec === '4433/udp' && !opts.lossless) continue
      if (rows.some(r => r.spec === spec)) continue
      rows.push({ spec, ...parsePort(spec), zone: z.id })
    }
  }
  push(catalog.core)
  for (const z of [...catalog.zones, ...catalog.addons]) if (on.has(z.id)) push(z)
  return rows
}

/** 주소의 IP 여부(도메인이 아닌지) */
export function isIpAddress(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value.trim()) || value.includes(':')
}

/** 단일 주소 또는 대역(CIDR) 형태 여부 — 서버가 재검증한다. 여기서는 즉시 표시할 형식 오류만 판별한다 */
export function isAddressOrCidr(value: string): boolean {
  const m = value.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/)
  if (!m) return false
  if (m.slice(1, 5).some(o => Number(o) > 255)) return false
  return m[5] === undefined || Number(m[5]) <= 32
}

export function isIpv4(value: string): boolean {
  return isAddressOrCidr(value) && !value.includes('/')
}

/** 내부 대역은 /24 하나 */
export function isSubnet24(value: string): boolean {
  return isAddressOrCidr(value) && value.trim().endsWith('/24')
}

/** 도메인 형태 여부(점이 하나 이상, 허용 문자만) */
export function isDomain(value: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value.trim())
}

/** 접속 주소 — 도메인 또는 IPv4 */
export function isAccessAddress(value: string): boolean {
  return isDomain(value) || isIpv4(value)
}

/** 메일 도메인의 기본값 — 접속 주소에서 맨 앞 이름 하나를 제거(workspace.example.com → example.com) */
export function defaultMailDomain(domain: string): string {
  const parts = domain.trim().split('.')
  if (!isDomain(domain)) return ''
  return parts.length > 2 ? parts.slice(1).join('.') : domain.trim()
}

/** 관리자 아이디 — 영문 소문자·숫자로 시작, 영문 소문자·숫자·점·밑줄·줄표, 3~32자 */
export function isUsername(value: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(value)
}

/** 이미지 태그 형태의 버전 */
export function isImageTag(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value)
}

/** 서버의 폴더 경로 — / 로 시작하는 전체 경로(최상위 폴더 자체는 불가) */
export function isHostPath(value: string): boolean {
  const v = value.trim()
  return /^\/[A-Za-z0-9._\-/]*$/.test(v) && v.replace(/\/+$/, '') !== '' && !v.split('/').includes('..')
}

/** 서버 이름 또는 IPv4 */
export function isHostname(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(value.trim())
}
