/**
 * Git(시안 GT1~GT4 · GTM1·GTM2 · 결정 Git 1~6) 상태 — Vue 판 composables/useGit.ts 그대로(모듈 싱글턴).
 * 화면은 라우트(utils/gitRoute)가 정하고, 이 store 는 "라우트가 가리키는 데이터"만 불러 둔다(딥링크·뒤로 가기·새로고침이 같은 화면).
 * 각 목록은 loading·error 를 따로 가진다(실패를 빈 목록으로 보이지 않게 — 시안 H).
 *
 * React: const { repos, selectedRepo, fetchRepos, ... } = useGit()   (값은 .value 없이)
 *   Vue 에서 바깥이 대입하던 상태(searchQuery · issueState · labelFilter · pullState)는 setter 를 같이 쓴다:
 *   setSearchQuery · setIssueState · setLabelFilter · setPullState
 * 컴포넌트 밖: gitStore.getState() / fetchRepos() 등 모듈 함수 import
 */
import { createStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { useTrackedStore } from '~/composables/useTrackedStore'

export interface RepoOwner {
  login: string
  avatar_url: string
}

export interface RepoSummary {
  id: number
  name: string
  full_name: string
  description: string
  owner: RepoOwner
  html_url: string
  default_branch: string
  stars_count: number
  forks_count: number
  open_issues_count: number
  updated_at: string
  language: string
  private: boolean
}

export interface RepoDetail extends RepoSummary {
  readme: string | null
  size: number
  created_at: string
  clone_url?: string
  ssh_url?: string
}

export interface LastCommit {
  sha: string
  message: string
  author_name: string
  date: string
}

export interface ContentEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  size: number
  sha: string
  /** 항목별 마지막 커밋(contents?with_commits=true — 목록을 먼저 그린 뒤 따로 받아 채운다) */
  last_commit?: LastCommit | null
}

/** GET /languages 항목(큰 순) */
export interface RepoLanguage {
  name: string
  bytes: number
  percent: number
}

/** GET /stats — 못 얻은 값은 null */
export interface RepoStats {
  tags: number | null
  open_issues: number | null
  closed_issues: number | null
  open_pulls: number | null
  closed_pulls: number | null
  commits: number | null
  branches: number | null
}

/** 이슈 수정(PATCH /issues/{n}) — 준 필드만 바뀐다. assignees 는 Gitea 로그인 이름([] = 담당 해제) */
export interface IssuePatch {
  title?: string
  body?: string
  state?: 'open' | 'closed'
  assignees?: string[]
}

export interface FileContent {
  name: string
  path: string
  size: number
  sha: string
  content: string | null
  too_large: boolean
}

export interface Branch {
  name: string
  commit_sha: string
  commit_message: string
}

export interface CommitEntry {
  sha: string
  message: string
  author: { name: string; email: string; date: string } | null
  committer: { name: string; email: string; date: string } | null
  html_url: string
}

export interface IssueUser {
  login: string
  avatar_url: string
}

export interface Label {
  id: number
  name: string
  color: string
}

export interface Issue {
  number: number
  title: string
  body: string
  state: string
  user: IssueUser | null
  labels: Label[]
  /** 백엔드가 담당자를 내려 주기 시작한 뒤부터(없으면 빈 배열) */
  assignees?: IssueUser[]
  comments: number
  created_at: string
  updated_at: string
}

export interface IssueComment {
  id: number
  body: string
  user: IssueUser | null
  created_at: string
  updated_at: string
}

export interface PullRequest {
  number: number
  title: string
  body: string
  state: string
  user: IssueUser | null
  labels: Label[]
  head_branch: string
  base_branch: string
  mergeable: boolean | null
  merged: boolean
  comments: number
  created_at: string
  updated_at: string
}

export type LoadError = 'notfound' | 'error' | null

function errKind(e: any): LoadError {
  const s = e?.status ?? e?.statusCode ?? e?.response?.status
  return s === 404 ? 'notfound' : 'error'
}

