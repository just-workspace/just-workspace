"""파일 검색 색인기 — 저장소를 순회하여 이름과 본문을 Postgres 에 적재한다.

색인 도입 사유
--------------
과거 검색은 질의마다 os.walk 로 트리 전체를 순회하며 파일명 부분일치만 확인했다.
파일 15,000개·386GB 규모에서는 속도가 느리고, 내용 검색·랭킹·필터 추가도 불가하다.

색인 대상
---------
이름·확장자·크기·수정시각은 모든 항목에 대해 저장한다. 본문은 추출 가능한 형식만 대상으로 한다:
  - 순수 텍스트 계열(.txt .md .csv .log .json .py .ts ...)
  - .pdf(pypdf) / .docx(python-docx)
  - .xlsx / .pptx — 표준 라이브러리만 사용하는 ooxml 파서(app/files/ooxml.py)
본문에는 파일당 상한을 적용한다. 목적은 검색어 탐색이며 원문 보관이 아니다.

재색인 판정
-----------
(크기, 수정시각) 을 stamp 로 저장하고 동일하면 생략한다. 따라서 두 번째
전체 순회는 디스크 stat 만 확인한다(본문 추출은 신규/변경 파일만 대상).
"""

import asyncio
import hashlib
import json
import logging
import mimetypes
import os
import re
import resource
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import FileIndex, User
from app.db.session import async_session
from app.files.service import STORAGE_ROOT, is_hidden_name

logger = logging.getLogger(__name__)

# 본문 상한. 초과 시 앞부분만 저장.
MAX_CONTENT = 200_000
# 이보다 큰 파일은 본문을 추출하지 않고 이름만 색인.
MAX_EXTRACT_BYTES = 40 * 1024 * 1024
# 압축 문서(xlsx/pptx/docx)는 해제 시 수십 배로 증가하므로 더 낮게 설정.
MAX_OOXML_BYTES = 10 * 1024 * 1024

# 본문 추출은 별도 프로세스에서 수행한다. 파일 하나가 pypdf/openpyxl 내부에서
# 수 GB 를 점유하여 워커(=요청 처리 중인 프로세스)가 cgroup OOM 으로 종료된 사례가 있다.
# 자식 프로세스에 주소공간 상한을 설정하면 MemoryError 로 종료되고 워커는 영향을 받지 않는다.
EXTRACT_RLIMIT_AS = 1024 * 1024 * 1024
EXTRACT_TIMEOUT = 300

TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".log", ".json", ".xml", ".yml", ".yaml",
    ".ini", ".conf", ".cfg", ".sql", ".sh", ".bash", ".ps1", ".bat",
    ".py", ".js", ".ts", ".tsx", ".jsx", ".vue", ".go", ".rs", ".java", ".c", ".h",
    ".cpp", ".hpp", ".cs", ".rb", ".php", ".html", ".htm", ".css", ".scss", ".toml",
}
# 탭·개행은 앞 단계의 공백 정규화에서 이미 제거된다. 여기서 처리되는 것은 실제 제어문자뿐이다.
_CTRL_RE = re.compile("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")
SKIP_DIRS = {".trash", ".versions", ".thumbs", "__pycache__", "node_modules", ".git"}


def _stamp(size: int, mtime: float) -> str:
    return hashlib.sha1(f"{size}:{int(mtime)}".encode()).hexdigest()[:16]


def _read_text(path: Path) -> str:
    try:
        return path.read_bytes()[:MAX_CONTENT].decode("utf-8", errors="replace")
    except Exception:
        return ""


def _read_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader

        out: list[str] = []
        for page in PdfReader(str(path)).pages[:200]:   # 매우 긴 문서는 앞부분만 대상
            out.append(page.extract_text() or "")
            if sum(len(x) for x in out) > MAX_CONTENT:
                break
        return "\n".join(out)
    except Exception:
        return ""


def _read_docx(path: Path) -> str:
    try:
        import docx

        d = docx.Document(str(path))
        parts = [p.text for p in d.paragraphs]
        for t in d.tables:
            for row in t.rows:
                parts.extend(c.text for c in row.cells)
        return "\n".join(x for x in parts if x)
    except Exception:
        return ""


