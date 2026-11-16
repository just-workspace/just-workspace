// 설치 마법사 화면(src/installer-app) — 가짜 서버(api/mock.ts)의 시나리오로 각 화면의 상태를 띄워 본다.
// 들어오기(토큰 · 잠김 · 이어 하기) · 사전 점검 · 시작 방식 · 접속 주소 · 프록시 · 저장 위치 · 구역 · 메일 · 관리자 · 요약 · 적용 · 완료 · 복원.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { InstallerApp } from '~/installer-app/InstallerApp'
import { createMockApi } from '~/installer-app/api/mock'
import { initInstallerI18n } from '~/installer-app/i18n'
import { createWizardStore } from '~/installer-app/store'
import { setLocale } from '~/i18n'

beforeAll(async () => {
  await initInstallerI18n()
  await setLocale('ko')
})
beforeEach(() => {
  window.history.replaceState(null, '', window.location.pathname)
  window.location.hash = ''
})

function open(scenario = '', hash = '') {
  if (hash) window.location.hash = hash
  const api = createMockApi(scenario)
  const store = createWizardStore(api)
  const view = render(<InstallerApp api={api} store={store} />)
  return { api, store, ...view }
}
const heading = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name })
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement
const next = () => button('다음')
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const stepList = () => screen.getByRole('list', { name: '설치 단계' })

describe('들어오기', () => {
  it('주소에 토큰 없이 들어오면 토큰 화면 — 맞는 토큰을 넣으면 사전 점검으로', async () => {
    open('token-none')
    await heading('설치 토큰을 확인합니다')
    expect(screen.getByText(/터미널에 나온 주소로 들어오면 이 화면을 거치지 않습니다/)).toBeTruthy()
    expect(screen.getByText(/영문 대문자와 숫자/)).toBeTruthy()
    type('설치 토큰', 'K7QF-93MD-2XTB')
    fireEvent.click(button('확인'))
    await heading('사전 점검')
  })

  it('틀린 토큰 · 만료된 토큰은 구분해서 알린다', async () => {
    const wrong = open('token-wrong')
    await heading('설치 토큰을 확인합니다')
    expect(screen.getByText('토큰이 맞지 않습니다. 터미널에 표시된 값을 다시 확인합니다.')).toBeTruthy()
    expect(screen.getByText('이 서버에 설치를 시작한 사람만 계속할 수 있습니다.')).toBeTruthy()
    wrong.unmount()

    open('token-expired')
    await heading('설치 토큰을 확인합니다')
    expect(screen.getByText('이 토큰은 만료됐습니다.')).toBeTruthy()
    expect(screen.getByText(/시간이 지나면 쓸 수 없습니다/)).toBeTruthy()
    expect(screen.getByText('docker exec jw-installer jw token')).toBeTruthy()
    expect(screen.queryByText(/영문 대문자와 숫자/)).toBeNull()
  })

  it('주소에 실려 온 토큰으로 세션을 만든다', async () => {
    const api = createMockApi('token-none')
    const store = createWizardStore(api)
    render(<InstallerApp api={api} store={store} token="K7QF93MD2XTB" />)
    await heading('사전 점검')
    expect(store.getState().server?.session).toBe('ok')
  })

  it('설치가 끝난 서버는 잠김 화면', async () => {
    open('locked')
    await heading('설치가 이미 끝났습니다')
    expect(screen.getByRole('link', { name: '로그인 화면으로' }).getAttribute('href')).toBe('https://workspace.example.com')
    // 다시 설치하는 명령은 서버가 알려 준 글자 그대로 보인다
    expect(screen.getByText(/처음부터 다시 설치하려면/)).toBeTruthy()
    expect(screen.getByText('docker exec jw-installer jw reinstall --yes')).toBeTruthy()
    // 소스 코드 링크 — 서버가 준 주소로, 새 창에서
    const source = screen.getByRole('link', { name: '소스 코드' })
    expect(source.getAttribute('href')).toBe('https://github.com/just-workspace/just-workspace')
    expect(source.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByTestId('source-link').textContent).toContain('AGPL-3.0-or-later')
  })

  it('입력하던 것이 있으면 이어 하기 — 이어서 하면 그 단계로', async () => {
    open('resume')
    await heading('하던 설치를 이어갑니다')
    expect(screen.getByText('접속 주소와 연결까지 입력됨')).toBeTruthy()
    expect(screen.getByText('다음은 파일 저장 위치')).toBeTruthy()
    fireEvent.click(button('이어서 하기'))
    await heading('파일을 어디에 저장할까요')
  })

  it('적용이 실패한 채 돌아오면 멈춘 곳을 알린다', async () => {
    open('resume-failed')
    await heading('설치가 멈춰 있습니다')
    expect(screen.getByText('인증서 발급에서 멈췄습니다.')).toBeTruthy()
    fireEvent.click(button('멈춘 곳 보기'))
    await heading('설치가 멈췄습니다')
  })

  it('적용 중에 돌아오면 진행 상황으로', async () => {
    open('resume-applying')
    await heading('설치가 진행 중입니다')
    expect(screen.getByText(/지금은 구역 시작/)).toBeTruthy()
    fireEvent.click(button('진행 상황 보기'))
    await heading('설치하는 중입니다')
  })
})

describe('사전 점검', () => {
  it('주의가 있어도 다음으로 갈 수 있고, 주의 항목은 펼쳐져 있다', async () => {
    open('', '#/check')
    await heading('사전 점검')
    await screen.findByText('통과 13 · 주의 1')
    expect(next().disabled).toBe(false)
    expect(screen.getByText('주의 항목은 그대로 두고 진행할 수 있습니다.')).toBeTruthy()
    expect(screen.getByText(/내장 메일 서버를 쓰려면 이 프로그램을 먼저 중지해야 합니다/)).toBeTruthy()
    expect(screen.getByText('16 GB')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '이전' })).toBeNull()
  })

  it('실패가 있으면 다음이 꺼지고 옆에 이유가 보인다', async () => {
    open('preflight-fail', '#/check')
    await screen.findByText('통과 12 · 주의 1 · 실패 1')
    expect(next().disabled).toBe(true)
    const reason = screen.getByText('실패한 항목을 해결하고 다시 확인해야 다음으로 갈 수 있습니다.')
    expect(next().getAttribute('aria-describedby')).toBe(reason.id)
    expect(screen.getByText(/쓰지 않는 Docker 이미지와 파일을 지운 뒤 다시 확인합니다/)).toBeTruthy()
  })

  it('메모리가 모자라면 실패', async () => {
    open('preflight-memory', '#/check')
    await screen.findByText(/기본 구역만 설치해도 메모리 4 GB가 필요합니다/)
    expect(next().disabled).toBe(true)
  })

  it('확인 중에는 다음이 꺼져 있다', async () => {
    open('preflight-checking', '#/check')
    await screen.findByText(/확인 중 9/)
    expect(next().disabled).toBe(true)
    expect(screen.getByText('점검이 끝나면 다음으로 갈 수 있습니다.')).toBeTruthy()
  })
})

