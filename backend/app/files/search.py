"""파일 검색 — 색인(file_index) 위에서 질의·랭킹·스니펫을 만든다.

질의 문법
---------
평범한 낱말은 이름/본문에 대한 부분일치다. 앞에 연산자를 붙이면 좁혀진다.

    보고서 ext:pdf                  확장자
    계약 kind:mail                  아카이브된 메일(.eml)
    예산 kind:sheet                 종류(doc/sheet/slide/pdf/image/video/audio/archive/code)
    회의록 in:프로젝트               경로에 '프로젝트' 가 들어가는 폴더 아래만
    "분기 실적"                      따옴표 = 구(句) 그대로
    계약서 after:2026-01-01          수정일
    로그 size:>10mb                  크기

랭킹
----
이름이 맞는 게 본문이 맞는 것보다 위다. 같은 이름 일치라도 정확히 같음 >
앞에서 시작 > 중간 포함 순. 거기에 trigram 유사도와 최신순 보정을 더한다.
한글은 형태소 분석기 없이 tsvector 를 쓰면 토큰이 통째로 잡혀 부분일치가
안 된다. 그래서 pg_trgm 기반 ILIKE 로 간다.
"""

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import Float, and_, case, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import FileIndex

# kind -> 확장자 집합
KINDS: dict[str, set[str]] = {
    "doc": {"doc", "docx", "hwp", "hwpx", "odt", "rtf", "txt", "md"},
    "sheet": {"xls", "xlsx", "csv", "tsv", "ods"},
    "slide": {"ppt", "pptx", "odp"},
    "pdf": {"pdf"},
    "mail": {"eml", "msg"},
    "image": {"jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "tiff", "ico"},
    "video": {"mp4", "mkv", "avi", "mov", "wmv", "webm", "m4v", "ts", "flv"},
    "audio": {"mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"},
    "archive": {"zip", "7z", "rar", "tar", "gz", "bz2", "xz", "iso"},
    "code": {"py", "js", "ts", "tsx", "jsx", "vue", "go", "rs", "java", "c", "h", "cpp",
             "cs", "rb", "php", "sh", "ps1", "sql", "json", "yaml", "yml", "html", "css"},
}

_SIZE_UNITS = {"b": 1, "kb": 1024, "mb": 1024 ** 2, "gb": 1024 ** 3, "tb": 1024 ** 4}


@dataclass
class Parsed:
    terms: list[str] = field(default_factory=list)      # 자유 낱말
    phrases: list[str] = field(default_factory=list)    # 따옴표로 묶인 구
    exts: set[str] = field(default_factory=set)
    kinds: set[str] = field(default_factory=set)
    in_paths: list[str] = field(default_factory=list)
    after: datetime | None = None
    before: datetime | None = None
    min_size: int | None = None
    max_size: int | None = None
    dirs_only: bool = False
    files_only: bool = False

    @property
    def needles(self) -> list[str]:
        return self.phrases + self.terms


def _parse_size(v: str) -> int | None:
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?", v.strip().lower())
    if not m:
        return None
    return int(float(m.group(1)) * _SIZE_UNITS.get(m.group(2) or "b", 1))


def _parse_date(v: str) -> datetime | None:
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            return datetime.strptime(v.strip(), fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def parse_query(raw: str) -> Parsed:
    p = Parsed()
    # 따옴표로 묶인 구를 먼저 떼어낸다
    for m in re.finditer(r'"([^"]+)"', raw):
        p.phrases.append(m.group(1).strip())
    rest = re.sub(r'"[^"]+"', " ", raw)

    for tok in rest.split():
        low = tok.lower()
        if ":" in tok:
            key, _, val = tok.partition(":")
            key, val = key.lower(), val.strip()
            if not val:
                continue
            if key in ("ext", "확장자"):
                p.exts.add(val.lower().lstrip("."))
                continue
            if key in ("kind", "type", "종류"):
                if val.lower() in KINDS:
                    p.kinds.add(val.lower())
                elif val.lower() in ("dir", "folder", "폴더"):
                    p.dirs_only = True
                elif val.lower() in ("file", "파일"):
                    p.files_only = True
                continue
            if key in ("in", "경로", "path"):
                p.in_paths.append(val)
                continue
            if key in ("after", "since", "이후"):
                p.after = _parse_date(val) or p.after
                continue
            if key in ("before", "until", "이전"):
                p.before = _parse_date(val) or p.before
                continue
            if key in ("size", "크기"):
                if val.startswith(">"):
                    p.min_size = _parse_size(val[1:])
                elif val.startswith("<"):
                    p.max_size = _parse_size(val[1:])
                else:
                    n = _parse_size(val)
                    if n:
                        p.min_size = n
                continue
        if low:
            p.terms.append(tok)
    return p


def make_snippet(content: str | None, needles: list[str], width: int = 110) -> str | None:
    """본문에서 검색어 주변을 잘라 온다. 어디서 걸렸는지 보여주는 게 목적."""
    if not content or not needles:
        return None
    low = content.lower()
    pos = -1
    hit = ""
    for n in needles:
        i = low.find(n.lower())
        if i >= 0 and (pos < 0 or i < pos):
            pos, hit = i, n
    if pos < 0:
        return None
    start = max(0, pos - width // 3)
    end = min(len(content), pos + len(hit) + width)
    s = content[start:end].strip()
    return ("…" if start > 0 else "") + s + ("…" if end < len(content) else "")


def build_query(scopes: list[str], p: Parsed, limit: int, offset: int, name_only: bool = False):
    """색인에 대한 SELECT 를 만든다. 점수 계산까지 SQL 안에서 끝낸다.

    name_only=True 면 낱말을 파일 **이름**에서만 찾는다(본문·경로 무시).
    정렬은 점수 → 수정 시각 → (scope, rel_path, id) 로 끝까지 결정적이다 — 점수 동점이 많아도
    offset 페이지 경계에서 겹치거나 빠지지 않는다."""
    needles = p.needles
    name_l = func.lower(FileIndex.name)
    path_l = func.lower(FileIndex.rel_path)
    content_l = func.lower(func.coalesce(FileIndex.content, ""))

    conds = [FileIndex.scope.in_(scopes)]

    # 낱말/구는 AND — 검색 엔진처럼 좁혀 들어가는 쪽이 자연스럽다
    for n in needles:
        like = f"%{n.lower()}%"
        if name_only:
            conds.append(name_l.like(like))
        else:
            conds.append(or_(name_l.like(like), path_l.like(like), content_l.like(like)))

    if p.exts:
        conds.append(FileIndex.ext.in_([e.lower() for e in p.exts]))
    if p.kinds:
        allowed: set[str] = set()
        for k in p.kinds:
            allowed |= KINDS.get(k, set())
        if allowed:
            conds.append(FileIndex.ext.in_(sorted(allowed)))
    for ip in p.in_paths:
        conds.append(path_l.like(f"%{ip.lower()}%"))
    if p.after:
        conds.append(FileIndex.mtime >= p.after)
    if p.before:
        conds.append(FileIndex.mtime <= p.before)
    if p.min_size is not None:
        conds.append(FileIndex.size >= p.min_size)
    if p.max_size is not None:
        conds.append(FileIndex.size <= p.max_size)
    if p.dirs_only:
        conds.append(FileIndex.is_dir.is_(True))
    if p.files_only:
        conds.append(FileIndex.is_dir.is_(False))

    # ── 점수 ──
    score = literal(0.0, Float)
    if needles:
        primary = needles[0].lower()
        exact = f"{primary}"
        starts = f"{primary}%"
        mid = f"%{primary}%"
        score = score + case(
            (name_l == exact, 1000.0),
            (name_l.like(starts), 600.0),
            (name_l.like(mid), 400.0),
            else_=0.0,
        )
        score = score + case((path_l.like(mid), 120.0), else_=0.0)
        score = score + case((content_l.like(mid), 90.0), else_=0.0)
        # 이름 유사도(오타·어순 흔들림 보정)
        score = score + func.similarity(name_l, primary) * 150.0
        # 나머지 낱말이 이름에 더 걸리면 가산
        for n in needles[1:]:
            score = score + case((name_l.like(f"%{n.lower()}%"), 60.0), else_=0.0)

    # 최신 파일 소폭 우대 — 동점일 때만 갈리도록 작게
    age_days = func.extract("epoch", func.now() - FileIndex.mtime) / 86400.0
    score = score + func.greatest(0.0, 30.0 - age_days) * 0.5
    # 폴더는 약간 뒤로(보통 파일을 찾는다)
    score = score + case((FileIndex.is_dir.is_(True), -40.0), else_=0.0)

    stmt = (
        select(
            FileIndex.scope, FileIndex.rel_path, FileIndex.parent_dir, FileIndex.name,
            FileIndex.ext, FileIndex.is_dir, FileIndex.size, FileIndex.mtime,
            FileIndex.mime, FileIndex.content, score.label("score"),
        )
        .where(and_(*conds))
        # 2차 기준(scope·rel_path·id)이 없으면 같은 점수·같은 시각끼리 순서가 매번 달라질 수 있다
        .order_by(score.desc(), FileIndex.mtime.desc(), FileIndex.scope.asc(),
                  FileIndex.rel_path.asc(), FileIndex.id.asc())
        .limit(limit)
        .offset(offset)
    )
    count_stmt = select(func.count()).select_from(FileIndex).where(and_(*conds))
    return stmt, count_stmt


def to_vpath(scope: str, rel_path: str, viewer_id: str) -> str:
    """색인의 (scope, rel_path) 를 사용자가 보는 가상경로로 되돌린다."""
    if scope == "shared":
        return f"shared/{rel_path}".rstrip("/")
    if scope == viewer_id:
        return f"my/{rel_path}".rstrip("/")
    return f"users/{scope}/{rel_path}".rstrip("/")   # 관리자 열람 경로


async def search(
    db: AsyncSession,
    raw_query: str,
    scopes: list[str],
    viewer_id: str,
    limit: int = 100,
    offset: int = 0,
    name_only: bool = False,
) -> dict:
    p = parse_query(raw_query)
    if not (p.needles or p.exts or p.kinds or p.in_paths or p.after or p.before
            or p.min_size or p.max_size or p.dirs_only or p.files_only):
        return {"total": 0, "items": [], "query": raw_query}

    stmt, count_stmt = build_query(scopes, p, limit, offset, name_only=name_only)
    rows = (await db.execute(stmt)).all()
    total = (await db.execute(count_stmt)).scalar() or 0

    items = []
    for r in rows:
        items.append({
            "name": r.name,
            "path": to_vpath(r.scope, r.rel_path, viewer_id),
            "parent": to_vpath(r.scope, r.parent_dir, viewer_id) if r.parent_dir else
                      ("shared" if r.scope == "shared" else "my"),
            "is_dir": r.is_dir,
            "size": r.size,
            "modified_at": r.mtime,
            "mime_type": r.mime,
            "ext": r.ext,
            "score": round(float(r.score or 0), 1),
            "snippet": make_snippet(r.content, p.needles),
        })
    return {"total": total, "items": items, "query": raw_query}
