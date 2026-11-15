/**
 * i18n — vue-i18n 과 같은 사용법을 주는 어댑터. 엔진은 i18next(react-i18next) 를 쓰되
 * 메시지 해석은 vue-i18n 문법(compile.ts)으로 한다.
 *
 * 사용법(컴포넌트):  const { t, te, tm, rt, locale, locales, setLocale } = useI18n()
 * 컴포넌트 밖:  import { i18n } from '~/i18n';  i18n.t('key')
 *
 * t 호출 형태(vue-i18n 과 같음):
 *   t(key) · t(key, { name }) · t(key, count) · t(key, count, { name }) · t(key, { name }, count) · t(key, [a, b]) · t(key, 'default')
 *
 * 언어 결정: 쿠키 `i18n_locale` → 없으면 브라우저 언어(ko/en) → 없으면 ko. 결정값을 쿠키에 남긴다.
 * 메시지 파일은 언어별로 지연 로드한다(첫 화면 전에 현재 언어만 await).
 * 메시지 원본: src/i18n/locales/*.json.
 */
import i18next from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import { useMemo } from 'react'
import { format, type Named } from './compile'

export interface LocaleInfo { code: string; language: string; name: string }

export const LOCALES: LocaleInfo[] = [
  { code: 'ko', language: 'ko-KR', name: '한국어' },
  { code: 'en', language: 'en-US', name: 'English' },
]
export const DEFAULT_LOCALE = 'ko'
export const LOCALE_COOKIE = 'i18n_locale'

type Messages = Record<string, unknown>
const loaders: Record<string, () => Promise<{ default: Messages }>> = {
  ko: () => import('./locales/ko.json'),
  en: () => import('./locales/en.json'),
}
const messages: Record<string, Messages> = {}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]) : null
}
function writeCookie(name: string, value: string) {
  if (typeof document === 'undefined') return
  const exp = new Date(Date.now() + 365 * 24 * 3600 * 1000).toUTCString()
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax`
}

/** 언어 감지(쿠키 → 브라우저 언어 → ko) */
export function detectLocale(): string {
  const fromCookie = readCookie(LOCALE_COOKIE)
  if (fromCookie && LOCALES.some(l => l.code === fromCookie)) return fromCookie
  const langs = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : []
  for (const l of langs) {
    if (!l) continue
    const lower = l.toLowerCase()
    const exact = LOCALES.find(x => x.language.toLowerCase() === lower || x.code === lower)
    if (exact) return exact.code
    const prefix = LOCALES.find(x => x.code === lower.split('-')[0])
    if (prefix) return prefix.code
  }
  return DEFAULT_LOCALE
}

async function ensureMessages(code: string) {
  if (messages[code]) return
  const mod = await loaders[code]()
  messages[code] = mod.default
  if (i18next.isInitialized) i18next.addResourceBundle(code, 'translation', mod.default, true, true)
}

/** 테스트에서 메시지를 직접 넣을 때 */
export function setMessages(code: string, msgs: Messages) {
  messages[code] = msgs
  if (i18next.isInitialized) i18next.addResourceBundle(code, 'translation', msgs, true, true)
}

let initPromise: Promise<void> | null = null
/** 앱 시작 시 한 번(main.tsx). 현재 언어 메시지를 받은 뒤 끝난다. */
export function initI18n(code = detectLocale()): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    await i18next.use(initReactI18next).init({
      lng: code,
      fallbackLng: false,
      resources: {},
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    })
    await ensureMessages(code)
    if (messages[code]) i18next.addResourceBundle(code, 'translation', messages[code], true, true)
    writeCookie(LOCALE_COOKIE, code)
  })()
  return initPromise
}

function lookup(code: string, key: string): unknown {
  let cur: unknown = messages[code]
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function currentLocale(): string {
  return i18next.language || DEFAULT_LOCALE
}

/** t 의 두 번째·세 번째 인자 */
export type TArg = Named | number | string | unknown[] | undefined

function splitArgs(a?: TArg, b?: TArg) {
  let named: Named | undefined
  let list: unknown[] | undefined
  let plural: number | undefined
  for (const x of [a, b]) {
    if (typeof x === 'number') plural = x
    else if (Array.isArray(x)) list = x
    else if (x && typeof x === 'object') named = x as Named
  }
  return { named, list, plural }
}

function translate(code: string, key: string, a?: TArg, b?: TArg): string {
  const raw = lookup(code, key)
  if (typeof raw !== 'string') {
    // vue-i18n: 없는 키는 키 문자열(기본 문구를 줬으면 그것)을 돌려준다
    if (typeof a === 'string') return a
    return key
  }
  return format(raw, { ...splitArgs(a, b), resolve: k => lookup(code, k) })
}

function render(code: string, message: unknown, a?: TArg, b?: TArg): string {
  if (typeof message !== 'string') return message == null ? '' : String(message)
  return format(message, { ...splitArgs(a, b), resolve: k => lookup(code, k) })
}

export interface I18nApi {
  /** vue-i18n `t` 와 같은 호출 형태 */
  t: (key: string, a?: TArg, b?: TArg) => string
  /** 키가 있는가(vue-i18n `te`) */
  te: (key: string, locale?: string) => boolean
  /** 원본 메시지(객체·배열·문자열) — `rt` 로 그린다(vue-i18n `tm`) */
  tm: <T = any>(key: string) => T
  /** tm 으로 꺼낸 원본 문자열을 보간(vue-i18n `rt`) */
  rt: (message: unknown, a?: TArg, b?: TArg) => string
  /** 현재 언어 코드 ('ko' | 'en') */
  locale: string
  locales: LocaleInfo[]
  setLocale: (code: string) => Promise<void>
}

function makeApi(code: string): I18nApi {
  return {
    t: (key, a, b) => translate(code, key, a, b),
    te: (key, loc) => lookup(loc || code, key) !== undefined,
    tm: <T,>(key: string) => (lookup(code, key) ?? key) as T,
    rt: (message, a, b) => render(code, message, a, b),
    locale: code,
    locales: LOCALES,
    setLocale,
  }
}

/** 언어 전환 — 쿠키 저장 + 메시지 로드 + 화면 갱신 */
export async function setLocale(code: string): Promise<void> {
  if (!LOCALES.some(l => l.code === code)) return
  await ensureMessages(code)
  writeCookie(LOCALE_COOKIE, code)
  await i18next.changeLanguage(code)
}

/** 언어 변경 구독(컴포넌트 밖 store 용). 해제 함수를 돌려준다. */
export function onLocaleChange(fn: (code: string) => void): () => void {
  i18next.on('languageChanged', fn)
  return () => i18next.off('languageChanged', fn)
}

/**
 * 컴포넌트 밖에서 쓰는 전역 i18n.
 * `i18n.locale` 은 읽을 때마다 현재 값이다.
 */
export const i18n = {
  t: (key: string, a?: TArg, b?: TArg) => translate(currentLocale(), key, a, b),
  te: (key: string, loc?: string) => lookup(loc || currentLocale(), key) !== undefined,
  tm: <T = any>(key: string) => (lookup(currentLocale(), key) ?? key) as T,
  rt: (message: unknown, a?: TArg, b?: TArg) => render(currentLocale(), message, a, b),
  get locale() { return currentLocale() },
  locales: LOCALES,
  setLocale,
}

/** 컴포넌트용 — 언어가 바뀌면 다시 그린다 */
export function useI18n(): I18nApi {
  const { i18n: inst } = useTranslation()
  const code = inst.language || DEFAULT_LOCALE
  return useMemo(() => makeApi(code), [code])
}
