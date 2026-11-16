/**
 * 작업 순수 로직 — 빠른 입력 해석 · 마감 표기(D-n) · 마감 묶기 · 우선순위 정렬.
 * 화면과 분리하여 vitest 로 검증한다(tests/lib/taskQuick.test.ts).
 *
 * 마감(due_date)은 "날짜"로만 취급한다. 서버는 datetime(UTC 자정)으로 반환하므로 앞 10자(YYYY-MM-DD)만 읽어
 * 시간대로 인한 하루 밀림을 방지한다.
 */

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done'

export interface QuickToken {
  kind: 'date' | 'priority' | 'assignee'
  start: number
  end: number
  text: string
}

export interface QuickParse {
  /** 토큰(날짜·!우선순위·@담당)을 제거한 제목 */
  title: string
  /** @담당만 남긴 제목 — 담당자 탐색 실패 시 문자 손실을 방지하기 위해 사용 */
  titleWithAssignee: string
  /** YYYY-MM-DD */
  due: string | null
  priority: TaskPriority | null
  /** @이름(아이디 또는 표시 이름) — 화면이 resolveAssignee 로 사용자를 조회하여 assignee_id 로 저장한다 */
  assignee: string | null
  tokens: QuickToken[]
}

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토']

/** Date → YYYY-MM-DD(로컬) */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** YYYY-MM-DD(또는 ISO datetime 앞 10자) → 로컬 자정 Date */
export function parseYmd(s: string | null | undefined): Date | null {
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}
/** 두 날짜(자정 기준) 사이 일수 b - a */
export function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86400000)
}
/** 월요일 시작 주의 일요일(이번 주 끝) */
function endOfWeek(d: Date): Date {
  const dow = (d.getDay() + 6) % 7 // 월=0 … 일=6
  return addDays(d, 6 - dow)
}

const PRIORITY_WORDS: Record<string, TaskPriority> = {
  긴급: 'urgent', urgent: 'urgent', u: 'urgent',
  높음: 'high', 높: 'high', high: 'high', h: 'high', 상: 'high',
  보통: 'medium', 중간: 'medium', medium: 'medium', m: 'medium', 중: 'medium',
  낮음: 'low', 낮: 'low', low: 'low', l: 'low', 하: 'low',
}

/**
 * 빠른 입력 한 줄 해석("회고 자료 준비 금요일 !높음").
 *  날짜: 오늘 · 내일 · 모레 · (이번 주|다음 주) X요일 · X요일 · 다음 주 · M/D · M월 D일 · YYYY-MM-DD
 *  우선순위: !긴급 · !높음 · !보통 · !낮음 (+ !high/!medium/!low)
 *  담당: @이름
 * 단어 경계에서만 인식한다("오늘의 회의" 의 '오늘' 은 날짜로 간주하지 않는다).
 */
