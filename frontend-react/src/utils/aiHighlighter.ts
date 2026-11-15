// Vue 원본: frontend/utils/aiHighlighter.ts (내용 그대로)
// 공유 shiki 하이라이터 (코드블록 신택스 하이라이트). 최초 1회만 로드.
let _p: Promise<any> | null = null

export const AI_LANGS = [
  'javascript', 'typescript', 'tsx', 'jsx', 'python', 'bash', 'shell', 'json',
  'html', 'css', 'scss', 'vue', 'go', 'rust', 'java', 'c', 'cpp', 'csharp',
  'sql', 'yaml', 'markdown', 'php', 'ruby', 'dockerfile', 'ini', 'diff', 'xml',
  'kotlin', 'swift', 'toml', 'powershell',
]

export function getAiHighlighter(): Promise<any> {
  if (!_p) {
    _p = import('shiki').then(s => s.createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: AI_LANGS,
    }))
  }
  return _p
}
