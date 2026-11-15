/**
 * 서비스 상태 — Vue 판 composables/useServices.ts 그대로.
 * GET /api/services/status 로 각 서비스의 상태(ok/down/checking)·응답 ms 를 받는다. 실패하면 이전 값을 유지.
 * Vue 에서 useState('services')·useState('services-loading') 로 전역 공유하던 것을 store 하나로.
 *
 * React: const { services, loading, fetchServices } = useServices()
 * 컴포넌트 밖: servicesStore.getState().services · fetchServices()
 */
import { createStore, useStore } from 'zustand'
import { $fetch } from '~/lib/api'

export interface ServiceStatus {
  name: string
  url: string | null
  status: 'ok' | 'down' | 'checking'
  response_ms: number | null
  internal_only: boolean
}

export const servicesStore = createStore<{ services: ServiceStatus[]; loading: boolean }>()(() => ({
  services: [],
  loading: true,
}))

export async function fetchServices() {
  try {
    servicesStore.setState({ loading: true })
    const data = await $fetch<ServiceStatus[]>('/api/services/status', {
      credentials: 'include',
    })
    servicesStore.setState({ services: data })
  } catch {
    // Keep previous data on error
  } finally {
    servicesStore.setState({ loading: false })
  }
}

export function useServices() {
  const services = useStore(servicesStore, s => s.services)
  const loading = useStore(servicesStore, s => s.loading)
  return { services, loading, fetchServices }
}
