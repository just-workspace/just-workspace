// handover-22 채팅 설정(SETTINGS) — 권한 행렬 비트(32비트 넘는 비트) · 3단 토글 → allow/deny · 동기화 판정 · 계층 잠금 ·
// 이모지 이름 검사·오류 문구 · 정책 토글 확인 흐름 · 저장 안 된 변경 띠
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  routes: {} as Record<string, (opts: any) => any>,
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => {
    api.calls.push({ url, opts })
    const key = `${(opts.method || 'GET').toUpperCase()} ${url}`
    const h = api.routes[key] ?? api.routes[url]
    if (h) return h(opts)
    return { ok: true }
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const L = await import('~/components/chat/settings/settingsLogic')
const R = await import('~/composables/useChatRoles')
const { PermissionMatrix } = await import('~/components/chat/settings/PermissionMatrix')
const { RolesSection } = await import('~/components/chat/settings/RolesSection')
const { ChannelOverwrites } = await import('~/components/chat/settings/ChannelOverwrites')
const { PolicySection, policyNeedsConfirm } = await import('~/components/chat/settings/PolicySection')
const { UiDialogHost } = await import('~/components/ui/DialogHost')
const { settingsUiStore } = await import('~/components/chat/settings/settingsStore')
const { setUser } = await import('~/composables/useAuth')
const { chatStore } = await import('~/composables/useChat')
const { i18n } = await import('~/i18n')
const t = (k: string, a?: any) => i18n.t(k, a)
const { PERM, hasBit, withBit, triOf, applyTri, chatRolesStore } = R

const role = (o: Partial<import('~/composables/useChatRoles').ChatRole>): import('~/composables/useChatRoles').ChatRole => ({
  id: 'r', name: 'r', color: null, icon: null, position: 1, permissions: 0, permission_names: [], hoist: false, mentionable: false,
  managed: false, group_id: null, is_default: false, mention: 'r', member_count: 0, ...o,
})

beforeEach(() => {
  api.calls = []; api.routes = {}
  settingsUiStore.setState({ dirty: false, shakeTick: 0 })
})

describe('비트 · 행렬', () => {
  it('hasBit/withBit — 2^32·2^40 도 산술로', () => {
    let b = 0
    b = withBit(b, PERM.USE_SOUNDBOARD, true)
    b = withBit(b, PERM.ADMINISTRATOR, true)
    b = withBit(b, PERM.VIEW_CHANNEL, true)
    expect(b).toBe(2 ** 32 + 2 ** 40 + 1)
    expect(hasBit(b, PERM.USE_SOUNDBOARD)).toBe(true)
    expect(hasBit(b, PERM.REQUEST_TO_SPEAK)).toBe(false)
    expect(withBit(b, PERM.USE_SOUNDBOARD, false)).toBe(2 ** 40 + 1)
    expect(withBit(b, PERM.USE_SOUNDBOARD, true)).toBe(b)
    expect(L.bitsList(b)).toEqual([1, 2 ** 32, 2 ** 40])
  })

  it('묶음 4개(일반·멤버·텍스트·음성) · 채널 범위는 ADMINISTRATOR 를 뺀다', () => {
    const g = L.permGroups(null, 'role')
    expect(g.map(x => x.key)).toEqual(['general', 'members', 'text', 'voice'])
    expect(g.flatMap(x => x.rows).length).toBe(35)
    expect(g[0].rows.find(r => r.name === 'ADMINISTRATOR')?.dangerous).toBe(true)
    expect(L.permGroups(null, 'channel').flatMap(x => x.rows).some(r => r.name === 'ADMINISTRATOR')).toBe(false)
  })

  it('행렬 스위치 → 32비트 넘는 비트 켜기 · 못 주는 비트는 잠금 + 위험 경고 aria-describedby', () => {
    const onChange = vi.fn()
    const groups = L.permGroups(null, 'role')
    const mine = PERM.CONNECT + PERM.USE_SOUNDBOARD + PERM.VIEW_CHANNEL
    render(<PermissionMatrix groups={groups} value={PERM.VIEW_CHANNEL} onChange={onChange} myBits={mine} isGlobalAdmin={false} />)
    fireEvent.click(screen.getByRole('switch', { name: t('chat.settings.perms.USE_SOUNDBOARD.n') }))
    expect(onChange).toHaveBeenLastCalledWith(PERM.VIEW_CHANNEL + 2 ** 32)
    const admin = screen.getByRole('switch', { name: t('chat.settings.perms.ADMINISTRATOR.n') }) as HTMLButtonElement
    expect(admin.disabled).toBe(true)
    const desc = admin.getAttribute('aria-describedby') || ''
    expect(desc.split(' ').map(id => document.getElementById(id)?.textContent).join(' ')).toContain(t('chat.settings.perms.ADMINISTRATOR.w'))
    expect(desc.split(' ').map(id => document.getElementById(id)?.textContent).join(' ')).toContain(t('chat.settings.matrix.cantGrant'))
  })

  it('canGrantBit — 전역 관리자·ADMINISTRATOR 는 전부', () => {
    expect(L.canGrantBit(0, PERM.MANAGE_ROLES, true)).toBe(true)
    expect(L.canGrantBit(PERM.ADMINISTRATOR, PERM.MANAGE_ROLES, false)).toBe(true)
    expect(L.canGrantBit(PERM.VIEW_CHANNEL, PERM.MANAGE_ROLES, false)).toBe(false)
  })
})

describe('3단 · 동기화 · 결과 요약', () => {
  it('triOf/applyTri', () => {
    let o = { allow: 0, deny: 0 }
    o = applyTri(o, PERM.SEND_MESSAGES, 'allow')
    expect(triOf(o, PERM.SEND_MESSAGES)).toBe('allow')
    o = applyTri(o, PERM.SEND_MESSAGES, 'deny')
    expect(o).toEqual({ allow: 0, deny: PERM.SEND_MESSAGES })
    o = applyTri(o, PERM.USE_SOUNDBOARD, 'allow')
    expect(o.allow).toBe(2 ** 32)
    expect(applyTri(o, PERM.SEND_MESSAGES, 'inherit')).toEqual({ allow: 2 ** 32, deny: 0 })
  })

  it('동기화 판정 — 채널 덮어쓰기 없음 = 동기화 · 같으면 동기화 · 다르면 아님', () => {
    const cat = [{ subject_kind: 'role' as const, subject_id: 'a', allow: 1, deny: 0 }]
    expect(L.channelSynced([], cat)).toBe(true)
    expect(L.channelSynced([{ subject_kind: 'role', subject_id: 'a', allow: 0, deny: 0 }], cat)).toBe(true)
    expect(L.channelSynced([...cat], cat)).toBe(true)
    expect(L.channelSynced([{ subject_kind: 'role', subject_id: 'a', allow: 2, deny: 0 }], cat)).toBe(false)
  })

  it('effectiveFor — @everyone → 역할 → 사람 순 · 카테고리 다음 채널 · VIEW 없으면 0', () => {
    const roles = [role({ id: 'ev', is_default: true, position: 0, permissions: PERM.VIEW_CHANNEL + PERM.SEND_MESSAGES }), role({ id: 'mod', position: 2, permissions: PERM.MANAGE_MESSAGES })]
    const ch = [
      { subject_kind: 'role' as const, subject_id: 'ev', allow: 0, deny: PERM.SEND_MESSAGES },
      { subject_kind: 'role' as const, subject_id: 'mod', allow: PERM.SEND_MESSAGES, deny: 0 },
    ]
    const ev = L.effectiveFor({ kind: 'role', id: 'ev' }, roles, ch)
    expect(hasBit(ev, PERM.SEND_MESSAGES)).toBe(false)
    const mod = L.effectiveFor({ kind: 'role', id: 'mod' }, roles, ch)
    expect(hasBit(mod, PERM.SEND_MESSAGES) && hasBit(mod, PERM.MANAGE_MESSAGES)).toBe(true)
    const u = L.effectiveFor({ kind: 'user', id: 'u1', roleIds: ['mod'] }, roles, [...ch, { subject_kind: 'user', subject_id: 'u1', allow: 0, deny: PERM.VIEW_CHANNEL }])
    expect(u).toBe(0)
    const cat = [{ subject_kind: 'role' as const, subject_id: 'ev', allow: PERM.PIN_MESSAGES, deny: 0 }]
    expect(hasBit(L.effectiveFor({ kind: 'role', id: 'ev' }, roles, [], cat), PERM.PIN_MESSAGES)).toBe(true)
  })

  it('채널 화면 — 3단 "허용" → PUT allow · 다른 카테고리면 동기화 banner [동기화] = 채널 덮어쓰기 지우기', async () => {
    setUser({ id: 'me', username: 'me', display_name: 'me', email: null, is_admin: true } as any)
    chatRolesStore.setState({
      roles: [role({ id: 'ev', is_default: true, position: 0, permissions: PERM.VIEW_CHANNEL }), role({ id: 'exec', name: '경영진', position: 1 })],
      loaded: true, catalog: null,
    })
    chatStore.setState({ channels: [{ id: 'c1', name: '경영', type: 'public', category_id: 'k1' }] as any })
    api.routes['GET /api/chat/channels/c1/permissions'] = () => ({
      overwrites: [{ subject_kind: 'role', subject_id: 'exec', allow: PERM.VIEW_CHANNEL, deny: 0 }],
      category_overwrites: [], category_id: 'k1',
    })
    render(<ChannelOverwrites kind="channel" targetId="c1" />)
    expect(await screen.findByText(t('chat.settings.perm.notSynced', { cat: '' }))).toBeTruthy()
    const send = await screen.findByRole('radiogroup', { name: t('chat.settings.perms.SEND_MESSAGES.n') })
    await act(async () => { fireEvent.click(within(send).getByRole('radio', { name: /허용|Allow/ })) })
    const put = api.calls.find(c => c.opts.method === 'PUT')
    expect(put?.url).toBe('/api/chat/channels/c1/permissions/role/exec')
    expect(put?.opts.body).toEqual({ allow: PERM.VIEW_CHANNEL + PERM.SEND_MESSAGES, deny: 0 })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('chat.settings.perm.sync') })) })
    await waitFor(() => expect(api.calls.some(c => c.opts.method === 'DELETE' && c.url === '/api/chat/channels/c1/permissions/role/exec')).toBe(true))
  })
})