describe('시작 방식', () => {
  it('고르는 즉시 단계 목록이 바뀐다', async () => {
    open('', '#/start')
    await heading('어떻게 시작할까요')
    const items = () => within(stepList()).getAllByRole('listitem').map(li => li.textContent)
    expect(items().some(x => x?.includes('구역 선택') && !x.includes('건너뜀'))).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /빠른 설치/ }))
    expect(items().some(x => x?.includes('구역 선택') && x.includes('건너뜀'))).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /백업에서 복원/ }))
    expect(items().map(x => x?.replace(/^\d+/, '').replace(/(완료|현재 단계|남음)$/, ''))).toEqual(['사전 점검', '시작 방식', '백업 파일 올리기', '내용 확인', '적용'])
  })

  it('이전은 사전 점검으로, 다음은 고른 방식의 첫 화면으로', async () => {
    const { store } = open('', '#/start')
    await heading('어떻게 시작할까요')
    fireEvent.click(screen.getByRole('radio', { name: /빠른 설치/ }))
    fireEvent.click(next())
    await heading('접속 주소')
    expect(store.getState().answers.mode).toBe('quick')
    expect(screen.getByText('기본값으로 정해지는 것')).toBeTruthy()
    fireEvent.click(button('이전'))
    await heading('어떻게 시작할까요')
  })
})

