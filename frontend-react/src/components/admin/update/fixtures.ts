/**
 * 관리 › 업데이트 — 계약(docs/update-api.md)에 따라 작성한 모의 응답 모음.
 *
 * 업데이트 엔진(설치 관리자)이 아직 없으므로 화면은 본 응답들로 검증한다(tests/admin/update*.test.tsx).
 * 화면의 모든 상태가 여기에 하나씩 정의되어 있다 — 엔진 구현 시 동일한 형식으로 응답하면 화면과 그대로 연동된다.
 * 앱 코드는 본 파일을 import 하지 않는다(번들 미포함).
 */
import type {
  AppsReply, Available, ExtraImage, HistoryDetail, HistoryItem, OfflineBundle, OfflineState, ReleaseNotes,
  RestorePoint, SettingsReply, StepStatus, UpdateJob, UpdateSettings, UpdateStatus,
} from '~/composables/useSystemUpdate'

export const T0 = '2026-01-12T01:30:00Z'
const ACTOR = { id: 'u-admin', name: '관리자' }

// ─── 상태 ───

export const settings = (over: Partial<UpdateSettings> = {}): UpdateSettings => ({
  mode: 'manual', window: { start: '03:00', end: '05:00' }, channel: 'stable', min_age_days: 3,
  beta: { since: null, restore_point: null }, ...over,
})

export const availableUpdate = (over: Record<string, unknown> = {}): Available => ({
  state: 'update', version: '1.1.0', channel: 'stable', published: '2026-01-08T09:00:00Z', summary: '메일 검색이 빨라졌습니다',
  path: ['1.1.0'], download_bytes: 1288490188, downtime_seconds: 240,
  zones: [{ id: 'core', name: { ko: '기본', en: 'Core' } }, { id: 'mail', name: { ko: '메일', en: 'Mail' } }],
  plugin_warnings: [], changelog: '- 메일 검색이 빨라졌습니다\n- 일정 초대 메일의 시간대 표기를 고쳤습니다\n- 보안 수정',
  auto_eligible_at: '2026-01-11T09:00:00Z', ...over,
} as Available)

export const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  current: { version: '1.0.0', channel: 'stable', applied_at: '2026-01-02T18:02:11Z', previous_version: null },
  settings: settings(),
  check: { state: 'idle', last_at: '2026-01-12T00:00:04Z', ok: true, error: null },
  available: { state: 'none' },
  job: null,
  auto: { paused: false, paused_at: null, reason: null },
  last_auto: null,
  server_time: T0,
  ...over,
})

/** 현황의 상태 목록 */
export const statuses = {
  latest: () => status(),
  available: () => status({ available: availableUpdate() }),
  checking: () => status({ check: { state: 'checking', last_at: '2026-01-12T00:00:04Z', ok: true, error: null } }),
  channelEmpty: () => status({ check: { state: 'idle', last_at: '2026-01-12T00:00:04Z', ok: false, error: { code: 'channel_empty', detail: 'HTTP 404' } } }),
  checkFailed: () => status({ check: { state: 'idle', last_at: '2026-01-12T00:00:04Z', ok: false, error: { code: 'channel_unreachable', detail: 'connect timeout' } } }),
  neverChecked: () => status({ check: { state: 'idle', last_at: null, ok: null, error: null } }),
  wait: () => status({
    current: { version: '1.2.0-beta.3', channel: 'beta', applied_at: T0, previous_version: '1.1.4' },
    available: { state: 'wait', channel_latest: '1.1.4', resume_from: '1.2.0' },
  }),
  blocked: () => status({ available: { state: 'blocked', version: '2.0.0', reason: { code: 'no_upgrade_path', vars: { min_upgrade_from: '1.5.0' } } } }),
  pluginWarning: () => status({ available: availableUpdate({ plugin_warnings: [{ id: 'sample-plugin', name: '샘플 플러그인', reason: 'unverified' }] }) }),
  viaIntermediate: () => status({ available: availableUpdate({ version: '1.2.0', path: ['1.1.0', '1.2.0'] }) }),
  /** 값이 비어 있는 새 버전 — 해당 줄이 숨겨진다 */
  sparse: () => status({ available: availableUpdate({ download_bytes: null, downtime_seconds: null, zones: [], changelog: null }) }),
  auto: () => status({ settings: settings({ mode: 'auto' }) }),
  autoOk: () => status({
    current: { version: '1.1.0', channel: 'stable', applied_at: '2026-01-11T18:21:40Z', previous_version: '1.0.0' },
    settings: settings({ mode: 'auto' }),
    last_auto: { job: 'jobauto1', result: 'success', version: '1.1.0', from_version: '1.0.0', finished_at: '2026-01-11T18:21:40Z', downtime_seconds: 212, failed_step: null },
  }),
  autoFailed: () => status({
    settings: settings({ mode: 'auto' }),
    available: availableUpdate(),
    auto: { paused: true, paused_at: '2026-01-11T18:25:00Z', reason: { job: 'jobauto2', step: 'migrate', version: '1.1.0' } },
    last_auto: { job: 'jobauto2', result: 'rolled_back', version: '1.1.0', from_version: '1.0.0', finished_at: '2026-01-11T18:25:00Z', downtime_seconds: 388, failed_step: 'migrate' },
  }),
  beta: () => status({
    current: { version: '1.2.0-beta.3', channel: 'beta', applied_at: T0, previous_version: '1.1.4' },
    settings: settings({ channel: 'beta', beta: { since: '2026-01-05T02:00:00Z', restore_point: restorePoints()[1] } }),
  }),
}