// ── 모듈 싱글턴 상태 ──
export interface GitState {
  repos: RepoSummary[]
  reposTotal: number
  reposLoading: boolean
  reposError: boolean
  searchQuery: string

  selectedRepo: RepoDetail | null
  repoLoading: boolean
  repoError: LoadError
  branches: Branch[]
  currentBranch: string
  latestCommit: CommitEntry | null
  languages: RepoLanguage[]
  repoStats: RepoStats | null
  /** 내 스타 여부 — null = 모름(아직 못 읽음), unavailable = Gitea 계정이 없어(409) 쓸 수 없음 */
  starred: boolean | null
  starUnavailable: boolean

  contents: ContentEntry[]
  contentsLoading: boolean
  contentsError: LoadError
  currentPath: string

  fileContent: FileContent | null
  fileLoading: boolean
  fileError: LoadError

  commits: CommitEntry[]
  commitsLoading: boolean
  commitsError: boolean
  commitsPage: number
  commitsHasMore: boolean

  issues: Issue[]
  issuesLoading: boolean
  issuesError: boolean
  issueState: 'open' | 'closed'
  labels: Label[]
  labelFilter: number[]
  selectedIssue: Issue | null
  issueComments: IssueComment[]
  issueLoading: boolean
  issueError: LoadError

  pulls: PullRequest[]
  pullsLoading: boolean
  pullsError: boolean
  pullState: 'open' | 'closed'
  selectedPull: PullRequest | null
  pullLoading: boolean
  pullError: LoadError
}

function initialState(): GitState {
  return {
    repos: [], reposTotal: 0, reposLoading: false, reposError: false, searchQuery: '',
    selectedRepo: null, repoLoading: false, repoError: null, branches: [], currentBranch: '', latestCommit: null,
    languages: [], repoStats: null, starred: null, starUnavailable: false,
    contents: [], contentsLoading: false, contentsError: null, currentPath: '',
    fileContent: null, fileLoading: false, fileError: null,
    commits: [], commitsLoading: false, commitsError: false, commitsPage: 1, commitsHasMore: false,
    issues: [], issuesLoading: false, issuesError: false, issueState: 'open', labels: [], labelFilter: [],
    selectedIssue: null, issueComments: [], issueLoading: false, issueError: null,
    pulls: [], pullsLoading: false, pullsError: false, pullState: 'open', selectedPull: null, pullLoading: false, pullError: null,
  }
}

export const gitStore = createStore<GitState>()(() => initialState())

const get = () => gitStore.getState()
const set = (p: Partial<GitState>) => gitStore.setState(p)

// 빠르게 라우트를 옮길 때 늦게 온 응답이 앞 화면을 덮지 않게 — 자원별 요청 번호
const seq: Record<string, number> = {}
function ticket(k: string) { seq[k] = (seq[k] ?? 0) + 1; return seq[k] }
function stale(k: string, n: number) { return seq[k] !== n }

const PAGE = 30 // Gitea 기본 페이지 크기

/** 테스트용 — 상태를 처음으로 */
export function _resetGitStore() {
  gitStore.setState(initialState(), true)
  for (const k of Object.keys(seq)) delete seq[k]
}

// Vue 에서 바깥이 직접 대입하던 상태
export function setSearchQuery(v: string) { set({ searchQuery: v }) }
export function setIssueState(v: 'open' | 'closed') { set({ issueState: v }) }
export function setLabelFilter(v: number[]) { set({ labelFilter: v }) }
export function setPullState(v: 'open' | 'closed') { set({ pullState: v }) }

function repoBase() {
  const r = get().selectedRepo
  return r ? `/api/git/repos/${encodeURIComponent(r.owner.login)}/${encodeURIComponent(r.name)}` : ''
}

// ─── 저장소 목록 ───
export async function fetchRepos(page = 1) {
  const n = ticket('repos')
  set({ reposLoading: true, reposError: false })
  try {
    const data = await $fetch<{ repos: RepoSummary[]; total: number }>('/api/git/repos', {
      params: { query: get().searchQuery, page, limit: 20, sort: 'updated' },
    })
    if (stale('repos', n)) return
    set({ repos: data.repos, reposTotal: data.total })
  } catch {
    if (stale('repos', n)) return
    set({ repos: [], reposTotal: 0, reposError: true })
  } finally {
    if (!stale('repos', n)) set({ reposLoading: false })
  }
}

