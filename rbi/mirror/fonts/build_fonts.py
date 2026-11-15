#!/usr/bin/env python3
"""고정 폰트 묶음 — 세션 이미지의 원격 Chromium 이 쓰는 **바로 그 폰트 파일**을 사용자 PC 용 WOFF2 로 바꾼다.

원격과 사용자 PC 가 같은 글리프 폭을 쓰게 하려는 것(글꼴이 다르면 글리프 폭이 12 % 까지 어긋난다).
원격 페이지가 내려보낸 폰트(@font-face)는 여기 없다 — 이건 이미지에 구운 데비안 패키지 폰트뿐이다.

입력(데비안 bookworm 패키지, Dockerfile 이 버전 고정):
  fonts-liberation2  — Liberation Sans/Serif/Mono (Arial·Times New Roman·Courier New 와 폭 호환, OFL-1.1)
  fonts-dejavu-core  — DejaVu Sans/Serif/Sans Mono (데비안 기본 sans/serif/monospace, Bitstream Vera 계열 자유 라이선스)
  fonts-noto-cjk     — Noto Sans CJK / Noto Serif CJK (KR 면만 꺼냄, OFL-1.1)
출력: <out>/<key>-<w><s>[-<n>].woff2 + <out>/fonts.json  [{key, file, weight, style, range}]
  라틴 폰트는 통째로(한 면 100~400KB). CJK 는 unicode-range 조각으로 나눠 쓰는 글자의 조각만 받게 한다:
  KS X 1001 한글 2,350자(자주 쓰는 글자) → 4조각, 나머지 한글 8,822자 → 12조각, 자모·기호·전각, KS X 1001 한자 4,888자 → 7조각, 라틴·숫자.
  (KS X 1001 밖 한자는 넣지 않는다 — 한국어 UI 에 거의 없다. 나오면 사용자 PC 의 시스템 폰트로 그려진다: 알려진 한계)

python3 build_fonts.py <out-dir>   (fontTools + brotli 필요)
"""
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTCollection, TTFont

LIB = '/usr/share/fonts/truetype/liberation2'
DJV = '/usr/share/fonts/truetype/dejavu'
NOTO = '/usr/share/fonts/opentype/noto'

# key, 파일, weight, style
LATIN = [
    ('lsans', f'{LIB}/LiberationSans-Regular.ttf', 400, 'normal'),
    ('lsans', f'{LIB}/LiberationSans-Bold.ttf', 700, 'normal'),
    ('lsans', f'{LIB}/LiberationSans-Italic.ttf', 400, 'italic'),
    ('lsans', f'{LIB}/LiberationSans-BoldItalic.ttf', 700, 'italic'),
    ('lserif', f'{LIB}/LiberationSerif-Regular.ttf', 400, 'normal'),
    ('lserif', f'{LIB}/LiberationSerif-Bold.ttf', 700, 'normal'),
    ('lserif', f'{LIB}/LiberationSerif-Italic.ttf', 400, 'italic'),
    ('lserif', f'{LIB}/LiberationSerif-BoldItalic.ttf', 700, 'italic'),
    ('lmono', f'{LIB}/LiberationMono-Regular.ttf', 400, 'normal'),
    ('lmono', f'{LIB}/LiberationMono-Bold.ttf', 700, 'normal'),
    ('lmono', f'{LIB}/LiberationMono-Italic.ttf', 400, 'italic'),
    ('lmono', f'{LIB}/LiberationMono-BoldItalic.ttf', 700, 'italic'),
    ('dsans', f'{DJV}/DejaVuSans.ttf', 400, 'normal'),
    ('dsans', f'{DJV}/DejaVuSans-Bold.ttf', 700, 'normal'),
    ('dserif', f'{DJV}/DejaVuSerif.ttf', 400, 'normal'),
    ('dserif', f'{DJV}/DejaVuSerif-Bold.ttf', 700, 'normal'),
    ('dmono', f'{DJV}/DejaVuSansMono.ttf', 400, 'normal'),
    ('dmono', f'{DJV}/DejaVuSansMono-Bold.ttf', 700, 'normal'),
]
# key, TTC, weight, 면 이름(TTC 하나에 Sans·Sans Mono 의 JP/KR/SC/TC/HK 가 다 들어 있다 — KR 면을 이름으로 고른다)
CJK = [
    ('cjks', f'{NOTO}/NotoSansCJK-Regular.ttc', 400, 'Noto Sans CJK KR'),
    ('cjks', f'{NOTO}/NotoSansCJK-Bold.ttc', 700, 'Noto Sans CJK KR'),
    ('cjkm', f'{NOTO}/NotoSansCJK-Regular.ttc', 400, 'Noto Sans Mono CJK KR'),
    ('cjkm', f'{NOTO}/NotoSansCJK-Bold.ttc', 700, 'Noto Sans Mono CJK KR'),
    ('cjkr', f'{NOTO}/NotoSerifCJK-Regular.ttc', 400, 'Noto Serif CJK KR'),
    ('cjkr', f'{NOTO}/NotoSerifCJK-Bold.ttc', 700, 'Noto Serif CJK KR'),
]