// ─── 작업 ───

const UPDATE_STEPS = ['preflight', 'backup', 'pull', 'migrate', 'switch', 'verify']
const BACK_STEPS = ['stop', 'images', 'restore_db', 'start', 'verify']

/** at 번째 단계가 진행 중(또는 실패)인 단계 목록. at 이 길이 이상이면 전부 완료, 음수면 전부 대기 */
export function steps(ids: string[], at: number, failed = false) {
  return ids.map((id, i) => {
    const st: StepStatus = i < at ? 'done' : i > at ? 'pending' : failed ? 'failed' : 'running'
    return { id, status: st, started_at: i <= at ? T0 : null, finished_at: i < at ? T0 : null, detail: {} as Record<string, unknown> }
  })
}

export const job = (over: Partial<UpdateJob> = {}): UpdateJob => ({
  id: 'job1', kind: 'update', trigger: 'manual', status: 'running', from_version: '1.0.0', target_version: '1.1.0',
  path: ['1.1.0'], version_index: 0, countdown: null, steps: steps(UPDATE_STEPS, 1), error: null, choices: [], rollback_job: null,
  restore: null, expected_seconds: 240, started_at: T0, maintenance_started_at: T0, finished_at: null, ...over,
})

const pulling = () => {
  const s = steps(UPDATE_STEPS, 2)
  s[2].detail = { images: [{ name: 'frontend', status: 'done', percent: 100 }, { name: 'backend', status: 'pulling', percent: 62 }, { name: 'mailserver', status: 'pending', percent: 0 }] }
  return s
}

