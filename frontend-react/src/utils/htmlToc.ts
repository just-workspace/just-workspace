/**
 * 위키 오른쪽 레일 "이 페이지" 목차: 본문 HTML 의 h1~h3 를 뽑고,
 * 읽기 화면에서는 제목에 id 를 붙여 클릭 이동이 되게 한다. 백엔드 TOC 가 없어(REVIEW 9-c) 클라이언트에서 만든다.
 */

export interface TocItem { id: string; level: 1 | 2 | 3; text: string; index: number }

export function headingId(text: string, index: number): string {
  const slug = text.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40)
  return `h-${index}${slug ? '-' + slug : ''}`
}

/** 제목 목록. index 는 h1~h3 전체에서의 순번(편집 화면에서 n 번째 제목으로 스크롤할 때 쓴다). */
export function extractToc(html: string): TocItem[] {
  if (!html || typeof DOMParser === 'undefined') return []
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  return Array.from(doc.body.querySelectorAll('h1, h2, h3')).map((el, index) => {
    const text = (el.textContent ?? '').trim()
    return { id: headingId(text, index), level: Number(el.tagName[1]) as 1 | 2 | 3, text, index }
  }).filter(h => h.text)
}

/** 읽기 화면용: 제목 요소에 id 를 붙인 HTML */
export function withHeadingIds(html: string): string {
  if (!html || typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  doc.body.querySelectorAll('h1, h2, h3').forEach((el, index) => {
    const text = (el.textContent ?? '').trim()
    if (text) el.id = headingId(text, index)
  })
  return doc.body.innerHTML
}