describe('역할 — 계층 잠금 · 저장 안 된 변경', () => {
  it('isRoleLocked · reorderAllowed · moveRoleIds', () => {
    expect(L.isRoleLocked({ position: 3, is_default: false }, 2, true)).toBe(true)
    expect(L.isRoleLocked({ position: 2, is_default: false }, 2, true)).toBe(true)
    expect(L.isRoleLocked({ position: 1, is_default: false }, 2, true)).toBe(false)
    expect(L.isRoleLocked({ position: 0, is_default: true }, 0, true)).toBe(false)
    expect(L.isRoleLocked({ position: 1, is_default: false }, Infinity, false)).toBe(true)
    expect(L.moveRoleIds(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(L.moveRoleIds(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'a', 'c'])
    expect(L.moveRoleIds(['a', 'b', 'c'], 'a', 0)).toBeNull()
    const rs = [{ id: 'a', position: 3 }, { id: 'b', position: 2 }, { id: 'c', position: 1 }]
    expect(L.reorderAllowed(rs, ['a', 'c', 'b'], 3)).toBe(true)
    expect(L.reorderAllowed(rs, ['c', 'a', 'b'], 3)).toBe(false)
  })

  it('목록: 내 최고 역할 이상은 잠금 아이콘 · 잠긴 역할은 보기만(banner)', async () => {
    setUser({ id: 'me', username: 'me', display_name: '나', email: null, is_admin: false } as any)
    chatRolesStore.setState({
      roles: [role({ id: 'top', name: '관리자', position: 3 }), role({ id: 'lead', name: '백엔드 리드', position: 2 }), role({ id: 'des', name: '디자인', position: 1 }), role({ id: 'ev', is_default: true, position: 0 })],
      loaded: true, error: null, catalog: null, myWorkspacePerms: PERM.MANAGE_ROLES, userRoles: { me: ['lead'] },
    })
    api.routes['GET /api/chat/roles'] = () => ({ items: chatRolesStore.getState().roles })
    render(<><RolesSection /><UiDialogHost /></>)
    const top = await screen.findByRole('option', { name: /관리자/ })
    expect(within(top).getByLabelText(t('chat.settings.roles.lockedShort'))).toBeTruthy()
    fireEvent.click(top)
    expect(await screen.findByText(t('chat.settings.roles.lockedBanner', { name: '관리자', top: '백엔드 리드' }))).toBeTruthy()
    expect((screen.getByRole('textbox', { name: t('chat.settings.role.name') }) as HTMLInputElement).disabled).toBe(true)
  })

  it('이름을 바꾸면 띠 · 다른 역할로 가려 하면 그대로 + 흔들기 · 되돌리기 · 저장 = PATCH', async () => {
    setUser({ id: 'me', username: 'me', display_name: '나', email: null, is_admin: true } as any)
    chatRolesStore.setState({
      roles: [role({ id: 'a', name: '디자인', position: 2 }), role({ id: 'b', name: '리뷰어', position: 1 }), role({ id: 'ev', is_default: true, position: 0 })],
      loaded: true, error: null, catalog: null, myWorkspacePerms: 0, userRoles: {},
    })
    api.routes['GET /api/chat/roles'] = () => ({ items: chatRolesStore.getState().roles })
    api.routes['PATCH /api/chat/roles/a'] = (o) => role({ id: 'a', position: 2, ...o.body })
    render(<><RolesSection /><UiDialogHost /></>)
    const name = await screen.findByRole('textbox', { name: t('chat.settings.role.name') })
    fireEvent.change(name, { target: { value: '디자인팀' } })
    expect(await screen.findByText(t('chat.settings.dirty.text'))).toBeTruthy()
    expect(settingsUiStore.getState().dirty).toBe(true)
    fireEvent.click(screen.getByRole('option', { name: /리뷰어/ }))
    expect(settingsUiStore.getState().shakeTick).toBe(1)
    expect(screen.getByRole('option', { name: /디자인/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: t('chat.settings.dirty.revert') }))
    expect(screen.queryByText(t('chat.settings.dirty.text'))).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: t('chat.settings.role.name') }), { target: { value: '디자인팀' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.save') })) })
    const patch = api.calls.find(c => c.opts.method === 'PATCH')
    expect(patch?.url).toBe('/api/chat/roles/a')
    expect(patch?.opts.body).toEqual({ name: '디자인팀' })
  })

  it('draftPatch — @everyone 은 권한만', () => {
    const base = L.draftOf(role({ name: 'x', permissions: 1 }))
    expect(L.draftPatch(base, { ...base, name: 'y', permissions: 3 }, true)).toEqual({ permissions: 3 })
    expect(L.draftPatch(base, { ...base, name: ' y ' }, false)).toEqual({ name: 'y' })
    expect(L.isDirty(base, base)).toBe(false)
  })
})

describe('커스텀 이모지 검사', () => {
  it('파일 이름 → 기본 이름 · 이름 · 파일 검사 · 오류 문구', () => {
    expect(L.emojiNameFromFile('Huge-Party.gif')).toBe('huge_party')
    expect(L.emojiNameFromFile('ship it!!.png')).toBe('ship_it')
    expect(L.emojiNameFromFile('로고.png')).toBe('')
    expect(L.checkEmojiName('ship_it', ['otter'])).toBeNull()
    expect(L.checkEmojiName('A', [])).toBe('name_invalid')
    expect(L.checkEmojiName('ship_it', ['ship_it'])).toBe('name_taken')
    expect(L.checkEmojiFile({ type: 'image/svg+xml', size: 10 })).toBe('bad_type')
    expect(L.checkEmojiFile({ type: 'image/gif', size: 412 * 1024 })).toBe('too_large')
    expect(L.checkEmojiFile({ type: 'image/webp', size: 1000 })).toBeNull()
    expect(t(L.emojiErrorKey('name_taken'), { name: ':ship_it:' })).toBe('이미 있는 이름입니다 — :ship_it:')
    expect(L.emojiErrorKey('weird' as any)).toBe('chat.settings.emoji.err.failed')
    expect(L.isNameError('name_invalid') && !L.isNameError('too_large')).toBe(true)
  })

  it('PTT 키 표시', () => {
    expect(L.pttKeyLabel('Backquote')).toBe('`')
    expect(L.pttKeyLabel('KeyV')).toBe('V')
    expect(L.pttKeyLabel('F13')).toBe('F13')
  })
})

describe('정책 토글', () => {
  it('(1) 켤 때만 확인 · 취소하면 PUT 없음 · 확인하면 PUT', async () => {
    expect(policyNeedsConfirm('admin_channel_privileges', true)).toBe(true)
    expect(policyNeedsConfirm('admin_channel_privileges', false)).toBe(false)
    expect(policyNeedsConfirm('owner_manage_messages', true)).toBe(false)
    setUser({ id: 'me', username: 'me', display_name: 'me', email: null, is_admin: true } as any)
    api.routes['GET /api/chat/policy'] = () => ({ admin_channel_privileges: false, owner_manage_messages: false, can_edit: true })
    api.routes['PUT /api/chat/policy'] = (o) => ({ admin_channel_privileges: false, owner_manage_messages: false, can_edit: true, ...o.body })
    render(<><PolicySection /><UiDialogHost /></>)
    const sw = await screen.findByRole('switch', { name: new RegExp(t('chat.settings.policy.admin')) })
    fireEvent.click(sw)
    expect(await screen.findByText(t('chat.settings.policy.adminConfirm'))).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.cancel') })) })
    expect(api.calls.some(c => c.opts.method === 'PUT')).toBe(false)
    fireEvent.click(sw)
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: t('chat.settings.policy.adminConfirmOk') })) })
    await waitFor(() => expect(api.calls.find(c => c.opts.method === 'PUT')?.opts.body).toEqual({ admin_channel_privileges: true }))
    // (2) 는 확인 없이 바로
    api.calls = []
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: new RegExp(t('chat.settings.policy.owner')) })) })
    await waitFor(() => expect(api.calls.find(c => c.opts.method === 'PUT')?.opts.body).toEqual({ owner_manage_messages: true }))
  })

  it('404 면 "서버가 아직 지원하지 않음"', async () => {
    api.routes['GET /api/chat/policy'] = () => { throw Object.assign(new Error('nf'), { status: 404 }) }
    render(<PolicySection />)
    expect(await screen.findByText(t('chat.settings.policy.unsupported'))).toBeTruthy()
  })
})

