// 캘린더 시간대 불일치 띠 — 순수 함수 + 기기별 "그대로" 기억.
//
// 띠: 설정 시간대(설정 › 캘린더 · 표시, 빈 값 = 기기 따름)가 기기 시간대와 지금 오프셋이 다르면 띄운다.
// [○○ 그대로] 를 고르면 그 (설정, 기기) 조합으로는 이 기기에서 다시 띄우지 않는다(localStorage — 기기 시간대는 기기마다 다르니 기기 단위).
import { timeZoneList, tzOffsetMinutes } from './calendarAttendees'

/** "UTC+9" · "UTC−7" · "UTC+5:30" · "UTC" (시안: 음수는 U+2212) */
export function utcOffsetLabel(tz: string, at = new Date()): string {
  const off = tzOffsetMinutes(tz, at)
  if (!off) return 'UTC'
  const a = Math.abs(off)
  return `UTC${off > 0 ? '+' : '−'}${Math.floor(a / 60)}${a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}`
}

/**
 * 주요 도시 IANA → 한글 도시명(브라우저가 한국어 도시명을 주지 않아 표로 둔다).
 * 표에 없는 시간대는 영문 도시명 그대로(+ 이름만 쓰는 자리에서는 UTC 오프셋 — tzPlace).
 * 같은 곳의 옛 이름(Asia/Calcutta·Asia/Saigon·America/Buenos_Aires 등)도 같이 둔다.
 * 베이징·하노이·뉴델리는 IANA 이름이 따로 없어 Asia/Shanghai·Asia/Ho_Chi_Minh·Asia/Kolkata 를 그 수도 이름으로 보인다
 * . 원래 도시 이름(상하이·호찌민·콜카타)은 검색에서도 맞도록 TZ_CITY_KO_ALIASES 에 남긴다.
 */
export const TZ_CITY_KO: Readonly<Record<string, string>> = {
  'Asia/Seoul': '서울',
  'Asia/Tokyo': '도쿄',
  'Asia/Shanghai': '베이징',
  'Asia/Hong_Kong': '홍콩',
  'Asia/Taipei': '타이베이',
  'Asia/Singapore': '싱가포르',
  'Asia/Bangkok': '방콕',
  'Asia/Jakarta': '자카르타',
  'Asia/Manila': '마닐라',
  'Asia/Ho_Chi_Minh': '하노이',
  'Asia/Saigon': '하노이',
  'Asia/Kuala_Lumpur': '쿠알라룸푸르',
  'Asia/Kolkata': '뉴델리',
  'Asia/Calcutta': '뉴델리',
  'Asia/Dubai': '두바이',
  'Asia/Riyadh': '리야드',
  'Europe/Moscow': '모스크바',
  'Europe/Istanbul': '이스탄불',
  'Europe/London': '런던',
  'Europe/Dublin': '더블린',
  'Europe/Paris': '파리',
  'Europe/Berlin': '베를린',
  'Europe/Madrid': '마드리드',
  'Europe/Rome': '로마',
  'Europe/Amsterdam': '암스테르담',
  'Europe/Brussels': '브뤼셀',
  'Europe/Vienna': '빈',
  'Europe/Zurich': '취리히',
  'Europe/Stockholm': '스톡홀름',
  'America/New_York': '뉴욕',
  'America/Chicago': '시카고',
  'America/Denver': '덴버',
  'America/Phoenix': '피닉스',
  'America/Los_Angeles': '로스앤젤레스',
  'America/Anchorage': '앵커리지',
  'America/Toronto': '토론토',
  'America/Vancouver': '밴쿠버',
  'America/Mexico_City': '멕시코시티',
  'America/Sao_Paulo': '상파울루',
  'America/Argentina/Buenos_Aires': '부에노스아이레스',
  'America/Buenos_Aires': '부에노스아이레스',
  'Pacific/Honolulu': '호놀룰루',
  'Australia/Sydney': '시드니',
  'Australia/Melbourne': '멜버른',
  'Pacific/Auckland': '오클랜드',
  'Africa/Cairo': '카이로',
  'Africa/Johannesburg': '요하네스버그',
}

/** 보이는 이름 말고도 검색에 맞아야 하는 이름("두 이름 모두") */
export const TZ_CITY_KO_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'Asia/Shanghai': ['상하이', 'Beijing'],
  'Asia/Ho_Chi_Minh': ['호찌민', 'Hanoi'],
  'Asia/Saigon': ['호찌민', 'Hanoi'],
  'Asia/Kolkata': ['콜카타', 'New Delhi'],
  'Asia/Calcutta': ['콜카타', 'New Delhi'],
}

/** 시간대 검색에 쓰는 이름 전부 — IANA 이름 · 영문 도시 · 한글 이름 · 별칭 */
export function tzSearchNames(tz: string): string[] {
  const out = [tz, tzCity(tz)]
  if (TZ_CITY_KO[tz]) out.push(TZ_CITY_KO[tz])
  out.push(...(TZ_CITY_KO_ALIASES[tz] ?? []))
  return Array.from(new Set(out))
}