export const jobs = {
  countdown: (endsAt: string) => job({ status: 'countdown', countdown: { ends_at: endsAt, seconds: 300 }, steps: steps(UPDATE_STEPS, -1), maintenance_started_at: null }),
  pulling: () => job({ steps: pulling() }),
  /** migrate 전 실패 — 관리자가 재시도/롤백 중 선택한다 */
  failedBeforeMigrate: () => job({ status: 'failed', steps: steps(UPDATE_STEPS, 2, true), choices: ['retry', 'rollback'], error: { step: 'pull', cause: 'pull_failed', detail: 'registry timeout', vars: {} } }),
  /** migrate 단계부터의 실패 — 선택 없이 자동 롤백 */
  failedAtMigrate: () => job({ status: 'failed', steps: steps(UPDATE_STEPS, 3, true), choices: [], rollback_job: 'jobrb1', error: { step: 'migrate', cause: 'migrate_failed', detail: 'step 12 failed', vars: {} } }),
  /** 자동 업데이트는 migrate 전이어도 자동 롤백 */
  autoFailedEarly: () => job({ trigger: 'auto', status: 'failed', steps: steps(UPDATE_STEPS, 2, true), choices: [], rollback_job: 'jobrb1', error: { step: 'pull', cause: 'pull_failed', detail: 'registry timeout', vars: {} } }),
  done: () => job({ status: 'done', steps: steps(UPDATE_STEPS, 6), finished_at: '2026-01-12T01:39:00Z' }),
  cancelled: () => job({ status: 'cancelled', steps: steps(UPDATE_STEPS, -1), maintenance_started_at: null, finished_at: T0 }),
  /** 중간 버전 경유 중 — 1/2 번째 */
  hopFirst: () => job({ target_version: '1.2.0', path: ['1.1.0', '1.2.0'], version_index: 0, steps: pulling() }),
  hopDone: () => job({ status: 'done', target_version: '1.2.0', path: ['1.1.0', '1.2.0'], version_index: 1, steps: steps(UPDATE_STEPS, 6), finished_at: T0 }),
  // 롤백 · 복원
  rollbackRunning: () => job({ id: 'jobrb1', kind: 'rollback', from_version: '1.1.0', target_version: '1.0.0', parent_job: 'job1', steps: steps(BACK_STEPS, 2) }),
  rollbackDone: () => job({ id: 'jobrb1', kind: 'rollback', status: 'done', from_version: '1.1.0', target_version: '1.0.0', parent_job: 'job1', steps: steps(BACK_STEPS, 5), finished_at: T0 }),
  rollbackFailed: () => job({
    id: 'jobrb1', kind: 'rollback', status: 'failed', from_version: '1.1.0', target_version: '1.0.0', parent_job: 'job1', steps: steps(BACK_STEPS, 2, true),
    choices: ['retry'], error: { step: 'restore_db', cause: 'restore_failed', detail: 'pg_restore: error', vars: { backup_location: '/data/backups/pre-update-20260112.jwbak' } },
  }),
  restoreCountdown: (endsAt: string) => job({ id: 'jobrs1', kind: 'restore', status: 'countdown', countdown: { ends_at: endsAt, seconds: 300 }, from_version: '1.1.0', target_version: '1.0.0', steps: steps(BACK_STEPS, -1), restore: { point: 'rp-1', version: '1.0.0', reason: 'manual' }, maintenance_started_at: null }),
  restoreRunning: () => job({ id: 'jobrs1', kind: 'restore', from_version: '1.1.0', target_version: '1.0.0', steps: steps(BACK_STEPS, 2), restore: { point: 'rp-1', version: '1.0.0', reason: 'manual' } }),
  restoreDone: () => job({ id: 'jobrs1', kind: 'restore', status: 'done', from_version: '1.1.0', target_version: '1.0.0', steps: steps(BACK_STEPS, 5), restore: { point: 'rp-1', version: '1.0.0', reason: 'manual' }, finished_at: T0 }),
  restoreFailed: () => job({
    id: 'jobrs1', kind: 'restore', status: 'failed', from_version: '1.1.0', target_version: '1.0.0', steps: steps(BACK_STEPS, 3, true), choices: ['retry'],
    restore: { point: 'rp-1', version: '1.0.0', reason: 'manual' }, error: { step: 'start', cause: 'start_failed', detail: 'backend unhealthy', vars: {} },
  }),
  betaRestoreRunning: () => job({ id: 'jobrs2', kind: 'restore', from_version: '1.2.0-beta.3', target_version: '1.1.4', steps: steps(BACK_STEPS, 2), restore: { point: 'rp-beta', version: '1.1.4', reason: 'beta' } }),
  betaRestoreDone: () => job({ id: 'jobrs2', kind: 'restore', status: 'done', from_version: '1.2.0-beta.3', target_version: '1.1.4', steps: steps(BACK_STEPS, 5), restore: { point: 'rp-beta', version: '1.1.4', reason: 'beta' }, finished_at: T0 }),
  betaRestoreFailed: () => job({
    id: 'jobrs2', kind: 'restore', status: 'failed', from_version: '1.2.0-beta.3', target_version: '1.1.4', steps: steps(BACK_STEPS, 2, true), choices: ['retry'],
    restore: { point: 'rp-beta', version: '1.1.4', reason: 'beta' }, error: { step: 'restore_db', cause: 'restore_failed', detail: 'pg_restore: error', vars: {} },
  }),
}

// ─── 설정 · 복원 지점 ───

export function restorePoints(): RestorePoint[] {
  return [
    { id: 'rp-1', kind: 'pre-update', version: '1.0.0', created_at: '2026-01-10T18:00:02Z', size_bytes: 73400320 },
    { id: 'rp-beta', kind: 'pre-beta', version: '1.1.4', created_at: '2026-01-05T02:00:00Z', size_bytes: 70254592 },
  ]
}

export const settingsReply = (s: UpdateSettings, effect: Partial<SettingsReply['effect']> = {}): SettingsReply => ({
  settings: s, effect: { channel: null, wait: null, job: null, ...effect },
})

// ─── 오프라인 ───

export const bundle = (over: Partial<OfflineBundle> = {}): OfflineBundle => ({
  source: 'upload', filename: 'just-workspace-1.1.0-offline.tar', size_bytes: 2147483648, state: 'verified', percent: 100,
  version: '1.1.0', current_version: '1.0.0', contains: { images: true, apps: ['windows-desktop', 'android'] }, downtime_seconds: 240, error: null, ...over,
})