def _read_ooxml(path: Path, ext: str) -> str:
    """xlsx / pptx — app/files/ooxml.py 의 읽기 함수를 사용한다."""
    try:
        from app.files import ooxml

        data = path.read_bytes()
        if ext == ".xlsx":
            cells = (ooxml.xlsx_to_seed(data) or {}).get("cells") or {}
            vals = []
            for v in cells.values():
                if isinstance(v, dict):
                    vals.append(str(v.get("v", "")))
                else:
                    vals.append(str(v))
            return "\n".join(x for x in vals if x)
        if ext == ".pptx":
            out: list[str] = []
            for s in (ooxml.pptx_to_seed(data) or {}).get("slides", []):
                out.append(s.get("title") or "")
                out.extend(s.get("bullets") or [])
                out.append(s.get("notes") or "")
            return "\n".join(x for x in out if x)
    except Exception:
        pass
    return ""


def _read_eml(path: Path) -> str:
    """아카이브된 메일(.eml) — 헤더와 본문을 함께 추출한다.

    발신자·제목까지 색인해야 "김부장이 보낸 계약서" 같은 검색이 가능하다.
    첨부 본문은 여기서 읽지 않는다. 아카이버가 첨부를 별도 파일로 저장하므로
    해당 파일은 기존 PDF/docx 추출기가 처리한다.
    """
    import email
    from email import policy

    try:
        msg = email.message_from_bytes(path.read_bytes(), policy=policy.default)
    except Exception:
        return ""

    parts = []
    for h in ("From", "To", "Cc", "Subject", "Date"):
        v = msg.get(h)
        if v:
            parts.append(str(v))

    try:
        body = msg.get_body(preferencelist=("plain", "html"))
        if body is not None:
            text = body.get_content()
            if body.get_content_subtype() == "html":
                text = re.sub(r"<(script|style)[^>]*>.*?</>", " ", text, flags=re.S | re.I)
                text = re.sub(r"<[^>]+>", " ", text)
            parts.append(text)
    except Exception:
        pass

    return chr(10).join(p for p in parts if p)


def extract_content(path: Path, ext: str, size: int) -> str:
    if size > MAX_EXTRACT_BYTES:
        return ""
    if ext in (".docx", ".xlsx", ".pptx") and size > MAX_OOXML_BYTES:
        return ""
    if ext in TEXT_EXTS:
        text = _read_text(path)
    elif ext == ".pdf":
        text = _read_pdf(path)
    elif ext == ".docx":
        text = _read_docx(path)
    elif ext in (".xlsx", ".pptx"):
        text = _read_ooxml(path, ext)
    elif ext == ".eml":
        text = _read_eml(path)
    else:
        return ""
    # 공백 정규화 — 줄바꿈·들여쓰기가 많으면 용량만 증가한다
    text = " ".join(text.split())
    # NUL 은 Postgres text 에 저장할 수 없다(invalid byte sequence 0x00). 파일 하나만
    # 해당해도 배치 INSERT 전체가 롤백되어 색인이 매 주기 전부 실패했다.
    # 다른 제어문자도 검색에 의미가 없으므로 함께 제거한다.
    text = _CTRL_RE.sub(" ", text)
    # 짝 없는 서로게이트(cp949 등에서 잘못 디코딩된 잔여물)는 UTF-8 로 인코딩할 수
    # 없다. 추출은 자식 프로세스가 수행하고 결과를 json 으로 반환하는데, 한 글자만
    # 포함되어도 json.dumps 가 예외를 발생시켜 해당 묶음(수십~수백 파일) 전체가 유실되었다.
    if not text.isascii():
        text = text.encode("utf-8", "replace").decode("utf-8", "replace")
    return text[:MAX_CONTENT]


