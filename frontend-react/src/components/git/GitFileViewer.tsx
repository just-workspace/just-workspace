// Vue 원본: frontend/components/git/GitFileViewer.vue
/**
 * 코드 뷰어.
 *  위: 브랜치 32 + 경로 브레드크럼(저장소 / 폴더 / … / 파일).
 *  카드(rounded-12): 머리 44 bg-card — mono 12 "n줄 · 크기 · 언어" | 줄바꿈 스위치 · [원본] · [복사] · [Gitea ↗] (각 28, 히트 40)
 *  본문 bg-background, mono 13 / 줄 22: 줄 번호 52(오른쪽 맞춤, 패딩 14) — 누르면 그 줄 링크(#L12)가 복사되고 강조,
 *  Shift+클릭 = 범위(#L12-L20). 강조 = warning/0.14 바탕 + 왼쪽 3px warning 바.
 *  아래 안내 12. 1 MB 넘는 파일·바이너리는 "원본 내려받기"만.
 *  구문 색은 토큰: shiki css-variables 테마로 토큰만 받고, 색은 GitFileViewer.css 의 --shiki-* 변수를 우리 토큰에 묶는다
 *  (키워드 primary · 문자열 success · 숫자/상수 warning · 주석 muted-foreground). github-light/dark 고정 폐지.
 */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { useI18n } from '~/i18n'
import { formatSize } from '~/lib/date'
import { cn } from '~/lib/utils'
import { useRoute, useRouter } from '~/lib/router'
import { parseLineHash, lineHash } from '~/utils/gitRoute'
import { gitStore, useGit, type FileContent } from '~/composables/useGit'
import { addToast } from '~/composables/useToast'
import { UiIcon } from '~/components/ui/Icon'
import { UiSwitch } from '~/components/ui/Switch'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { GitBranchSelector } from './GitBranchSelector'
import { GitPathCrumbs } from './GitPathCrumbs'
import { UiTrans } from '~/components/ui/Trans'
import './GitFileViewer.css'
import { writeClipboard } from '~/lib/clipboard'

export interface GitFileViewerProps {
  /** 파일 경로 */
  path: string
}

interface Tok { content: string; color?: string; fontStyle?: number }

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
  cs: 'csharp', css: 'css', scss: 'scss', less: 'less',
  html: 'html', vue: 'vue', svelte: 'svelte',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
  md: 'markdown', dockerfile: 'dockerfile',
  makefile: 'makefile', nginx: 'nginx',
  env: 'dotenv', ini: 'ini', conf: 'ini',
}
// 머리의 언어 이름(시안 "TypeScript")
const LANG_NAME: Record<string, string> = {
  typescript: 'TypeScript', tsx: 'TSX', javascript: 'JavaScript', jsx: 'JSX', python: 'Python', rust: 'Rust', go: 'Go',
  java: 'Java', c: 'C', cpp: 'C++', ruby: 'Ruby', php: 'PHP', swift: 'Swift', kotlin: 'Kotlin', csharp: 'C#',
  css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML', vue: 'Vue', svelte: 'Svelte', json: 'JSON', yaml: 'YAML',
  toml: 'TOML', xml: 'XML', sql: 'SQL', bash: 'Shell', markdown: 'Markdown', dockerfile: 'Dockerfile',
  makefile: 'Makefile', nginx: 'Nginx', dotenv: 'dotenv', ini: 'INI',
}
export function detectLang(filename: string): string {
  const name = filename.toLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  return EXT_LANG[ext] || 'text'
}

function rawLinesOf(f: FileContent | null) {
  return (f?.content ?? '').replace(/\n$/, '').split('\n')
}

let cssTheme: any = null

function tokStyle(tk: Tok): CSSProperties | undefined {
  if (!tk.color && !tk.fontStyle) return undefined
  const s: CSSProperties = {}
  if (tk.color) s.color = tk.color
  if (tk.fontStyle && tk.fontStyle & 1) s.fontStyle = 'italic'
  if (tk.fontStyle && tk.fontStyle & 2) s.fontWeight = '600'
  return s
}

const BTN = "relative inline-flex h-7 shrink-0 items-center rounded-sm border border-border px-2.5 text-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"

