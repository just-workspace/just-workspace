/**
 * 연락처 편집 — Vue 판 components/contacts/ContactsEditModal.vue.
 * UiModal 520(모바일 바텀시트). 사진 56(없으면 이니셜) + "사진 추가"(이미지를 256px JPEG 로 줄여 data URI 저장),
 * 2열 입력(이름 · 회사 · 성 · 이름(given)) + 직함, 이메일·전화는 [종류 ▾ 96][값][✕ 40] 행 + "+ 이메일 추가",
 * 그룹 칩(점 8 + 이름 ✕, 28 · rounded 6 · 테두리) + "+ 그룹"(점선) → 기존 그룹 자동완성 입력,
 * 주소·메모·주소록. 푸터 [삭제(편집일 때, 왼쪽 danger 글자)] … [취소][저장].
 *
 * Vue 는 watch(showEditModal, immediate) 로 열릴 때 폼을 채웠다. React 는 열려 있는 동안만 본체(ContactsEditForm)를
 * 마운트해 같은 시점에 초기화한다.
 */
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { useI18n } from '~/i18n'
import { useContacts, type Contact, type TypedValue } from '~/composables/useContacts'
import { confirmBox } from '~/composables/useDialog'
import { initialsOf, groupDotColor } from '~/utils/contactsIndex'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import { UiSelect } from '~/components/ui/Select'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiButton } from '~/components/ui/Button'

interface FormState {
  address_book_id: string
  name: string
  first_name: string
  last_name: string
  organization: string
  title: string
  emails: TypedValue[]
  phones: TypedValue[]
  addresses: TypedValue[]
  notes: string
  photo: string
  groups: string[]
}

/** 이미지 파일 → 정사각 256px JPEG data URI(서버 한도 약 512KB 안쪽) */
async function toPhotoDataUri(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('image'))
      i.src = url
    })
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    const S = 256
    const canvas = document.createElement('canvas')
    canvas.width = S
    canvas.height = S
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, S, S)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}

const BASE_TYPES = ['work', 'home', 'other']
const label = 'text-xs font-semibold text-muted-foreground'
const addLink = 'self-start rounded-sm text-[13px] font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring'

/** 연락처 만들기·편집 모달. showEditModal 이 켜져 있을 때만 그린다(props 없음). */
export function ContactsEditModal() {
  const { showEditModal } = useContacts()
  if (!showEditModal) return null
  return <ContactsEditForm />
}

function initialForm(c: Contact | null, selectedBookId: string | null, firstBookId: string | undefined, groupScope: string | null): FormState {
  if (c) {
    return {
      address_book_id: c.address_book_id,
      name: c.name,
      first_name: c.first_name || '',
      last_name: c.last_name || '',
      organization: c.organization || '',
      title: c.title || '',
      photo: c.photo || '',
      groups: [...(c.groups || [])],
      emails: c.emails.length > 0 ? c.emails.map(e => ({ ...e })) : [{ type: 'work', value: '' }],
      phones: c.phones.length > 0 ? c.phones.map(p => ({ ...p })) : [{ type: 'work', value: '' }],
      addresses: c.addresses.map(a => ({ ...a })),
      notes: c.notes || '',
    }
  }
  return {
    address_book_id: selectedBookId || firstBookId || '',
    name: '',
    first_name: '',
    last_name: '',
    organization: '',
    title: '',
    photo: '',
    // 그룹 범위에서 만들면 그 그룹을 미리 붙인다
    groups: groupScope ? [groupScope] : [],
    emails: [{ type: 'work', value: '' }],
    phones: [{ type: 'work', value: '' }],
    addresses: [],
    notes: '',
  }
}

