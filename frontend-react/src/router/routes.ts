// 손으로 관리한다. 처음엔 옛 Vue pages/** 에서 1:1 로 생성했다(생성기·Vue 소스는 2026-11-14 삭제).
// 화면을 이식할 때 이 표는 건드리지 않는다. src/pages/<file> 만 바꾼다.
// layout: Vue definePageMeta 의 layout('default' 기본, false = 셸 없음) · ownMobileHeader · redirect(Vue redirect 메타).
import type { RouteMeta } from '~/lib/router'

export interface AppRouteDef {
  /** React Router 경로(Vue pages 파일 경로에서 만든 것과 같은 URL) */
  path: string
  /** src/pages 아래 파일(= Vue frontend/pages 아래 같은 경로의 .vue) */
  file: string
  layout: Exclude<RouteMeta['layout'], undefined>
  ownMobileHeader?: boolean
  /** 데스크톱에서 공용 상단바를 그리지 않는다 — 페이지 머리가 그 자리를 맡는다(채팅) */
  noDesktopTopbar?: boolean
  /** 페이지 사이드바 하단에 내 계정 패널이 있다 — 레일 맨 아래 아바타를 뺀다 */
  sidebarAccount?: boolean
  redirect?: string
  /** Vue [...slug] 의 파라미터 이름 — useRoute().params[slug] 가 string[] */
  catchAll?: string
  /** 전환(2026-10-17) 뒤 React 에만 새로 생긴 화면 — Vue pages 와 1:1 대조에서 뺀다 */
  reactOnly?: boolean
}