/** 시간대가 검색어에 맞나(대소문자·공백/밑줄 무시, 부분 일치). 빈 검색어는 다 맞음 */
export function tzMatches(tz: string, query: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/[\s_]+/g, '')
  const q = norm(query.trim())
  if (!q) return true
  return tzSearchNames(tz).some(n => norm(n).includes(q))
}

function isKo(locale?: string) { return !!locale && locale.toLowerCase().startsWith('ko') }

/**
 * 시간대의 도시 이름. ko 로케일이고 표에 있으면 한글("America/Los_Angeles" → "로스앤젤레스"),
 * 아니면 IANA 이름의 도시 부분 영문("Los Angeles", "UTC" → "UTC"). locale 을 안 주면 영문.
 */
export function tzCity(tz: string, locale?: string): string {
  if (isKo(locale) && TZ_CITY_KO[tz]) return TZ_CITY_KO[tz]
  const last = tz.split('/').pop() || tz
  return last.replace(/_/g, ' ')
}

/**
 * 도시 이름만 쓰는 자리(띠 문장의 "{city} 기준", [○○로 바꾸기]·[○○ 그대로]).
 * ko 에서 표에 없는 시간대는 영문 이름 + UTC 오프셋("Almaty (UTC+5)") — 한글 이름이 없으니 어디인지 오프셋으로 보탠다.
 * en 이거나 표에 있으면 tzCity 그대로. 오프셋이 이미 붙는 자리("{city} ({utc})", 툴바)는 tzCity 를 쓴다.
 */
export function tzPlace(tz: string, locale?: string, at = new Date()): string {
  const city = tzCity(tz, locale)
  if (!isKo(locale) || TZ_CITY_KO[tz]) return city
  const utc = utcOffsetLabel(tz, at)
  return city === utc ? city : `${city} (${utc})`
}

/** 띠를 띄울 만큼 다른가 — 설정이 있고, 지금 오프셋이 기기와 다를 때 */
export function tzMismatch(pref: string | null | undefined, device: string, at = new Date()): boolean {
  if (!pref || !pref.trim() || pref === device) return false
  return tzOffsetMinutes(pref, at) !== tzOffsetMinutes(device, at)
}

const KEY = 'jw:calendar:tzBandKept'

function comboKey(pref: string, device: string) { return `${pref}|${device}` }

/** "그대로"로 닫은 조합인가 */
export function tzBandKept(pref: string, device: string): boolean {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) && list.includes(comboKey(pref, device))
  } catch { return false }
}

/** "그대로" — 이 조합은 다시 띄우지 않는다 */
export function keepTzBand(pref: string, device: string): void {
  try {
    const raw = localStorage.getItem(KEY)
    const prev = raw ? (JSON.parse(raw) as unknown) : []
    const list = Array.isArray(prev) ? prev.filter((x): x is string => typeof x === 'string') : []
    const k = comboKey(pref, device)
    if (!list.includes(k)) list.push(k)
    localStorage.setItem(KEY, JSON.stringify(list.slice(-20)))
  } catch { /* 저장소를 못 쓰면 이번 화면에서만 닫힘 */ }
}

/**
 * "(으)로" 조사 — 한글 받침이 있고 ㄹ 이 아니면 "으로", 아니면 "로"("런던으로" · "서울로" · "도쿄로").
 * 한글로 끝나지 않으면(영문 도시명·오프셋) 읽는 소리를 알 수 없어 "로".
 */
export function roParticle(word: string): string {
  const code = word.charCodeAt(word.length - 1)
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28
    return jong !== 0 && jong !== 8 ? '으로' : '로'
  }
  return '로'
}

/**
 * 시간대 고르기(UiSelect search)용 — 한글·영문 도시명·IANA 이름(tzMatches) 또는 라벨 일부로 찾는다.
 * @example <UiSelect options={zones} search={tzSelectSearch(t)} />
 */
export function tzSelectSearch(t: (k: string) => string): { placeholder: string; match: (o: { value: string | number; label: string }, q: string) => boolean } {
  return {
    placeholder: t('common.tzSearch'),
    match: (o, q) => (!!o.value && tzMatches(String(o.value), q)) || o.label.toLowerCase().includes(q.toLowerCase()),
  }
}

/** 시간대 고르기 목록 머리(설정 › 표시 · 일정 편집 창이 같이 쓴다) */
export const TZ_TOP: readonly string[] = ['Asia/Seoul', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'UTC', 'Europe/London', 'America/New_York', 'America/Los_Angeles']

/**
 * 시간대 고르기 목록 — 기기 시간대 → 주요 도시(TZ_TOP) → 나머지 IANA 이름(중복 없이). 설정 › 표시와 일정 편집 창이 같은 목록을 쓴다.
 * @param extra 맨 앞에 넣을 이름(예: 일정에 저장된, 목록에 없는 시간대)
 */
export function tzZoneNames(extra?: string | null): string[] {
  let sys = 'UTC'
  try { sys = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { /* 기본 UTC */ }
  return Array.from(new Set([...(extra ? [extra] : []), sys, ...TZ_TOP, ...timeZoneList()]))
}
