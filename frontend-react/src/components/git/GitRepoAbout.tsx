/**
 * 저장소 정보(모바일 "정보 더보기" 시트 안).
 * 정보(설명) → ★ 스타 · 용량 · 최근 푸시 → 언어 막대 → 클론 카드(HTTPS/SSH 세그먼트 + 점선 mono 주소 + 복사).
 * 언어 막대 = GET /languages 비율. 색은 시안 순서(primary · success · warning), 넷째부터는 "기타"(muted-foreground)로 묶는다.
 * 언어 정보를 못 얻으면 예전처럼 주 언어 하나를 100% 막대로.
 */
import { useState } from 'react'
import { useI18n } from '~/i18n'
import { timeAgo, formatSize } from '~/lib/date'
import { languageSegments, type LanguageSegment } from '~/utils/gitLanguages'
import { useGit } from '~/composables/useGit'
import { addToast } from '~/composables/useToast'
import { UiIcon } from '~/components/ui/Icon'
import { UiSegment } from '~/components/ui/Segment'
import { writeClipboard } from '~/lib/clipboard'

const TONE_BG = { primary: 'bg-primary', success: 'bg-success', warning: 'bg-warning', muted: 'bg-muted-foreground' } as const

/** 저장소 정보 패널(오른쪽 280 · 모바일 시트 안) */
export function GitRepoAbout() {
  const { selectedRepo, branches, languages, repoStats } = useGit()
  const { t } = useI18n()

  const r = selectedRepo
  const segments: LanguageSegment[] = languages.length
    ? languageSegments(languages, t('git.about.otherLanguages'))
    : r?.language ? [{ name: r.language, percent: 100, tone: 'primary' }] : []

  const [proto, setProto] = useState<'https' | 'ssh'>('https')
  const protoItems = [
    { value: 'https', label: 'HTTPS' },
    { value: 'ssh', label: 'SSH', disabled: !r?.ssh_url },
  ]
  const cloneUrl = !r
    ? ''
    : proto === 'ssh' && r.ssh_url
      ? r.ssh_url
      : r.clone_url || `${window.location.origin}/git/${r.owner.login}/${r.name}.git`

  async function copy() {
    try {
      await writeClipboard(cloneUrl)
      addToast('success', t('git.shared.cloneCopied'))
    } catch { addToast('error', t('common.copyFailed')) }
  }

  if (!r) return null
  return (
    <div className="flex flex-col gap-3.5 text-[13px]">
      <div>
        <h2 className="mb-1.5 text-xs font-semibold text-muted-foreground">{t('git.about.info')}</h2>
        {r.description
          ? <p className="leading-relaxed text-foreground">{r.description}</p>
          : <p className="text-muted-foreground">{t('git.pull.noDescription')}</p>}
      </div>

      <div className="flex flex-col gap-1.5 text-muted-foreground">
        <span><UiIcon name="star" className="inline-block h-3 w-3 align-[-1px]" aria-hidden="true" /> <span className="font-mono text-foreground">{r.stars_count}</span> {t('git.about.stars')}</span>
        <span>{t('git.about.size')} <span className="font-mono text-foreground">{formatSize(r.size * 1024)}</span></span>
        {r.updated_at && <span>{t('git.about.lastPush')} <span className="font-mono text-foreground">{timeAgo(r.updated_at)}</span></span>}
        <span>{t('git.branch.label')} <span className="font-mono text-foreground">{repoStats?.branches ?? branches.length}</span></span>
        {repoStats?.tags != null && <span>{t('git.about.tags')} <span className="font-mono text-foreground">{repoStats.tags}</span></span>}
      </div>

      {segments.length > 0 && (
        <div>
          <h2 className="mb-2 text-xs font-semibold text-muted-foreground">{t('git.about.language')}</h2>
          <div className="flex h-2 overflow-hidden rounded-full" aria-hidden="true">
            {segments.map(sg => <span key={sg.name} className={TONE_BG[sg.tone]} style={{ width: `${sg.percent}%` }} />)}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {segments.map(sg => (
              <span key={sg.name}><span className={`mr-1 inline-block h-2 w-2 rounded-full ${TONE_BG[sg.tone]}`} aria-hidden="true" />{sg.name}{languages.length ? ` ${sg.percent}%` : null}</span>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-3">
        <UiSegment modelValue={proto} onUpdateModelValue={v => setProto(v as 'https' | 'ssh')} items={protoItems} size="sm" ariaLabel={t('git.about.cloneMethod')} />
        <div className="mt-2.5 flex h-9 items-center gap-1.5 rounded-md border border-dashed border-input pl-2.5 pr-1 font-mono text-[11px]">
          <span className="min-w-0 flex-1 truncate" title={cloneUrl}>{cloneUrl}</span>
          <button
            type="button"
            className="relative inline-flex h-7 shrink-0 items-center rounded-sm border border-border px-2 font-sans text-xs hover:bg-accent before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            onClick={copy}
          >{t('common.copy')}</button>
        </div>
      </div>
    </div>
  )
}

export default GitRepoAbout
