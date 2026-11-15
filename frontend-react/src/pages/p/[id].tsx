// 플러그인 페이지(/p/:id). 번들 로딩은 ~/plugins/pluginHost.
import { useEffect, useMemo } from 'react'
import { useRoute, navigateTo } from '~/lib/router'
import { useHead } from '~/lib/head'
import { useI18n } from '~/i18n'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useAuth } from '~/composables/useAuth'
import { usePlatform, isModuleEnabled } from '~/composables/usePlatform'
import { clearAllHeaderActions } from '~/composables/useShellHeaderActions'
import { clearAllTitles } from '~/composables/useShellTitle'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { PluginHost, pluginApiStatics, type PluginApiV2 } from '~/plugins/pluginHost'

export default function PluginPage() {
  const route = useRoute()
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  const { user } = useAuth()
  const { loaded } = usePlatform()

  const pluginId = route.params.id as string

  // 모듈이 꺼져 있으면 / 로 — pluginId·loaded 가 바뀔 때만 본다(처음에도)
  useEffect(() => {
    if (loaded && !isModuleEnabled(pluginId)) {
      void navigateTo('/')
    }
  }, [pluginId, loaded])

  useHead({ title: `${pluginId} | ${appName}` })

  // v2(React) 플러그인에 넘길 API — v1(Vue) 은 PluginHost 가 provide('pluginApi') 로 만든다
  const pluginApi = useMemo<PluginApiV2>(() => ({
    version: 2,
    pluginId,
    user,
    appName,
    ...pluginApiStatics,
    t,
  }), [pluginId, user, appName, t])

  // 플러그인이 해제를 잊어도 페이지를 떠나거나 다른 플러그인으로 바꾸면 상단바 항목·제목을 지운다(원복)
  useEffect(() => () => { clearAllHeaderActions(); clearAllTitles() }, [pluginId])

  if (!user) return null

  return (
    <div className="h-full overflow-auto">
      {/* Dynamic plugin UI — id 가 있으면 항상 컴포넌트를 그린다(아래 빈 상태는 id 가 없을 때뿐) */}
      {pluginId ? (
        <PluginHost key={pluginId} pluginId={pluginId} pluginApi={pluginApi} />
      ) : (
        // Fallback: plugin has no frontend — 공용 EmptyState(full)
        <div className="px-4 py-10 sm:px-6 lg:px-8">
          <UiEmptyState
            variant="full"
            icon="grid"
            title={t('plugins.placeholder')}
            description={t('plugins.rebuildHint')}
            className="mx-auto max-w-[680px]"
          />
        </div>
      )}
    </div>
  )
}
