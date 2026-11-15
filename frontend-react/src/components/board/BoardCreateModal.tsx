/**
 * 게시판 만들기(관리자) — Vue 판 components/board/BoardCreateModal.vue 이식.
 * 이름 → 주소(slug) 자동 생성, 카테고리는 쉼표로 구분, 쓰기 권한(모두/관리자).
 */
import { useState } from 'react'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { createBoard } from '~/composables/useBoard'
import { UiModal } from '~/components/ui/Modal'
import { UiButton } from '~/components/ui/Button'

export interface BoardCreateModalProps {
  onClose?: () => void
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100)
}

/** 게시판 만들기 모달 */
export function BoardCreateModal({ onClose }: BoardCreateModalProps) {
  const { t } = useI18n()

  const [name, setNameState] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [categories, setCategories] = useState('')
  const [writePermission, setWritePermission] = useState('all')
  const [submitting, setSubmitting] = useState(false)

  // Auto-generate slug from name (Vue watch(name) — 새 값 기준으로 "한 글자 전 이름"의 slug 와 비교)
  function setName(val: string) {
    setNameState(val)
    if (val === name) return
    if (!slug || slug === slugify(val.slice(0, -1))) {
      setSlug(slugify(val))
    }
  }

  async function handleSubmit() {
    if (!name.trim() || !slug.trim()) {
      addToast('error', t('board.create.nameSlugRequired'))
      return
    }
    setSubmitting(true)
    try {
      const cats = categories
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)

      await createBoard({
        name,
        slug,
        description: description || undefined,
        categories: cats.length > 0 ? cats : undefined,
        write_permission: writePermission,
      })
      onClose?.()
    } catch (e: any) {
      console.error('Create board error:', e)
      const detail = e?.data?.detail
      const msg = typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((d: any) => d.msg).join(', ') : t('board.create.error')
      addToast('error', msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <UiModal
      size="md"
      onClose={() => onClose?.()}
      titleSlot={<h2 className="text-[15px] font-semibold text-foreground">{t('board.create.title')}</h2>}
      footer={(
        <>
          <UiButton variant="outline" onClick={() => onClose?.()}>{t('common.cancel')}</UiButton>
          <UiButton onClick={() => { void handleSubmit() }} disabled={submitting}>
            {submitting ? t('board.create.submitting') : t('board.create.submit')}
          </UiButton>
        </>
      )}
    >
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">{t('board.create.nameLabel')}</label>
          <input autoComplete="off" value={name} onChange={e => setName(e.target.value)} type="text" placeholder={t('board.create.namePlaceholder')} className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">{t('board.create.slugLabel')}</label>
          <input autoComplete="off" value={slug} onChange={e => setSlug(e.target.value)} type="text" placeholder={t('board.create.slugPlaceholder')} className="h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">{t('board.create.descriptionLabel')}</label>
          <input autoComplete="off" value={description} onChange={e => setDescription(e.target.value)} type="text" placeholder={t('board.create.descriptionPlaceholder')} className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">{t('board.create.categoriesLabel')}</label>
          <input autoComplete="off" value={categories} onChange={e => setCategories(e.target.value)} type="text" placeholder={t('board.create.categoriesPlaceholder')} className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">{t('board.create.writePermissionLabel')}</label>
          <select value={writePermission} onChange={e => setWritePermission(e.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring">
            <option value="all">{t('board.create.writePermissionAll')}</option>
            <option value="admin">{t('board.create.writePermissionAdmin')}</option>
          </select>
        </div>
      </div>
    </UiModal>
  )
}

export default BoardCreateModal
