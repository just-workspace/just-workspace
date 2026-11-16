/**
 * 저장된 본문 HTML(게시글·위키)을 읽기 화면에 삽입하기 전, 정화(DOMPurify) 이후 추가로 수행하는 필터.
 *
 * DOMPurify 기본 설정은 style 속성을 유지한다(정렬·표 너비 등에 사용). 그대로 두면 API 로 삽입한
 * `style="position:fixed;inset:0;z-index:9999"` 한 줄이 앱 전체를 덮는 링크가 된다(스크립트 없이도 화면 가로채기 가능).
 * 본 모듈은 "위치·겹침"을 변경하는 속성만 제거한다. 정렬·색·크기 등 나머지는 유지한다.
 */

/** 본문 영역을 벗어나거나 다른 요소를 덮을 수 있는 속성 */
const LAYOUT_PROP = /^(position|z-index|top|right|bottom|left|inset(-.+)?|transform(-.+)?|translate|scale|rotate|pointer-events|opacity|clip-path|mask(-.+)?|filter|backdrop-filter|mix-blend-mode)$/
/** 브라우저별 style 열거 차이로 인한 누락을 방지하기 위해 직접 제거도 수행한다 */
const LAYOUT_PROPS = [
  'position', 'z-index', 'top', 'right', 'bottom', 'left', 'inset', 'inset-block', 'inset-inline',
  'transform', 'translate', 'scale', 'rotate', 'pointer-events', 'opacity', 'clip-path', 'filter', 'backdrop-filter', 'mix-blend-mode',
]

/** 요소 하나의 인라인 style 에서 위치·겹침 속성을 제거한다(음수 바깥 여백 포함). 남는 속성이 없으면 style 속성 자체를 제거한다. */
export function stripLayoutStyle(el: HTMLElement): void {
  const st = el.style
  if (!st) return
  const names: string[] = []
  for (let i = 0; i < st.length; i++) names.push(st.item(i))
  for (const name of names) {
    const n = name.toLowerCase()
    // 음수 여백은 앞 요소 위로 이동시켜 덮는 데 사용됨
    if (LAYOUT_PROP.test(n) || (n.startsWith('margin') && st.getPropertyValue(name).includes('-'))) st.removeProperty(name)
  }
  for (const p of LAYOUT_PROPS) st.removeProperty(p)
  if (!el.getAttribute('style')?.trim()) el.removeAttribute('style')
}

/** 문서 조각 내 모든 style 속성에 stripLayoutStyle 적용 */
export function stripLayoutStylesIn(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[style]').forEach(stripLayoutStyle)
}

/** 정화된 HTML 문자열 → 위치·겹침 스타일을 제거한 HTML 문자열 */
export function stripLayoutStyles(html: string): string {
  if (!html || typeof DOMParser === 'undefined' || !/style\s*=/i.test(html)) return html
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  stripLayoutStylesIn(doc.body)
  return doc.body.innerHTML
}

/** HTML 의 텍스트만 추출(편집기 조작 전, 저장된 본문이 비어 있는지 확인할 때 사용) */
export function textOfHtml(html: string | null | undefined): string {
  if (!html) return ''
  if (typeof DOMParser === 'undefined') return html.replace(/<[^>]+>/g, ' ')
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.textContent ?? ''
}