describe('접속 주소와 연결', () => {
  it('주소가 이 서버를 가리키면 다음으로 — 저장하고 파일 저장 위치로 간다', async () => {
    const { store } = open('', '#/domain')
    await heading('접속 주소와 연결 형태')
    expect(next().disabled).toBe(true)
    expect(screen.getByText('접속 주소를 입력해야 다음으로 갈 수 있습니다.')).toBeTruthy()
    type('접속 주소', 'workspace.example.com')
    expect(screen.getByText('접속 주소 확인이 끝나면 다음으로 갈 수 있습니다.')).toBeTruthy()
    await screen.findByText('일치')
    expect(screen.getByText('203.0.113.24')).toBeTruthy()
    expect(screen.getByText('감지됨: 공인 주소에 직접 연결')).toBeTruthy()
    expect(screen.queryByRole('radio', { name: /임시 인증서/ })).toBeNull()
    fireEvent.click(next())
    await heading('파일을 어디에 저장할까요')
    expect(store.getState().answers.access).toMatchObject({ domain: 'workspace.example.com', network: 'direct', cert: 'auto' })
    expect(store.getState().server?.step).toBe('storage')
  })

  it('주소가 다른 곳을 가리키면 자동 발급을 막고 임시 인증서가 나타난다', async () => {
    const { store } = open('dns-mismatch', '#/domain')
    await heading('접속 주소와 연결 형태')
    type('접속 주소', 'workspace.example.com')
    await screen.findByText('불일치')
    expect(screen.getByText('198.51.100.7')).toBeTruthy()
    expect((screen.getByRole('radio', { name: /자동 발급/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('radio', { name: /임시 인증서로 설치하고 나중에 발급/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/자동 발급은 접속 주소가 이 서버를 가리키는 것이 확인돼야 고를 수 있습니다/)).toBeTruthy()
    fireEvent.click(next())
    await heading('파일을 어디에 저장할까요')
    expect(store.getState().answers.access.cert).toBe('temporary')
  })

  it('기존 프록시 뒤를 고르면 인증서는 프록시가 처리 — 다음은 프록시 주소', async () => {
    const { store } = open('', '#/domain')
    await heading('접속 주소와 연결 형태')
    type('접속 주소', 'workspace.example.com')
    fireEvent.click(screen.getByRole('radio', { name: /기존 프록시 뒤/ }))
    expect(screen.getByText('프록시가 처리')).toBeTruthy()
    expect(screen.queryByRole('radio', { name: /자동 발급/ })).toBeNull()
    expect(within(stepList()).getByText('프록시 주소')).toBeTruthy()
    await screen.findByText('일치')
    fireEvent.click(next())
    await heading('프록시 주소')
    expect(store.getState().answers.access).toMatchObject({ network: 'proxy', cert: 'proxy' })
    expect(next().disabled).toBe(true)
    expect(screen.getByText('프록시 주소를 입력해야 다음으로 갈 수 있습니다.')).toBeTruthy()
    type(/프록시 주소 또는 대역/, '192.168.10.300')
    expect(screen.getByText('주소 형식이 맞지 않습니다. 주소 하나 또는 대역으로 입력합니다.')).toBeTruthy()
    expect(screen.getByText('프록시 주소를 고쳐야 다음으로 갈 수 있습니다.')).toBeTruthy()
    type(/프록시 주소 또는 대역/, '192.168.10.5')
    expect(next().disabled).toBe(false)
    fireEvent.click(button('이전'))
    await heading('접속 주소와 연결 형태')
  })

  it('빠른 설치 — 메모리가 모자라면 최소 묶음으로 내리고, 주소가 안 맞으면 임시 인증서를 골라야 한다', async () => {
    open('quick,mem-6,dns-unknown', '#/domain')
    await heading('접속 주소')
    expect(screen.getByText('최소 묶음 · 기본 구역만')).toBeTruthy()
    expect(screen.getByText(/최소 묶음\(기본 구역만/)).toBeTruthy()
    type('접속 주소', 'workspace.example.com')
    await screen.findByText('확인 불가')
    expect(next().disabled).toBe(true)
    expect(screen.getByText('접속 주소를 고치거나 임시 인증서를 골라야 다음으로 갈 수 있습니다.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/임시 인증서로 설치하고 나중에 발급/))
    expect(next().disabled).toBe(false)
    expect(screen.getByText('임시 인증서 · 나중에 발급')).toBeTruthy()
    fireEvent.click(next())
    // 최소 묶음에는 메일이 없다 — 메일 화면을 건너뛰고 관리자 계정으로
    await heading('관리자 계정')
  })
})

describe('파일 저장 위치', () => {
  it('이 서버의 디스크는 바로 다음으로 — 네트워크 저장소는 연결 확인이 통과해야 한다', async () => {
    const { store } = open('', '#/storage')
    await heading('파일을 어디에 저장할까요')
    expect(next().disabled).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: /네트워크 저장소/ }))
    expect(next().disabled).toBe(true)
    expect(screen.getByText('서버 주소와 공유 경로를 넣고 연결 확인을 눌러야 다음으로 갈 수 있습니다.')).toBeTruthy()
    expect(button('연결 확인').disabled).toBe(true)
    type(/서버 주소/, 'nas.example.com')
    type(/공유 경로/, '/volume1/workspace')
    fireEvent.click(button('연결 확인'))
    await screen.findByText('통과 5')
    expect(screen.getByText('1. 서버에 닿는가')).toBeTruthy()
    expect(screen.getByText('5. 여유 공간')).toBeTruthy()
    expect(next().disabled).toBe(false)
    // 값을 바꾸면 앞선 확인은 쓸 수 없다
    type(/공유 경로/, '/volume2/other')
    expect(next().disabled).toBe(true)
    type(/공유 경로/, '/volume1/workspace')
    fireEvent.click(next())
    await heading('쓸 구역을 고릅니다')
    expect(store.getState().answers.storage).toMatchObject({ kind: 'nfs', server: 'nas.example.com', export: '/volume1/workspace' })
  })

  it.each([
    ['nfs-unreachable', '1. 서버에 닿는가', /서버에 닿지 않습니다/, 3],
    ['nfs-permission', '2. 붙일 수 있는가', /NAS가 연결을 거부했습니다/, 2],
    ['nfs-export', '2. 붙일 수 있는가', /서버에는 닿았지만 이 공유 경로를 붙일 수 없습니다/, 2],
    ['nfs-readonly', '3. 쓰기·읽기·지우기', /공유 폴더가 읽기 전용입니다/, 1],
    ['nfs-nolock', '4. 파일 잠금', /파일 잠금이 동작하지 않습니다/, 0],
  ] as const)('연결 확인 실패(%s) — 원인별 문구와 꺼진 다음', async (scenario, label, text, skippedAfter) => {
    open(scenario, '#/storage')
    await heading('파일을 어디에 저장할까요')
    fireEvent.click(screen.getByRole('radio', { name: /네트워크 저장소/ }))
    type(/서버 주소/, 'nas.example.com')
    type(/공유 경로/, '/volume1/workspace')
    fireEvent.click(button('연결 확인'))
    await screen.findByText(text)
    const row = screen.getByText(label).closest('li')!
    expect(row.getAttribute('data-state')).toBe('fail')
    expect(within(row).getByText('실패')).toBeTruthy()
    // 실패한 검사 뒤의 것(여유 공간 제외한 1~4번 가운데 남은 것)과 5번은 확인하지 않는다
    expect(screen.getAllByText('확인 안 함')).toHaveLength(skippedAfter + 1)
    expect(next().disabled).toBe(true)
    expect(screen.getByText('1~4번 검사를 모두 통과해야 다음으로 갈 수 있습니다.')).toBeTruthy()
  })

  it('여유 공간이 적으면 주의만 하고 막지 않는다', async () => {
    open('nfs-lowspace', '#/storage')
    await heading('파일을 어디에 저장할까요')
    fireEvent.click(screen.getByRole('radio', { name: /네트워크 저장소/ }))
    type(/서버 주소/, 'nas.example.com')
    type(/공유 경로/, '/volume1/workspace')
    fireEvent.click(button('연결 확인'))
    await screen.findByText('통과 4 · 주의 1')
    expect(screen.getByText(/여유 공간이 10 GB보다 적습니다/)).toBeTruthy()
    expect(next().disabled).toBe(false)
  })
})

describe('구역 선택', () => {
  it('구역과 숫자는 서버가 준 대로 — 협업 7 GB, 전체 9.5 GB', async () => {
    const { store } = open('', '#/zones')
    await heading('쓸 구역을 고릅니다')
    const names = Array.from(document.querySelectorAll('[data-zone]')).map(el => el.getAttribute('data-zone'))
    expect(names).toEqual(['mail', 'chat', 'calendar', 'docs', 'meetings', 'git', 'ai'])
    expect(screen.queryByText('상태 감시')).toBeNull()
    expect(screen.getByRole('radio', { name: '협업' }).getAttribute('aria-checked')).toBe('true')
    const meter = () => screen.getByRole('meter', { name: '권장 메모리' })
    expect(meter().getAttribute('aria-valuenow')).toBe('7')
    expect(meter().getAttribute('aria-valuemax')).toBe('16')
    expect(screen.getByText(/남는 메모리 9 GB/)).toBeTruthy()
    expect(screen.getByText('음성 채널은 회의 구역을 함께 골라야 쓸 수 있습니다')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: '전체' }))
    expect(meter().getAttribute('aria-valuenow')).toBe('9.5')
    expect(screen.queryByText('음성 채널은 회의 구역을 함께 골라야 쓸 수 있습니다')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /선택 애드온/ }))
    fireEvent.click(screen.getByLabelText(/SSO·LDAP 제공/))
    expect(meter().getAttribute('aria-valuenow')).toBe('10')
    fireEvent.click(screen.getByLabelText(/^메일/))
    expect(screen.getByRole('radio', { name: '직접 고름' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(next())
    // 메일을 뺐고 회의를 골랐다 — 다음은 회의
    await heading('회의 연결')
    expect(store.getState().answers.zones).toEqual(['chat', 'calendar', 'docs', 'meetings', 'git', 'ai'])
    expect(store.getState().answers.addons).toEqual(['sso'])
  })

  it('권장 메모리가 서버 메모리를 넘으면 다음을 막는다', async () => {
    open('mem-6', '#/zones')
    await heading('쓸 구역을 고릅니다')
    // 6 GB 서버 — 협업 묶음(7 GB)이 맞지 않아 최소 묶음에서 시작한다
    expect(screen.getByRole('radio', { name: '최소' }).getAttribute('aria-checked')).toBe('true')
    expect(next().disabled).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: '협업' }))
    expect(next().disabled).toBe(true)
    expect(screen.getByText('권장 메모리가 서버 메모리를 넘습니다.')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('넘습니다. 구역을 줄여야 다음으로 갈 수 있습니다.')
    fireEvent.click(screen.getByLabelText(/^문서 편집/))
    expect(next().disabled).toBe(false)
  })

  it('공유기 뒤면 다음은 포트 포워딩 안내 — 고른 구역의 포트를 보여 준다', async () => {
    open('router', '#/zones')
    await heading('쓸 구역을 고릅니다')
    fireEvent.click(next())
    await heading('공유기에서 열 포트')
    expect(screen.getByText('192.168.10.10')).toBeTruthy()
    expect(screen.getByText('465 · 587')).toBeTruthy()
    expect(screen.getByText('메일 받기')).toBeTruthy()
    expect(screen.queryByText('7881')).toBeNull()
    fireEvent.click(button('이전'))
    await heading('쓸 구역을 고릅니다')
  })
})

describe('메일', () => {
  it('내장 서버 — 레코드 상태를 보여 주고, 맞지 않아도 다음으로 간다', async () => {
    open('ready', '#/mail')
    await heading('메일을 어떻게 보낼까요')
    await screen.findByText('아직 없음')
    expect(screen.getByText('값이 다름')).toBeTruthy()
    expect(screen.getAllByText('확인됨')).toHaveLength(3)
    expect(screen.getByText(/개가 맞지 않습니다. 이대로 설치하면 보낸 메일이 스팸으로 분류될 수 있습니다/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '_dmarc.example.com 값 복사' })).toBeTruthy()
    expect(screen.getByText('v=DMARC1 p=none')).toBeTruthy()
    // 긴 값은 줄여 보이고 펼칠 수 있다
    const expand = screen.getAllByRole('button', { name: '펼침' })[0]
    expect(screen.queryByText(/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$/)).toBeNull()
    fireEvent.click(expand)
    expect(screen.getByText(/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$/)).toBeTruthy()
    expect(next().disabled).toBe(false)
  })

  it('외부 발신 서버 — 연결이 확인돼야 다음으로 간다', async () => {
    const { store } = open('ready', '#/mail')
    await heading('메일을 어떻게 보낼까요')
    fireEvent.click(screen.getByRole('radio', { name: /외부 발신 서버/ }))
    expect(next().disabled).toBe(true)
    expect(screen.getByText('발신 서버 연결이 확인돼야 다음으로 갈 수 있습니다.')).toBeTruthy()
    type('서버 주소', 'smtp.example.com')
    type('계정', 'sender')
    type('비밀번호', 'app-password')
    fireEvent.click(button('연결 확인'))
    await screen.findByText(/발신 서버에 로그인했습니다/)
    expect(next().disabled).toBe(false)
    fireEvent.click(next())
    await heading('관리자 계정')
    expect(store.getState().answers.mail).toMatchObject({ kind: 'external', host: 'smtp.example.com', port: 587, username: 'sender' })
    // 비밀번호는 서버가 돌려준 답변에 없다 — 서버가 가지고 있다는 표시만 온다
    expect(store.getState().answers.mail.password).toBeUndefined()
    expect(store.getState().secretsOnServer['mail.password']).toBe(true)
  })

  it('외부 발신 서버 — 로그인 실패', async () => {
    open('ready,smtp-fail', '#/mail')
    await heading('메일을 어떻게 보낼까요')
    fireEvent.click(screen.getByRole('radio', { name: /외부 발신 서버/ }))
    type('서버 주소', 'smtp.example.com')
    type('계정', 'sender')
    type('비밀번호', 'wrong')
    fireEvent.click(button('연결 확인'))
    await screen.findByText(/발신 서버가 로그인을 거부했습니다/)
    expect(screen.getByText('계정과 비밀번호를 확인합니다.')).toBeTruthy()
    expect(next().disabled).toBe(true)
  })
})

