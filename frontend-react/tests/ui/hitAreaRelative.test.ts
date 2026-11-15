// 히트 영역 확장(before:absolute before:-inset-*)은 그 요소가 relative 여야 자기 둘레만 넓힌다.
// relative 가 빠지면 가상 요소가 가장 가까운 positioned 조상(행 전체)을 덮어 다른 클릭을 가로챈다
// (위키 트리: 페이지 제목을 누르면 "하위 페이지 추가"가 눌리던 회귀).
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx|ts)$/.test(n)) out.push(p)
  }
  return out
}

describe('히트 영역 가상 요소', () => {
  it('before:absolute 를 쓰는 className 줄에는 relative 가 함께 있다', () => {
    const bad: string[] = []
    for (const f of walk(join(__dirname, '../../src'))) {
      readFileSync(f, 'utf-8').split('\n').forEach((line, i) => {
        if (line.includes('before:absolute') && !/\brelative\b/.test(line)) bad.push(`${f}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })
})
