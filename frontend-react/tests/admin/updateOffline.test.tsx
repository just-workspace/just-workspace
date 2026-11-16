// 관리 › 업데이트 › 오프라인 — 업로드 방식과 경로 방식 각각의 전체 상태(올리는 중·검증 중·검증됨·서명 불일치·버전 낮음·파일 없음),
// 추가로 필요한 이미지의 상태별 표시(있음·없음·검증 중·해시 불일치·필요 없음), 전부 구비되어야 적용되는 차단.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { api, on, seq, called, fakeFetch, renderUpdate, text, disabled, value, ADMIN, B } from './updateHarness'

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const $fetch = Object.assign((u: string, o?: any) => fakeFetch(u, o), { raw: fakeFetch, native: fetch, create: () => fakeFetch })
  return { ...real, $fetch }
})
const clipboard = vi.hoisted(() => ({ written: [] as string[] }))
vi.mock('~/lib/clipboard', () => ({ writeClipboard: async (t: string) => { clipboard.written.push(t) } }))

const fx = await import('~/components/admin/update/fixtures')
const parts = await import('~/components/admin/update/parts')
const sys = await import('~/composables/useSystemUpdate')
const { setUser } = await import('~/composables/useAuth')
const { toastStore } = await import('~/composables/useToast')

interface Upload { path: string; file: File; progress: (p: number) => void; resolve: (v: any) => void; reject: (e: any) => void; signal?: AbortSignal }
let uploads: Upload[] = []

const open = async (state: any) => {
  on('GET', '/offline', state)
  const page = await renderUpdate('/admin/update/offline')
  await screen.findByTestId('offline-reason')
  return page
}
const reason = () => text(screen.getByTestId('offline-reason'))
const applyButton = () => screen.getByRole('button', { name: '적용' })
const imageState = (id: string) => text(screen.getByTestId(`offline-image-${id}`))
const file = (name = 'just-workspace-1.1.0-offline.tar') => new File(['x'], name)
const pathWay = () => fireEvent.click(screen.getByText('서버에 있는 파일 경로'))
const toasts = () => toastStore.getState().toasts.map((x: any) => `${x.type}:${x.message ?? x.title}`)

beforeEach(() => {
  api.calls = []
  api.routes = {}
  uploads = []
  clipboard.written = []
  parts.updateTiming.pollMs = 20
  toastStore.setState({ toasts: [] } as any)
  setUser(ADMIN as any)
  on('GET', '/status', fx.statuses.latest())
  sys.updateUpload.send = ((path: string, f: File, progress: any, signal?: AbortSignal) => new Promise((resolve, reject) => {
    uploads.push({ path, file: f, progress: progress ?? (() => {}), resolve, reject, signal })
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { aborted: true })))
  })) as any
})