def _scan_scope(root: Path, scope: str, known: dict[str, str]) -> tuple[list[dict], set[str]]:
    """한 scope 를 순회하여 (갱신할 항목의 메타, 존재하는 rel_path 집합) 을 생성한다.

    known 은 {rel_path: stamp}. stamp 가 동일하면 생략한다.
    여기서는 stat 만 확인한다 — 본문 추출은 _fill_content 가 묶음 단위로 수행한다.
    전체를 한 번에 추출하여 보유하면 파일 15,000개 × 본문 200KB 가 워커 메모리에
    모두 적재되어 cgroup 한도(4GB)를 초과해 OOM 으로 종료되고, 커밋 전에 종료되므로
    다음 주기에 처음부터 재수행하는 무한 반복이 발생했다.
    """
    rows: list[dict] = []
    alive: set[str] = set()
    if not root.is_dir():
        return rows, alive

    for dirpath, dirnames, filenames in os.walk(root):
        # 숨김 판정은 service.is_hidden_name 으로 단일화 — 과거에는 "." 만 확인하여 NAS 휴지통(@Recycle) 내부까지 색인되었다
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not is_hidden_name(d)]
        base = Path(dirpath)
        rel_dir = base.relative_to(root).as_posix()
        rel_dir = "" if rel_dir == "." else rel_dir

        for name, is_dir in [(d, True) for d in dirnames] + [(f, False) for f in filenames]:
            if is_hidden_name(name):
                continue
            rel = f"{rel_dir}/{name}" if rel_dir else name
            alive.add(rel)

            p = base / name
            try:
                st = p.stat()
            except OSError:
                continue
            stamp = _stamp(0 if is_dir else st.st_size, st.st_mtime)
            if known.get(rel) == stamp:
                continue                      # 변경 없음 — 처리 생략

            ext = p.suffix.lower()
            rows.append({
                "scope": scope,
                "rel_path": rel,
                "parent_dir": rel_dir,
                "name": name,
                "ext": "" if is_dir else ext.lstrip("."),
                "is_dir": is_dir,
                "size": 0 if is_dir else st.st_size,
                "mtime": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
                "mime": None if is_dir else mimetypes.guess_type(name)[0],
                "stamp": stamp,
                "_path": p,
                "_ext": ext,
            })
    return rows, alive


def _limit_child():
    resource.setrlimit(resource.RLIMIT_AS, (EXTRACT_RLIMIT_AS, EXTRACT_RLIMIT_AS))


def _extract_many(items: list[tuple[str, str, int]]) -> list[str]:
    """(path, ext, size) 목록의 본문을 자식 프로세스에서 추출한다.

    자식 프로세스가 종료되거나(상한 초과·크래시) 제한 시간을 초과하면 묶음을 하나씩 재시도하여
    문제 파일 하나로 인해 나머지가 유실되지 않도록 한다. 그래도 실패하는 파일은 빈 본문으로 처리한다.
    """
    if not items:
        return []
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "app.files.indexer", "--extract"],
            input=json.dumps(items).encode(),
            capture_output=True,
            timeout=EXTRACT_TIMEOUT if len(items) > 1 else 60,
            preexec_fn=_limit_child,
        )
        if proc.returncode == 0:
            out = json.loads(proc.stdout)
            if isinstance(out, list) and len(out) == len(items):
                return out
        logger.warning("본문 추출 자식 실패 rc=%s (%d개): %s",
                       proc.returncode, len(items), proc.stderr[-300:].decode(errors="replace"))
    except subprocess.TimeoutExpired:
        logger.warning("본문 추출 시간 초과 (%d개)", len(items))
    except Exception:
        logger.exception("본문 추출 자식 실행 실패")
    if len(items) == 1:
        return [""]
    return [_extract_many([it])[0] for it in items]


def _fill_content(chunk: list[dict]) -> list[dict]:
    """묶음 하나의 본문을 추출하여 DB 행으로 변환한다(스레드에서 실행)."""
    todo = [(str(r["_path"]), r["_ext"], r["size"]) for r in chunk if not r["is_dir"]]
    texts = iter(_extract_many(todo))
    out: list[dict] = []
    for r in chunk:
        r.pop("_path"), r.pop("_ext")
        r["content"] = None if r["is_dir"] else (next(texts) or None)
        r["indexed_at"] = datetime.now(timezone.utc)
        out.append(r)
    return out


BATCH = 100


