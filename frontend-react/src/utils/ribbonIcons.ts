/**
 * 리본 아이콘 — 24×24 stroke SVG 의 **내부 마크업**만 담는다.
 *
 * 문서·시트·슬라이드 리본이 같이 쓴다. 아이콘 패키지를 하나 더 물리지 않은 이유는
 * 어차피 Office 아이콘과 다르게 생겨서 얻는 게 없고, 쓰는 건 수십 개뿐이라서다.
 * 쓰는 쪽에서는 이렇게 그린다:
 *
 *   <svg viewBox="0 0 24 24" v-html="I.bold" class="rb-i16" />
 */
export const RIBBON_ICONS: Record<string, string> = {
  // 클립보드
  paste: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  brush: '<path d="M4 4h16v6H4z"/><path d="M12 10v4"/><rect x="9" y="14" width="6" height="7" rx="1"/>',

  // 글꼴
  grow: '<path d="m3 20 5.5-14L14 20M5.5 15h6"/><path d="M17 8h6M20 5v6"/>',
  shrink: '<path d="m3 20 5.5-14L14 20M5.5 15h6"/><path d="M17 8h6"/>',
  clear: '<path d="M4 7V4h15v3"/><path d="M13 4 9.5 20"/><path d="M7 20h6"/><path d="m16 13 5 5m0-5-5 5"/>',
  sub: '<path d="m4 5 8 10M12 5 4 15"/><path d="M20 20h-4c0-1.5 3-2 3-3.5 0-1-.8-1.5-1.7-1.5-.7 0-1.1.2-1.4.5"/>',
  sup: '<path d="m4 9 8 10M12 9 4 19"/><path d="M20 9h-4c0-1.5 3-2 3-3.5 0-1-.8-1.5-1.7-1.5-.7 0-1.1.2-1.4.5"/>',

  // 맞춤
  al: '<path d="M3 6h18M3 12h11M3 18h15"/>',
  ac: '<path d="M3 6h18M7 12h10M5 18h14"/>',
  ar: '<path d="M3 6h18M10 12h11M6 18h15"/>',
  aj: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  vtop: '<path d="M3 4h18"/><path d="M12 8v12M8 12l4-4 4 4"/>',
  vmid: '<path d="M3 12h18"/><path d="M12 3v6M9 6l3-3 3 3M12 21v-6M9 18l3 3 3-3"/>',
  vbot: '<path d="M3 20h18"/><path d="M12 4v12M8 12l4 4 4-4"/>',
  wrap: '<path d="M3 6h18M3 18h8"/><path d="M3 12h14a3 3 0 0 1 0 6h-3l2-2m-2 2 2 2"/>',
  mergecenter: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M9 5v14M15 5v14" stroke-dasharray="2 2"/><path d="M7 12h10M9 10l-2 2 2 2M15 10l2 2-2 2"/>',

  // 목록·들여쓰기
  ul: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
  ol: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M4 4h1v4"/><path d="M3.2 8h2.6"/><path d="M6 18H3.4c0-1.2 2.4-1.9 2.4-3 0-.7-.6-1.1-1.4-1.1-.6 0-1 .2-1.3.5"/>',
  indent: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="m3 8 3.5 4L3 16"/>',
  outdent: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M6.5 8 3 12l3.5 4"/>',
  lh: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M4 4v16M2 6l2-2 2 2M2 18l2 2 2-2"/>',

  // 서식·개체
  shade: '<rect x="3" y="4" width="18" height="10" rx="1"/><path d="M3 18h18M3 21h18"/>',
  border: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 12h18M12 3v18" stroke-dasharray="2 2"/>',
  quote: '<path d="M9 7H5a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h3v1a2 2 0 0 1-2 2"/><path d="M20 7h-4a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h3v1a2 2 0 0 1-2 2"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  shape: '<circle cx="8" cy="8" r="5"/><rect x="12" y="12" width="9" height="9" rx="1"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v3M12 9v9M17 12v6"/>',
  pie: '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M14 2.5A9 9 0 0 1 21.5 10H14z"/>',
  line: '<path d="M3 3v18h18"/><path d="m6 15 4-5 4 3 5-7"/>',
  video: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l2.5-2.5a5 5 0 0 0-7-7L11.5 6"/><path d="M14 11a5 5 0 0 0-7.5-.5L4 13a5 5 0 0 0 7 7l1.5-1.5"/>',
  bookmark: '<path d="M19 21 12 16 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  header: '<rect x="3" y="3" width="18" height="6" rx="1"/><path d="M3 13h18M3 17h12M3 21h15"/>',
  footer: '<rect x="3" y="15" width="18" height="6" rx="1"/><path d="M3 3h18M3 7h12M3 11h15"/>',
  textbox: '<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M8 10h8M8 14h5"/>',
  datetime: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  omega: '<path d="M7 20h3c-3-2-4.5-4.5-4.5-7.5A6.5 6.5 0 0 1 12 6a6.5 6.5 0 0 1 6.5 6.5c0 3-1.5 5.5-4.5 7.5h3"/>',
  formula: '<path d="M5 4h9l-5 8 5 8H5"/><path d="M15 9h5M17.5 6.5v5"/>',
  sigma: '<path d="M18 4H6l7 8-7 8h12"/>',
  hr: '<path d="M3 12h18"/>',
  cover: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  newpage: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M12 8v8M8 12h8"/>',
  pagebreak: '<path d="M6 3h12v6H6zM6 15h12v6H6z"/><path d="M2 12h20" stroke-dasharray="3 2"/>',

  // 편집·찾기
  find: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  replace: '<path d="M4 7h11l-3-3M20 17H9l3 3"/><path d="M20 7v4M4 17v-4"/>',
  select: '<path d="M3 3h6M3 3v6M21 3h-6M21 3v6M3 21h6M3 21v-6M21 21h-6M21 21v-6"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.7 3L3 13"/>',
  redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3L21 13"/>',

  // 데이터
  sortaz: '<path d="M6 4v16M3 17l3 3 3-3"/><path d="M13 6h8M13 12h6M13 18h4"/>',
  sortza: '<path d="M6 4v16M3 17l3 3 3-3"/><path d="M13 6h4M13 12h6M13 18h8"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  dedupe: '<rect x="3" y="3" width="12" height="12" rx="1"/><path d="M9 9h12v12H9z"/><path d="m12 15 2 2 4-4"/>',
  freeze: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M9 3v18" stroke-width="2.4"/>',
  gridlines: '<rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18" stroke-dasharray="2 2"/>',
  headings: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 8h18M8 3v18" /><path d="M3 3h18v5H3z" fill="currentColor" stroke="none" opacity=".25"/>',

  // 디자인·배경
  theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" opacity=".35"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.6 1.5-1.3 0-.9-.9-1.3-.9-2.2 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/>',
  fontset: '<path d="m4 20 6-14 6 14M6.5 15h7"/><path d="M18 12h4"/>',
  spacing: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 4v16"/>',
  watermark: '<path d="M12 3s6 6.5 6 10.5A6 6 0 0 1 6 13.5C6 9.5 12 3 12 3z"/>',
  pagecolor: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 14h18"/>',
  pageborder: '<rect x="2" y="2" width="20" height="20" rx="1" stroke-dasharray="3 2"/><rect x="6" y="6" width="12" height="12" rx="1"/>',
  margin: '<rect x="3" y="3" width="18" height="18" rx="1"/><rect x="7" y="7" width="10" height="10" rx="1" stroke-dasharray="2 2"/>',
  orient: '<rect x="6" y="3" width="12" height="18" rx="1"/><path d="m19 8 2 2-2 2"/>',
  size: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 7h8M8 11h8"/>',
  columns: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M12 3v18"/>',

  // 참조·검토
  toc: '<path d="M4 5h4M4 12h4M4 19h4"/><path d="M11 5h9M11 12h9M11 19h9"/>',
  footnote: '<path d="M4 4h10M4 9h10M4 14h7"/><path d="M14 20h5M16 17v6"/><path d="M4 20h6"/>',
  citation: '<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="18" cy="18" r="3"/>',
  caption: '<rect x="3" y="4" width="18" height="11" rx="1"/><path d="M6 19h12"/>',
  spell: '<path d="m3 16 5-12 5 12M4.8 12h6.4"/><path d="m15 15 3 3 5-6"/>',
  wordcount: '<path d="M4 6h16M4 12h16M4 18h9"/><circle cx="18" cy="18" r="3"/>',
  track: '<path d="M12 20h8"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  protect: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',

  // 보기·인쇄
  print: '<path d="M6 9V2h12v7"/><rect x="6" y="14" width="12" height="8"/><path d="M6 18H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2"/>',
  ruler: '<rect x="2" y="8" width="20" height="8" rx="1"/><path d="M6 8v3M10 8v4M14 8v3M18 8v4"/>',
  zoom: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6M11 8v6"/>',
  onepage: '<rect x="7" y="3" width="10" height="18" rx="1"/>',
  manypage: '<rect x="3" y="3" width="8" height="18" rx="1"/><rect x="13" y="3" width="8" height="18" rx="1"/>',
  width: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  read: '<path d="M2 5h8a3 3 0 0 1 2 1 3 3 0 0 1 2-1h8v14h-8a3 3 0 0 0-2 1 3 3 0 0 0-2-1H2z"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7v.5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 7 10-7"/>',
  merge: '<path d="M3 5h6M3 12h6M3 19h6"/><path d="m12 12 4-4v8z" fill="currentColor" stroke="none"/><path d="M17 12h4"/>',

  // 슬라이드
  slide: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  newslide: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M12 7v7M8.5 10.5h7"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M9 9v12"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',
  transition: '<rect x="2" y="5" width="9" height="14" rx="1"/><rect x="13" y="5" width="9" height="14" rx="1" stroke-dasharray="3 2"/><path d="m11 12 2 0"/>',
  animate: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="3.5"/><path d="m5.6 5.6 2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  notes: '<path d="M4 4h16v12H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
  grid4: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
}
