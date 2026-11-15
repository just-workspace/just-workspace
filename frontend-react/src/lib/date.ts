import { i18n } from '~/i18n'

/**
 * Relative time formatting (e.g., "3분 전", "2시간 전")
 */
export function timeAgo(dateStr: string): string {
  const now = Date.now()
  const past = new Date(dateStr).getTime()
  if (isNaN(past)) return ''

  // 문구는 i18n(현재 로캘) — 템플릿 렌더 중 불리면 로캘 전환에 반응
  const { t } = i18n
  const diff = Math.floor((now - past) / 1000)
  if (diff < 60) return t('date.justNow')
  if (diff < 3600) return t('common.minutesAgo', { n: Math.floor(diff / 60) })
  if (diff < 86400) return t('common.hoursAgo', { n: Math.floor(diff / 3600) })
  if (diff < 2592000) return t('common.daysAgo', { n: Math.floor(diff / 86400) })
  if (diff < 31536000) return t('date.monthsAgo', { n: Math.floor(diff / 2592000) })
  return t('date.yearsAgo', { n: Math.floor(diff / 31536000) })
}

/**
 * Human-readable file size (e.g., "1.5 GB")
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`
}