describe('ChatSettingsScreen 틀', () => {
  it('섹션 전환 · Esc 닫기 · 변경 중 닫기는 확인', async () => {
    const { ChatSettingsScreen } = await import('~/components/chat/settings/ChatSettingsScreen')
    const ui = await import('~/composables/useChatUi')
    const { renderInRouter } = await import('../ui/helpers')
    setUser({ id: 'me', username: 'me', display_name: 'me', email: null, is_admin: true } as any)
    api.routes['GET /api/chat/emojis'] = () => ({ items: [], can_manage: true, limit: 200 })
    api.routes['GET /api/chat/roles'] = () => ({ items: [] })
    ui.openChatSettings('emoji')
    renderInRouter(<><ChatSettingsScreen /><UiDialogHost /></>)
    expect(await screen.findByText(t('chat.settings.emoji.title', { n: 0, limit: 200 }))).toBeTruthy()
    expect(await screen.findByText(t('chat.settings.emoji.emptyTitle'))).toBeTruthy()
    // 관리자에게만 정책 메뉴
    expect(screen.getByRole('button', { name: t('chat.settings.nav.policy') })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('chat.settings.nav.voice') }))
    expect(ui.chatUiStore.getState().settings?.section).toBe('voice')
    // 변경 중이면 Esc → 확인 대화 상자
    settingsUiStore.setState({ dirty: true })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(await screen.findByText(t('chat.settings.dirty.closeConfirm'))).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('chat.settings.dirty.closeDiscard') })) })
    await waitFor(() => expect(ui.chatUiStore.getState().settings).toBeNull())
  })
})

