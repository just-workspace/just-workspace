import { describe, expect, it } from 'vitest'
import {
  canMoveInto, expiryLabel, fileKind, formatSize, formatStamp, KIND_META, linkMeta, parentLabel,
  previewKind, rangeBetween, shareUrl, activityKey, sharedSubPath, canBundleLink, samePathSet,
  roleAtLeast, roleOf, roleLabelKey,
} from '~/lib/files'

describe('fileKind — 유형 아이콘 색 체계(시안 06-1 결정 8)', () => {
  it('폴더·문서·시트·슬라이드·PDF·이미지·압축·기타', () => {
    expect(fileKind({ name: '디자인 자료', is_dir: true })).toBe('folder')
    expect(fileKind({ name: '4분기 로드맵.docx' })).toBe('doc')
    expect(fileKind({ name: '예산안-v3.xlsx' })).toBe('sheet')
    expect(fileKind({ name: 'data.csv' })).toBe('sheet')
    expect(fileKind({ name: '킥오프.pptx' })).toBe('slide')
    expect(fileKind({ name: '계약서.PDF' })).toBe('pdf')
    expect(fileKind({ name: 'x', mime_type: 'application/pdf' })).toBe('pdf')
    expect(fileKind({ name: 'screenshot.png' })).toBe('img')
    expect(fileKind({ name: 'build-logs.zip' })).toBe('zip')
    expect(fileKind({ name: 'a.bin' })).toBe('file')
  })

  it('색 토큰은 시안 표와 같다(목록·그리드 공용)', () => {
    expect(KIND_META.folder.tone).toBe('text-warning')
    expect(KIND_META.doc.tone).toBe('text-primary')
    expect(KIND_META.sheet.tone).toBe('text-success')
    expect(KIND_META.slide.tone).toBe('text-warning')
    expect(KIND_META.pdf.tone).toBe('text-danger')
    expect(KIND_META.img.tone).toBe('text-muted-foreground')
    expect(KIND_META.zip.tone).toBe('text-muted-foreground')
  })
})

describe('previewKind — 클릭 = 열기', () => {
  it('이미지·PDF·텍스트만 미리보기, 오피스·폴더는 아님', () => {
    expect(previewKind({ name: 'a.png', mime_type: 'image/png' })).toBe('image')
    expect(previewKind({ name: 'a.pdf', mime_type: 'application/pdf' })).toBe('pdf')
    expect(previewKind({ name: 'README.md' })).toBe('text')
    expect(previewKind({ name: 'a.docx' })).toBeNull()
    expect(previewKind({ name: 'dir', is_dir: true })).toBeNull()
  })
})

describe('표기', () => {
  it('크기', () => {
    expect(formatSize(0)).toBe('—')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(240 * 1024)).toBe('240.0 KB')
  })
  it('수정 시각 10/15 10:40', () => {
    const iso = new Date(2026, 9, 15, 10, 40).toISOString()
    expect(formatStamp(iso)).toBe('10/15 10:40')
    expect(formatStamp(null)).toBe('—')
  })
  it('만료 선택지 라벨은 날짜를 붙인다', () => {
    const now = new Date(2026, 9, 15, 9, 0)
    expect(expiryLabel('7d', now)).toBe('10월 22일 (7일 뒤)')
    expect(expiryLabel('', now)).toBe('만료 없음')
  })
  it('링크 메타', () => {
    expect(linkMeta({ expires_at: null, max_downloads: 1, download_count: 0 })).toBe('만료 없음 · 1회용 · 다운로드 0회')
  })
  it('공유 주소 — 같이 편집은 /s/', () => {
    expect(shareUrl('https://x', 't', true)).toBe('https://x/s/t')
    expect(shareUrl('https://x', 't', false)).toBe('https://x/api/files/shared/t')
    expect(shareUrl('https://x', 't', false, { isFolder: true })).toBe('https://x/s/t')   // 폴더 링크는 둘러보기 화면
  })
  it('들어 있는 폴더 표기', () => {
    expect(parentLabel('my/프로젝트/a.txt')).toBe('내 파일 / 프로젝트')
  })
})