async def _sync_scope(db: AsyncSession, root: Path, scope: str) -> dict:
    rowsx = (await db.execute(
        select(FileIndex.rel_path, FileIndex.stamp).where(FileIndex.scope == scope)
    )).all()
    known = {r[0]: r[1] for r in rowsx}

    rows, alive = await asyncio.to_thread(_scan_scope, root, scope, known)

    # 묶음마다 본문 추출 → upsert → commit. 메모리는 묶음 하나 분량만 사용하며,
    # 중도 종료되어도 그때까지의 결과는 보존되어 다음 주기에 이어서 수행한다.
    updated = 0
    for i in range(0, len(rows), BATCH):
        chunk = await asyncio.to_thread(_fill_content, rows[i:i + BATCH])
        stmt = pg_insert(FileIndex).values(chunk)
        stmt = stmt.on_conflict_do_update(
            index_elements=["scope", "rel_path"],
            set_={
                "parent_dir": stmt.excluded.parent_dir,
                "name": stmt.excluded.name,
                "ext": stmt.excluded.ext,
                "is_dir": stmt.excluded.is_dir,
                "size": stmt.excluded.size,
                "mtime": stmt.excluded.mtime,
                "mime": stmt.excluded.mime,
                "content": stmt.excluded.content,
                "stamp": stmt.excluded.stamp,
                "indexed_at": stmt.excluded.indexed_at,
            },
        )
        await db.execute(stmt)
        await db.commit()
        updated += len(chunk)
        rows[i:i + BATCH] = [None] * len(chunk)   # 묶음 하나 완료 시 참조 해제
        await asyncio.sleep(0)

    gone = sorted(set(known) - alive)
    for i in range(0, len(gone), 500):
        await db.execute(
            delete(FileIndex).where(
                FileIndex.scope == scope, FileIndex.rel_path.in_(gone[i:i + 500])
            )
        )
    if gone:
        await db.commit()

    return {"scope": scope, "updated": updated, "removed": len(gone), "total": len(alive)}


async def reindex_all() -> list[dict]:
    """모든 scope(사용자별 + shared)를 1회 순회한다."""
    stats: list[dict] = []
    async with async_session() as db:
        uids = (await db.execute(select(User.id).where(User.is_active.is_(True)))).scalars().all()
        for uid in uids:
            stats.append(await _sync_scope(db, STORAGE_ROOT / "users" / uid, uid))
        stats.append(await _sync_scope(db, STORAGE_ROOT / "shared", "shared"))
    return stats


# ─── 즉시 색인(업로드·폴더 생성·이름 변경·이동 직후) ───
# 주기 색인(15분)만으로는 방금 업로드한 파일이 최대 15분간 검색되지 않았다. 변경된 경로만 이름·메타를 즉시 저장하고
# (본문과 stamp 는 비워 두어 다음 주기에 본문까지 채우도록 함), 이동·삭제된 기존 경로는 즉시 제거한다.
QUICK_MAX = 2000      # 폴더 이동 시 한 번에 저장하는 최대 항목 수(나머지는 주기 색인)
_quick_tasks: set[asyncio.Task] = set()


def scope_of(real: Path) -> tuple[str, Path] | None:
    """실제 경로 → (scope, scope 루트). 색인 대상(users/<id>/…, shared/…)이 아니면 None."""
    try:
        r = real.resolve()
        users = (STORAGE_ROOT / "users").resolve()
        shared = (STORAGE_ROOT / "shared").resolve()
        if r.is_relative_to(users) and r != users:
            uid = r.relative_to(users).parts[0]
            return uid, users / uid
        if r.is_relative_to(shared):
            return "shared", shared
    except (OSError, ValueError):
        return None
    return None


def _quick_rows(real: Path) -> list[dict]:
    sc = scope_of(real)
    if not sc or not real.exists():
        return []
    scope, root = sc
    out: list[dict] = []

    def add(p: Path) -> None:
        try:
            st = p.stat()
        except OSError:
            return
        rel = p.relative_to(root).as_posix()
        if not rel or rel == "." or any(is_hidden_name(part) for part in rel.split("/")):
            return
        is_dir = p.is_dir()
        parent = rel.rsplit("/", 1)[0] if "/" in rel else ""
        out.append({
            "scope": scope, "rel_path": rel, "parent_dir": parent, "name": p.name,
            "ext": "" if is_dir else p.suffix.lower().lstrip("."), "is_dir": is_dir,
            "size": 0 if is_dir else st.st_size,
            "mtime": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
            "mime": None if is_dir else mimetypes.guess_type(p.name)[0],
            "stamp": "", "content": None, "indexed_at": datetime.now(timezone.utc),
        })

    add(real)
    if real.is_dir():
        for dirpath, dirnames, filenames in os.walk(real):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not is_hidden_name(d)]
            for n in dirnames + filenames:
                if len(out) >= QUICK_MAX:
                    return out
                if not is_hidden_name(n):
                    add(Path(dirpath) / n)
    return out


