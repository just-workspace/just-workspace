/**
 * 파일 유형 아이콘(Vue components/files/FileTypeIcon.vue · 시안 06-1 결정 8): 모양 + 색 토큰, aria-label = 유형 이름.
 * 목록·그리드·상세·시트 공용. 모양은 공용 아이콘 세트(utils/icons: file-sheet·file-slide·file-pdf·file-zip …).
 * UiIcon 은 aria-hidden 이라 role=img 로 직접 그린다. 크기는 className(h-/w-)으로.
 */
import type { SVGAttributes } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { fileKind, KIND_META, type FileKind } from '~/lib/files'
import { iconPaths } from '~/utils/icons'

export interface FilesFileTypeIconProps extends Omit<SVGAttributes<SVGSVGElement>, 'strokeWidth'> {
  /** 유형을 판정할 항목(이름·폴더 여부·MIME) */
  item?: { name: string; is_dir?: boolean; mime_type?: string | null }
  /** 항목 대신 유형을 직접 지정 */
  kind?: FileKind
  /** 선 굵기(기본 2) */
  strokeWidth?: number | string
}

/**
 * 파일 유형 아이콘.
 * @example <FilesFileTypeIcon item={file} className="h-4 w-4" />
 */
export function FilesFileTypeIcon({ item, kind, strokeWidth = 2, className, ...rest }: FilesFileTypeIconProps) {
  const { t } = useI18n()
  const meta = KIND_META[kind ?? (item ? fileKind(item) : 'file')]
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={t(meta.labelKey)}
      focusable="false"
      {...rest}
      className={cn('shrink-0', meta.tone, className)}
      dangerouslySetInnerHTML={{ __html: iconPaths(meta.icon) }}
    />
  )
}

export default FilesFileTypeIcon