const image = (id: string, ko: string, over: Partial<ExtraImage> = {}): ExtraImage => ({
  id, name: { ko, en: id }, reason: 'always', zone: null, zone_enabled: true, state: 'present',
  command: `docker pull example/${id}@sha256:0000 && docker save example/${id} -o ${id}.tar`, filename: `${id}.tar`, ...over,
})

/** 항상 필요한 3종 + 활성화한 구역 1개(doc 의 상태를 변경하며 확인) + 비활성 구역 2개 */
export const extraImages = (doc: ExtraImage['state'] = 'present'): ExtraImage[] => [
  image('postgres', '데이터베이스'),
  image('redis', '캐시'),
  image('nginx', '웹 서버'),
  image('onlyoffice', '문서 편집기', { reason: 'zone', zone: { id: 'docs', name: { ko: '문서', en: 'Documents' } }, state: doc }),
  image('livekit', '회의 서버', { reason: 'zone', zone: { id: 'meetings', name: { ko: '회의', en: 'Meetings' } }, zone_enabled: false, state: 'not_needed' }),
  image('gitea', '코드 저장소', { reason: 'zone', zone: { id: 'git', name: { ko: '코드 저장소', en: 'Code' } }, zone_enabled: false, state: 'not_needed' }),
]

export const offline = (over: Partial<OfflineState> = {}): OfflineState => ({
  bundle: bundle(), images: extraImages(), download_url: 'https://downloads.example.com/just-workspace-offline.tar', accept: '.tar', ready: true, blockers: [], ...over,
})

export const offlines = {
  empty: () => offline({ bundle: null, images: [], ready: false, blockers: ['bundle_missing'] }),
  uploading: () => offline({ bundle: bundle({ state: 'uploading', percent: 62, version: null }), images: [], ready: false, blockers: ['bundle_not_verified'] }),
  verifying: () => offline({ bundle: bundle({ state: 'verifying', percent: null, version: null }), images: [], ready: false, blockers: ['bundle_not_verified'] }),
  verified: () => offline(),
  signatureMismatch: () => offline({ bundle: bundle({ state: 'signature_mismatch', version: null }), images: [], ready: false, blockers: ['bundle_rejected'] }),
  versionTooLow: () => offline({ bundle: bundle({ state: 'version_too_low', version: '0.9.0' }), images: [], ready: false, blockers: ['bundle_rejected'] }),
  invalid: () => offline({ bundle: bundle({ state: 'invalid', version: null, error: { code: 'no_upgrade_path' } }), images: [], ready: false, blockers: ['bundle_rejected'] }),
  imageMissing: () => offline({ images: extraImages('missing'), ready: false, blockers: ['images_missing'] }),
  imageVerifying: () => offline({ images: extraImages('verifying'), ready: false, blockers: ['images_verifying'] }),
  imageMismatch: () => offline({ images: extraImages('hash_mismatch'), ready: false, blockers: ['images_mismatch'] }),
  // 서버 경로 방식
  pathVerifying: () => offline({ bundle: bundle({ source: 'path', state: 'verifying', percent: null, version: null }), images: [], ready: false, blockers: ['bundle_not_verified'] }),
  pathVerified: () => offline({ bundle: bundle({ source: 'path' }) }),
  pathMissing: () => offline({ bundle: bundle({ source: 'path', state: 'file_missing', filename: null, size_bytes: null, version: null }), images: [], ready: false, blockers: ['bundle_rejected'] }),
  pathSignatureMismatch: () => offline({ bundle: bundle({ source: 'path', state: 'signature_mismatch', version: null }), images: [], ready: false, blockers: ['bundle_rejected'] }),
  pathVersionTooLow: () => offline({ bundle: bundle({ source: 'path', state: 'version_too_low', version: '0.9.0' }), images: [], ready: false, blockers: ['bundle_rejected'] }),
  pathImageMissing: () => offline({ bundle: bundle({ source: 'path' }), images: extraImages('missing'), ready: false, blockers: ['images_missing'] }),
}

// ─── 앱 · 기록 · 변경 내용 ───

