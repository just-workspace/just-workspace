/**
 * 메일 서명 — Vue 판 composables/useMailSignature.ts 그대로(모듈 싱글턴).
 *
 * React: const { signatures, loading, fetchSignatures, getDefaultSignature, createSignature, updateSignature, deleteSignature } = useMailSignature()
 * 컴포넌트 밖: mailSignatureStore.getState() 또는 동작 함수 직접 import.
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { $fetch } from '~/lib/api'

export interface Signature {
  id: string
  name: string
  html_content: string
  is_default: boolean
  created_at: string
}

export const mailSignatureStore = createStore<{ signatures: Signature[]; loading: boolean }>()(() => ({
  signatures: [],
  loading: false,
}))

const set = mailSignatureStore.setState

export async function fetchSignatures() {
  set({ loading: true })
  try {
    set({ signatures: await $fetch<Signature[]>('/api/mail/signatures') })
  } catch (e: any) {
    console.error('fetchSignatures error:', e)
  } finally {
    set({ loading: false })
  }
}

export async function getDefaultSignature(): Promise<Signature | null> {
  try {
    return await $fetch<Signature | null>('/api/mail/signatures/default')
  } catch {
    return null
  }
}

export async function createSignature(data: {
  name: string
  html_content: string
  is_default?: boolean
}): Promise<Signature> {
  const sig = await $fetch<Signature>('/api/mail/signatures', {
    method: 'POST',
    body: data,
  })
  await fetchSignatures()
  return sig
}

export async function updateSignature(
  id: string,
  data: { name?: string; html_content?: string; is_default?: boolean },
): Promise<Signature> {
  const sig = await $fetch<Signature>(`/api/mail/signatures/${id}`, {
    method: 'PATCH',
    body: data,
  })
  await fetchSignatures()
  return sig
}

export async function deleteSignature(id: string) {
  await $fetch(`/api/mail/signatures/${id}`, { method: 'DELETE' })
  await fetchSignatures()
}

export function useMailSignature() {
  const { signatures, loading } = useStore(mailSignatureStore, useShallow(s => ({ signatures: s.signatures, loading: s.loading })))
  return {
    signatures,
    loading,
    fetchSignatures,
    getDefaultSignature,
    createSignature,
    updateSignature,
    deleteSignature,
  }
}