export function parseQuickTask(input: string, now: Date = new Date()): QuickParse {
  const tokens: QuickToken[] = []
  let due: string | null = null
  let priority: TaskPriority | null = null
  let assignee: string | null = null
  const today = startOfDay(now)

  const taken = (s: number, e: number) => tokens.some(t => s < t.end && e > t.start)
  // 앞뒤가 공백/문자열 끝이어야 토큰으로 인정
  const B = '(?<=^|\\s)'
  const E = '(?=$|\\s)'

  const datePatterns: Array<[RegExp, (m: RegExpExecArray) => Date | null]> = [
    [new RegExp(`${B}(\\d{4})-(\\d{1,2})-(\\d{1,2})${E}`, 'g'), m => validDate(Number(m[1]), Number(m[2]), Number(m[3]))],
    [new RegExp(`${B}(\\d{1,2})월\\s?(\\d{1,2})일${E}`, 'g'), m => nextMonthDay(today, Number(m[1]), Number(m[2]))],
    [new RegExp(`${B}(\\d{1,2})/(\\d{1,2})${E}`, 'g'), m => nextMonthDay(today, Number(m[1]), Number(m[2]))],
    [new RegExp(`${B}(이번\\s?주|다음\\s?주)\\s([월화수목금토일])요일${E}`, 'g'), (m) => {
      const target = DAY_NAMES.indexOf(m[2])
      const monday = addDays(today, -((today.getDay() + 6) % 7))
      const base = m[1].startsWith('다음') ? addDays(monday, 7) : monday
      return addDays(base, (target + 6) % 7)
    }],
    [new RegExp(`${B}([월화수목금토일])요일${E}`, 'g'), (m) => {
      const target = DAY_NAMES.indexOf(m[1])
      const diff = (target - today.getDay() + 7) % 7
      return addDays(today, diff)
    }],
    [new RegExp(`${B}다음\\s?주${E}`, 'g'), () => {
      const monday = addDays(today, -((today.getDay() + 6) % 7))
      return addDays(monday, 7)
    }],
    [new RegExp(`${B}오늘${E}`, 'g'), () => today],
    [new RegExp(`${B}내일${E}`, 'g'), () => addDays(today, 1)],
    [new RegExp(`${B}모레${E}`, 'g'), () => addDays(today, 2)],
  ]

  for (const [re, toDate] of datePatterns) {
    if (due) break
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(input))) {
      const s = m.index, e = s + m[0].length
      if (taken(s, e)) continue
      const d = toDate(m)
      if (!d) continue
      due = ymd(d)
      tokens.push({ kind: 'date', start: s, end: e, text: m[0] })
      break
    }
  }

  const pRe = new RegExp(`${B}!([^\\s!]+)${E}`, 'g')
  let pm: RegExpExecArray | null
  while ((pm = pRe.exec(input))) {
    const p = PRIORITY_WORDS[pm[1].toLowerCase()]
    if (!p || taken(pm.index, pm.index + pm[0].length)) continue
    priority = p
    tokens.push({ kind: 'priority', start: pm.index, end: pm.index + pm[0].length, text: pm[0] })
    break
  }

  const aRe = new RegExp(`${B}@([^\\s@]+)${E}`, 'g')
  const am = aRe.exec(input)
  if (am && !taken(am.index, am.index + am[0].length)) {
    assignee = am[1]
    tokens.push({ kind: 'assignee', start: am.index, end: am.index + am[0].length, text: am[0] })
  }

  tokens.sort((a, b) => a.start - b.start)

  // 제목: 토큰 제거. titleWithAssignee 는 @담당만 유지(담당자 탐색 실패 시 사용)
  const strip = (keepAssignee: boolean) => {
    let out = ''
    let cur = 0
    for (const t of tokens) {
      if (keepAssignee && t.kind === 'assignee') continue
      out += input.slice(cur, t.start)
      cur = t.end
    }
    out += input.slice(cur)
    return out.replace(/\s+/g, ' ').trim()
  }

  return { title: strip(false), titleWithAssignee: strip(true), due, priority, assignee, tokens }
}

function validDate(y: number, m: number, d: number): Date | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(y, m - 1, d)
  return dt.getMonth() === m - 1 ? dt : null
}
/** M/D — 올해 해당 날짜가 이미 경과했으면 내년 */
function nextMonthDay(today: Date, m: number, d: number): Date | null {
  const thisYear = validDate(today.getFullYear(), m, d)
  if (!thisYear) return null
  return thisYear < today ? validDate(today.getFullYear() + 1, m, d) : thisYear
}

// ─── 마감 표기 · 묶기 ───

export type DueGroupKey = 'overdue' | 'today' | 'week' | 'later' | 'none' | 'done'

export const DUE_GROUP_LABEL: Record<DueGroupKey, string> = {
  overdue: '마감 지남',
  today: '오늘',
  week: '이번 주',
  later: '이후',
  none: '마감 없음',
  // 시안에 완료 묶음 없음 — 완료 작업은 최하단 "완료"로 모음
  done: '완료',
}

export function dueGroupOf(task: { due_date: string | null; status: string }, now: Date = new Date()): DueGroupKey {
  if (task.status === 'done') return 'done'
  const d = parseYmd(task.due_date)
  if (!d) return 'none'
  const today = startOfDay(now)
  const diff = dayDiff(today, d)
  if (diff < 0) return 'overdue'
  if (diff === 0) return 'today'
  if (d <= endOfWeek(today)) return 'week'
  return 'later'
}

export type DueTone = 'danger' | 'warning' | 'foreground' | 'muted'