function ContactsEditForm() {
  const {
    addressBooks, editingContact, selectedBookId, groups: allGroups, scope,
    createContact, updateContact, deleteContact, closeModal,
  } = useContacts()
  const { t } = useI18n()

  const [form, setForm] = useState<FormState>(() =>
    initialForm(editingContact, selectedBookId, addressBooks[0]?.id, scope.kind === 'group' ? scope.name : null))
  const patch = (p: Partial<FormState>) => setForm(f => ({ ...f, ...p }))
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 사진은 바뀌었을 때만 보낸다("" = 지움)
  const [photoDirty, setPhotoDirty] = useState(false)
  const photoInput = useRef<HTMLInputElement | null>(null)

  async function onPhoto(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { setError(t('contacts.edit.photoInvalid')); return }
    try {
      const photo = await toPhotoDataUri(file)
      patch({ photo })
      setPhotoDirty(true)
      setError('')
    } catch { setError(t('contacts.edit.photoInvalid')) }
  }

  function removePhoto() {
    patch({ photo: '' })
    setPhotoDirty(true)
  }

  // ── 그룹 ──
  const [groupInput, setGroupInput] = useState('')
  const [addingGroup, setAddingGroup] = useState(false)
  const groupEl = useRef<HTMLInputElement | null>(null)
  const groupSuggestions = allGroups.map(g => g.name).filter(n => !form.groups.includes(n))
  function startGroup() {
    setAddingGroup(true)
  }
  useEffect(() => { if (addingGroup) groupEl.current?.focus() }, [addingGroup])
  /** 지금 입력값으로 그룹을 붙인 새 목록(제출 때 같이 쓰려고 값을 돌려준다) */
  function commitGroup(): string[] {
    const g = groupInput.trim().slice(0, 100)
    let next = form.groups
    if (g && !form.groups.includes(g)) { next = [...form.groups, g]; patch({ groups: next }) }
    setGroupInput('')
    setAddingGroup(false)
    return next
  }
  function onGroupKey(e: KeyboardEvent<HTMLInputElement>) {
    // 한글 조합 중 Enter 는 글자 확정이다(macOS 는 조합 중에도 key='Enter') — 넘기면 마지막 글자가 한 번 더 들어간다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') { e.preventDefault(); commitGroup() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setGroupInput(''); setAddingGroup(false) }
  }

  const isEditing = !!editingContact
  const modalTitle = isEditing ? t('contacts.edit.editTitle') : t('contacts.edit.createTitle')
  const bookOptions = addressBooks.map(b => ({ value: b.id, label: b.name }))

  function typeOptions(current: string) {
    const list = BASE_TYPES.map(v => ({ value: v, label: t(`contacts.type.${v}`) }))
    // 가져온 vCard 의 다른 종류(cell 등)는 지우지 않고 그대로 보여 준다
    if (current && !BASE_TYPES.includes(current)) list.push({ value: current, label: current })
    return list
  }

  type ListKey = 'emails' | 'phones' | 'addresses'
  function setRow(key: ListKey, i: number, p: Partial<TypedValue>) {
    setForm(f => ({ ...f, [key]: f[key].map((r, j) => (j === i ? { ...r, ...p } : r)) }))
  }
  function removeRow(key: ListKey, i: number) {
    setForm(f => ({ ...f, [key]: f[key].filter((_, j) => j !== i) }))
  }
  function addRow(key: ListKey, type: string) {
    setForm(f => ({ ...f, [key]: [...f[key], { type, value: '' }] }))
  }

  async function handleSubmit() {
    if (submitting) return
    if (!form.name.trim()) { setError(t('contacts.edit.nameRequired')); return }
    if (!form.address_book_id) { setError(t('contacts.edit.addressBookRequired')); return }
    let groups = form.groups
    if (addingGroup && groupInput.trim()) groups = commitGroup()
    setSubmitting(true)
    setError('')
    try {
      const data = {
        address_book_id: form.address_book_id,
        name: form.name.trim(),
        // 비운 값도 보낸다("" = 지움) — undefined 로 빼면 편집에서 소속·메모·성·이름이 지워지지 않았다
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        organization: form.organization.trim(),
        emails: form.emails.filter(e => e.value.trim()),
        phones: form.phones.filter(p => p.value.trim()),
        addresses: form.addresses.filter(a => a.value.trim()),
        notes: form.notes.trim(),
        groups: [...groups],
      }
      if (isEditing) {
        await updateContact(editingContact!.id, {
          ...data,
          // 직함은 비우면 지운다(""), 사진은 바뀐 경우에만("" = 지움)
          title: form.title.trim(),
          ...(photoDirty ? { photo: form.photo } : {}),
        })
      } else {
        await createContact({
          ...data,
          title: form.title.trim() || undefined,
          ...(form.photo ? { photo: form.photo } : {}),
        })
      }
      closeModal()
    } catch (e: any) {
      setError((typeof e?.data?.detail === 'string' && e.data.detail) || t('contacts.edit.saveError'))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    const c = editingContact
    if (!c) return
    if (!await confirmBox(t('contacts.detail.deleteConfirm', { name: c.name }), { danger: true, confirmLabel: t('common.delete') })) return
    await deleteContact(c.id)
    closeModal()
  }

  return (
    <UiModal
      title={modalTitle}
      size="520"
      onClose={closeModal}
      footer={(
        <>
          {isEditing && <UiButton variant="ghost" size="sm" className="mr-auto font-semibold text-danger hover:bg-danger/10 hover:text-danger" onClick={handleDelete}>{t('common.delete')}</UiButton>}
          <UiButton variant="outline" size="sm" onClick={closeModal}>{t('common.cancel')}</UiButton>
          <UiButton type="submit" form="contact-edit-form" size="sm" className="font-semibold" disabled={submitting}>
            {submitting ? t('common.saving') : t('common.save')}
          </UiButton>
        </>
      )}
    >
      <form id="contact-edit-form" className="flex flex-col gap-3.5" noValidate onSubmit={(e) => { e.preventDefault(); void handleSubmit() }}>
        {/* 사진 */}
        <div className="flex items-center gap-3.5">
          {form.photo
            ? <img src={form.photo} alt="" className="h-14 w-14 shrink-0 rounded-full object-cover" />
            : <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-muted text-xl font-semibold text-foreground" aria-hidden="true">{initialsOf(form.name)}</span>}
          <button type="button" className={addLink} onClick={() => photoInput.current?.click()}>{form.photo ? t('contacts.edit.changePhoto') : t('contacts.edit.addPhoto')}</button>
          {form.photo && <button type="button" className="self-center rounded-sm text-[13px] text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" onClick={removePhoto}>{t('contacts.edit.removePhoto')}</button>}
          <input ref={photoInput} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-label={t('contacts.edit.addPhoto')} onChange={onPhoto} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiInput modelValue={form.name} onUpdateModelValue={v => patch({ name: v })} label={t('contacts.edit.nameLabel')} placeholder={t('contacts.edit.namePlaceholder')} required data-autofocus />
          <UiInput modelValue={form.organization} onUpdateModelValue={v => patch({ organization: v })} label={t('contacts.edit.organizationLabel')} placeholder={t('contacts.edit.organizationPlaceholder')} />
          <UiInput modelValue={form.title} onUpdateModelValue={v => patch({ title: v })} label={t('contacts.edit.titleLabel')} placeholder={t('contacts.edit.titlePlaceholder')} className="sm:col-span-2" />
          <UiInput modelValue={form.last_name} onUpdateModelValue={v => patch({ last_name: v })} label={t('contacts.edit.lastNameLabel')} placeholder={t('contacts.edit.lastNamePlaceholder')} />
          <UiInput modelValue={form.first_name} onUpdateModelValue={v => patch({ first_name: v })} label={t('contacts.edit.firstNameLabel')} placeholder={t('contacts.edit.firstNamePlaceholder')} />
        </div>

        {/* 이메일 */}
        <div className="flex flex-col gap-1.5" role="group" aria-label={t('contacts.edit.emailLabel')}>
          <span className={label}>{t('contacts.edit.emailLabel')}</span>
          {form.emails.map((email, i) => (
            <div key={`e${i}`} className="flex gap-2">
              <UiSelect modelValue={email.type} onUpdateModelValue={v => setRow('emails', i, { type: String(v ?? '') })} options={typeOptions(email.type)} native className="w-24 shrink-0" aria-label={t('contacts.edit.typeLabel')} />
              <UiInput modelValue={email.value} onUpdateModelValue={v => setRow('emails', i, { value: v })} type="email" className="min-w-0 flex-1" placeholder="email@example.com" aria-label={t('contacts.edit.emailLabel')} />
              <UiIconButton label={t('contacts.edit.removeEmail')} icon="close" size="md" onClick={() => removeRow('emails', i)} />
            </div>
          ))}
          <button type="button" className={addLink} onClick={() => addRow('emails', 'other')}>{`+ ${t('contacts.edit.addEmail')}`}</button>
        </div>

        {/* 전화 */}
        <div className="flex flex-col gap-1.5" role="group" aria-label={t('contacts.edit.phoneLabel')}>
          <span className={label}>{t('contacts.edit.phoneLabel')}</span>
          {form.phones.map((phone, i) => (
            <div key={`p${i}`} className="flex gap-2">
              <UiSelect modelValue={phone.type} onUpdateModelValue={v => setRow('phones', i, { type: String(v ?? '') })} options={typeOptions(phone.type)} native className="w-24 shrink-0" aria-label={t('contacts.edit.typeLabel')} />
              <UiInput modelValue={phone.value} onUpdateModelValue={v => setRow('phones', i, { value: v })} type="tel" mono className="min-w-0 flex-1" placeholder="010-0000-0000" aria-label={t('contacts.edit.phoneLabel')} />
              <UiIconButton label={t('contacts.edit.removePhone')} icon="close" size="md" onClick={() => removeRow('phones', i)} />
            </div>
          ))}
          <button type="button" className={addLink} onClick={() => addRow('phones', 'other')}>{`+ ${t('contacts.edit.addPhone')}`}</button>
        </div>

        {/* 주소 */}
        <div className="flex flex-col gap-1.5" role="group" aria-label={t('contacts.edit.addressLabel')}>
          <span className={label}>{t('contacts.edit.addressLabel')}</span>
          {form.addresses.map((addr, i) => (
            <div key={`a${i}`} className="flex gap-2">
              <UiSelect modelValue={addr.type} onUpdateModelValue={v => setRow('addresses', i, { type: String(v ?? '') })} options={typeOptions(addr.type)} native className="w-24 shrink-0" aria-label={t('contacts.edit.typeLabel')} />
              <UiInput modelValue={addr.value} onUpdateModelValue={v => setRow('addresses', i, { value: v })} className="min-w-0 flex-1" placeholder={t('contacts.edit.addressPlaceholder')} aria-label={t('contacts.edit.addressLabel')} />
              <UiIconButton label={t('contacts.edit.removeAddress')} icon="close" size="md" onClick={() => removeRow('addresses', i)} />
            </div>
          ))}
          <button type="button" className={addLink} onClick={() => addRow('addresses', 'home')}>{`+ ${t('contacts.edit.addAddress')}`}</button>
        </div>

        {/* 그룹 */}
        <div className="flex flex-col gap-1.5" role="group" aria-label={t('contacts.edit.groupsLabel')}>
          <span className={label}>{t('contacts.edit.groupsLabel')}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {form.groups.map((g, i) => (
              <span
                key={g}
                className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-border pl-2.5 pr-1 text-xs text-foreground"
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: groupDotColor(g) }} aria-hidden="true" />
                {g}
                <button
                  type="button"
                  aria-label={t('contacts.edit.removeGroup', { name: g })}
                  className="relative grid h-5 w-5 place-items-center rounded-full text-muted-foreground hover:text-foreground before:absolute before:-inset-2.5 before:content-['']"
                  onClick={() => patch({ groups: form.groups.filter((_, j) => j !== i) })}
                ><UiIcon name="close" className="h-3 w-3" strokeWidth={2.4} /></button>
              </span>
            ))}
            {addingGroup
              ? (
                <input
                  ref={groupEl}
                  value={groupInput}
                  onChange={e => setGroupInput(e.target.value)}
                  type="text"
                  list="contact-group-options"
                  maxLength={100}
                  autoComplete="off"
                  aria-label={t('contacts.edit.groupName')}
                  placeholder={t('contacts.edit.groupName')}
                  className="h-7 w-36 rounded-sm border border-input bg-background px-2 text-xs text-foreground outline-hidden focus:border-ring focus:ring-2 focus:ring-ring/35"
                  onKeyDown={onGroupKey}
                  onBlur={() => commitGroup()}
                />
              )
              : (
                <button
                  type="button"
                  className="inline-flex h-7 items-center rounded-sm border border-dashed border-border px-2.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={startGroup}
                >{`+ ${t('contacts.edit.addGroup')}`}</button>
              )}
            <datalist id="contact-group-options">
              {groupSuggestions.map(g => <option key={g} value={g} />)}
            </datalist>
          </div>
        </div>

        <UiTextarea modelValue={form.notes} onUpdateModelValue={v => patch({ notes: v })} rows={2} label={t('contacts.edit.notesLabel')} placeholder={t('contacts.edit.notesPlaceholder')} />
        {(bookOptions.length > 1 || !isEditing) && (
          <UiSelect modelValue={form.address_book_id} onUpdateModelValue={v => patch({ address_book_id: String(v ?? '') })} options={bookOptions} label={t('contacts.edit.addressBookLabel')} />
        )}

        {error && (
          <p role="alert" className="flex items-center gap-1.5 text-xs text-danger">
            <UiIcon name="alert-circle" className="h-3.5 w-3.5 shrink-0" />{error}
          </p>
        )}
      </form>
    </UiModal>
  )
}

export default ContactsEditModal