export const ROUTES: AppRouteDef[] = [
  { path: '/activity', file: 'activity.tsx', layout: 'default', ownMobileHeader: true },
  { path: '/admin/ai', file: 'admin/ai.tsx', layout: 'admin' },
  { path: '/admin/ai-ops/*', file: 'admin/ai-ops.tsx', layout: 'admin', reactOnly: true, catchAll: 'tab' },
  { path: '/admin/app-build', file: 'admin/app-build.tsx', layout: 'admin' },
  { path: '/admin/branding', file: 'admin/branding.tsx', layout: 'admin' },
  { path: '/admin/dashboard', file: 'admin/dashboard.tsx', layout: 'admin' },
  { path: '/admin/dashboard-layout', file: 'admin/dashboard-layout.tsx', layout: 'admin', reactOnly: true },
  { path: '/admin/groups', file: 'admin/groups.tsx', layout: 'admin' },
  { path: '/admin', file: 'admin/index.tsx', layout: 'admin', ownMobileHeader: true },
  { path: '/admin/logs', file: 'admin/logs.tsx', layout: 'admin' },
  { path: '/admin/mail', file: 'admin/mail.tsx', layout: 'admin' },
  { path: '/admin/modules', file: 'admin/modules.tsx', layout: 'admin' },
  { path: '/admin/plugins', file: 'admin/plugins.tsx', layout: 'admin', redirect: '/admin/modules' },
  { path: '/admin/rbi', file: 'admin/rbi.tsx', layout: 'admin', reactOnly: true },
  { path: '/admin/security', file: 'admin/security.tsx', layout: 'admin' },
  { path: '/admin/settings', file: 'admin/settings.tsx', layout: 'admin' },
  { path: '/admin/storage', file: 'admin/storage.tsx', layout: 'admin' },
  { path: '/admin/system', file: 'admin/system.tsx', layout: 'admin' },
  { path: '/admin/update/*', file: 'admin/update.tsx', layout: 'admin', reactOnly: true, catchAll: 'view' },
  { path: '/admin/users', file: 'admin/users.tsx', layout: 'admin' },
  { path: '/admin/zones', file: 'admin/zones.tsx', layout: 'admin', reactOnly: true },
  { path: '/ai', file: 'ai.tsx', layout: 'default' },
  { path: '/approvals', file: 'approvals.tsx', layout: 'default', reactOnly: true },
  { path: '/board/:boardId/:postId', file: 'board/[boardId]/[postId].tsx', layout: 'default' },
  { path: '/board/:boardId', file: 'board/[boardId]/index.tsx', layout: 'default' },
  { path: '/board/:boardId/write', file: 'board/[boardId]/write.tsx', layout: 'default', ownMobileHeader: true },
  { path: '/board', file: 'board/index.tsx', layout: 'default', ownMobileHeader: true },
  { path: '/calendar', file: 'calendar.tsx', layout: 'default' },
  { path: '/chat', file: 'chat.tsx', layout: 'default', noDesktopTopbar: true, sidebarAccount: true },
  { path: '/code/*', file: 'code/[...slug].tsx', layout: 'default', catchAll: 'slug' },
  { path: '/consent', file: 'consent.tsx', layout: false },
  { path: '/contacts', file: 'contacts.tsx', layout: 'default', ownMobileHeader: true },
  { path: '/error', file: 'error.tsx', layout: false },
  { path: '/files', file: 'files.tsx', layout: 'default', ownMobileHeader: true },
  { path: '/forgot-password', file: 'forgot-password.tsx', layout: false },
  { path: '/git', file: 'git.tsx', layout: 'default', redirect: '/code' },
  { path: '/', file: 'index.tsx', layout: 'default' },
  { path: '/login', file: 'login.tsx', layout: false },
  { path: '/mail/:id', file: 'mail/[id].tsx', layout: 'default' },
  { path: '/mail/accounts', file: 'mail/accounts.tsx', layout: 'default' },
  { path: '/mail/compose', file: 'mail/compose.tsx', layout: false },
  { path: '/mail', file: 'mail/index.tsx', layout: 'default' },
  { path: '/meetings', file: 'meetings/index.tsx', layout: 'default' },
  { path: '/meetings/join/:token', file: 'meetings/join/[token].tsx', layout: false },
  { path: '/meetings/room/:name', file: 'meetings/room/[name].tsx', layout: false },
  { path: '/office/open', file: 'office/open.tsx', layout: false },
  { path: '/p/:id', file: 'p/[id].tsx', layout: 'default' },
  { path: '/profile', file: 'profile.tsx', layout: 'default', redirect: '/settings/account' },
  { path: '/rbi', file: 'rbi.tsx', layout: 'default', reactOnly: true },
  { path: '/register', file: 'register.tsx', layout: false },
  { path: '/reset-password', file: 'reset-password.tsx', layout: false },
  { path: '/s/:token', file: 's/[token].tsx', layout: false },
  { path: '/settings/account', file: 'settings/account.tsx', layout: 'settings' },
  { path: '/settings/ai', file: 'settings/ai.tsx', layout: 'settings' },
  { path: '/settings/ai/memory', file: 'settings/ai-memory.tsx', layout: 'settings', reactOnly: true },
  { path: '/settings/ai/mcp', file: 'settings/ai-mcp.tsx', layout: 'settings', reactOnly: true },
  { path: '/settings/apps', file: 'settings/apps.tsx', layout: 'settings' },
  { path: '/settings/calendar', file: 'settings/calendar.tsx', layout: 'settings', reactOnly: true },
  { path: '/settings/chat', file: 'settings/chat.tsx', layout: 'settings', reactOnly: true },
  { path: '/settings/display', file: 'settings/display.tsx', layout: 'settings' },
  { path: '/settings', file: 'settings/index.tsx', layout: 'settings' },
  { path: '/settings/mail', file: 'settings/mail.tsx', layout: 'settings' },
  { path: '/settings/notifications', file: 'settings/notifications.tsx', layout: 'settings' },
  { path: '/settings/security', file: 'settings/security.tsx', layout: 'settings' },
  { path: '/setup', file: 'setup.tsx', layout: false },
  { path: '/tasks', file: 'tasks.tsx', layout: 'default', ownMobileHeader: true },
  { path: '/verify-email', file: 'verify-email.tsx', layout: false },
  { path: '/wiki', file: 'wiki.tsx', layout: 'default', ownMobileHeader: true },
]
