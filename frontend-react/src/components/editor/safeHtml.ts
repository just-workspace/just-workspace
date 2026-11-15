/**
 * 저장된 본문 HTML(게시글·위키)을 읽기 화면에 넣기 전, 정화(DOMPurify) 뒤에 한 번 더 거르는 것.
 *
 * DOMPurify 기본 설정은 style 속성을 남긴다(정렬·표 너비 등에 쓴다). 그대로 두면 API 로 넣은
 * `style="position:fixed;inset:0;z-index:9999"` 한 줄이 앱 전체를 덮는 링크가 된다(스크립트 없이도 화면 가로채기).
 * 여기서는 "자리·겹침"을 바꾸는 속성만 지운다 — 정렬·색·크기 같은 나머지는 그대로 둔다.
 */

/** 본문 밖으로 나가거나 다른 것을 덮을 수 있는 속성 */
const LAYOUT_PROP = /^(position|z-index|top|right|bottom|left|inset(-.+)?|transform(-.+)?|translate|scale|rotate|pointer-events|opacity|clip-path|mask(-.+)?|filter|backdrop-filter|mix-blend-mode)$/
/** 브라우저마다 style 열거가 달라도 빠지지 않게 직접도 지운다 */
const LAYOUT_PROPS = [
  'position', 'z-index', 'top', 'right', 'bottom', 'left', 'inset', 'inset-block', 'inset-inline',
  'transform', 'translate', 'scale', 'rotate', 'pointer-events', 'opacity', 'clip-path', 'filter', 'backdrop-filter', 'mix-blend-mode',
]

/** 요소 하나의 인라인 style 에서 자리·겹침 속성을 지운다(음수 바깥 여백 포함). 남는 것이 없으면 속성째 지운다. */
export function stripLayoutStyle(el: HTMLElement): void {
  const st = el.style
  if (!st) return
  const names: string[] = []
  for (let i = 0; i < st.length; i++) names.push(st.item(i))
  for (const name of names) {
    const n = name.toLowerCase()
    // 음수 여백은 앞 요소 위로 끌어올려 덮는 데 쓰인다
    if (LAYOUT_PROP.test(n) || (n.startsWith('margin') && st.getPropertyValue(name).includes('-'))) st.removeProperty(name)
  }
  for (const p of LAYOUT_PROPS) st.removeProperty(p)
  if (!el.getAttribute('style')?.trim()) el.removeAttribute('style')
}

/** 문서 조각 안의 모든 style 속성에 stripLayoutStyle */
export function stripLayoutStylesIn(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[style]').forEach(stripLayoutStyle)
}

/** 정화된 HTML 문자열 → 자리·겹침 스타일을 지운 HTML 문자열 */
export function stripLayoutStyles(html: string): string {
  if (!html || typeof DOMParser === 'undefined' || !/style\s*=/i.test(html)) return html
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  stripLayoutStylesIn(doc.body)
  return doc.body.innerHTML
}

/** HTML 의 글자만(편집기를 건드리기 전, 저장된 본문이 비었는지 볼 때) */
export function textOfHtml(html: string | null | undefined): string {
  if (!html) return ''
  if (typeof DOMParser === 'undefined') return html.replace(/<[^>]+>/g, ' ')
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.textContent ?? ''
}
