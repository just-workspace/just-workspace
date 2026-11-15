// 결과물 카드: 파일 카드·저장(공간 부족)·링크 만료·묶음(부분 실패·이것만 다시)·만드는 중·
// 모바일, 완료 토스트(카드가 화면에 없을 때만), 도우미 함수, 파일 화면 압축 도우미.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { AiArtifact, AiArtifactJob } from '~/utils/aiArtifacts'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: any }[],
  respond: (_url: string, _opts?: any): any => ({}),
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => { api.calls.push({ url, opts }); return api.respond(url, opts) }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { AiArtifacts } = await import('~/components/ai/AiArtifacts')
const { ArtifactToast } = await import('~/components/ai/AiArtifactToasts')
const U = await import('~/utils/aiArtifacts')
const A = await import('~/composables/useAiArtifacts')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { i18n } = await import('~/i18n')
const t = (k: string, v?: Record<string, unknown>) => i18n.t(k, v)

const H = 3_600_000
function art(over: Partial<AiArtifact> = {}): AiArtifact {
  return {
    id: 'a1', format: 'docx', name: 'VPN 장애 보고서 초안.docx', label: 'Word 문서', size: 24 * 1024, status: 'ready',
    pages: 3, download_url: '/api/ai/artifacts/a1/download?exp=1&sig=x', expires_at: new Date(Date.now() + 23 * H).toISOString(),
    can_rebuild: true, saved_path: null, saved_folder: null, ...over,
  }
}
function job(over: Partial<AiArtifactJob> = {}): AiArtifactJob {
  return {
    id: 'j1', kind: 'docs', name: '장애 묶음.zip', status: 'partial', total: 3, done: 3, ok: 2, failed: 1, size: 60 * 1024,
    items: [
      { index: 0, name: 'VPN 장애 보고서.docx', format: 'docx', status: 'ready', artifact_id: 'a1', size: 24 * 1024, download_url: '/d/a1' },
      { index: 1, name: '장애 일지.xlsx', format: 'xlsx', status: 'failed', error: '변환 실패' },
      { index: 2, name: '보고 발표.pptx', format: 'pptx', status: 'ready', artifact_id: 'a3', size: 36 * 1024, download_url: '/d/a3' },
    ],
    zip: art({ id: 'z1', format: 'zip', name: '장애 묶음.zip', size: 4.1 * 1024 * 1024, download_url: '/d/z1' }),
    conversation_id: 'c1', conversation_title: 'VPN 장애 보고서 초안', saved_folder: null, ...over,
  }
}