def _upsert(db: AsyncSession, rows: list[dict]):
    if db.bind.dialect.name == "postgresql":
        stmt = pg_insert(FileIndex).values(rows)
    else:
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert
        stmt = sqlite_insert(FileIndex).values(rows)
    cols = ("parent_dir", "name", "ext", "is_dir", "size", "mtime", "mime", "content", "stamp", "indexed_at")
    return stmt.on_conflict_do_update(index_elements=["scope", "rel_path"],
                                      set_={c: getattr(stmt.excluded, c) for c in cols})


async def quick_index(db: AsyncSession, add: list[Path] | tuple = (), forget: list[Path] | tuple = ()) -> None:
    """add 경로(폴더면 하위까지)를 즉시 저장하고 forget 경로(및 그 하위)를 즉시 제거한다."""
    for real in forget:
        sc = scope_of(real)
        if not sc:
            continue
        scope, root = sc
        try:
            rel = real.resolve().relative_to(root).as_posix()
        except ValueError:
            continue
        if not rel or rel == ".":
            continue
        await db.execute(delete(FileIndex).where(
            FileIndex.scope == scope,
            (FileIndex.rel_path == rel) | FileIndex.rel_path.startswith(rel + "/"),
        ))
    for real in add:
        rows = await asyncio.to_thread(_quick_rows, real)
        for i in range(0, len(rows), BATCH):
            await db.execute(_upsert(db, rows[i:i + BATCH]))
    await db.commit()


def schedule_quick_index(add: list[Path] | tuple = (), forget: list[Path] | tuple = ()) -> None:
    """응답을 지연시키지 않도록 백그라운드에서 수행 — 실패해도 주기 색인이 최종적으로 반영한다."""
    async def run():
        try:
            async with async_session() as db:
                await quick_index(db, list(add), list(forget))
        except Exception:
            logger.warning("바로 색인 실패(주기 색인이 이어 맞춘다)", exc_info=True)
    try:
        t = asyncio.get_running_loop().create_task(run())
    except RuntimeError:
        return
    _quick_tasks.add(t)
    t.add_done_callback(_quick_tasks.discard)


_LOCK_KEY = "files:index:lock"
# 색인기의 실행 사실 자체를 기록한다.
# file_index.indexed_at 은 **파일이 변경된 시각**이므로 감시에 사용할 수 없다 — 변경된 파일이
# 없으면 색인기가 정상 동작해도 그 값은 수일간 갱신되지 않는다. 둘을 구분하지 않으면
# "색인기 중단"과 "최근 파일 변경 없음"이 동일한 신호로 나타난다.
_HEARTBEAT_KEY = "files:index:last_run"


async def run_indexer(interval_seconds: int = 900):
    """주기 색인. 워커 8개 중 Redis 락을 획득한 하나만 수행한다. 한 주기에서 예외가 발생해도 루프를 유지한다."""
    import time as _time

    from app.chat.redis_client import get_redis

    await asyncio.sleep(20)          # 기동 직후 혼잡 회피
    while True:
        try:
            redis = await get_redis()
            # 락 TTL 은 한 주기보다 길게 설정 — 최초 전체 색인(본문 추출)은 장시간 소요된다.
            got = await redis.set(_LOCK_KEY, "1", nx=True, ex=interval_seconds * 4)
            if got:
                try:
                    stats = await reindex_all()
                    changed = sum(s["updated"] + s["removed"] for s in stats)
                    # 변경이 없어도 기록한다. 정상 동작을 나타내는 유일한 근거이다.
                    await redis.set(_HEARTBEAT_KEY, str(int(_time.time())),
                                    ex=interval_seconds * 6)
                    if changed:
                        logger.info("파일 색인 갱신 %d건 (scope %d개)", changed, len(stats))
                finally:
                    await redis.delete(_LOCK_KEY)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("파일 색인 실패 — 다음 주기에 다시 시도한다")
        await asyncio.sleep(interval_seconds)


def _extract_main() -> None:
    """자식 모드: stdin 으로 [(path, ext, size)...] 를 수신하여 본문 목록을 JSON 으로 출력한다."""
    items = json.loads(sys.stdin.read())
    out: list[str] = []
    for path, ext, size in items:
        try:
            out.append(extract_content(Path(path), ext, int(size)))
        except BaseException:              # MemoryError 포함 — 해당 파일 하나만 제외
            out.append("")
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__" and "--extract" in sys.argv:
    _extract_main()
