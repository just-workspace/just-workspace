/**
 * 서비스 상태.
 * GET /api/services/status 로 각 서비스의 상태(ok/down/checking)·응답 ms 를 조회한다. 실패 시 이전 값을 유지한다.
 * 앱 전역에서 공유하는 값이므로 단일 store 에 저장한다.
 *
 * React: const { services, loading, fetchServices } = useServices()
 * 컴포넌트 외부: servicesStore.getState().services · fetchServices()
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