describe('선택·이동 판정', () => {
  const order = ['my/a', 'my/b', 'my/c', 'my/d']
  it('Shift 범위는 양방향', () => {
    expect(rangeBetween(order, 'my/b', 'my/d')).toEqual(['my/b', 'my/c', 'my/d'])
    expect(rangeBetween(order, 'my/d', 'my/b')).toEqual(['my/b', 'my/c', 'my/d'])
    expect(rangeBetween(order, null, 'my/c')).toEqual(['my/c'])
  })
  it('자기 자신·하위·같은 폴더로는 이동 불가', () => {
    expect(canMoveInto(['my/a'], 'my/a')).toBe(false)
    expect(canMoveInto(['my/a'], 'my/a/sub')).toBe(false)
    expect(canMoveInto(['my/x/a'], 'my/x')).toBe(false)
    expect(canMoveInto(['my/x/a'], 'my/y')).toBe(true)
    expect(canMoveInto(['my/ab'], 'my/a')).toBe(true)
  })
})

describe('p4 공유·활동 보조', () => {
  it('비밀번호·내려받기 막음 링크는 손님 화면(/s/)', () => {
    expect(shareUrl('https://x', 't', false, { hasPassword: true })).toBe('https://x/s/t')
    expect(shareUrl('https://x', 't', false, { allowDownload: false })).toBe('https://x/s/t')
    expect(shareUrl('https://x', 't', false, { hasPassword: false, allowDownload: true })).toBe('https://x/api/files/shared/t')
  })
  it('활동 키', () => {
    expect(activityKey('upload')).toBe('files.activity.upload')
    expect(activityKey('weird')).toBe('files.activity.other')
  })
  it('공유받은 하위 경로', () => {
    expect(sharedSubPath('shared-with-me/abc/폴더/a.txt')).toEqual({ shareId: 'abc', sub: '폴더/a.txt' })
    expect(sharedSubPath('shared-with-me/abc')).toEqual({ shareId: 'abc', sub: '' })
    expect(sharedSubPath('my/a')).toBeNull()
  })
  it('묶음 링크는 같은 루트 둘 이상', () => {
    expect(canBundleLink(['my/a', 'my/b'])).toBe(true)
    expect(canBundleLink(['my/a', 'shared/b'])).toBe(false)
    expect(canBundleLink(['my/a'])).toBe(false)
    expect(canBundleLink(['users/x/a', 'users/x/b'])).toBe(false)
    expect(samePathSet(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(samePathSet(['a'], ['a', 'b'])).toBe(false)
  })
})

describe('공유 권한 4단계(p9 · 보기 < 댓글 < 편집 < 공동 소유)', () => {
  it('roleAtLeast — 순서대로 비교, 내 항목(role 없음)은 소유자', () => {
    expect(roleAtLeast('view', 'comment')).toBe(false)
    expect(roleAtLeast('comment', 'comment')).toBe(true)
    expect(roleAtLeast('comment', 'edit')).toBe(false)
    expect(roleAtLeast('edit', 'comment')).toBe(true)
    expect(roleAtLeast('edit', 'owner')).toBe(false)
    expect(roleAtLeast('owner', 'edit')).toBe(true)
    expect(roleAtLeast(undefined, 'owner')).toBe(true)
  })
  it('roleOf — 예전 응답(role 없음)은 can_write 로', () => {
    expect(roleOf({ can_write: true })).toBe('edit')
    expect(roleOf({ can_write: false })).toBe('view')
    expect(roleOf({ role: 'comment', can_write: false })).toBe('comment')
    expect(roleOf({ role: 'owner', can_write: true })).toBe('owner')
  })
  it('roleLabelKey · 활동 키(댓글·공유 해제)', () => {
    expect(roleLabelKey('owner')).toBe('files.shareModal.role.owner')
    expect(activityKey('comment')).toBe('files.activity.comment')
    expect(activityKey('unshare_user')).toBe('files.activity.unshare_user')
  })
})