describe('개요 · 알림 기본값 · 내 설정', () => {
  it('개요: 404 면 미지원 · 이름 비면 사이트 이름 자리표시 · 저장 = PUT', async () => {
    const { OverviewSection } = await import('~/components/chat/settings/ServerSections')
    const { chatServerStore } = await import('~/components/chat/settings/serverSettingsStore')
    const { siteConfigStore } = await import('~/composables/useSiteConfig')
    siteConfigStore.setState({ appName: '한빛 워크스페이스' })
    api.routes['GET /api/chat/server-settings'] = () => { throw Object.assign(new Error('nf'), { status: 404 }) }
    const r1 = render(<OverviewSection />)
    expect(await screen.findByText(t('chat.settings.server.unsupported'))).toBeTruthy()
    r1.unmount()
    chatServerStore.setState({ settings: null, state: 'idle' })
    api.routes['GET /api/chat/server-settings'] = () => ({ name: null, description: null, default_notify_level: 'all', can_edit: true })
    api.routes['PUT /api/chat/server-settings'] = (o) => ({ name: null, description: null, default_notify_level: 'all', can_edit: true, ...o.body })
    render(<OverviewSection />)
    const name = await screen.findByRole('textbox', { name: t('chat.settings.overview.name') }) as HTMLInputElement
    await waitFor(() => expect(name.disabled).toBe(false))
    expect(name.placeholder).toBe('한빛 워크스페이스')
    fireEvent.change(name, { target: { value: '개발팀 채팅' } })
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: t('common.save') })) })
    expect(api.calls.find(c => c.opts.method === 'PUT')?.opts.body).toEqual({ name: '개발팀 채팅', description: null })
    expect(chatServerStore.getState().settings?.name).toBe('개발팀 채팅')
  })

  it('알림 기본값: 고르면 바로 PUT', async () => {
    const { NotifyDefaultSection } = await import('~/components/chat/settings/ServerSections')
    api.routes['GET /api/chat/server-settings'] = () => ({ name: null, description: null, default_notify_level: 'all', can_edit: true })
    api.routes['PUT /api/chat/server-settings'] = (o) => ({ name: null, description: null, default_notify_level: 'all', can_edit: true, ...o.body })
    render(<NotifyDefaultSection />)
    const opt = await screen.findByRole('radio', { name: new RegExp(t('chat.settings.notifyDefault.mentions')) })
    await act(async () => { fireEvent.click(opt) })
    await waitFor(() => expect(api.calls.find(c => c.opts.method === 'PUT')?.opts.body).toEqual({ default_notify_level: 'mentions' }))
  })

  it('메시지 표시: compact · 묶음 간격 → 개인 설정', async () => {
    const { DisplaySection } = await import('~/components/chat/settings/MySections')
    const { userPrefsStore } = await import('~/composables/useUserPrefs')
    const { renderInRouter } = await import('../ui/helpers')
    renderInRouter(<DisplaySection />)
    fireEvent.click(await screen.findByRole('radio', { name: new RegExp(t('chat.settings.display.compact')) }))
    expect(userPrefsStore.getState().prefs.chatMessageDisplay).toBe('compact')
    fireEvent.click(screen.getByRole('radio', { name: '8px' }))
    expect(userPrefsStore.getState().prefs.chatGroupGap).toBe(8)
  })

  it('프로필: 소개 바꾸고 저장 = PATCH /me/profile', async () => {
    const { ProfileSection } = await import('~/components/chat/settings/MySections')
    const { renderInRouter } = await import('../ui/helpers')
    setUser({ id: 'me', username: 'me', display_name: '나', email: null, is_admin: false } as any)
    api.routes['GET /api/chat/users/me/profile'] = () => ({ id: 'me', bio: '', timezone: 'Asia/Seoul' })
    api.routes['PATCH /api/chat/me/profile'] = (o) => ({ id: 'me', bio: o.body.bio, timezone: o.body.timezone })
    renderInRouter(<ProfileSection />)
    const bio = await screen.findByRole('textbox', { name: t('chat.settings.profile.bio') }) as HTMLTextAreaElement
    await waitFor(() => expect(bio.disabled).toBe(false))
    fireEvent.change(bio, { target: { value: '백엔드 담당' } })
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: t('common.save') })) })
    expect(api.calls.find(c => c.opts.method === 'PATCH')?.opts.body).toEqual({ bio: '백엔드 담당', timezone: 'Asia/Seoul' })
  })

  it('음성: 다른 단축키(Ctrl+Shift+M · D) 표시', async () => {
    const { VoiceSection } = await import('~/components/chat/settings/VoiceSection')
    const { createMemoryRouter, RouterProvider } = await import('react-router')
    const router = createMemoryRouter([{ path: '/', element: <VoiceSection /> }])
    render(<RouterProvider router={router} />)
    await screen.findByText(t('chat.settings.voice.otherKeys'))
    expect(screen.getByText(t('chat.settings.voice.otherKeys'))).toBeTruthy()
    // 음질·장치(접속 줄 팝오버와 같은 내용)도 여기 있다
    expect(screen.getAllByText(t('chat.voice.quality.title')).length).toBeGreaterThan(0)
    expect(screen.getByText(t('chat.settings.voice.muteKey'))).toBeTruthy()
    expect(screen.getByText(t('chat.settings.voice.deafenKey'))).toBeTruthy()
  })
})