// ─── 저장소(라우트가 바뀔 때마다 부르되, 같은 저장소면 다시 받지 않는다) ───
export async function ensureRepo(owner: string, repo: string, ref?: string | null) {
  const s = get()
  const same = s.selectedRepo
    && s.selectedRepo.owner.login.toLowerCase() === owner.toLowerCase()
    && s.selectedRepo.name.toLowerCase() === repo.toLowerCase()
  if (same && !s.repoError) {
    if (ref && ref !== s.currentBranch) { set({ currentBranch: ref }); void fetchLatestCommit() }
    return
  }
  const n = ticket('repo')
  set({
    repoLoading: true, repoError: null, selectedRepo: null,
    contents: [], fileContent: null, commits: [], issues: [], pulls: [],
    selectedIssue: null, selectedPull: null, latestCommit: null,
    languages: [], repoStats: null, starred: null, starUnavailable: false,
    labelFilter: [], issueState: 'open', pullState: 'open',
  })
  try {
    const data = await $fetch<RepoDetail>(`/api/git/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
    if (stale('repo', n)) return
    set({ selectedRepo: data, currentBranch: ref || data.default_branch })
    // 언어·총수·스타는 화면을 막지 않는다(실패해도 그 부분만 숨김)
    void fetchLanguages(); void fetchStats(); void fetchStar()
    await Promise.all([fetchBranches(), fetchLabels(), fetchLatestCommit()])
  } catch (e) {
    if (stale('repo', n)) return
    set({ repoError: errKind(e) })
  } finally {
    if (!stale('repo', n)) set({ repoLoading: false })
  }
}

export function setBranch(ref: string) {
  if (ref === get().currentBranch) return
  set({ currentBranch: ref })
  void fetchLatestCommit()
}

export async function fetchBranches() {
  const base = repoBase()
  if (!base) return
  try { set({ branches: await $fetch<Branch[]>(`${base}/branches`) }) }
  catch { set({ branches: [] }) }
}

export async function fetchLatestCommit() {
  const base = repoBase()
  if (!base) return
  const n = ticket('latest')
  try {
    const data = await $fetch<CommitEntry[]>(`${base}/commits`, { params: { sha: get().currentBranch || undefined, page: 1 } })
    if (!stale('latest', n)) set({ latestCommit: data[0] || null })
  } catch { if (!stale('latest', n)) set({ latestCommit: null }) }
}

// ─── 언어 · 총수 · 스타 ───
export async function fetchLanguages() {
  const base = repoBase()
  if (!base) return
  try { set({ languages: (await $fetch<{ languages: RepoLanguage[] }>(`${base}/languages`)).languages || [] }) }
  catch { set({ languages: [] }) }
}

export async function fetchStats() {
  const base = repoBase()
  if (!base) return
  try { set({ repoStats: await $fetch<RepoStats>(`${base}/stats`) }) }
  catch { set({ repoStats: null }) }
}

export async function fetchStar() {
  const base = repoBase()
  if (!base) return
  try {
    set({ starred: (await $fetch<{ starred: boolean }>(`${base}/star`)).starred, starUnavailable: false })
  } catch (e: any) {
    set({ starred: null, starUnavailable: (e?.status ?? e?.statusCode) === 409 })
  }
}

/** 스타 켜기/끄기. 409(Gitea 계정 없음)면 'unavailable' 을 돌려준다 — 화면이 안내한다 */
export async function toggleStar(): Promise<'ok' | 'unavailable'> {
  const base = repoBase()
  const r = get().selectedRepo
  if (!base || !r) return 'ok'
  const next = !get().starred
  try {
    const res = await $fetch<{ starred: boolean; stars_count: number | null }>(`${base}/star`, { method: next ? 'PUT' : 'DELETE' })
    const count = res.stars_count ?? Math.max(0, r.stars_count + (next ? 1 : -1))
    set({ starred: res.starred, starUnavailable: false, selectedRepo: { ...r, stars_count: count } })
    return 'ok'
  } catch (e: any) {
    if ((e?.status ?? e?.statusCode) === 409) { set({ starUnavailable: true }); return 'unavailable' }
    throw e
  }
}

// ─── 코드 ───
export async function fetchContents(path = '') {
  const base = repoBase()
  if (!base) return
  const n = ticket('contents')
  set({ contentsLoading: true, contentsError: null, currentPath: path })
  try {
    const params: Record<string, string> = {}
    if (path) params.path = path
    const branch = get().currentBranch
    if (branch) params.ref = branch
    const data = await $fetch<ContentEntry[]>(`${base}/contents`, { params })
    if (stale('contents', n)) return
    // 폴더 먼저, 이름순
    set({
      contents: [...data].sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1
        if (a.type !== 'dir' && b.type === 'dir') return 1
        return a.name.localeCompare(b.name)
      }),
    })
    // 항목별 마지막 커밋은 항목마다 Gitea 조회가 들어 느리다 — 목록을 먼저 보이고 뒤에서 채운다
    void fillLastCommits(base, params, n)
  } catch (e) {
    if (stale('contents', n)) return
    set({ contents: [], contentsError: errKind(e) })
  } finally {
    if (!stale('contents', n)) set({ contentsLoading: false })
  }
}

async function fillLastCommits(base: string, params: Record<string, string>, n: number) {
  try {
    const data = await $fetch<ContentEntry[]>(`${base}/contents`, { params: { ...params, with_commits: 'true' } })
    if (stale('contents', n)) return
    const by = new Map(data.map(e => [e.path, e.last_commit ?? null]))
    set({ contents: get().contents.map(e => ({ ...e, last_commit: by.get(e.path) ?? null })) })
  } catch { /* 세 번째 칸만 빈다 */ }
}

export async function openFile(path: string) {
  const base = repoBase()
  if (!base) return
  const n = ticket('file')
  set({ fileLoading: true, fileError: null, currentPath: path })
  try {
    const params: Record<string, string> = { path }
    const branch = get().currentBranch
    if (branch) params.ref = branch
    const data = await $fetch<FileContent>(`${base}/file`, { params })
    if (stale('file', n)) return
    set({ fileContent: data })
  } catch (e) {
    if (stale('file', n)) return
    set({ fileContent: null, fileError: errKind(e) })
  } finally {
    if (!stale('file', n)) set({ fileLoading: false })
  }
}

// ─── 커밋(더 보기 = 다음 페이지 이어 붙이기) ───
export async function fetchCommits(page = 1) {
  const base = repoBase()
  if (!base) return
  const n = ticket('commits')
  set({ commitsLoading: true, commitsError: false })
  try {
    const data = await $fetch<CommitEntry[]>(`${base}/commits`, { params: { sha: get().currentBranch || undefined, page } })
    if (stale('commits', n)) return
    set({
      commits: page === 1 ? data : [...get().commits, ...data],
      commitsPage: page,
      commitsHasMore: data.length >= PAGE,
    })
  } catch {
    if (stale('commits', n)) return
    if (page === 1) set({ commits: [] })
    set({ commitsError: true })
  } finally {
    if (!stale('commits', n)) set({ commitsLoading: false })
  }
}

// ─── 이슈 ───
export async function fetchIssues(page = 1) {
  const base = repoBase()
  if (!base) return
  const n = ticket('issues')
  set({ issuesLoading: true, issuesError: false })
  try {
    const { issueState, labelFilter } = get()
    const data = await $fetch<Issue[]>(`${base}/issues`, {
      params: { state: issueState, page, labels: labelFilter.length ? labelFilter.join(',') : undefined },
    })
    if (stale('issues', n)) return
    set({ issues: data })
  } catch {
    if (stale('issues', n)) return
    set({ issues: [], issuesError: true })
  } finally {
    if (!stale('issues', n)) set({ issuesLoading: false })
  }
}

export async function loadIssue(index: number) {
  const base = repoBase()
  if (!base) return
  if (get().selectedIssue?.number === index && !get().issueError) return
  const n = ticket('issue')
  // 목록에 있으면 먼저 그려 둔다(댓글만 기다리게)
  set({
    issueLoading: true, issueError: null,
    selectedIssue: get().issues.find(i => i.number === index) ?? null,
    issueComments: [],
  })
  try {
    const [issue, comments] = await Promise.all([
      $fetch<Issue>(`${base}/issues/${index}`),
      $fetch<IssueComment[]>(`${base}/issues/${index}/comments`),
    ])
    if (stale('issue', n)) return
    set({ selectedIssue: issue, issueComments: comments })
  } catch (e) {
    if (stale('issue', n)) return
    set({ selectedIssue: null, issueError: errKind(e) })
  } finally {
    if (!stale('issue', n)) set({ issueLoading: false })
  }
}

export function clearIssue() { ticket('issue'); set({ selectedIssue: null, issueComments: [], issueError: null, issueLoading: false }) }

export async function createIssue(title: string, body: string, labelIds: number[] = []) {
  const base = repoBase()
  if (!base) return null
  const created = await $fetch<Issue>(`${base}/issues`, { method: 'POST', body: { title, body, labels: labelIds } })
  await fetchIssues()
  return created
}

/** 이슈 수정 — 제목·본문·닫기/다시 열기·담당. 목록과 상세를 함께 맞춘다 */
export async function updateIssue(index: number, patch: IssuePatch) {
  const base = repoBase()
  if (!base) return null
  const s0 = get()
  const prevState = (s0.selectedIssue?.number === index ? s0.selectedIssue : s0.issues.find(x => x.number === index))?.state
  const updated = await $fetch<Issue>(`${base}/issues/${index}`, { method: 'PATCH', body: patch })
  const s = get()
  if (s.selectedIssue?.number === index) set({ selectedIssue: updated })
  const i = s.issues.findIndex(x => x.number === index)
  if (i >= 0) {
    // 상태가 바뀌면 지금 보고 있는 목록(열림/닫힘)에서 빠진다
    if (patch.state && updated.state !== s.issueState) set({ issues: s.issues.filter(x => x.number !== index) })
    else set({ issues: s.issues.map((x, j) => (j === i ? updated : x)) })
  }
  if (patch.state && prevState && prevState !== updated.state) {
    const r = get().selectedRepo
    if (r) set({ selectedRepo: { ...r, open_issues_count: Math.max(0, r.open_issues_count + (patch.state === 'open' ? 1 : -1)) } })
    void fetchStats()
  }
  return updated
}

// ─── 라벨 ───
export async function fetchLabels() {
  const base = repoBase()
  if (!base) return
  try { set({ labels: await $fetch<Label[]>(`${base}/labels`) }) }
  catch { set({ labels: [] }) }
}

// 이슈의 라벨을 통째로 교체한다(PATCH 1회 — 체크마다 요청하지 않는다)
export async function setIssueLabels(index: number, labelIds: number[]) {
  const base = repoBase()
  if (!base) return
  const updated = await $fetch<Issue>(`${base}/issues/${index}/labels`, { method: 'PATCH', body: { labels: labelIds } })
  // 목록과 상세를 함께 갱신 — 목록으로 돌아갔을 때 값이 어긋나지 않게
  const s = get()
  if (s.selectedIssue?.number === index) set({ selectedIssue: { ...updated, assignees: updated.assignees ?? s.selectedIssue.assignees } })
  const i = s.issues.findIndex(x => x.number === index)
  if (i >= 0) set({ issues: s.issues.map((x, j) => (j === i ? updated : x)) })
}

export async function createLabel(name: string) {
  const base = repoBase()
  if (!base) return null
  const created = await $fetch<Label>(`${base}/labels`, { method: 'POST', body: { name } })
  set({ labels: [...get().labels, created] })
  return created
}

/** 라벨별 열린 이슈 수 — 드롭다운 우측 mono 숫자 */
export function computeLabelCounts(issues: ReadonlyArray<Issue>): Map<number, number> {
  const m = new Map<number, number>()
  for (const i of issues)
    if (i.state === 'open')
      for (const l of i.labels) m.set(l.id, (m.get(l.id) ?? 0) + 1)
  return m
}

export function labelById(id: number): Label {
  return get().labels.find(l => l.id === id) || { id, name: '?', color: '888888' }
}

export async function addIssueComment(index: number, body: string) {
  const base = repoBase()
  if (!base) return
  const comment = await $fetch<IssueComment>(`${base}/issues/${index}/comments`, { method: 'POST', body: { body } })
  set({ issueComments: [...get().issueComments, comment] })
  const sel = get().selectedIssue
  if (sel?.number === index) set({ selectedIssue: { ...sel, comments: sel.comments + 1 } })
}

// ─── PR(읽기 전용 — 리뷰·머지·diff 는 Gitea) ───
export async function fetchPulls(page = 1) {
  const base = repoBase()
  if (!base) return
  const n = ticket('pulls')
  set({ pullsLoading: true, pullsError: false })
  try {
    const data = await $fetch<PullRequest[]>(`${base}/pulls`, { params: { state: get().pullState, page } })
    if (stale('pulls', n)) return
    set({ pulls: data })
  } catch {
    if (stale('pulls', n)) return
    set({ pulls: [], pullsError: true })
  } finally {
    if (!stale('pulls', n)) set({ pullsLoading: false })
  }
}

export async function loadPull(index: number) {
  const base = repoBase()
  if (!base) return
  if (get().selectedPull?.number === index && !get().pullError) return
  const n = ticket('pull')
  set({ pullLoading: true, pullError: null, selectedPull: get().pulls.find(p => p.number === index) ?? null })
  try {
    const data = await $fetch<PullRequest>(`${base}/pulls/${index}`)
    if (stale('pull', n)) return
    set({ selectedPull: data })
  } catch (e) {
    if (stale('pull', n)) return
    set({ selectedPull: null, pullError: errKind(e) })
  } finally {
    if (!stale('pull', n)) set({ pullLoading: false })
  }
}

export function clearPull() { ticket('pull'); set({ selectedPull: null, pullError: null, pullLoading: false }) }

const actions = {
  setSearchQuery,
  setIssueState,
  setLabelFilter,
  setPullState,
  fetchRepos,
  ensureRepo,
  setBranch,
  fetchBranches,
  fetchContents,
  openFile,
  fetchCommits,
  fetchIssues,
  loadIssue,
  clearIssue,
  createIssue,
  updateIssue,
  toggleStar,
  fetchStats,
  fetchLabels,
  setIssueLabels,
  createLabel,
  labelById,
  addIssueComment,
  fetchPulls,
  loadPull,
  clearPull,
}

type GitHook = Readonly<GitState> & typeof actions & { readonly labelCounts: Map<number, number> }

// labelCounts(Vue computed) — 같은 issues 배열이면 다시 세지 않는다
const countsCache = new WeakMap<ReadonlyArray<Issue>, Map<number, number>>()
function labelCountsOf(issues: ReadonlyArray<Issue>) {
  let m = countsCache.get(issues)
  if (!m) { m = computeLabelCounts(issues); countsCache.set(issues, m) }
  return m
}

/** Vue useGit() 과 같은 멤버(값은 렌더 시점 값). 읽은 필드만 구독한다(useTrackedStore). */
export function useGit(): GitHook {
  const { track } = useTrackedStore(gitStore)
  const out = { ...actions } as GitHook
  for (const k of Object.keys(initialState()) as (keyof GitState)[]) {
    Object.defineProperty(out, k, { get: () => track(k), enumerable: true })
  }
  Object.defineProperty(out, 'labelCounts', { get: () => labelCountsOf(track('issues')), enumerable: true })
  return out
}