/** 마감 표기 번역기(i18n t). 미지정 시 한국어 기본값(테스트·서버 밖 호출용) */
export type TaskTranslate = (key: string, params?: Record<string, string | number>) => string
const DUE_TEXT_KO: Record<string, string> = {
  'tasks.due.yesterdayOverdue': '어제 · 지남',
  'tasks.due.dateOverdue': '{md} · 지남',
  'common.today': '오늘',
  'tasks.due.longOverdue': '{md} (지남)',
  'tasks.due.longToday': '{md} (오늘)',
}
const koTranslate: TaskTranslate = (key, params) =>
  (DUE_TEXT_KO[key] ?? key).replace(/\{(\w+)\}/g, (_, n: string) => String(params?.[n] ?? ''))

/**
 * 행 마감 표기: 지남 = "어제 · 지남"/"10/12 · 지남"(danger), 오늘 = "오늘"(warning),
 * 이번 주 = "10/17 D-2"(foreground — 2일 이내만 D-n 병기), 이후 = "10/24"(muted).
 */
export function dueLabel(task: { due_date: string | null; status: string }, now: Date = new Date(), tr: TaskTranslate = koTranslate): { text: string; tone: DueTone } | null {
  const d = parseYmd(task.due_date)
  if (!d) return null
  const today = startOfDay(now)
  const diff = dayDiff(today, d)
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  if (task.status === 'done') return { text: md, tone: 'muted' }
  if (diff < 0) return { text: diff === -1 ? tr('tasks.due.yesterdayOverdue') : tr('tasks.due.dateOverdue', { md }), tone: 'danger' }
  if (diff === 0) return { text: tr('common.today'), tone: 'warning' }
  if (d <= endOfWeek(today)) return { text: diff <= 2 ? `${md} D-${diff}` : md, tone: 'foreground' }
  return { text: md, tone: 'muted' }
}

/** 상세 패널 마감 "10/17 (D-2)" · 지난 경우 "10/12 (지남)" */
export function dueLong(dueDate: string | null, now: Date = new Date(), tr: TaskTranslate = koTranslate): { text: string; tone: DueTone } | null {
  const d = parseYmd(dueDate)
  if (!d) return null
  const diff = dayDiff(startOfDay(now), d)
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  if (diff < 0) return { text: tr('tasks.due.longOverdue', { md }), tone: 'danger' }
  if (diff === 0) return { text: tr('tasks.due.longToday', { md }), tone: 'warning' }
  return { text: `${md} (D-${diff})`, tone: diff <= 2 ? 'warning' : 'foreground' }
}

const PRIORITY_RANK: Record<string, number> = { urgent: -1, high: 0, medium: 1, low: 2 }

export type TaskSort = 'priority' | 'due' | 'created'
export type TaskGroupBy = 'due' | 'priority' | 'none'

interface SortableTask { priority: string; due_date: string | null; created_at: string; status: string }

export function compareTasks(a: SortableTask, b: SortableTask, sort: TaskSort): number {
  const byPriority = (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1)
  const ad = a.due_date ? a.due_date.slice(0, 10) : '9999-99-99'
  const bd = b.due_date ? b.due_date.slice(0, 10) : '9999-99-99'
  const byDue = ad < bd ? -1 : ad > bd ? 1 : 0
  const byCreated = a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
  if (sort === 'priority') return byPriority || byDue || byCreated
  if (sort === 'due') return byDue || byPriority || byCreated
  return byCreated
}

export interface TaskGroup<T> { key: string; label: string; tone: 'danger' | 'foreground'; items: T[] }

const DUE_ORDER: DueGroupKey[] = ['overdue', 'today', 'week', 'later', 'none', 'done']
const PRIORITY_GROUPS: Array<[TaskPriority, string]> = [['urgent', '긴급'], ['high', '높음'], ['medium', '보통'], ['low', '낮음']]