describe('오프라인 — 파일 올리기', () => {
  it('빈 상태: 끌어다 놓는 자리와 받는 주소, 적용은 꺼져 있고 이유가 적혀 있다', async () => {
    await open(fx.offlines.empty())
    expect(screen.getByTestId('offline-drop')).toBeTruthy()
    expect(screen.getByText('오프라인 번들을 여기에 끌어다 놓습니다')).toBeTruthy()
    expect(screen.getByText(/인터넷에 연결할 수 없는 서버는 오프라인 번들로 업데이트합니다\./)).toBeTruthy()
    expect(screen.getByText('https://downloads.example.com/just-workspace-offline.tar')).toBeTruthy()
    expect(reason()).toBe('오프라인 번들을 업로드하면 서명과 버전을 확인합니다.')
    expect(disabled(applyButton())).toBe(true)
    expect(screen.queryByTestId('offline-verdict')).toBeNull()
    expect(screen.queryByTestId('offline-images')).toBeNull()
  })

  it('올리는 중 → 검증 중 → 검증됨: 진행률, 검증 결과, 추가 이미지 목록, 적용이 켜진다', async () => {
    on('GET', '/offline', seq(fx.offlines.empty(), fx.offlines.verifying(), fx.offlines.verified()))
    await renderUpdate('/admin/update/offline')
    const input = (await screen.findByTestId('offline-drop')).querySelector('input[type="file"]')!
    fireEvent.change(input, { target: { files: [file()] } })

    // 올리는 중
    const card = await screen.findByTestId('offline-file')
    expect(text(card)).toContain('just-workspace-1.1.0-offline.tar')
    expect(text(card)).toContain('업로드 중 · 0%')
    expect(uploads[0].path).toBe(`${B}/offline/bundle`)
    act(() => { uploads[0].progress(62) })
    expect(text(card)).toContain('업로드 중 · 62%')
    expect(within(card).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('62')
    expect(within(card).getByRole('button', { name: '취소' })).toBeTruthy()
    expect(reason()).toBe('업로드가 완료되면 서명과 버전을 확인합니다.')
    expect(disabled(applyButton())).toBe(true)

    // 검증 중
    await act(async () => { uploads[0].resolve(fx.offlines.verifying()) })
    expect(text(screen.getByTestId('offline-file'))).toContain('검증 중 · 서명과 버전을 확인하고 있습니다')
    expect(reason()).toBe('검증이 완료되면 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)

    // 검증됨(재조회로 확인)
    const verdict = await screen.findByTestId('offline-verdict')
    expect(text(verdict)).toContain('서명확인됨 · Just Workspace 공식 오프라인 번들')
    expect(text(verdict)).toContain('버전1.0.0 → 1.1.0')
    expect(text(verdict)).toContain('포함 항목Just Workspace 이미지, 데스크톱·모바일 앱 설치 파일')
    expect(text(verdict)).toContain('예상 중단 시간4분')
    expect(text(screen.getByTestId('offline-file'))).toContain('2.0 GB')
    expect(within(screen.getByTestId('offline-file')).getByRole('button', { name: '변경' })).toBeTruthy()
    expect(text(screen.getByTestId('offline-tally'))).toBe('필요한 것은 모두 있음')
    expect(reason()).toBe('')
    expect(disabled(applyButton())).toBe(false)
    expect(screen.queryByTestId('offline-alert')).toBeNull()
  })

  it('다른 화면에서 올리는 중인 묶음도 올리는 중으로 보인다', async () => {
    await open(fx.offlines.uploading())
    expect(text(screen.getByTestId('offline-file'))).toContain('업로드 중')
    expect(reason()).toBe('업로드가 완료되면 서명과 버전을 확인합니다.')
    expect(disabled(applyButton())).toBe(true)
  })

  it('올리는 중 취소: 올리기를 끊고 서버의 준비물을 비운다', async () => {
    on('DELETE', '/offline/bundle', fx.offlines.empty())
    await open(fx.offlines.empty())
    fireEvent.change(screen.getByTestId('offline-drop').querySelector('input[type="file"]')!, { target: { files: [file()] } })
    fireEvent.click(within(await screen.findByTestId('offline-file')).getByRole('button', { name: '취소' }))
    await waitFor(() => expect(called('DELETE', '/offline/bundle')).toHaveLength(1))
    expect(uploads[0].signal?.aborted).toBe(true)
    expect(await screen.findByTestId('offline-drop')).toBeTruthy()
    expect(toasts()).toEqual([])
  })

  it('서명 불일치: 무엇이 틀렸는지와 할 일, 적용은 막힌다', async () => {
    await open(fx.offlines.signatureMismatch())
    const alert = screen.getByTestId('offline-alert')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(text(alert)).toContain('서명이 맞지 않습니다.')
    expect(text(alert)).toContain('공식 오프라인 번들이 아니거나 전송 중에 손상되었습니다. 오프라인 번들을 다시 다운로드합니다.')
    expect(text(screen.getByTestId('offline-verdict'))).toContain('서명서명 불일치')
    expect(reason()).toBe('서명이 확인된 오프라인 번들만 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)
    expect(screen.queryByTestId('offline-images')).toBeNull()
  })

  it('버전 낮음: 묶음의 버전과 지금 버전을 말한다', async () => {
    await open(fx.offlines.versionTooLow())
    const alert = screen.getByTestId('offline-alert')
    expect(text(alert)).toContain('지금 버전보다 새 버전이 아닙니다.')
    expect(text(alert)).toContain('이 오프라인 번들은 0.9.0 버전이고 현재는 1.0.0 버전입니다. 버전을 낮추려면 롤백 탭에서 이전 버전을 복원합니다.')
    expect(text(screen.getByTestId('offline-verdict'))).toContain('버전0.9.0 · 지금 버전보다 새 버전이 아님')
    expect(text(screen.getByTestId('offline-verdict'))).toContain('서명확인됨')
    expect(reason()).toBe('지금보다 새 버전의 오프라인 번들만 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)
  })

  it('묶음이 아니거나 내용이 어긋난 파일', async () => {
    await open(fx.offlines.invalid())
    expect(text(screen.getByTestId('offline-alert'))).toContain('사용할 수 없는 오프라인 번들입니다.')
    expect(reason()).toBe('검증을 통과한 오프라인 번들만 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)
  })

  it('올리다 실패하면 알리고 빈 상태로 돌아온다', async () => {
    await open(fx.offlines.empty())
    fireEvent.change(screen.getByTestId('offline-drop').querySelector('input[type="file"]')!, { target: { files: [file()] } })
    await screen.findByTestId('offline-file')
    await act(async () => { uploads[0].reject(fx.apiError(413, 'too_large', { limit: 1 })) })
    expect(toasts()).toEqual(['error:파일이 너무 커서 업로드할 수 없습니다. 서버에 복사해 두고 경로를 지정하십시오.'])
    expect(screen.getByTestId('offline-drop')).toBeTruthy()
  })
})

describe('오프라인 — 추가로 필요한 이미지', () => {
  it('항상 필요한 것과 구역의 것, 꺼진 구역의 것은 필요 없음', async () => {
    await open(fx.offlines.verified())
    const rows = within(within(screen.getByTestId('offline-images')).getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map(r => within(r).getAllByRole('cell').slice(0, 3).map(c => text(c)))).toEqual([
      ['데이터베이스', '항상 필요', '있음'],
      ['캐시', '항상 필요', '있음'],
      ['웹 서버', '항상 필요', '있음'],
      ['문서 편집기', '문서 구역 · 사용', '있음'],
      ['회의 서버', '회의 구역 · 사용 안 함', '필요 없음'],
      ['코드 저장소', '코드 저장소 구역 · 사용 안 함', '필요 없음'],
    ])
    // 행마다 이름이 포함된 버튼, 불필요한 행에는 없음
    expect(screen.getByRole('button', { name: '데이터베이스 다운로드 명령 복사' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '문서 편집기 이미지 파일 업로드' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '회의 서버 다운로드 명령 복사' })).toBeNull()
    expect(screen.getByText(/오프라인 번들에는 Just Workspace 이미지만 들어 있습니다\./)).toBeTruthy()
    expect(within(screen.getByTestId('offline-images')).getByRole('table').className).toMatch(/min-w-\[620px\]/)
  })

  it('없음: 올려야 적용할 수 있다', async () => {
    await open(fx.offlines.imageMissing())
    expect(imageState('onlyoffice')).toBe('없음')
    expect(screen.getByTestId('offline-image-onlyoffice').getAttribute('data-state')).toBe('missing')
    expect(text(screen.getByTestId('offline-tally'))).toBe('아직 갖춰지지 않은 것 1')
    expect(reason()).toBe('필요한 이미지를 모두 업로드해야 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)
    expect(screen.queryByTestId('offline-alert')).toBeNull()
  })

  it('검증 중: 끝날 때까지 다시 읽고, 끝나면 적용이 켜진다', async () => {
    on('GET', '/offline', seq(fx.offlines.imageVerifying(), fx.offlines.imageVerifying(), fx.offlines.verified()))
    await renderUpdate('/admin/update/offline')
    await waitFor(() => expect(imageState('onlyoffice')).toBe('검증 중'))
    expect(reason()).toBe('업로드한 이미지의 검증이 완료되면 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)
    await waitFor(() => expect(imageState('onlyoffice')).toBe('있음'))
    expect(disabled(applyButton())).toBe(false)
  })

  it('해시 불일치: 어느 이미지인지와 할 일', async () => {
    await open(fx.offlines.imageMismatch())
    expect(imageState('onlyoffice')).toBe('해시 불일치')
    const alert = screen.getByTestId('offline-alert')
    expect(text(alert)).toContain('문서 편집기 이미지의 해시가 맞지 않습니다.')
    expect(text(alert)).toContain('다운로드 명령을 다시 복사해 새로 다운로드한 뒤 업로드합니다.')
    expect(reason()).toBe('해시가 맞는 이미지를 업로드해야 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)
  })

  it('받는 명령 복사', async () => {
    await open(fx.offlines.imageMissing())
    fireEvent.click(screen.getByRole('button', { name: '문서 편집기 다운로드 명령 복사' }))
    await waitFor(() => expect(clipboard.written).toEqual([fx.extraImages()[3].command]))
    expect(toasts()).toEqual(['success:다운로드 명령을 복사했습니다'])
  })

  it('이미지 파일 올리기: 그 줄로 올라가고 결과가 반영된다', async () => {
    await open(fx.offlines.imageMissing())
    fireEvent.click(screen.getByRole('button', { name: '문서 편집기 이미지 파일 업로드' }))
    fireEvent.change(screen.getByTestId('offline-image-input'), { target: { files: [file('onlyoffice.tar')] } })
    await waitFor(() => expect(uploads).toHaveLength(1))
    expect(uploads[0].path).toBe(`${B}/offline/images/onlyoffice`)
    expect(uploads[0].file.name).toBe('onlyoffice.tar')
    act(() => { uploads[0].progress(40) })
    expect(screen.getByText('업로드 중 · 40%')).toBeTruthy()
    await act(async () => { uploads[0].resolve(fx.offlines.verified()) })
    expect(imageState('onlyoffice')).toBe('있음')
    expect(disabled(applyButton())).toBe(false)
  })
})

describe('오프라인 — 적용', () => {
  it('전부 갖춰지면 적용을 시작하고 진행 화면으로 간다', async () => {
    on('POST', '/offline/apply', fx.job({ trigger: 'offline' }))
    on('GET', '/jobs/job1', fx.job({ trigger: 'offline' }))
    const page = await open(fx.offlines.verified())
    fireEvent.click(applyButton())
    await waitFor(() => expect(page.path()).toBe('/admin/update/apply/job1'))
    expect(called('POST', '/offline/apply')[0].body).toEqual({ start: 'countdown' })
  })

  it('서버가 아직 모자라다고 하면 알리고 상태를 다시 읽는다', async () => {
    on('POST', '/offline/apply', () => { throw fx.apiError(409, 'offline_incomplete', { blockers: ['images_missing'] }) })
    const page = await open(fx.offlines.verified())
    on('GET', '/offline', fx.offlines.imageMissing())
    fireEvent.click(applyButton())
    await waitFor(() => expect(toasts()).toHaveLength(1))
    await waitFor(() => expect(imageState('onlyoffice')).toBe('없음'))
    expect(page.path()).toBe('/admin/update/offline')
  })
})

describe('오프라인 — 서버에 있는 파일 경로', () => {
  it('입력 전: 경로를 넣고 확인해야 한다', async () => {
    await open(fx.offlines.empty())
    pathWay()
    expect(screen.queryByTestId('offline-drop')).toBeNull()
    expect(value(screen.getByLabelText('서버에 있는 오프라인 번들 경로'))).toBe('')
    expect(screen.getByText('큰 파일은 서버에 먼저 복사해 두고 경로를 지정하는 편이 빠릅니다.')).toBeTruthy()
    expect(disabled(screen.getByRole('button', { name: '파일 확인' }))).toBe(true)
    expect(reason()).toBe('경로를 입력하고 파일 확인을 눌러야 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)
  })

  it('확인 중 → 확인됨: 파일 이름·크기, 검증 결과와 추가 이미지, 적용이 켜진다', async () => {
    await open(fx.offlines.empty())
    on('POST', '/offline/bundle-path', fx.offlines.pathVerifying())
    on('GET', '/offline', seq(fx.offlines.pathVerifying(), fx.offlines.pathVerified()))
    pathWay()
    fireEvent.change(screen.getByLabelText('서버에 있는 오프라인 번들 경로'), { target: { value: ' /data/in/bundle.tar ' } })
    fireEvent.click(screen.getByRole('button', { name: '파일 확인' }))

    expect(text(await screen.findByTestId('offline-path-busy'))).toBe('확인 중 · 파일을 읽고 서명과 버전을 확인하고 있습니다')
    expect(called('POST', '/offline/bundle-path')[0].body).toEqual({ path: '/data/in/bundle.tar' })
    expect(reason()).toBe('검증이 완료되면 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)

    expect(text(await screen.findByTestId('offline-path-ok'))).toBe('확인됨 · just-workspace-1.1.0-offline.tar · 2.0 GB')
    expect(screen.queryByTestId('offline-path-busy')).toBeNull()
    expect(text(screen.getByTestId('offline-verdict'))).toContain('버전1.0.0 → 1.1.0')
    expect(screen.getByTestId('offline-images')).toBeTruthy()
    expect(reason()).toBe('')
    expect(disabled(applyButton())).toBe(false)
  })

  it('파일 없음: 칸에 오류가 붙고 적용은 막힌다', async () => {
    await open(fx.offlines.pathMissing())
    // 경로로 지정한 오프라인 번들이 있으면 이 방식으로 열림
    expect(screen.getByLabelText('서버에 있는 오프라인 번들 경로').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('이 경로에 파일이 없거나 읽을 권한이 없습니다. 경로와 파일 권한을 확인합니다.')).toBeTruthy()
    expect(reason()).toBe('읽을 수 있는 오프라인 번들 경로를 입력해야 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)
    expect(screen.queryByTestId('offline-verdict')).toBeNull()
  })

  it('경로 방식의 서명 불일치도 같은 안내와 차단을 쓴다', async () => {
    await open(fx.offlines.pathSignatureMismatch())
    expect(text(screen.getByTestId('offline-alert'))).toContain('서명이 맞지 않습니다.')
    expect(text(screen.getByTestId('offline-verdict'))).toContain('서명서명 불일치')
    expect(screen.queryByTestId('offline-path-ok')).toBeNull()
    expect(reason()).toBe('서명이 확인된 오프라인 번들만 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)
  })

  it('경로 방식의 버전 낮음', async () => {
    await open(fx.offlines.pathVersionTooLow())
    expect(text(screen.getByTestId('offline-alert'))).toContain('이 오프라인 번들은 0.9.0 버전이고 현재는 1.0.0 버전입니다.')
    expect(reason()).toBe('지금보다 새 버전의 오프라인 번들만 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)
  })

  it('경로 방식도 추가 이미지가 다 갖춰져야 적용된다', async () => {
    await open(fx.offlines.pathImageMissing())
    expect(screen.getByTestId('offline-path-ok')).toBeTruthy()
    expect(imageState('onlyoffice')).toBe('없음')
    expect(reason()).toBe('필요한 이미지를 모두 업로드해야 적용할 수 있습니다.')
    expect(disabled(applyButton())).toBe(true)
  })
})

describe('오프라인 — 차단 판정(순수 계산)', () => {
  it('상태별 이유', () => {
    const b = (s: any, up = false) => sys.offlineBlock(s, up)
    expect(b(null)).toBe('empty')
    expect(b(fx.offlines.empty())).toBe('empty')
    expect(b(fx.offlines.empty(), true)).toBe('uploading')
    expect(b(fx.offlines.uploading())).toBe('uploading')
    expect(b(fx.offlines.verifying())).toBe('verifying')
    expect(b(fx.offlines.signatureMismatch())).toBe('signature')
    expect(b(fx.offlines.versionTooLow())).toBe('version')
    expect(b(fx.offlines.pathMissing())).toBe('file_missing')
    expect(b(fx.offlines.invalid())).toBe('invalid')
    expect(b(fx.offlines.imageMismatch())).toBe('image_mismatch')
    expect(b(fx.offlines.imageVerifying())).toBe('image_verifying')
    expect(b(fx.offlines.imageMissing())).toBe('image_missing')
    expect(b(fx.offlines.verified())).toBeNull()
    // 화면상 전부 구비되어도 서버가 미준비로 응답하면 차단
    expect(b({ ...fx.offlines.verified(), ready: false })).toBe('image_missing')
  })
})