function mount(node: React.ReactNode) {
  const router = createMemoryRouter([{ path: '*', element: node }], { initialEntries: ['/ai'] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  api.calls = []
  api.respond = () => { throw Object.assign(new Error('offline'), { status: 500 }) }
  isMobileStore.setState({ isMobile: false })
  A._resetAiArtifacts()
})

describe('도우미', () => {
  it('남은 시간·아이콘·단위·쓰기 결과에서 묶음 카드', () => {
    expect(U.aiHoursLeft(new Date(Date.now() + 22.2 * H).toISOString())).toBe(23)
    expect(U.aiHoursLeft('2000-01-01T00:00:00Z')).toBe(0)
    expect(U.aiArtifactIcon('xlsx')).toBe('file-sheet')
    expect(U.aiArtifactIcon('zip')).toBe('file-zip')
    expect(U.aiArtifactUnit({ slides: 5 })).toEqual({ key: 'ai.artifact.unit.slides', n: 5 })
    const w: any = { id: 'w', tool: 'files_zip', status: 'executed', result: { job: job({ id: 'jz', kind: 'files_zip' }) } }
    expect(U.aiArtifactsFromWrites([w])[0]).toMatchObject({ type: 'bundle', job: { id: 'jz' } })
    expect(U.aiArtifactsFromWrites([{ ...w, status: 'pending' }])).toEqual([])
    const merged = U.aiMergeArtifacts([{ type: 'file', artifact: art() }, { type: 'file', artifact: art({ name: 'new' }) }])
    expect(merged).toHaveLength(1)
    expect((merged[0] as any).artifact.name).toBe('new')
    expect(U.aiArtifactError({ data: { detail: { code: 'quota', message: 'm', room_bytes: 5 } } })).toEqual({ code: 'quota', message: 'm', room: 5 })
  })
})

describe('파일 카드', () => {
  it('이름·메타·세 버튼, 저장 → 저장 위치 줄', async () => {
    api.respond = (url) => {
      if (url.endsWith('/save')) return { folder: 'my/AI 결과물/2026-11-05 VPN', files: [], artifact: art({ saved_path: 'my/AI 결과물/2026-11-05 VPN/x.docx', saved_folder: 'my/AI 결과물/2026-11-05 VPN', saved_label: '내 파일 › AI 결과물 › 2026-11-05 VPN' }) }
      throw new Error('offline')
    }
    mount(<AiArtifacts items={[{ type: 'file', artifact: art() }]} />)
    expect(screen.getByText('VPN 장애 보고서 초안.docx')).toBeTruthy()
    expect(screen.getByText('Word 문서')).toBeTruthy()
    expect(screen.getByRole('link', { name: t('ai.artifact.download') }).getAttribute('href')).toContain('/download?')
    fireEvent.click(screen.getByRole('button', { name: t('ai.artifact.save') }))
    await screen.findByText(t('ai.artifact.saved', { folder: '내 파일 › AI 결과물 › 2026-11-05 VPN' }))
    expect(screen.getByRole('link', { name: t('ai.artifact.openFolder') })).toBeTruthy()
  })

  it('공간 부족이면 danger 띠 + 남은 공간 + [다시]', async () => {
    api.respond = (url) => {
      if (url.endsWith('/save')) throw Object.assign(new Error('x'), { data: { detail: { code: 'quota', message: 'm', room_bytes: 120 * 1024 * 1024 } } })
      throw new Error('offline')
    }
    mount(<AiArtifacts items={[{ type: 'file', artifact: art() }]} />)
    fireEvent.click(screen.getByRole('button', { name: t('ai.artifact.save') }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('ai.artifact.quota'))
    expect(alert.textContent).toContain('120.0 MB')
    expect(screen.getByRole('button', { name: t('ai.artifact.again') })).toBeTruthy()
  })

  it('링크 만료 → 배지 + [다시 만들기] → 다시 준비됨', async () => {
    api.respond = (url) => {
      if (url.endsWith('/rebuild')) return art()
      throw new Error('offline')
    }
    mount(<AiArtifacts items={[{ type: 'file', artifact: art({ status: 'expired', download_url: null, saved_folder: 'my/AI 결과물/x', saved_path: 'my/AI 결과물/x/a.docx' }) }]} />)
    expect(screen.getByText(t('ai.artifact.expired'))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('ai.artifact.openInFiles') })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('ai.artifact.rebuild') }))
    await screen.findByRole('button', { name: t('ai.artifact.save') })
  })

  it('실패 → 오류 타일 + 다시 만들기', () => {
    mount(<AiArtifacts items={[{ type: 'file', artifact: art({ status: 'failed', error: '변환 서버 응답 없음', download_url: null }) }]} />)
    expect(screen.getByText(t('ai.artifact.failedTitle'))).toBeTruthy()
    expect(screen.getByText(/변환 서버 응답 없음/)).toBeTruthy()
  })

  it('모바일 = 2열 큰 버튼 [다운로드][내 파일에]', () => {
    isMobileStore.setState({ isMobile: true })
    mount(<AiArtifacts items={[{ type: 'file', artifact: art() }]} />)
    expect(screen.getByRole('button', { name: t('ai.artifact.saveShort') })).toBeTruthy()
    expect(screen.queryByRole('button', { name: t('ai.artifact.preview') })).toBeNull()
  })
})

