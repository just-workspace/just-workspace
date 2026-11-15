/**
 * 파일 액션 메뉴(Vue components/files/FileContextMenu.vue) — 데스크톱 드롭다운(⋮·우클릭) / 모바일 액션 시트.
 * 같은 항목·같은 순서.
 * 순서: 열기 · 공유 · 채널로 보내기(파일만) · 이동·복사 · 이름 바꾸기 · 버전 기록 · 다운로드 · 즐겨찾기 · 상세 정보 · (검색 결과) 위치 열기 — 휴지통으로.
 * "채널로 보내기"는 공유 모달의 "사람·채널" 탭을 연다(POST /share-channel). 즐겨찾기 줄은 시안 목록에 없어 다운로드 뒤에 붙였다(디자이너 확인 필요).
 * 공유받은 항목(shared-with-me/..): 같은 순서에서 권한에 맞는 줄만 — 열기 · 다운로드 · 상세 정보는 늘,
 *   공유 · 이동·복사 · 이름 바꾸기 · 휴지통은 공동 소유일 때만. 채널로 보내기 · 버전 · 즐겨찾기는 서버가 내 경로만 받아 뺀다.
 * 마운트 = 열림. 부모가 onClose 에서 상태를 내린다.
 */
import { useMemo } from 'react'
import { useI18n } from '~/i18n'
import type { FileItem } from '~/composables/useFiles'
import { useIsMobile } from '~/composables/useIsMobile'
import { fileKind, formatSize, formatStamp, KIND_META, roleAtLeast, sharedSubPath, type FileAction } from '~/lib/files'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiActionSheet } from '~/components/ui/ActionSheet'
import { FilesFileTypeIcon } from './FileTypeIcon'

export interface FilesFileContextMenuProps {
  item: FileItem
  /** 데스크톱 기준점(우클릭·⋮ 좌표) */
  x: number
  y: number
  /** 검색 결과 행이면 "위치 열기" 추가 */
  inSearch?: boolean
  onClose?: () => void
  /** 항목 고름 */
  onAction?: (key: FileAction, item: FileItem) => void
}

/** 메뉴 항목 목록(순수 — 테스트용으로도 낸다) */
export function fileMenuItems(it: FileItem, inSearch: boolean | undefined, t: (k: string) => string): UiMenuItem[] {
  if (sharedSubPath(it.path)) {
    const owner = roleAtLeast(it.role ?? 'view', 'owner')
    const list: UiMenuItem[] = [{ key: 'open', label: t('files.action.open'), icon: 'external-link' }]
    if (owner) {
      list.push(
        { key: 'share', label: t('common.share'), icon: 'share-up' },
        { key: 'rename', label: t('files.action.rename'), icon: 'pen' },
      )
      // 공유 루트 자체는 옮길 곳이 없다(공유 폴더 밖으로는 못 옮김) — 안의 항목만
      if (sharedSubPath(it.path)?.sub) list.splice(2, 0, { key: 'move', label: t('files.action.moveCopy'), icon: 'folder-move' })
    }
    list.push({ key: 'download', label: it.is_dir ? t('files.action.downloadZip') : t('common.download'), icon: 'download' })
    list.push({ key: 'detail', label: t('files.detail.title'), icon: 'info' })
    if (owner) list.push({ key: 'delete', label: t('files.action.toTrash'), icon: 'trash', danger: true, separated: true })
    return list
  }
  const list: UiMenuItem[] = [
    { key: 'open', label: t('files.action.open'), icon: 'external-link' },
    { key: 'share', label: t('common.share'), icon: 'share-up' },
  ]
  if (!it.is_dir) list.push({ key: 'channel', label: t('files.action.toChannel'), icon: 'message-square' })
  list.push(
    { key: 'move', label: t('files.action.moveCopy'), icon: 'folder-move' },
    { key: 'rename', label: t('files.action.rename'), icon: 'pen' },
  )
  // 버전은 내 파일(my/)의 파일만 서버가 남긴다
  if (!it.is_dir && it.path.startsWith('my/')) list.push({ key: 'versions', label: t('files.action.versions'), icon: 'clock' })
  list.push({ key: 'download', label: it.is_dir ? t('files.action.downloadZip') : t('common.download'), icon: 'download' })
  list.push({ key: 'star', label: it.is_starred ? t('files.star.remove') : t('files.star.add'), icon: 'star' })
  list.push({ key: 'detail', label: t('files.detail.title'), icon: 'info' })
  if (inSearch) list.push({ key: 'location', label: t('files.action.openLocation'), icon: 'folder' })
  list.push({ key: 'delete', label: t('files.action.toTrash'), icon: 'trash', danger: true, separated: true })
  return list
}

export function FilesFileContextMenu({ item, x, y, inSearch, onClose, onAction }: FilesFileContextMenuProps) {
  const isMobile = useIsMobile()
  const { t } = useI18n()

  // 순서·이름은 디자인 그대로, 모양은 공용 아이콘 세트
  const items = useMemo(() => fileMenuItems(item, inSearch, t), [item, inSearch, t])

  const kind = KIND_META[fileKind(item)]
  const meta: { text: string; mono?: boolean }[] = [{ text: t(kind.labelKey) }]
  if (!item.is_dir) meta.push({ text: formatSize(item.size), mono: true })
  if (item.modified_at) meta.push({ text: formatStamp(item.modified_at) })

  // 데스크톱 드롭다운 기준점 = 우클릭·⋮ 좌표
  const anchor = useMemo(() => new DOMRect(x, y, 0, 0), [x, y])

  function pick(key: string) {
    onAction?.(key as FileAction, item)
    onClose?.()
  }

  const label = t('files.action.menuFor', { name: item.name })
  // 모바일: 액션 시트(아이콘 + 이름 + 메타 머리글)
  if (isMobile) {
    return (
      <UiActionSheet
        label={label}
        title={item.name}
        meta={meta}
        items={items}
        onSelect={pick}
        onClose={() => onClose?.()}
        header={<FilesFileTypeIcon item={item} className="h-7 w-7" strokeWidth={1.8} />}
      />
    )
  }
  // 데스크톱: 드롭다운(드롭다운 규격 rounded-lg bg-popover shadow-md 224)
  return <UiMenu anchor={anchor} items={items} label={label} align="start" sheet={false} onSelect={pick} onClose={() => onClose?.()} />
}

export default FilesFileContextMenu