/** 파일 보기(코드 뷰어) */
export function GitFileViewer({ path }: GitFileViewerProps) {
  const { fileContent, fileLoading, fileError, selectedRepo, currentBranch, openFile } = useGit()
  const route = useRoute()
  const router = useRouter()
  const { t } = useI18n()

  const [lines, setLines] = useState<Tok[][]>([])
  const [highlighting, setHighlighting] = useState(false)
  const [wrap, setWrap] = useState(false)

  const lineCount = fileContent?.content ? rawLinesOf(fileContent).length : 0

  // watch(fileContent, highlight, { immediate: true })
  useEffect(() => {
    const f = fileContent
    if (!f?.content) { setLines([]); return }
    // 일단 평문으로 그려 두고(즉시 보이게) 색은 이어서 입힌다
    setLines(rawLinesOf(f).map(l => [{ content: l }]))
    const lang = detectLang(f.name)
    if (lang === 'text' || f.content.length > 400_000) return
    setHighlighting(true)
    void (async () => {
      try {
        const shiki = await import('shiki')
        cssTheme ??= shiki.createCssVariablesTheme({ name: 'jw-tokens', variablePrefix: '--shiki-', fontStyle: true })
        const res = await shiki.codeToTokens(f.content!.replace(/\n$/, ''), { lang: lang as any, theme: cssTheme })
        if (gitStore.getState().fileContent !== f) return
        setLines(res.tokens.map(row => row.map(tk => ({ content: tk.content, color: tk.color, fontStyle: tk.fontStyle }))))
      } catch { /* 모르는 언어 — 평문 유지 */ }
      finally { setHighlighting(false) }
    })()
  }, [fileContent])

  // ── 줄 선택(#L12 · #L12-L20) ──
  const sel = parseLineHash(route.hash)
  const anchorLine = useRef<number | null>(null)
  function selectLine(n: number, e: MouseEvent) {
    const range = e.shiftKey && anchorLine.current ? lineHash(anchorLine.current, n) : lineHash(n)
    if (!e.shiftKey) anchorLine.current = n
    void router.replace({ query: route.query, hash: range })
    // 줄 링크 복사(시안 안내: "줄 번호를 누르면 #L12 링크가 복사되고 그 줄이 강조됩니다")
    const url = `${window.location.origin}${route.path}${window.location.search}${range}`
    writeClipboard(url).then(
      () => addToast('success', t('git.file.lineCopied', { range: range.slice(1) })),
      () => addToast('error', t('common.copyFailed')),
    )
  }
  function isSel(n: number) {
    return !!sel && n >= sel[0] && n <= sel[1]
  }
  // 처음 열 때(그리고 해시가 바뀔 때) 선택 줄로 스크롤
  const selStart = sel?.[0] ?? null
  useEffect(() => {
    if (!lines.length || selStart == null) return
    document.getElementById(`L${selStart}`)?.scrollIntoView({ block: 'center' })
  }, [lines, route.hash, selStart])

  async function copyAll() {
    try {
      await writeClipboard(gitStore.getState().fileContent?.content ?? '')
      addToast('success', t('git.file.copied'))
    } catch { addToast('error', t('common.copyFailed')) }
  }

  const encPath = path.split('/').map(encodeURIComponent).join('/')
  const branchSeg = encodeURIComponent(currentBranch || selectedRepo?.default_branch || '')
  const rawUrl = selectedRepo ? `${selectedRepo.html_url}/raw/branch/${branchSeg}/${encPath}` : ''
  // Gitea 에서 열기 — 지금 강조한 줄 범위를 그대로 넘긴다(Gitea 도 #L12-L20 형식)
  const giteaUrl = selectedRepo ? `${selectedRepo.html_url}/src/branch/${branchSeg}/${encPath}${sel ? lineHash(sel[0], sel[1]) : ''}` : ''
  const langName = (() => {
    if (!fileContent) return ''
    const l = detectLang(fileContent.name)
    return l === 'text' ? '' : (LANG_NAME[l] || '')
  })()
  const metaLine = fileContent
    ? [lineCount ? t('git.file.lines', { n: lineCount }) : '', formatSize(fileContent.size), langName].filter(Boolean).join(' · ')
    : ''

  return (
    // 코드 상자가 남은 높이를 채우고(안에서 스크롤) 안내문은 그 아래 고정
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4 md:px-6">
        <div className="flex shrink-0 items-center gap-2 text-[13px]">
          <GitBranchSelector />
          <GitPathCrumbs path={path} className="flex-1" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
          {/* 머리 44. 모바일은 메타 줄이 잘리지 않게 두 줄(메타 / 줄바꿈·원본·복사·Gitea) */}
          <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border bg-card py-2 pl-3.5 pr-2 text-xs text-muted-foreground sm:h-11 sm:flex-nowrap sm:py-0">
            <span className="min-w-0 font-mono max-sm:w-full sm:truncate">{metaLine}</span>
            <span className="flex-1 max-sm:hidden" />
            <UiSwitch modelValue={wrap} onUpdateModelValue={setWrap} label={t('git.file.wrap')} className="shrink-0 gap-1.5 max-sm:mr-auto" />
            {rawUrl && <a href={rawUrl} target="_blank" rel="noopener" className={BTN}>{t('git.file.raw')}</a>}
            <button type="button" disabled={!fileContent?.content} className={cn(BTN, 'gap-1.5')} onClick={() => { void copyAll() }}>
              <UiIcon name="copy" className="h-[13px] w-[13px]" />{t('common.copy')}
            </button>
            {giteaUrl && (
              <a href={giteaUrl} target="_blank" rel="noopener" aria-label={t('git.file.openGitea')} className={cn(BTN, 'gap-1')}>
                Gitea<UiIcon name="external-link" strokeWidth={2.2} className="h-3 w-3" />
              </a>
            )}
          </div>

          {fileLoading ? (
            <UiSkeleton preset="text" rows={8} className="bg-background p-4" />
          ) : fileError ? (
            <UiErrorTile
              placement="panel"
              title={fileError === 'notfound' ? t('git.file.notFound') : t('git.file.loadFailed')}
              noRetry={fileError === 'notfound'}
              onRetry={() => { void openFile(path) }}
            />
          ) : fileContent?.too_large ? (
            <UiEmptyState
              variant="panel"
              icon="file-text"
              title={t('git.file.tooLarge')}
              actionLabel={t('git.file.downloadRaw')}
              actionTo={rawUrl}
            />
          ) : !fileContent?.content ? (
            <UiEmptyState
              variant="panel"
              icon="file-text"
              title={t('git.file.emptyOrBinary')}
              actionLabel={rawUrl ? t('git.file.downloadRaw') : undefined}
              actionTo={rawUrl || undefined}
            />
          ) : (
            /* 코드: 줄 번호 52 + 토큰 */
            <div className="git-code min-h-0 flex-1 overflow-auto bg-background py-2 font-mono text-[13px] leading-[22px]" aria-busy={highlighting}>
              <table className="w-full border-collapse">
                <tbody>
                  {lines.map((row, i) => (
                    <tr
                      id={`L${i + 1}`}
                      key={i}
                      className={isSel(i + 1) ? 'bg-warning/[0.14] shadow-[inset_3px_0_0_hsl(var(--warning))]' : ''}
                    >
                      {/* td 기본 패딩 1px 이 줄 높이를 24 로 만들던 것 — py-0 으로 시안 22 */}
                      <td className={cn('sticky left-0 w-[52px] min-w-[52px] select-none whitespace-nowrap py-0 pl-0 pr-3.5 text-right align-top', isSel(i + 1) ? '' : 'bg-background')}>
                        <a
                          href={lineHash(i + 1)}
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={t('git.file.lineLink', { n: i + 1 })}
                          onClick={(e) => { e.preventDefault(); selectLine(i + 1, e) }}
                        >{i + 1}</a>
                      </td>
                      <td className={cn('py-0 pl-0 pr-4 align-top text-foreground', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
                        {row.map((tk, j) => <span key={j} style={tokStyle(tk)}>{tk.content}</span>)}
                        {(!row.length || (row.length === 1 && !row[0].content)) && '​'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="shrink-0 text-xs text-muted-foreground [word-break:keep-all]">
          <UiTrans
            k="git.file.hint"
            slots={{
              one: <span className="font-mono">#L12</span>,
              range: <span className="font-mono">#L12-L15</span>,
            }}
          />
        </p>
      </div>
    </div>
  )
}

export default GitFileViewer