/** 묶기(기본 마감) + 정렬(기본 우선순위). 빈 묶음은 제외 */
export function groupTasks<T extends SortableTask>(tasks: readonly T[], groupBy: TaskGroupBy, sort: TaskSort, now: Date = new Date()): TaskGroup<T>[] {
  const sorted = [...tasks].sort((a, b) => compareTasks(a, b, sort))
  if (groupBy === 'none') return sorted.length ? [{ key: 'all', label: '전체', tone: 'foreground', items: sorted }] : []
  if (groupBy === 'priority') {
    return PRIORITY_GROUPS
      .map(([k, label]) => ({ key: k, label, tone: 'foreground' as const, items: sorted.filter(t => t.priority === k) }))
      .filter(g => g.items.length)
  }
  return DUE_ORDER
    .map(k => ({
      key: k,
      label: DUE_GROUP_LABEL[k],
      tone: (k === 'overdue' ? 'danger' : 'foreground') as 'danger' | 'foreground',
      items: sorted.filter(t => dueGroupOf(t, now) === k),
    }))
    .filter(g => g.items.length)
}

/** 묶음 머리 글자의 i18n 키(groupTasks 의 key → 키). label 은 한국어 기본값(테스트용)이므로 화면은 이 키로 번역한다 */
export const TASK_GROUP_LABEL_KEY: Record<string, string> = {
  overdue: 'tasks.counts.overdue',
  today: 'common.today',
  week: 'tasks.group.week',
  later: 'tasks.group.later',
  none: 'tasks.group.noDue',
  done: 'tasks.statusDone',
  urgent: 'tasks.priorityUrgent',
  high: 'tasks.priorityHigh',
  medium: 'tasks.priorityMedium',
  low: 'tasks.priorityLow',
  all: 'common.all',
}

/** 우선순위 표기(화살표 + 글자). 낮음은 시안에 없어 ↓ muted 로 지정. labelKey = i18n 키 */
export const PRIORITY_META: Record<TaskPriority, { arrow: string; labelKey: string; tone: 'danger' | 'warning' | 'muted' }> = {
  urgent: { arrow: '↑↑', labelKey: 'tasks.priorityUrgent', tone: 'danger' },
  high: { arrow: '↑', labelKey: 'tasks.priorityHigh', tone: 'warning' },
  medium: { arrow: '—', labelKey: 'tasks.priorityMedium', tone: 'muted' },
  low: { arrow: '↓', labelKey: 'tasks.priorityLow', tone: 'muted' },
}

export const STATUS_META: Record<TaskStatus, { labelKey: string; tone: 'neutral' | 'warning' | 'primary' | 'success' }> = {
  todo: { labelKey: 'tasks.statusLabel.todo', tone: 'neutral' },
  in_progress: { labelKey: 'tasks.statusInProgress', tone: 'warning' },
  // 검토 = primary 틴트("검토")
  review: { labelKey: 'tasks.statusLabel.review', tone: 'primary' },
  done: { labelKey: 'tasks.statusDone', tone: 'success' },
}

/** 우선순위 선택 순서(높은 순) */
export const PRIORITY_ORDER: TaskPriority[] = ['urgent', 'high', 'medium', 'low']
/** 상태 순서(할 일·진행 중·검토·완료) */
export const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'review', 'done']

export interface AssigneeCandidate { id: string; username: string; display_name: string | null }

/**
 * 빠른 입력 @담당 → 사용자. 아이디 완전 일치 > 표시 이름 완전 일치 > 아이디·표시 이름 접두 일치가 1건일 때(대소문자 무시).
 * 여러 건이 일치하거나 없으면 null(제목에 @글자를 유지).
 */
export function resolveAssignee<U extends AssigneeCandidate>(name: string | null, users: readonly U[]): U | null {
  if (!name) return null
  const q = name.trim().toLowerCase()
  if (!q) return null
  const exactId = users.find(u => u.username.toLowerCase() === q)
  if (exactId) return exactId
  const exactName = users.filter(u => (u.display_name || '').toLowerCase() === q)
  if (exactName.length === 1) return exactName[0]
  const prefix = users.filter(u => u.username.toLowerCase().startsWith(q) || (u.display_name || '').toLowerCase().startsWith(q))
  return prefix.length === 1 ? prefix[0] : null
}

/** 태그 정규화(서버 normalize_tags 와 동일 기준): 앞뒤 공백·선행 # 제거, 빈 값·중복 제거, 40자 */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim().slice(0, 40)
}