describe('묶음 카드', () => {
  it('머리(개수·크기·만료·zip) + 항목 + 부분 실패 [이것만 다시]', async () => {
    api.respond = (url) => {
      if (url.includes('/items/1/retry')) return job({ status: 'done', ok: 3, failed: 0, items: job().items.map(i => ({ ...i, status: 'ready' as const })) })
      throw new Error('offline')
    }
    mount(<AiArtifacts items={[{ type: 'bundle', job: job() }]} />)
    expect(screen.getByRole('link', { name: t('ai.artifact.bundle.downloadAll') }).getAttribute('href')).toBe('/d/z1')
    expect(screen.getByText(/23/)).toBeTruthy()
    expect(screen.getByText(t('ai.artifact.bundle.itemFailed', { name: '장애 일지.xlsx' }))).toBeTruthy()
    expect(screen.getByLabelText(t('ai.artifact.downloadOf', { name: 'VPN 장애 보고서.docx' }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('ai.artifact.bundle.retryOne') }))
    await waitFor(() => expect(screen.queryByRole('button', { name: t('ai.artifact.bundle.retryOne') })).toBeNull())
    expect(api.calls.some(c => c.url.endsWith('/jobs/j1/items/1/retry'))).toBe(true)
  })

  it('만드는 중 = 진행 막대 + 계속 안내, 실시간 이벤트로 끝남', async () => {
    mount(<AiArtifacts items={[{ type: 'bundle', job: job({ status: 'running', done: 1, ok: 1, failed: 0, zip: null }) }]} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('33')
    expect(screen.getByText(new RegExp(t('ai.artifact.bundle.keepGoing')))).toBeTruthy()
    act(() => { A.handleArtifactEvent({ type: 'ai.artifact_job', finished: true, job: job({ status: 'done', ok: 3, failed: 0, items: job().items.map(i => ({ ...i, status: 'ready' as const })) }) }) })
    await screen.findByRole('link', { name: t('ai.artifact.bundle.downloadAll') })
    // 카드가 화면에 있으니 토스트는 없다
    expect(A.aiArtifactToastStore.getState().toasts).toHaveLength(0)
  })

  it('파일 압축(files_zip) = 저장 위치가 늘 보이고, 건너뛴 파일 사유', () => {
    const z = job({
      kind: 'files_zip', ok: 1, failed: 1,
      items: [{ index: 0, name: 'a.txt', arc: '보고서/a.txt', path: 'my/보고서/a.txt', status: 'ready', size: 10 },
        { index: 1, name: 's.txt', path: 'users/bob/s.txt', status: 'forbidden', error: '권한 없음' }],
      zip: art({ id: 'z', format: 'zip', name: '묶음.zip', saved_path: 'my/AI 결과물/x/묶음.zip', saved_folder: 'my/AI 결과물/x', saved_label: '내 파일 › AI 결과물 › x' }),
    })
    mount(<AiArtifacts items={[{ type: 'bundle', job: z }]} />)
    expect(screen.getByText('보고서/a.txt')).toBeTruthy()
    expect(screen.getByText('users/bob/s.txt — 권한 없음')).toBeTruthy()
    expect(screen.getByText(t('ai.artifact.saved', { folder: '내 파일 › AI 결과물 › x' }))).toBeTruthy()
  })
})

describe('완료 토스트', () => {
  it('카드가 없을 때만 뜨고, 대화로 가기·zip 받기', () => {
    A.handleArtifactEvent({ type: 'ai.artifact_job', finished: true, job: job({ status: 'done', ok: 3, failed: 0 }) })
    const [tj] = A.aiArtifactToastStore.getState().toasts
    expect(tj.id).toBe('j1')
    mount(<ArtifactToast job={tj} />)
    expect(screen.getByText(/3/)).toBeTruthy()
    expect(screen.getByText(t('ai.artifact.toast.conv', { title: 'VPN 장애 보고서 초안' }))).toBeTruthy()
    expect(screen.getByRole('link', { name: t('ai.artifact.toast.zip') }).getAttribute('href')).toBe('/d/z1')
    const opened: string[] = []
    window.addEventListener(A.AI_OPEN_CONVERSATION_EVENT, (e: Event) => opened.push((e as CustomEvent).detail))
    A.openAiConversation('c1', () => {}, true)
    expect(opened).toEqual(['c1'])
    A.handleArtifactEvent({ type: 'ai.artifact_job', finished: false, job: job({ id: 'j2', status: 'running' }) })
    expect(A.aiArtifactToastStore.getState().toasts.map(x => x.id)).toEqual(['j1'])
  })
})

describe('파일 화면 압축 도우미', () => {
  it('작업이 끝날 때까지 진행률, 끝나면 내려받기', async () => {
    let n = 0
    api.respond = (url) => {
      if (url.endsWith('/zip')) return job({ kind: 'files_zip', status: 'running', done: 0, total: 2, zip: null })
      n += 1
      return job({ kind: 'files_zip', status: 'done', done: 2, total: 2, ok: 2, failed: 0 })
    }
    const progress: number[] = []
    const fin: string[] = []
    const out = await U.aiZipAndDownload({ paths: ['my/a', 'my/b'] }, 'zip', {
      addTransfer: () => ({ id: 't' }), updateProgress: (_i, l) => progress.push(l), finishTransfer: (_i, s) => fin.push(s),
      sleep: async () => {},
    })
    expect(out.status).toBe('done')
    expect(n).toBe(1)
    expect(progress).toEqual([0])
    expect(fin).toEqual(['done'])
  })
})