describe('관리자 계정', () => {
  it('아이디 규칙 · 비밀번호 길이 · 두 칸 불일치마다 이유가 다르다', async () => {
    const { store } = open('', '#/admin')
    await heading('관리자 계정')
    expect(next().disabled).toBe(true)
    expect(screen.getByText('이름을 입력해야 다음으로 갈 수 있습니다.')).toBeTruthy()
    type(/^이름/, '관리자')
    type(/^아이디/, 'Admin 1')
    expect(screen.getByText(/쓸 수 없는 글자가 들어 있습니다/)).toBeTruthy()
    expect(screen.getByText('아이디를 고쳐야 다음으로 갈 수 있습니다.')).toBeTruthy()
    type(/^아이디/, 'admin')
    type('비밀번호', 'correct')
    expect(screen.getByText('12자 이상이어야 합니다. 지금 7자입니다.')).toBeTruthy()
    expect(screen.getByText('비밀번호가 12자 이상이어야 다음으로 갈 수 있습니다.')).toBeTruthy()
    type('비밀번호', 'correct horse battery')
    type('비밀번호 확인', 'correct horse batter')
    expect(screen.getByText('비밀번호가 일치하지 않습니다.')).toBeTruthy()
    expect(screen.getByText('두 비밀번호가 같아야 다음으로 갈 수 있습니다.')).toBeTruthy()
    type('비밀번호 확인', 'correct horse battery')
    expect(next().disabled).toBe(false)
    fireEvent.click(next())
    await heading('이대로 설치합니다')
    expect(store.getState().answers.admin).toMatchObject({ name: '관리자', username: 'admin' })
    expect(store.getState().secretsOnServer['admin.password']).toBe(true)
  })
})

describe('요약', () => {
  it('입력한 값을 다시 보여 주고 주의를 모은다 — 고치기는 그 화면으로, 돌아올 때는 요약으로', async () => {
    open('ready', '#/summary')
    await heading('이대로 설치합니다')
    await screen.findByText('80 · 443 · 25 · 465 · 587 · 993')
    expect(screen.getByText('https://workspace.example.com')).toBeTruthy()
    expect(screen.getByText(/공인 주소에 직접 연결 · 인증서 자동 발급/)).toBeTruthy()
    expect(screen.getByText('기본, 메일, 채팅, 일정·연락처·할 일, 문서 편집·위키·게시판')).toBeTruthy()
    expect(screen.getByText('admin@example.com')).toBeTruthy()
    expect(within(screen.getByRole('main')).getByText('AI 도우미')).toBeTruthy()
    expect(within(screen.getByRole('main')).queryByText('AI')).toBeNull()
    expect(screen.getAllByText('고르지 않음')).toHaveLength(3)
    expect(screen.getByRole('heading', { name: /넘어온 주의 사항\s*3\s*건/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: '사전 점검 보기' }).getAttribute('href')).toBe('#/check?fix=1')
    expect(screen.getByRole('link', { name: '답변 파일 내려받기' }).getAttribute('download')).toBe('answers.json')
    expect(button('설치').disabled).toBe(false)

    window.location.hash = screen.getByRole('link', { name: '파일 저장 위치 고치기' }).getAttribute('href')!
    await act(async () => { window.dispatchEvent(new Event('hashchange')) })
    await heading('파일을 어디에 저장할까요')
    expect(screen.queryByRole('button', { name: '다음' })).toBeNull()
    expect(screen.queryByRole('button', { name: '이전' })).toBeNull()
    fireEvent.click(button('요약으로 돌아가기'))
    await heading('이대로 설치합니다')
  })

  it('전체 묶음 — 회의 · AI 도우미 · 코드 저장소 값과 열리는 포트', async () => {
    open('ready,full', '#/summary')
    await heading('이대로 설치합니다')
    await screen.findByText('TCP 80 · TCP 443 · TCP 25 · TCP 465 · TCP 587 · TCP 993 · TCP 7881 · UDP 7882-7892 · UDP 3478 · UDP 4433 · TCP 2222 · TCP 389 · TCP 636')
    expect(screen.getByText(/내장 중계 서버 사용/).textContent).toContain('무손실 오디오 켬')
    expect(screen.getByText('검증된 버전')).toBeTruthy()
    expect(screen.getByText('나중에 연결')).toBeTruthy()
    expect(screen.getByText(/애드온 SSO·LDAP 제공/)).toBeTruthy()
  })

  it('서버가 설치할 수 없다고 하면 설치가 꺼지고 고칠 곳을 알린다', async () => {
    open('ready,summary-error', '#/summary')
    await heading('이대로 설치합니다')
    await screen.findByText('이대로는 설치할 수 없습니다')
    expect(screen.getByText('관리자 비밀번호 항목이 비어 있습니다.')).toBeTruthy()
    expect(button('설치').disabled).toBe(true)
    expect(screen.getByText('위 항목을 고쳐야 설치할 수 있습니다.')).toBeTruthy()
  })

  it('사전 점검을 통과하지 못한 서버에서는 설치가 꺼진다', async () => {
    open('ready,preflight-fail', '#/summary')
    await heading('이대로 설치합니다')
    await waitFor(() => expect(screen.getAllByText('사전 점검을 통과해야 설치할 수 있습니다.').length).toBeGreaterThan(0))
    expect(button('설치').disabled).toBe(true)
    expect(screen.getAllByRole('link', { name: '사전 점검 보기' })[0].getAttribute('href')).toBe('#/check?fix=1')
  })

  it('고급 설정 — 내부 대역이 겹치면 돌아갈 수 없다', async () => {
    open('ready', '#/advanced')
    await heading('고급 설정')
    type('내부 대역', '172.28.0.0/16')
    expect(screen.getByText('172.28.0.0/24 처럼 /24 대역으로 입력합니다.')).toBeTruthy()
    expect(button('요약으로 돌아가기').disabled).toBe(true)
    type('내부 대역', '192.168.10.0/24')
    fireEvent.click(button('요약으로 돌아가기'))
    await screen.findByText('이 서버가 이미 쓰는 네트워크와 겹칩니다. 다른 대역을 입력합니다.')
    expect(screen.getByText('내부 대역을 고쳐야 돌아갈 수 있습니다.')).toBeTruthy()
    type('내부 대역', '172.30.0.0/24')
    fireEvent.click(button('요약으로 돌아가기'))
    await heading('이대로 설치합니다')
    await screen.findByText('172.30.0.0/24')
  })

  it('빠른 설치의 요약 — 묻지 않은 항목은 기본값으로 보이고 고치기가 없다', async () => {
    open('quick-ready', '#/summary')
    await heading('이대로 설치합니다')
    expect(screen.getByText(/협업 묶음 · 기본, 메일, 채팅/)).toBeTruthy()
    expect(screen.getAllByText(/· 기본값/).length).toBeGreaterThanOrEqual(3)
    expect(screen.queryByRole('link', { name: '구역 고치기' })).toBeNull()
    expect(screen.queryByRole('link', { name: '파일 저장 위치 고치기' })).toBeNull()
    expect(screen.getByRole('link', { name: '메일 고치기' })).toBeTruthy()
    expect(screen.queryByText('고급 설정')).toBeNull()
  })
})