export const apps = {
  /** 포함된 항목이 없는 버전 */
  none: (): AppsReply => ({ version: '1.0.0', download_page: '/settings/apps', apps: [] }),
  both: (): AppsReply => ({
    version: '1.1.0', download_page: '/settings/apps',
    apps: [
      { kind: 'windows-desktop', version: '1.1.0', filename: 'JustWorkspace-Setup-1.1.0.exe', size_bytes: 98566144, url: '/downloads/JustWorkspace-Setup-1.1.0.exe' },
      { kind: 'android', version: '1.1.0', filename: 'just-workspace-1.1.0.apk', size_bytes: 41943040, url: '/downloads/just-workspace-1.1.0.apk' },
    ],
  }),
  desktopOnly: (): AppsReply => ({ version: '1.1.0', download_page: null, apps: [{ kind: 'windows-desktop', version: '1.1.0', filename: 'JustWorkspace-Setup-1.1.0.exe', size_bytes: 98566144, url: '/downloads/JustWorkspace-Setup-1.1.0.exe' }] }),
}

const item = (over: Partial<HistoryItem>): HistoryItem => ({
  id: 'h1', kind: 'update', trigger: 'manual', version: '1.1.0', from_version: '1.0.0', result: 'success', started_at: T0,
  finished_at: '2026-01-12T01:39:00Z', duration_seconds: 540, downtime_seconds: 212, actor: ACTOR, ...over,
})

export const history = () => ({
  items: [
    item({ id: 'h5', trigger: 'auto', version: '1.3.0', from_version: '1.2.0', actor: null }),
    item({ id: 'h4', trigger: 'auto', version: '1.3.0', from_version: '1.2.0', result: 'rolled_back', actor: null }),
    item({ id: 'h3', version: '1.2.0', from_version: '1.0.0' }),
    item({ id: 'h2', kind: 'restore', version: '1.0.0', from_version: '1.1.0', result: 'restored' }),
    item({ id: 'h1', trigger: 'offline', version: '1.1.0' }),
  ],
  retention_days: 365, more: false,
})

const hsteps = (ids: string[], at: number, failed = false, note = 'ERROR: relation exists') => ids.map((id, i) => ({
  id, status: (i < at ? 'done' : i > at ? 'pending' : failed ? 'failed' : 'done') as StepStatus,
  duration_seconds: i <= at ? 4 + i * 20 : null, note: failed && i === at ? note : null,
}))

export const historyDetails: Record<string, () => HistoryDetail> = {
  h5: () => ({ ...history().items[0], versions: [{ version: '1.3.0', steps: hsteps(UPDATE_STEPS, 5) }], rollback: null }),
  h4: () => ({ ...history().items[1], versions: [{ version: '1.3.0', steps: hsteps(UPDATE_STEPS, 3, true) }], rollback: { result: 'done', steps: hsteps(BACK_STEPS, 4) } }),
  h3: () => ({ ...history().items[2], versions: [{ version: '1.1.0', steps: hsteps(UPDATE_STEPS, 5) }, { version: '1.2.0', steps: hsteps(UPDATE_STEPS, 5) }], rollback: null }),
  h2: () => ({ ...history().items[3], versions: [{ version: '1.0.0', steps: hsteps(BACK_STEPS, 4) }], rollback: null }),
  h1: () => ({ ...history().items[4], versions: [{ version: '1.1.0', steps: hsteps(UPDATE_STEPS, 5) }], rollback: null }),
}

export const releases = {
  plain: (): ReleaseNotes => ({
    version: '1.1.0', channel: 'stable', published: '2026-01-08T09:00:00Z', changelog: '- 메일 검색이 빨라졌습니다\n- 보안 수정',
    applied_at: '2026-01-11T18:21:40Z', trigger: 'auto', downtime_seconds: 212, previous_version: '1.0.0', disabled_plugins: [],
  }),
  withDisabledPlugins: (): ReleaseNotes => ({ ...releases.plain(), disabled_plugins: [{ id: 'sample-plugin', name: '샘플 플러그인' }] }),
  /** 최초 설치 버전 — 적용 기록과 이전 버전 모두 없음 */
  firstInstall: (): ReleaseNotes => ({ version: '1.0.0', channel: 'stable', published: null, changelog: '- 첫 릴리스' }),
}

// ─── 오류 ───

export const apiError = (statusCode: number, code: string, vars: Record<string, unknown> = {}) =>
  Object.assign(new Error(String(statusCode)), { status: statusCode, statusCode, data: { code, vars, detail: code } })

export const errors = {
  noInstaller: () => apiError(503, 'update_unavailable', { reason: 'no_installer' }),
  unsupported: () => apiError(501, 'update_unavailable', { reason: 'unsupported' }),
  busy: () => apiError(409, 'busy', { job: 'other' }),
  /** 서버 교체 중 — 응답 없음 */
  down: () => Object.assign(new Error('fetch failed'), { data: undefined }),
}
