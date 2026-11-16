/**
 * 설치 마법사 문구 — 워크스페이스 앱의 대형 번역 파일과 분리된 전용 파일(ko.json · en.json)을 사용한다.
 * 엔진은 앱의 i18n 을 그대로 사용하며(UI 키트가 해당 엔진의 `common`·`ui` 문구를 참조한다), 전용 문구를 `installer` 아래에 추가한다.
 * 빌드는 앱 번역 파일에서 `common`·`ui` 만 남긴다(vite.installer.config.ts).
 *
 * 화면에서:  const t = useT();  t('check.title')   — 키 앞의 `installer.` 는 붙이지 않는다
 * 문장 안 숫자·주소:  <M k="dns.matchBody" v={{ ip }} />   — `{m}…{/m}` 는 mono, `{b}…{/b}` 는 굵게
 */
import { useCallback, type ReactNode } from 'react'
import { i18n, initI18n, setLocale, setMessages, useI18n, LOCALES, type TArg } from '~/i18n'
import { UiTrans, type UiTransSlot } from '~/components/ui/Trans'
import ko from './ko.json'
import en from './en.json'

const OWN: Record<string, Record<string, unknown>> = { ko, en }
/** UI 키트가 참조하는 앱 문구 중 이 번들에 없는 항목(비밀번호 보기 버튼) */
const KIT: Record<string, Record<string, unknown>> = {
  ko: { auth: { showPassword: '비밀번호 보기', hidePassword: '비밀번호 숨기기' } },
  en: { auth: { showPassword: 'Show password', hidePassword: 'Hide password' } },
}

function mount(code: string) {
  const pick = (key: string) => {
    const v = i18n.tm<unknown>(key)
    return v && typeof v === 'object' ? v : {}
  }
  setMessages(code, { common: pick('common'), ui: pick('ui'), ...KIT[code], installer: OWN[code] })
}

let ready: Promise<void> | null = null
/** 시작 시 1회 호출 — 두 언어를 모두 로드(언어 전환 시 대기 없음) */
export function initInstallerI18n(): Promise<void> {
  if (ready) return ready
  ready = (async () => {
    await initI18n()
    const first = i18n.locale
    mount(first)
    for (const l of LOCALES) {
      if (l.code === first || !OWN[l.code]) continue
      await setLocale(l.code)
      mount(l.code)
    }
    await setLocale(first)
  })()
  return ready
}

export type Translate = (key: string, values?: Record<string, unknown>) => string

export function useT(): Translate {
  const { t } = useI18n()
  return useCallback((key, values) => t(`installer.${key}`, values as TArg), [t])
}

/** 키 존재 여부 — 서버가 전달한 키(원인·주의 등)에 해당하는 문구가 없을 때 대체 문구로 전환하기 위함 */
export function useHas(): (key: string) => boolean {
  const { te } = useI18n()
  return useCallback(key => te(`installer.${key}`), [te])
}

export function useLocale(): { locale: string; locales: typeof LOCALES; setLocale: (code: string) => Promise<void> } {
  const { locale } = useI18n()
  return { locale, locales: LOCALES, setLocale }
}

const mono = (c: ReactNode) => <span className="font-mono">{c}</span>
const bold = (c: ReactNode) => <span className="font-semibold text-foreground">{c}</span>

/** 문장 안에 mono·굵은 글자가 혼재하는 문구 */
export function M({ k, v, slots }: { k: string; v?: Record<string, unknown>; slots?: Record<string, UiTransSlot> }) {
  return <UiTrans k={`installer.${k}`} values={v} slots={{ m: mono, b: bold, ...slots }} />
}

/** 서버가 전달한 이름({ ko, en }) 중 현재 언어의 값 */
export function useLocalized(): (text: Record<string, string> | null | undefined) => string {
  const { locale } = useI18n()
  return useCallback(text => (text ? (text[locale] ?? text.ko ?? text.en ?? '') : ''), [locale])
}

// ─── 한국어 조사 ───

const DIGIT_BATCHIM: Record<string, boolean> = { 0: true, 1: true, 2: false, 3: true, 4: false, 5: false, 6: true, 7: true, 8: true, 9: false }
const DIGIT_RIEUL: Record<string, boolean> = { 1: true, 7: true, 8: true }
const LATIN_BATCHIM = new Set(['l', 'm', 'n', 'r'])

/** 단어 끝의 받침 유무 · 해당 받침의 ㄹ 여부 */
function ending(word: string): { batchim: boolean; rieul: boolean } {
  const ch = word.trim().replace(/[)\]"'`]+$/, '').slice(-1)
  if (!ch) return { batchim: false, rieul: false }
  const code = ch.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28
    return { batchim: jong !== 0, rieul: jong === 8 }
  }
  if (ch in DIGIT_BATCHIM) return { batchim: DIGIT_BATCHIM[ch], rieul: !!DIGIT_RIEUL[ch] }
  const lower = ch.toLowerCase()
  return { batchim: LATIN_BATCHIM.has(lower), rieul: lower === 'l' }
}

export type Josa = '을/를' | '이/가' | '으로/로' | '과/와'

/** 단어 뒤에 붙일 조사. 한국어가 아니면 빈 문자열(번역문에는 `{p}` 자리가 없음) */
export function josa(word: string, pair: Josa, locale = i18n.locale): string {
  if (locale !== 'ko') return ''
  const [withB, without] = pair.split('/')
  const e = ending(word)
  if (pair === '으로/로') return e.batchim && !e.rieul ? withB : without
  return e.batchim ? withB : without
}