describe('적용', () => {
  const stepsOf = () => Array.from(document.querySelectorAll('[data-step]')).map(el => `${el.getAttribute('data-step')}:${el.getAttribute('data-status')}`)

  it('설치를 누르면 적용 화면 — 다 끝나면 완료 화면으로 넘어갈 수 있다', async () => {
    open('ready,records-ok', '#/summary')
    await heading('이대로 설치합니다')
    await waitFor(() => expect(button('설치').disabled).toBe(false))
    fireEvent.click(button('설치'))
    await heading('설치가 끝났습니다')
    // 이 서버의 디스크(기본 폴더)면 "저장소 연결" 단계가 없다
    expect(stepsOf()).toEqual(['config:done', 'pull:done', 'database:done', 'cert:done', 'zones:done', 'admin:done', 'lock:done'])
    expect(screen.getByRole('progressbar', { name: '설치 진행' }).getAttribute('aria-valuenow')).toBe('7')
    fireEvent.click(button('완료 화면 열기'))
    expect(await screen.findByRole('link', { name: /워크스페이스 열기/ })).toBeTruthy()
    expect(screen.getByDisplayValue('https://workspace.example.com')).toBeTruthy()
    expect(screen.getByText('사람 초대')).toBeTruthy()
    expect(screen.queryByText('인증서 발급')).toBeNull()
    expect(screen.queryByText('빠진 메일 레코드 등록')).toBeNull()
  })

  it('인증서 발급 실패 — 실패 카드, 기록 보기, 임시 인증서로 계속', async () => {
    const { store } = open('ready,apply-cert-fail', '#/summary')
    await heading('이대로 설치합니다')
    await waitFor(() => expect(button('설치').disabled).toBe(false))
    fireEvent.click(button('설치'))
    await heading('설치가 멈췄습니다')
    expect(stepsOf()).toEqual(['config:done', 'pull:done', 'database:done', 'cert:failed', 'zones:pending', 'admin:pending', 'lock:pending'])
    expect(screen.getByText('한 단계에서 멈췄습니다. 앞에서 끝난 단계는 그대로 남아 있습니다.')).toBeTruthy()
    const card = screen.getByRole('alert')
    expect(card.textContent).toContain('인증 기관이 workspace.example.com의 80번 포트에 접속하지 못했습니다.')
    expect(within(card).getByRole('link', { name: '요약으로 돌아가 고치기' }).getAttribute('href')).toBe('#/summary')
    expect(within(card).getByRole('button', { name: '기록 내려받기' })).toBeTruthy()

    const log = within(card).getByRole('button', { name: '기록 보기' })
    expect(log.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(log)
    expect(log.getAttribute('aria-expanded')).toBe('true')
    await screen.findByText(/failed: connection timed out/)

    fireEvent.click(within(card).getByRole('button', { name: '임시 인증서로 계속' }))
    await heading('설치가 끝났습니다')
    fireEvent.click(button('완료 화면 열기'))
    // 임시 인증서로 끝냈으니 할 일에 인증서 발급이 있다
    expect(await screen.findByText('인증서 발급')).toBeTruthy()
    expect(store.getState().finishedHere).toBe(true)
  })

  it('저장소 연결 실패 — 네트워크 저장소일 때만 있는 단계, 이 단계부터 다시', async () => {
    open('ready,apply-storage-fail', '#/summary')
    await heading('이대로 설치합니다')
    await waitFor(() => expect(button('설치').disabled).toBe(false))
    fireEvent.click(button('설치'))
    await heading('설치가 멈췄습니다')
    expect(stepsOf().slice(0, 3)).toEqual(['config:done', 'storage:failed', 'pull:pending'])
    const card = screen.getByRole('alert')
    expect(card.textContent).toContain('nas.example.com:/volume1/workspace')
    expect(within(card).getByRole('link', { name: '파일 저장 위치 고치기' }).getAttribute('href')).toBe('#/storage?fix=1')
    expect(within(card).queryByRole('button', { name: '임시 인증서로 계속' })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: '이 단계부터 다시' }))
    await heading('설치가 끝났습니다')
    expect(stepsOf()[1]).toBe('storage:done')
  })

  it('진행 중 — 이미지별 진행률을 보여 주고, 진행 부분은 실시간 낭독 영역이 아니다', async () => {
    open('ready,apply-running', '#/apply')
    await heading('설치하는 중입니다')
    expect(stepsOf()).toContain('pull:running')
    const pull = document.querySelector('[data-step=pull]') as HTMLElement
    expect(within(pull).getByRole('progressbar', { name: 'postgres' }).getAttribute('aria-valuenow')).toBe('62')
    expect(within(pull).getByText('62%')).toBeTruthy()
    expect(within(pull).getByRole('progressbar', { name: 'frontend' }).getAttribute('aria-valuenow')).toBe('100')
    expect(pull.closest('[aria-live]')).toBeNull()
    expect(pull.closest('[role=status]')).toBeNull()
    expect(screen.getByText(/이 창을 닫아도 설치는 계속됩니다/)).toBeTruthy()
  })

  it('시작하지 않은 채 적용 주소로 오면 요약으로 돌려보낸다', async () => {
    open('ready', '#/apply')
    await heading('이대로 설치합니다')
  })
})