def ksx1001(cp: int) -> bool:
    """KS X 1001 완성형(2바이트)인가 — 파이썬 euc-kr 은 나머지 한글을 8바이트 조합형으로도 인코딩하므로 길이로 가른다"""
    try:
        return len(chr(cp).encode('euc-kr')) == 2
    except UnicodeEncodeError:
        return False


def chunks(seq, n):
    seq = list(seq)
    size = max(1, -(-len(seq) // n))
    return [seq[i:i + size] for i in range(0, len(seq), size)]


def cjk_slices():
    hangul = range(0xAC00, 0xD7A4)
    common = [c for c in hangul if ksx1001(c)]
    rare = [c for c in hangul if not ksx1001(c)]
    hanja = [c for c in range(0x4E00, 0xA000) if ksx1001(c)] + [c for c in range(0xF900, 0xFB00) if ksx1001(c)]
    misc = list(range(0x1100, 0x1200)) + list(range(0x3130, 0x3190)) + list(range(0x3000, 0x3040)) + list(range(0x3200, 0x3300)) \
        + list(range(0xFF00, 0xFFF0)) + list(range(0x2000, 0x2070)) + list(range(0x2100, 0x2200)) + list(range(0x2460, 0x2500)) \
        + list(range(0x25A0, 0x2700)) + list(range(0xA960, 0xA980)) + list(range(0xD7B0, 0xD800))
    latin = list(range(0x20, 0x7F)) + list(range(0xA0, 0x180))
    out = [('lat', latin), ('sym', misc)]
    out += [(f'k{i}', c) for i, c in enumerate(chunks(common, 4))]
    out += [(f'r{i}', c) for i, c in enumerate(chunks(rare, 12))]
    out += [(f'h{i}', c) for i, c in enumerate(chunks(hanja, 7))]
    return out


def unicode_range(cps):
    cps = sorted(set(cps))
    out, start, prev = [], None, None
    for c in cps:
        if start is None:
            start = prev = c
        elif c == prev + 1:
            prev = c
        else:
            out.append((start, prev))
            start = prev = c
    if start is not None:
        out.append((start, prev))
    return ', '.join(f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in out)


def kr_face(path, want):
    """TTC 에서 이름이 정확히 want 인 면을 고른다(없으면 실패 — 엉뚱한 면으로 구우면 폭이 어긋난다)"""
    col = TTCollection(path, lazy=True)
    for i, f in enumerate(col.fonts):
        if (f['name'].getDebugName(1) or '') == want:
            return i
    raise SystemExit(f'{path}: 면 {want!r} 없음')


def subset_one(job):
    src, index, cps, out, flavor = job
    f = TTFont(src, fontNumber=index, lazy=False) if src.endswith('.ttc') else TTFont(src)
    opt = Options()
    opt.flavor = flavor
    opt.layout_features = ['*']
    opt.name_IDs = ['*']
    opt.notdef_outline = True
    opt.hinting = False
    opt.desubroutinize = True
    if cps is None:
        f.flavor = flavor
        f.save(out)
    else:
        s = Subsetter(opt)
        s.populate(unicodes=cps)
        s.subset(f)
        f.flavor = flavor
        f.save(out)
    return out, os.path.getsize(out)


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    manifest, jobs = [], []
    for key, path, w, st in LATIN:
        name = f'{key}-{w}{"i" if st == "italic" else ""}.woff2'
        jobs.append((path, 0, None, os.path.join(out, name), 'woff2'))
        manifest.append({'key': key, 'file': name, 'weight': str(w), 'style': st})
    slices = cjk_slices()
    for key, path, w, face in CJK:
        idx = kr_face(path, face)
        for sname, cps in slices:
            name = f'{key}-{w}-{sname}.woff2'
            jobs.append((path, idx, cps, os.path.join(out, name), 'woff2'))
            manifest.append({'key': key, 'file': name, 'weight': str(w), 'style': 'normal', 'range': unicode_range(cps)})
    total = 0
    with ProcessPoolExecutor(max_workers=max(1, min(8, os.cpu_count() or 2))) as ex:
        for name, size in ex.map(subset_one, jobs):
            total += size
    with open(os.path.join(out, 'fonts.json'), 'w', encoding='utf-8') as fp:
        json.dump(manifest, fp, ensure_ascii=False)
    print(f'fonts: {len(manifest)} files, {total / 1024 / 1024:.1f} MiB → {out}')


if __name__ == '__main__':
    main()