describe('백업에서 복원', () => {
  const restoreSteps = () => Array.from(document.querySelectorAll('[data-step]')).map(el => `${el.getAttribute('data-step')}:${el.getAttribute('data-status')}`)

  it('서버가 아직 지원하지 않으면 그 사실을 알린다', async () => {
    open('', '#/start')
    await heading('어떻게 시작할까요')
    fireEvent.click(screen.getByRole('radio', { name: /백업에서 복원/ }))
    fireEvent.click(next())
    await heading('백업 파일 올리기')
    fireEvent.click(screen.getByRole('radio', { name: '서버에 있는 파일 경로' }))
    type(/서버에 있는 백업 파일 경로/, '/srv/backup/a.jwbak')
    fireEvent.click(button('파일 확인'))
    await screen.findByRole('alert')
    expect(screen.getAllByText('아직 지원하지 않습니다').length).toBeGreaterThan(0)
    expect(next().disabled).toBe(true)
    fireEvent.click(button('시작 방식으로 돌아가기'))
    await heading('어떻게 시작할까요')
  })

  it('파일을 확인하고 내용을 본 뒤 복원한다', async () => {
    const { container } = open('restore', '#/file')
    await heading('백업 파일 올리기')
    expect(next().disabled).toBe(true)
    expect(screen.getByText('백업 파일을 올려야 다음으로 갈 수 있습니다.')).toBeTruthy()
    const input = container.querySelector('input[type=file]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'workspace-backup.jwbak')] } })
    await screen.findByText(/파일이 온전하고, 이 버전에서 복원할 수 있는 백업입니다/)
    fireEvent.click(next())

    await heading('이 백업으로 복원합니다')
    await screen.findByText(/네트워크 저장소 \(NFS\) · nas.example.com:\/volume1\/workspace/)
    expect(screen.getByText('없음 · 네트워크 저장소의 파일은 백업에 넣지 않습니다')).toBeTruthy()
    expect((screen.getByRole('radio', { name: /이 서버의 디스크/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(button('복원').disabled).toBe(true)
    expect(screen.getByText('네트워크 저장소 연결이 확인돼야 복원할 수 있습니다.')).toBeTruthy()
    fireEvent.click(button('연결 확인'))
    await screen.findByText(/검사 다섯 가지를 통과했습니다/)
    await screen.findByText('일치')
    expect(button('복원').disabled).toBe(false)
    fireEvent.click(button('복원'))

    await heading('복원이 끝났습니다')
    expect(restoreSteps()).toEqual(['unpack:done', 'storage:done', 'pull:done', 'database:done', 'cert:done', 'zones:done'])
    expect(screen.getByText('백업 풀고 설정 파일 만들기')).toBeTruthy()
    expect(screen.getByText('데이터 되돌리기')).toBeTruthy()
    expect(screen.getByText('구역 시작하고 마법사 잠그기')).toBeTruthy()
    // 백업에 파일이 없으면 "파일 되돌리기" 단계가 없다
    expect(screen.queryByText('파일 되돌리기')).toBeNull()
    fireEvent.click(button('완료 화면 열기'))
    expect(await screen.findByText('원래 서버 끄기')).toBeTruthy()
    expect(screen.getByText(/계정, 비밀번호, 데이터는 원래 서버에서 쓰던 그대로입니다/)).toBeTruthy()
    // 원래 서버가 네트워크 저장소를 썼으면 같은 저장소를 다시 연결한 것이다
    expect(screen.getByText(/네트워크 저장소를 다시 연결했습니다/)).toBeTruthy()
    expect(screen.getByText('접속 주소 옮기기')).toBeTruthy()
    expect(screen.queryByText('인증서 발급')).toBeNull()
  })

  it('새 버전의 백업은 복원할 수 없다 · 연결 확인 실패는 원인을 알린다', async () => {
    open('restore,restore-version,nfs-permission', '#/review')
    await heading('이 백업으로 복원합니다')
    await screen.findByText('이 백업은 지금 설치하는 버전보다 새 버전에서 만들었습니다.')
    expect(screen.getByText('이 버전의 백업은 복원할 수 없습니다.')).toBeTruthy()
    fireEvent.click(button('연결 확인'))
    await screen.findByText('2번 검사 실패')
    expect(screen.getByText(/새 서버는 주소가 달라서 권한을 다시 줘야 합니다/)).toBeTruthy()
    expect(button('복원').disabled).toBe(true)
  })

  it('맞지 않는 파일', async () => {
    const { container } = open('restore,restore-badfile', '#/file')
    await heading('백업 파일 올리기')
    fireEvent.change(container.querySelector('input[type=file]') as HTMLInputElement, { target: { files: [new File(['x'], 'notes.zip')] } })
    await screen.findByText('이 파일로는 복원할 수 없습니다.')
    expect(next().disabled).toBe(true)
    expect(screen.getByText('복원할 수 있는 백업 파일을 올려야 다음으로 갈 수 있습니다.')).toBeTruthy()
  })
})

describe('백업에서 복원 — 파일 상태', () => {
  const pickFile = (container: HTMLElement, fileName = 'workspace-backup.jwbak') =>
    fireEvent.change(container.querySelector('input[type=file]') as HTMLInputElement, { target: { files: [new File(['x'], fileName)] } })

  it.each([
    ['restore-badfile', /Just Workspace 백업 파일이 아닙니다/],
    ['restore-format', /이 설치 관리자가 모르는 형식의 백업입니다/],
    ['restore-noconfig', /설정이 들어 있지 않은 백업이라 새 서버로 옮길 수 없습니다/],
    ['restore-corrupt', /옮기는 중에 손상됐습니다/],
  ])('복원할 수 없는 파일은 사유를 알린다 (%s)', async (scenario, body) => {
    const { container } = open(`restore,${scenario}`, '#/file')
    await heading('백업 파일 올리기')
    pickFile(container)
    await screen.findByText('이 파일로는 복원할 수 없습니다.')
    expect(screen.getByText(body)).toBeTruthy()
    expect(next().disabled).toBe(true)
  })

  it('다 올라간 뒤에는 서버가 확인하는 동안 "확인 중"을 보인다 · 취소하면 처음으로', async () => {
    const { container } = open('restore,restore-checking', '#/file')
    await heading('백업 파일 올리기')
    pickFile(container)
    await screen.findByText(/확인 중 · 파일이 온전한지 보고 있습니다/)
    expect(screen.getByText('파일 확인이 끝나면 다음으로 갈 수 있습니다.')).toBeTruthy()
    expect(next().disabled).toBe(true)
    fireEvent.click(button('취소'))
    await screen.findByText('백업 파일을 여기에 끌어다 놓습니다')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('올리는 중에는 진행률을 보인다', async () => {
    const { container } = open('restore,restore-uploading', '#/file')
    await heading('백업 파일 올리기')
    pickFile(container)
    await screen.findByText('올리는 중 · 62%')
    expect(screen.getByText('다 올라가면 파일을 확인합니다.')).toBeTruthy()
  })

  it('서버에 빈 공간이 모자라면 얼마가 필요한지 알린다', async () => {
    const { container } = open('restore,restore-nospace', '#/file')
    await heading('백업 파일 올리기')
    pickFile(container)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('서버에 빈 공간이 모자랍니다. 4.5 GB가 필요한데 1.1 GB만 남았습니다.')
    expect(next().disabled).toBe(true)
  })

  it('암호로 보호된 백업 — 틀리면 다시 묻고, 맞으면 다음으로 간다', async () => {
    const { container } = open('restore,restore-password', '#/file')
    await heading('백업 파일 올리기')
    pickFile(container)
    await screen.findByText('암호로 보호된 백업입니다.')
    expect(next().disabled).toBe(true)
    expect(screen.getByText('백업 암호를 넣고 확인해야 다음으로 갈 수 있습니다.')).toBeTruthy()
    expect((screen.getByLabelText('백업 암호') as HTMLInputElement).type).toBe('password')
    expect(button('암호 확인').disabled).toBe(true)
    type('백업 암호', 'not-it')
    fireEvent.click(button('암호 확인'))
    await screen.findByText('암호가 맞지 않습니다. 다시 넣습니다.')
    expect(next().disabled).toBe(true)
    type('백업 암호', 'backup-pass')
    fireEvent.click(button('암호 확인'))
    await screen.findByText(/파일이 온전하고, 이 버전에서 복원할 수 있는 백업입니다/)
    expect(screen.queryByText('암호로 보호된 백업입니다.')).toBeNull()
    expect(next().disabled).toBe(false)
  })

  it('다시 들어오면 서버가 가진 백업의 상태를 그대로 보인다 · 버릴 수 있다', async () => {
    const { api } = open('restore,restore-kept', '#/file')
    await heading('백업 파일 올리기')
    await screen.findByText('workspace-backup-20260101.jwbak')
    expect(screen.getByText(/파일이 온전하고, 이 버전에서 복원할 수 있는 백업입니다/)).toBeTruthy()
    expect(next().disabled).toBe(false)
    fireEvent.click(button('버리기'))
    await screen.findByText('백업 파일을 여기에 끌어다 놓습니다')
    expect(next().disabled).toBe(true)
    expect((await api.restoreFile()).status).toBe('none')
  })

  it('서버에 있는 경로 — 없는 파일은 입력란에 알리고, 있는 파일은 확인된다', async () => {
    open('restore', '#/file')
    await heading('백업 파일 올리기')
    fireEvent.click(screen.getByRole('radio', { name: '서버에 있는 파일 경로' }))
    type(/서버에 있는 백업 파일 경로/, '/srv/backup/missing.jwbak')
    fireEvent.click(button('파일 확인'))
    await screen.findByText(/이 경로에 파일이 없거나 읽을 권한이 없습니다/)
    expect(next().disabled).toBe(true)
    type(/서버에 있는 백업 파일 경로/, '/srv/backup/a.jwbak')
    fireEvent.click(button('파일 확인'))
    await screen.findByText(/파일이 온전하고, 이 버전에서 복원할 수 있는 백업입니다/)
    expect(next().disabled).toBe(false)
  })
})

describe('백업에서 복원 — 내용 확인과 완료', () => {
  const stepsOf = () => Array.from(document.querySelectorAll('[data-step]')).map(el => `${el.getAttribute('data-step')}:${el.getAttribute('data-status')}`)
  const ready = async () => {
    await heading('이 백업으로 복원합니다')
    await waitFor(() => expect(button('복원').disabled).toBe(false), { timeout: 3000 })
  }

  it('올려 둔 백업이 없으면 파일 화면으로 돌려보낸다', async () => {
    open('restore,restore-nobackup', '#/review')
    await heading('백업 파일 올리기')
  })

  it('서버가 알려 준 막는 사유를 보이고 복원을 막는다', async () => {
    open('restore,restore-local,restore-memory', '#/review')
    await heading('이 백업으로 복원합니다')
    await screen.findByText('이 서버에는 이 백업을 복원할 수 없습니다.')
    expect(screen.getByText(/백업에 든 구역에 권장 메모리 8 GB가 필요한데 이 서버는 6 GB입니다/)).toBeTruthy()
    expect(screen.getByText('위 사유를 해결해야 복원할 수 있습니다.')).toBeTruthy()
    expect(button('복원').disabled).toBe(true)
  })

  it('다섯 검사를 통과해도 백업의 그 공유가 아니면 막는다(번호 없는 제목)', async () => {
    open('restore,restore-nfs-marker', '#/review')
    await heading('이 백업으로 복원합니다')
    fireEvent.click(await screen.findByRole('button', { name: '연결 확인' }))
    await screen.findByText('이 공유로는 복원할 수 없습니다.')
    expect(screen.getByText(/이 공유에는 원래 서버가 남긴 표식이 없습니다/)).toBeTruthy()
    expect(screen.queryByText(/번 검사 실패/)).toBeNull()
    expect(screen.getByText('원래 서버가 쓰던 공유를 연결해야 복원할 수 있습니다.')).toBeTruthy()
    expect(button('복원').disabled).toBe(true)
  })

  it('서버가 시작을 거부하면(422) 사유를 항목별로 보인다', async () => {
    open('restore,restore-local,restore-invalid', '#/review')
    await ready()
    fireEvent.click(button('복원'))
    await screen.findByText('이대로는 복원을 시작할 수 없습니다.')
    expect(screen.getByText(/이 공유에는 원래 서버가 남긴 표식이 없습니다. 다른 공유이거나 비어 있습니다./)).toBeTruthy()
    // 문구를 모르는 사유는 코드를 그대로 보인다
    expect(screen.getByText('서버가 값을 받지 않았습니다. (domain_unusual)')).toBeTruthy()
    expect(screen.getByText('위 항목을 고친 뒤 다시 누릅니다.')).toBeTruthy()
    await heading('이 백업으로 복원합니다')
  })

  it('연결 형태 · 프록시 주소 · 내부 대역은 백업의 값을 기본으로 보낸다', async () => {
    const { api } = open('restore,restore-local,restore-proxy', '#/review')
    const sent = vi.spyOn(api, 'restoreApply')
    await ready()
    const box = screen.getByRole('button', { name: /연결 형태와 내부 대역/ })
    expect(box.textContent).toContain('기존 프록시 뒤 · 내부 대역 172.28.0.0/24')
    fireEvent.click(box)
    expect((screen.getByLabelText(/프록시 주소 또는 대역/) as HTMLInputElement).value).toBe('192.168.10.5')
    type(/프록시 주소 또는 대역/, '')
    expect(button('복원').disabled).toBe(true)
    expect(screen.getByText('프록시 주소를 입력해야 복원할 수 있습니다.')).toBeTruthy()
    type(/프록시 주소 또는 대역/, '192.168.10.5, 192.168.10.6')
    type('내부 대역', '172.30.0.0/16')
    expect(screen.getByText('내부 대역을 고쳐야 복원할 수 있습니다.')).toBeTruthy()
    type('내부 대역', '172.30.0.0/24')
    fireEvent.click(button('복원'))
    await heading('복원이 끝났습니다')
    expect(sent).toHaveBeenCalledWith({
      domain: 'workspace.example.com', storage: { kind: 'local' }, network: 'proxy',
      proxy_addresses: ['192.168.10.5', '192.168.10.6'], subnet: '172.30.0.0/24',
    })
    // 프록시 뒤면 인증서 단계가 없다
    expect(stepsOf()).toEqual(['unpack:done', 'pull:done', 'database:done', 'files:done', 'zones:done'])
    fireEvent.click(button('완료 화면 열기'))
    expect(await screen.findByText('백업에 든 파일도 되돌렸습니다.')).toBeTruthy()
  })

  it('연결 형태를 바꿔 보낸다 · 프록시가 아니면 프록시 주소를 보내지 않는다', async () => {
    const { api } = open('restore,restore-local', '#/review')
    const sent = vi.spyOn(api, 'restoreApply')
    await ready()
    fireEvent.click(screen.getByRole('button', { name: /연결 형태와 내부 대역/ }))
    fireEvent.click(screen.getByRole('radio', { name: '공유기 뒤 (포트 포워딩)' }))
    expect(screen.queryByLabelText(/프록시 주소 또는 대역/)).toBeNull()
    fireEvent.click(button('복원'))
    await heading('복원이 끝났습니다')
    expect(sent).toHaveBeenCalledWith({ domain: 'workspace.example.com', storage: { kind: 'local' }, network: 'router', subnet: '172.28.0.0/24' })
  })

  it('파일 없는 백업 · 접속 주소가 아직 여기를 가리키지 않으면 — 완료 화면이 그렇게 알린다', async () => {
    open('restore,restore-nofiles,dns-mismatch', '#/review')
    await ready()
    expect(screen.getByText('파일 없이 복원합니다.')).toBeTruthy()
    expect(screen.getByText('접속 주소가 아직 이 서버를 가리키지 않습니다. 그대로 복원할 수 있습니다.')).toBeTruthy()
    fireEvent.click(button('복원'))
    await heading('복원이 끝났습니다')
    fireEvent.click(button('완료 화면 열기'))
    expect(await screen.findByText(/파일 없이 복원했습니다/)).toBeTruthy()
    // 서버가 임시 인증서로 정했다
    expect(screen.getByText('인증서 발급')).toBeTruthy()
    expect(screen.getByText('원래 서버 끄기')).toBeTruthy()
  })

  it('인증서 발급 실패 — 복원에서도 임시 인증서로 계속할 수 있다', async () => {
    const { api } = open('restore,restore-local,restore-cert-fail', '#/review')
    const retried = vi.spyOn(api, 'restoreRetry')
    await ready()
    fireEvent.click(button('복원'))
    await heading('복원이 멈췄습니다')
    expect(stepsOf()).toEqual(['unpack:done', 'pull:done', 'database:done', 'files:done', 'cert:failed', 'zones:pending'])
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: /임시 인증서/ }))
    await heading('복원이 끝났습니다')
    expect(retried).toHaveBeenCalledWith({ use_temporary_cert: true })
    fireEvent.click(button('완료 화면 열기'))
    expect(await screen.findByText('인증서 발급')).toBeTruthy()
  })

  it('데이터를 되돌리다 멈추면 원인을 알리고 다시 시도할 수 있다', async () => {
    open('restore,restore-local,restore-fail', '#/review')
    await ready()
    fireEvent.click(button('복원'))
    await heading('복원이 멈췄습니다')
    const card = screen.getByRole('alert')
    expect(card.textContent).toContain('백업의 데이터를 되돌리다 멈췄습니다.')
    expect(within(card).getByRole('link', { name: '내용 확인으로 돌아가기' }).getAttribute('href')).toBe('#/review')
    fireEvent.click(within(card).getByRole('button', { name: '이 단계부터 다시' }))
    await heading('복원이 끝났습니다')
  })
})

describe('언어', () => {
  it('영어로 바꾸면 화면 문구와 단계 목록이 영어로 나온다', async () => {
    open('', '#/check')
    await heading('사전 점검')
    fireEvent.click(screen.getAllByRole('radio', { name: 'English' })[0])
    await heading('Server check')
    expect(within(screen.getByRole('list', { name: 'Setup steps' })).getByText('How to start')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy()
    await act(async () => { await setLocale('ko') })
    await heading('사전 점검')
  })
})

describe('인증서 올리기 — 사설 CA 의 인증서', () => {
  const pem = (name: string) => new File(['PEM'], name, { type: 'application/x-pem-file' })
  const drop = (container: HTMLElement, index: number, file: File) =>
    fireEvent.change(container.querySelectorAll('input[type=file]')[index], { target: { files: [file] } })

  it('서버 인증서 한 장만 올리면 발급 CA 가 없다고 알리고(막지는 않는다), CA 인증서를 올리면 풀린다', async () => {
    const { container, api } = open('ready,upload,cert-leaf', '#/cert')
    await heading('인증서 올리기')
    expect(screen.getByText('CA 인증서 (선택)')).toBeTruthy()
    expect(screen.getByTestId('cert-ca-note').textContent).toContain('공개 인증 기관이 내준 인증서면 비워 둡니다.')
    const probe = vi.spyOn(api, 'probeCert')
    drop(container, 0, pem('server.crt'))
    drop(container, 1, pem('server.key'))
    await screen.findByText('인증서 파일에 발급 CA 가 들어 있지 않습니다.')
    expect(screen.getByText(/사설 CA 가 내준 인증서라면 위의 CA 인증서 칸에/)).toBeTruthy()
    expect(screen.getByTestId('cert-row-ca').textContent).toContain('들어 있지 않음')
    expect(next().disabled).toBe(false)                                        // 공개 CA 일 수 있다 — 주의일 뿐이다
    expect(probe.mock.calls.at(-1)?.[3] ?? null).toBeNull()

    drop(container, 2, pem('ca.crt'))
    await waitFor(() => expect(screen.getByTestId('cert-row-ca').textContent).toContain('함께 올림'))
    expect(screen.queryByText('인증서 파일에 발급 CA 가 들어 있지 않습니다.')).toBeNull()
    expect((probe.mock.calls.at(-1)?.[3] as File).name).toBe('ca.crt')         // CA 파일도 함께 확인에 보낸다
    expect(next().disabled).toBe(false)

    // CA 를 빼면 다시 서버 인증서만으로 확인한다
    fireEvent.click(button('CA 인증서 빼기'))
    await screen.findByText('인증서 파일에 발급 CA 가 들어 있지 않습니다.')
    expect(probe.mock.calls.at(-1)?.[3] ?? null).toBeNull()
  })

  it('올린 CA 가 그 인증서를 내준 CA 가 아니면 다음으로 갈 수 없다', async () => {
    const { container } = open('ready,upload,cert-leaf,cert-ca-bad', '#/cert')
    await heading('인증서 올리기')
    drop(container, 0, pem('server.crt'))
    drop(container, 1, pem('server.key'))
    drop(container, 2, pem('other-ca.crt'))
    await screen.findByText('이 CA 는 올린 인증서를 내준 CA 가 아닙니다.')
    expect(screen.getByTestId('cert-row-ca').textContent).toContain('이 인증서를 내준 CA 가 아님')
    expect(next().disabled).toBe(true)
  })

  it('CA 인증서에 관한 문구가 한국어·영어에 모두 있다', async () => {
    const { default: ko } = await import('~/installer-app/i18n/ko.json')
    const { default: en } = await import('~/installer-app/i18n/en.json')
    for (const m of [ko, en] as any[]) {
      for (const key of ['caSlot', 'caEmpty', 'caNote', 'caRemove', 'rowCa', 'caOk', 'caMissing', 'caBad']) expect(m.cert[key], key).toBeTruthy()
      for (const key of ['cert_chain_missing', 'ca_not_pem', 'ca_is_private_key', 'ca_not_a_ca', 'ca_not_issuer']) expect(m.cert.msg[key].title && m.cert.msg[key].body, key).toBeTruthy()
    }
  })
})
