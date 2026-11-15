"""S4 결과물 — AI 가 만든 파일·묶음(zip) 작업·만료 링크·내 파일 저장 (S4).

* 파일 하나(docs_create)는 바로 만든다. 여러 개(docs_create_bundle)와 파일 압축(files_zip)은 **서버 작업**
  (작업 id, 화면을 떠나도 계속) — 진행은 실시간 이벤트 ``ai.artifact_job`` 으로, 끝나면 알림도 남긴다.
* 묶음 일부가 실패하면 zip 에는 만든 것만 넣고 실패 항목 목록을 남긴다. [이것만 다시] = retry_item.
* 내려받기 링크는 24시간(서명 exp·sig) + **소유자 로그인** 둘 다 맞아야 한다. 지나면 "링크 만료" →
  [다시 만들기](저장해 둔 입력으로 다시 생성) 또는 내 파일에서 열기.
* 내 파일 저장: ``my/AI 결과물/YYYY-MM-DD 대화 제목/`` — 업로드와 같은 대상 판정·크기 상한·사용자 할당.
* 바이트는 ARTIFACT_DIR(임시)에 24시간, 행은 30일(다시 만들기용 입력 포함).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import time
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import delete, select

from app.ai import docgen
from app.ai.artifact_models import AIArtifact, AIArtifactJob
from app.files.service import is_hidden_name as _files_hidden

logger = logging.getLogger(__name__)

ARTIFACT_DIR = os.environ.get("AI_ARTIFACT_DIR", "/tmp/ws_ai_artifacts")
LINK_TTL = timedelta(hours=24)
KEEP_ROWS = timedelta(days=30)
STALE_JOB = timedelta(minutes=10)
MAX_BUNDLE = 10
ROOT_FOLDER = "AI 결과물"
DEFAULT_TITLE = "새 대화"
EVENT = "ai.artifact_job"
# 파일 압축(files_zip) 상한 — 관리자 설정(system_settings)으로 바꿀 수 있다
ZIP_MAX_FILES_KEY = "ai.zip.max_files"
ZIP_MAX_BYTES_KEY = "ai.zip.max_bytes"
ZIP_MAX_FILES = 2_000
ZIP_MAX_BYTES = 2 * 1024 ** 3
MANIFEST_NAME = "압축 목록.txt"
_ITEMS_OUT = 200             # 작업 응답에 싣는 항목 상한(실패 항목은 늘 먼저)

_STORED_EXT = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".avif", ".mp4", ".mov", ".mkv", ".webm", ".mp3", ".m4a",
    ".aac", ".ogg", ".flac", ".zip", ".gz", ".7z", ".rar", ".xz", ".zst", ".pdf", ".docx", ".xlsx", ".pptx",
    ".odt", ".ods", ".hwpx",
}
_BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

_build_sem = asyncio.Semaphore(2)     # 워커 하나에서 동시에 만드는 문서 수(CPU)
_tasks: set = set()
_last_sweep = 0.0


class ArtifactError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, **extra):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra


def session():
    """DB 세션 진입점 — 테스트가 바꿔 끼운다."""
    from app.db.session import async_session

    return async_session()


def _spawn(coro) -> None:
    """백그라운드 작업(테스트가 바꿔 끼워 직접 await 한다)."""
    t = asyncio.create_task(coro)
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt):
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _j(v) -> str:
    return json.dumps(v, ensure_ascii=False, default=str)


def _uj(s, default=None):
    if not s:
        return default
    try:
        return json.loads(s)
    except Exception:  # noqa: BLE001
        return default


def file_path(aid: str) -> str:
    return os.path.join(ARTIFACT_DIR, aid)


def _write_bytes(aid: str, data: bytes) -> None:
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    tmp = file_path(aid) + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, file_path(aid))


# ── 서명 링크 ─────────────────────────────────────────────────
def _sig(aid: str, user_id: str, exp: int) -> str:
    from app.config import get_settings

    key = (get_settings().secret_key or "").encode()
    return hmac.new(key, f"ai-artifact|{aid}|{user_id}|{exp}".encode(), hashlib.sha256).hexdigest()[:40]


def check_sig(a: AIArtifact, user_id: str, exp: object, sig: object) -> bool:
    try:
        exp_i = int(exp)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    if not isinstance(sig, str) or exp_i < int(time.time()):
        return False
    return a.user_id == user_id and hmac.compare_digest(sig, _sig(a.id, user_id, exp_i))


def download_url(a: AIArtifact, absolute: bool = False) -> str:
    exp = int(_aware(a.expires_at).timestamp())
    path = f"/api/ai/artifacts/{a.id}/download?exp={exp}&sig={_sig(a.id, a.user_id, exp)}"
    if absolute:
        from app.config import get_settings

        return (get_settings().app_url or "").rstrip("/") + path
    return path


# ── 상태 · 직렬화 ─────────────────────────────────────────────
def real_path(a: AIArtifact) -> str:
    """바이트 위치 — 파일 압축(files_zip)의 zip 은 내 파일에 저장된 그 파일, 나머지는 임시 디렉터리."""
    info = _uj(a.info, {}) or {}
    if info.get("source") == "files" and info.get("real"):
        return info["real"]
    return file_path(a.id)


def state(a: AIArtifact) -> str:
    if a.status == "failed":
        return "failed"
    if _aware(a.expires_at) <= _now() or not os.path.isfile(real_path(a)):
        return "expired"
    return "ready"


def _vp_label(vp: str | None) -> str | None:
    if not vp:
        return None
    from app.mcp.tools.files_write_tool import vp_label

    return vp_label(vp)


def artifact_out(a: AIArtifact, absolute: bool = False) -> dict:
    st = state(a)
    info = _uj(a.info, {}) or {}
    saved_folder = a.saved_path.rsplit("/", 1)[0] if a.saved_path else None
    return {
        "id": a.id,
        "format": a.format,
        "name": a.name,
        "label": docgen.FORMATS.get(a.format, {}).get("label") or ("압축 파일" if a.format == "zip" else a.format),
        "mime": a.mime,
        "size": int(a.size or 0),
        "status": st,
        "error": a.error,
        "pages": info.get("pages"),
        "sheets": info.get("sheets"),
        "slides": info.get("slides"),
        "files": info.get("files"),
        "conversation_id": a.conversation_id,
        "job_id": a.job_id,
        "can_rebuild": bool(a.spec) or bool(a.job_id and a.item_index is None),
        "download_url": download_url(a, absolute) if st == "ready" else None,
        "expires_at": _aware(a.expires_at).isoformat(),
        "created_at": _aware(a.created_at).isoformat() if a.created_at else None,
        "saved_path": a.saved_path,
        "saved_folder": saved_folder,
        "saved_label": _vp_label(saved_folder),
    }


def _items_out(items: list[dict]) -> list[dict]:
    if len(items) <= _ITEMS_OUT:
        return items
    bad = [x for x in items if x.get("status") in ("failed", "forbidden")]
    rest = [x for x in items if x.get("status") not in ("failed", "forbidden")]
    return (bad + rest)[:_ITEMS_OUT]


def job_out(job: AIArtifactJob, zip_art: AIArtifact | None = None, absolute: bool = False,
            title: str | None = None) -> dict:
    items = _uj(job.items, []) or []
    ok = sum(1 for x in items if x.get("status") == "ready")
    failed = sum(1 for x in items if x.get("status") in ("failed", "forbidden"))
    done = sum(1 for x in items if x.get("status") in ("ready", "failed", "forbidden"))
    z = artifact_out(zip_art, absolute) if zip_art is not None else None
    meta = _uj(job.meta, {}) or {}
    st = job.status
    if st in ("done", "partial") and z and z["status"] == "expired":
        st_link = "expired"
    else:
        st_link = z["status"] if z else None
    return {
        "id": job.id,
        "kind": job.kind or "docs",
        "name": job.name,
        "status": st,                       # running | done | partial | failed
        "link_status": st_link,             # ready | expired | failed | None(아직)
        "total": int(job.total or len(items)),
        "done": done,
        "ok": ok,
        "failed": failed,
        "size": sum(int(x.get("size") or 0) for x in items if x.get("status") == "ready"),
        "items": _items_out(items),
        "items_more": max(0, len(items) - _ITEMS_OUT),
        "zip": z,
        "conversation_id": job.conversation_id,
        "conversation_title": title,
        "saved_folder": job.saved_folder,
        "saved_label": _vp_label(job.saved_folder),
        "skipped": meta.get("skipped") or 0,
        "created_at": _aware(job.created_at).isoformat() if job.created_at else None,
        "finished_at": _aware(job.finished_at).isoformat() if job.finished_at else None,
    }


async def conversation_title(db, conv_id: str | None) -> str:
    if not conv_id:
        return DEFAULT_TITLE
    try:
        from app.ai.models import AIConversation

        c = await db.get(AIConversation, conv_id)
        t = (c.title or "").strip() if c else ""
        return t or DEFAULT_TITLE
    except Exception:  # noqa: BLE001
        return DEFAULT_TITLE


async def job_view(db, job: AIArtifactJob, absolute: bool = False) -> dict:
    z = await db.get(AIArtifact, job.zip_artifact_id) if job.zip_artifact_id else None
    out = job_out(job, z, absolute, await conversation_title(db, job.conversation_id))
    if (job.kind or "docs") == "docs":
        # 문서 묶음은 항목마다 미리보기·내려받기(카드 L1-1) — 항목 수는 MAX_BUNDLE 이하
        for it in out["items"]:
            a = await db.get(AIArtifact, it["artifact_id"]) if it.get("artifact_id") else None
            if a is not None:
                st = state(a)
                it["download_url"] = download_url(a, absolute) if st == "ready" else None
                it["link_status"] = st
    return out


# ── 정리 ──────────────────────────────────────────────────────
async def sweep(db, force: bool = False) -> int:
    """만료 지난 바이트 삭제 + 30일 지난 행 삭제. 워커마다 10분에 한 번."""
    global _last_sweep
    if not force and time.time() - _last_sweep < 600:
        return 0
    _last_sweep = time.time()
    n = 0
    try:
        rows = (await db.execute(select(AIArtifact.id).where(AIArtifact.expires_at < _now()))).scalars().all()
        for aid in rows:
            try:
                os.remove(file_path(aid))
                n += 1
            except FileNotFoundError:
                pass
        old = _now() - KEEP_ROWS
        await db.execute(delete(AIArtifact).where(AIArtifact.created_at < old))
        await db.execute(delete(AIArtifactJob).where(AIArtifactJob.created_at < old))
        await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("[artifacts] sweep failed", exc_info=True)
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
    return n


# ── 문서 하나 ─────────────────────────────────────────────────
async def _build_into(a: AIArtifact, spec: dict) -> None:
    """spec 으로 바이트를 만들어 a 에 반영(성공·실패 모두). 커밋은 호출자."""
    try:
        async with _build_sem:
            built = await asyncio.to_thread(docgen.build, spec)
        await asyncio.to_thread(_write_bytes, a.id, built.data)
        a.size = len(built.data)
        a.info = _j(built.info)
        a.status = "ready"
        a.error = None
    except Exception as e:  # noqa: BLE001 — 실패는 카드(다시 만들기)로 보인다
        logger.warning("[artifacts] build failed: %s", e, exc_info=True)
        a.status = "failed"
        a.error = (str(e) or e.__class__.__name__)[:500]
        a.size = 0
    a.created_at = a.created_at or _now()
    a.expires_at = _now() + LINK_TTL


async def create_artifact(db, user_id: str, spec: dict, conversation_id: str | None = None,
                          job_id: str | None = None, item_index: int | None = None) -> AIArtifact:
    """정리된 입력(docgen.normalize) → 파일 하나."""
    fmt = spec["format"]
    a = AIArtifact(id=str(uuid.uuid4()), user_id=user_id, conversation_id=conversation_id, job_id=job_id,
                   item_index=item_index, format=fmt, name=spec["filename"],
                   mime=docgen.FORMATS[fmt]["mime"], spec=_j(spec), created_at=_now())
    await _build_into(a, spec)
    db.add(a)
    await db.commit()
    await sweep(db)
    return a


async def get_owned(db, user, aid: str) -> AIArtifact:
    a = await db.get(AIArtifact, aid)
    if a is None or a.user_id != user.id:
        raise ArtifactError("not_found", "결과물이 없습니다", 404)
    return a


async def rebuild(db, user, aid: str) -> AIArtifact:
    """[다시 만들기] — 저장해 둔 입력으로 같은 결과물을 다시 만든다(같은 id, 새 24시간)."""
    a = await get_owned(db, user, aid)
    if a.format == "zip" and a.job_id:
        await rebuild_job(db, user, a.job_id)
        return await get_owned(db, user, aid)
    spec = _uj(a.spec)
    if not spec:
        raise ArtifactError("gone", "원래 입력이 남아 있지 않아 다시 만들 수 없습니다", 410)
    await _build_into(a, spec)
    a.saved_path = a.saved_path   # 저장 기록은 그대로
    await db.commit()
    if a.job_id and a.item_index is not None:
        job = await db.get(AIArtifactJob, a.job_id)
        if job is not None:
            _set_item(job, a.item_index, status=a.status, artifact_id=a.id, size=a.size, error=a.error)
            await db.commit()
    return a


# ── 묶음 작업 ─────────────────────────────────────────────────
def _set_item(job: AIArtifactJob, idx: int, **kw) -> None:
    items = _uj(job.items, []) or []
    if 0 <= idx < len(items):
        items[idx].update(kw)
        job.items = _j(items)
        job.updated_at = _now()


def _zip_name(name: str) -> str:
    return docgen.safe_filename(name or "결과물", "zip", fallback="결과물")


async def start_bundle(db, user_id: str, specs: list[dict], name: str, conversation_id: str | None) -> AIArtifactJob:
    """문서 여러 개 → 작업 id 를 바로 돌려주고 백그라운드에서 만든다."""
    items = [{"index": i, "name": s["filename"], "format": s["format"], "status": "pending",
              "artifact_id": None, "size": 0, "error": None} for i, s in enumerate(specs)]
    job = AIArtifactJob(id=str(uuid.uuid4()), user_id=user_id, conversation_id=conversation_id, kind="docs",
                        name=_zip_name(name or (specs[0].get("title") if specs else "") or "결과물"),
                        status="running", total=len(specs), items=_j(items), specs=_j(specs),
                        created_at=_now(), updated_at=_now())
    db.add(job)
    await db.commit()
    _spawn(run_job(job.id))
    return job


async def _emit(db, job: AIArtifactJob, finished: bool = False) -> None:
    try:
        from app.realtime.events import emit_to_user

        await emit_to_user(job.user_id, {"type": EVENT, "finished": finished, "job": await job_view(db, job)})
    except Exception:  # noqa: BLE001
        logger.debug("[artifacts] emit failed", exc_info=True)


async def _notify_done(db, job: AIArtifactJob) -> None:
    try:
        from app.notifications.service import create_notification

        items = _uj(job.items, []) or []
        ok = sum(1 for x in items if x.get("status") == "ready")
        title = await conversation_title(db, job.conversation_id)
        if job.kind == "files_zip":
            head = (f"파일 {ok}개를 압축했습니다" if ok == len(items) else f"파일 {ok}/{len(items)}개를 압축했습니다")
        else:
            head = (f"파일 {ok}개를 다 만들었습니다" if ok == len(items) else f"파일 {ok}/{len(items)}개를 만들었습니다")
        if ok == 0:
            head = "파일을 만들지 못했습니다"
        link = f"/ai?c={job.conversation_id}" if job.conversation_id else "/ai"
        await create_notification(db, job.user_id, "system", title=head, body=f"대화 “{title}”", link=link)
    except Exception:  # noqa: BLE001
        logger.debug("[artifacts] notify failed", exc_info=True)


def _unique(name: str, used: set[str]) -> str:
    if name.lower() not in used:
        used.add(name.lower())
        return name
    stem, ext = os.path.splitext(name)
    n = 2
    while f"{stem} ({n}){ext}".lower() in used:
        n += 1
    out = f"{stem} ({n}){ext}"
    used.add(out.lower())
    return out


def _write_docs_zip(zid: str, entries: list[tuple[str, str]]) -> int:
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    tmp = file_path(zid) + ".part"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for src, arc in entries:
            zf.write(src, arc)
    os.replace(tmp, file_path(zid))
    return os.path.getsize(file_path(zid))


async def _zip_artifact(db, job: AIArtifactJob) -> AIArtifact:
    z = await db.get(AIArtifact, job.zip_artifact_id) if job.zip_artifact_id else None
    if z is None:
        z = AIArtifact(id=str(uuid.uuid4()), user_id=job.user_id, conversation_id=job.conversation_id,
                       job_id=job.id, item_index=None, format="zip", name=job.name, mime="application/zip",
                       created_at=_now(), expires_at=_now() + LINK_TTL)
        db.add(z)
        job.zip_artifact_id = z.id
    return z


async def _finish_docs(db, job: AIArtifactJob) -> None:
    items = _uj(job.items, []) or []
    used: set[str] = set()
    entries = []
    for it in items:
        if it.get("status") == "ready" and it.get("artifact_id") and os.path.isfile(file_path(it["artifact_id"])):
            entries.append((file_path(it["artifact_id"]), _unique(it["name"], used)))
    z = await _zip_artifact(db, job)
    if entries:
        try:
            z.size = await asyncio.to_thread(_write_docs_zip, z.id, entries)
            z.status, z.error = "ready", None
        except Exception as e:  # noqa: BLE001
            z.status, z.error, z.size = "failed", str(e)[:500], 0
    else:
        z.status, z.error, z.size = "failed", "만든 파일이 없습니다", 0
    z.info = _j({"files": len(entries)})
    z.expires_at = _now() + LINK_TTL
    _close(job, items)


def _close(job: AIArtifactJob, items: list[dict]) -> None:
    ok = sum(1 for x in items if x.get("status") == "ready")
    job.status = "done" if ok == len(items) and items else ("failed" if ok == 0 else "partial")
    job.finished_at = _now()
    job.updated_at = _now()


async def run_job(job_id: str) -> None:
    """백그라운드 실행 — 종류별로 나눈다. 어떤 오류도 작업을 running 으로 남기지 않는다."""
    async with session() as db:
        job = await db.get(AIArtifactJob, job_id)
        if job is None:
            return
        try:
            if job.kind == "files_zip":
                await _run_files_zip(db, job)
            else:
                await _run_docs(db, job)
        except Exception as e:  # noqa: BLE001
            logger.exception("[artifacts] job %s failed", job_id)
            items = _uj(job.items, []) or []
            for it in items:
                if it.get("status") in ("pending", "running"):
                    it.update(status="failed", error=str(e)[:300] or "오류")
            job.items = _j(items)
            _close(job, items)
            await db.commit()
        await _emit(db, job, finished=True)
        await _notify_done(db, job)


async def _run_docs(db, job: AIArtifactJob) -> None:
    specs = _uj(job.specs, []) or []
    for i, spec in enumerate(specs):
        items = _uj(job.items, []) or []
        if i >= len(items) or items[i].get("status") == "ready":
            continue
        _set_item(job, i, status="running")
        await db.commit()
        await _emit(db, job)
        old = items[i].get("artifact_id")
        a = await db.get(AIArtifact, old) if old else None
        if a is None:
            a = await create_artifact(db, job.user_id, spec, job.conversation_id, job.id, i)
        else:
            await _build_into(a, spec)
        _set_item(job, i, status=a.status, artifact_id=a.id, size=a.size, error=a.error)
        await db.commit()
        await _emit(db, job)
    await _finish_docs(db, job)
    await db.commit()


async def get_job(db, user, job_id: str) -> AIArtifactJob:
    job = await db.get(AIArtifactJob, job_id)
    if job is None or job.user_id != user.id:
        raise ArtifactError("not_found", "작업이 없습니다", 404)
    # 워커가 다시 시작돼 멈춘 작업 — 남은 항목을 실패로 닫는다(만든 것만 zip)
    if job.status == "running" and _aware(job.updated_at) < _now() - STALE_JOB:
        items = _uj(job.items, []) or []
        for it in items:
            if it.get("status") in ("pending", "running"):
                it.update(status="failed", error="서버가 다시 시작돼 중단됐습니다")
        job.items = _j(items)
        if job.kind == "files_zip":
            await _zip_files(db, job)
        else:
            await _finish_docs(db, job)
        await db.commit()
    return job


async def retry_item(db, user, job_id: str, index: int) -> AIArtifactJob:
    """[이것만 다시] — 실패한 항목 하나를 다시 만들고 zip 을 다시 묶는다."""
    job = await get_job(db, user, job_id)
    if job.status == "running":
        raise ArtifactError("conflict", "아직 만드는 중입니다", 409)
    items = _uj(job.items, []) or []
    if not 0 <= index < len(items):
        raise ArtifactError("not_found", "항목이 없습니다", 404)
    if job.kind == "files_zip":
        _set_item(job, index, status="pending", error=None)
        await _zip_files(db, job)
    else:
        specs = _uj(job.specs, []) or []
        spec = specs[index] if index < len(specs) else None
        if not spec:
            raise ArtifactError("gone", "원래 입력이 없습니다", 410)
        old = items[index].get("artifact_id")
        a = await db.get(AIArtifact, old) if old else None
        if a is None:
            a = await create_artifact(db, job.user_id, spec, job.conversation_id, job.id, index)
        else:
            await _build_into(a, spec)
        _set_item(job, index, status=a.status, artifact_id=a.id, size=a.size, error=a.error)
        await _finish_docs(db, job)
    await db.commit()
    await _emit(db, job, finished=True)
    return job


async def rebuild_job(db, user, job_id: str) -> AIArtifactJob:
    """만료된 묶음 [다시 만들기] — 전부 다시(백그라운드)."""
    job = await get_job(db, user, job_id)
    if job.status == "running":
        raise ArtifactError("conflict", "아직 만드는 중입니다", 409)
    items = _uj(job.items, []) or []
    for it in items:
        if job.kind == "files_zip" or it.get("status") != "ready" or not (
                it.get("artifact_id") and os.path.isfile(file_path(it["artifact_id"]))):
            it.update(status="pending", error=None)
    job.items = _j(items)
    job.status = "running"
    job.finished_at = None
    job.updated_at = _now()
    await db.commit()
    _spawn(run_job(job.id))
    return job


# ── 파일 압축(files_zip) ──────────────────────────────────────
SYNC_MAX_FILES = 500                  # 이 아래(그리고 SYNC_MAX_BYTES 아래)면 바로 만들어 결과를 돌려준다
SYNC_MAX_BYTES = 200 * 1024 ** 2
ENCODINGS = ("utf-8", "cp949")
CONFLICTS = ("preserve_paths", "suffix")


async def zip_limits(db) -> tuple[int, int]:
    from app.admin.settings import get_setting

    async def _int(key, default):
        try:
            v = await get_setting(db, key)
            return max(1, int(v)) if v not in (None, "") else default
        except Exception:  # noqa: BLE001
            return default
    return await _int(ZIP_MAX_FILES_KEY, ZIP_MAX_FILES), await _int(ZIP_MAX_BYTES_KEY, ZIP_MAX_BYTES)


def _human(n: int) -> str:
    from app.mcp.tools._common import human_size

    return human_size(n) or f"{n} B"


async def collect_files(db, user, *, paths: list[str] | None = None, folder: str | None = None,
                        query: str | None = None, search_path: str = "", name_only: bool = False,
                        max_files: int = ZIP_MAX_FILES, conflict: str = "preserve_paths") -> tuple[list[dict], int]:
    """입력 → 압축할 항목 [{path, arc, size, status, error}], 상한으로 뺀 수.

    폴더는 하위 전체·구조 유지. 검색은 files_search 와 같은 조건으로 끝까지. 못 읽는 경로는 status=forbidden
    (manifest·skipped 에 '권한 없음'). 이름 충돌은 conflict 모드로(_assign_arcs).
    """
    from fastapi import HTTPException

    from app.files import access as acc

    roots: list[str] = []
    for p in paths or []:
        if isinstance(p, str) and p.strip("/"):
            roots.append(p.strip("/"))
    if folder and folder.strip("/"):
        roots.append(folder.strip("/"))
    if query and query.strip():
        roots.extend(await _search_all(db, user, query.strip(), search_path, name_only, max_files + 1))

    items: list[dict] = []
    seen: set[str] = set()
    over = 0

    def add(vp: str, base: str, size: int, status: str = "pending", error: str | None = None):
        nonlocal over
        if vp in seen:
            return
        seen.add(vp)
        if len(items) >= max_files:
            over += 1
            return
        items.append({"index": len(items), "path": vp, "rel": base, "name": base.rsplit("/", 1)[-1],
                      "size": int(size or 0), "status": status, "error": error})

    for vp in roots:
        try:
            a = await acc.resolve(db, user, vp, "view")
        except HTTPException as e:
            add(vp, vp.rsplit("/", 1)[-1], 0, "forbidden" if e.status_code in (401, 403) else "failed",
                "권한 없음" if e.status_code in (401, 403) else ("없는 파일" if e.status_code == 404 else str(e.detail)))
            continue
        real = a.real
        if real.is_file():
            add(vp, real.name, real.stat().st_size)
        elif real.is_dir():
            top = real.name or vp.rsplit("/", 1)[-1]
            for p in sorted(await asyncio.to_thread(lambda r=real: list(r.rglob("*")))):
                if p.is_symlink() or not p.is_file():
                    continue
                rel = p.relative_to(real).as_posix()
                if any(_files_hidden(seg) for seg in rel.split("/")):
                    continue                     # 숨김(동기화 메타·NAS 시스템 폴더 등)은 넣지 않는다 — 판정은 files.service 한 곳
                add(f"{vp}/{rel}", f"{top}/{rel}", p.stat().st_size)
        else:
            add(vp, vp.rsplit("/", 1)[-1], 0, "failed", "없는 파일")
    _assign_arcs(items, conflict)
    return items, over


def _assign_arcs(items: list[dict], conflict: str = "preserve_paths") -> None:
    """zip 안 이름.

    preserve_paths(기본): 폴더째 넣은 건 구조 유지, 낱개 파일은 이름만 — 같은 이름이 둘 이상이면 원래 상대 경로
                         (my/·shared/ 머리만 뗀 경로)로 구분. 그래도 겹치면 " (2)".
    suffix: 낱개 파일은 늘 이름만, 겹치면 "이름 (2).확장자".
    """
    by_name: dict[str, int] = {}
    for it in items:
        by_name[it["name"].lower()] = by_name.get(it["name"].lower(), 0) + 1
    used: set[str] = set()
    for it in items:
        if "/" in it["rel"]:
            cand = it["rel"]
        elif conflict == "preserve_paths" and by_name[it["name"].lower()] > 1:
            parts = it["path"].split("/")
            cand = "/".join(parts[1:]) if len(parts) > 1 else it["name"]
        else:
            cand = it["name"]
        cand = "/".join(_BAD_NAME.sub("_", seg) for seg in cand.split("/") if seg not in ("", ".", ".."))
        it["arc"] = _unique(cand or it["name"], used)


async def _search_all(db, user, query: str, path: str, name_only: bool, cap: int) -> list[str]:
    from app.files import search as fsearch
    from app.mcp.tools.files_tool import _scopes_for

    vp = (path or "").strip("/")
    scopes = _scopes_for(user, vp)
    if not scopes:
        raise ArtifactError("forbidden", "이 경로에서 검색할 수 있는 범위가 없습니다", 403)
    q = query
    parts = vp.split("/", 1)
    if len(parts) > 1 and parts[0] in ("my", "shared"):
        q = f"{q} in:{parts[1]}"
    out: list[str] = []
    off = 0
    while len(out) < cap:
        kw = {"name_only": True} if name_only else {}
        res = await fsearch.search(db, q, scopes, user.id, limit=200, offset=off, **kw)
        rows = res.get("items") or []
        if not rows:
            break
        out.extend(it["path"] for it in rows if not it.get("is_dir"))
        off += len(rows)
        if off >= int(res.get("total") or 0):
            break
    return out[:cap]


def _dst_vp(dst_path: str, zip_name: str) -> str:
    """dst_path 검사 — my/ 아래 새 .zip 파일만."""
    vp = (dst_path or "").strip().replace("\\", "/").lstrip("/")
    if vp.endswith("/"):
        vp += zip_name
    if not (vp.startswith("my/") and len(vp) > 3):
        raise ArtifactError("invalid_argument", "dst_path 는 내 파일(my/…) 아래 새 파일 경로여야 합니다", 400,
                            hint="예: my/보고/자료.zip")
    if any(seg in ("", ".", "..") or _files_hidden(seg) for seg in vp.split("/")):
        raise ArtifactError("invalid_argument", "dst_path 에 쓸 수 없는 경로 조각이 있습니다", 400)
    if not vp.lower().endswith(".zip"):
        vp += ".zip"
    return vp


async def start_files_zip(db, user, *, name: str, conversation_id: str | None, paths=None, folder=None,
                          query=None, search_path: str = "", name_only: bool = False, dst_path: str = "",
                          encoding: str = "utf-8", conflict: str = "preserve_paths", dedupe: bool = False,
                          force_async: bool = False) -> tuple[AIArtifactJob, bool]:
    """(작업, 바로 끝났는지). 작으면 이 요청 안에서 만들고, 크면 백그라운드 작업 id."""
    from app.files import quota as file_quota

    encoding = (encoding or "utf-8").lower().replace("_", "-")
    if encoding == "utf8":
        encoding = "utf-8"
    if encoding not in ENCODINGS:
        raise ArtifactError("invalid_argument", "encoding 은 utf-8 또는 cp949 입니다", 400)
    conflict = conflict or "preserve_paths"
    if conflict not in CONFLICTS:
        raise ArtifactError("invalid_argument", "conflict 는 preserve_paths 또는 suffix 입니다", 400)
    zname = _zip_name(name or "파일 묶음")
    dst = _dst_vp(dst_path, zname) if dst_path else ""
    if dst:
        from app.files import access as acc

        exists = False
        try:
            exists = (await acc.resolve(db, user, dst, "view")).real.exists()
        except Exception:  # noqa: BLE001 — 아직 없는 경로(정상)
            exists = False
        if exists:
            raise ArtifactError("conflict", f"이미 있는 파일입니다: {dst} — 덮어쓰지 않습니다", 409,
                                hint="다른 dst_path 를 주거나 비워 두면 AI 결과물 폴더에 저장합니다")
        zname = dst.rsplit("/", 1)[-1]
    max_files, max_bytes = await zip_limits(db)
    items, over = await collect_files(db, user, paths=paths, folder=folder, query=query, search_path=search_path,
                                      name_only=name_only, max_files=max_files, conflict=conflict)
    if not items:
        raise ArtifactError("not_found", "압축할 파일이 없습니다", 404)
    total = sum(it["size"] for it in items if it["status"] == "pending")
    if total > max_bytes:
        raise ArtifactError("too_large", f"총 크기 {_human(total)} 가 상한 {_human(max_bytes)} 을 넘습니다", 413,
                            hint="폴더·검색 범위를 줄이거나 여러 번에 나눠 압축하세요",
                            total_bytes=total, max_bytes=max_bytes)
    room = await file_quota.room_left(db, user, "my")
    if room is not None and total > room:
        raise ArtifactError("too_large", f"내 파일 공간이 부족합니다(남은 공간 {_human(room)}, 필요 {_human(total)})", 413,
                            hint="파일을 정리하거나 범위를 줄이세요", room_bytes=room)
    job = AIArtifactJob(id=str(uuid.uuid4()), user_id=user.id, conversation_id=conversation_id, kind="files_zip",
                        name=zname, status="running", total=len(items), items=_j(items), specs="[]",
                        meta=_j({"paths": (paths or [])[:50], "folder": folder, "query": query,
                                 "search_path": search_path, "skipped": over, "max_files": max_files,
                                 "max_bytes": max_bytes, "dst": dst, "encoding": encoding, "conflict": conflict,
                                 "dedupe": bool(dedupe)}),
                        created_at=_now(), updated_at=_now())
    db.add(job)
    await db.commit()
    pending = sum(1 for it in items if it["status"] == "pending")
    if not force_async and pending <= SYNC_MAX_FILES and total <= SYNC_MAX_BYTES:
        await _run_files_zip(db, job)
        return job, True
    _spawn(run_job(job.id))
    return job, False


async def _run_files_zip(db, job: AIArtifactJob) -> None:
    await _zip_files(db, job, progress=True)
    await db.commit()


class _CP949Info(zipfile.ZipInfo):
    """옛 Windows 탐색기 호환 — 이름을 cp949 로(UTF-8 표시 끔). cp949 로 못 쓰는 이름만 UTF-8 + 표시."""

    def _encodeFilenameFlags(self):  # noqa: N802 — zipfile 내부 훅
        try:
            return self.filename.encode("cp949"), self.flag_bits & ~0x800
        except UnicodeEncodeError:
            return self.filename.encode("utf-8"), self.flag_bits | 0x800


def _sha256_file(p: Path) -> str:
    from app.mcp.tools.files_tool import _sha256

    return _sha256(p)


def _add_to_zip(zf: zipfile.ZipFile, real: Path, arc: str, cp949: bool) -> None:
    cls = _CP949Info if cp949 else zipfile.ZipInfo
    zi = cls.from_file(real, arc)
    zi.compress_type = zipfile.ZIP_STORED if real.suffix.lower() in _STORED_EXT else zipfile.ZIP_DEFLATED
    with open(real, "rb") as src, zf.open(zi, "w", force_zip64=zi.file_size > 0x7FFFFFFF) as dst:
        shutil.copyfileobj(src, dst, 1024 * 1024)


async def _zip_files(db, job: AIArtifactJob, progress: bool = False) -> None:
    """항목마다 권한을 다시 보고 zip 에 쓴다 → 내 파일(dst 또는 AI 결과물)에 새 파일로 둔다."""
    from fastapi import HTTPException

    from app.db.models import User
    from app.files import access as acc

    user = await db.get(User, job.user_id)
    items = _uj(job.items, []) or []
    meta = _uj(job.meta, {}) or {}
    cp949 = meta.get("encoding") == "cp949"
    dedupe = bool(meta.get("dedupe"))
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    tmp = os.path.join(ARTIFACT_DIR, f"{job.id}.zip.part")
    last_emit = time.monotonic()
    max_bytes = int(meta.get("max_bytes") or ZIP_MAX_BYTES)
    written = 0
    hashes: dict[str, str] = {}
    warnings: list[str] = []
    zf = await asyncio.to_thread(zipfile.ZipFile, tmp, "w", zipfile.ZIP_DEFLATED, True, 1)
    try:
        for it in items:
            # 다시 묶을 때는 이미 담은 것(ready)·중복(deduped)도 다시 본다. 실패·권한 없음은 [이것만 다시](pending)일 때만
            if it.get("status") not in ("pending", "running", "ready", "deduped"):
                continue
            try:
                a = await acc.resolve(db, user, it["path"], "view")
                real = a.real
                if not real.is_file():
                    raise FileNotFoundError(it["path"])
                size = real.stat().st_size
                if dedupe:
                    h = await asyncio.to_thread(_sha256_file, real)
                    if h in hashes:
                        it.update(status="deduped", same_as=hashes[h], size=size, error=None)
                        continue
                    hashes[h] = it["path"]
                if written + size > max_bytes:
                    it.update(status="failed", error="총 크기 상한 초과")
                    continue
                if cp949:
                    try:
                        it["arc"].encode("cp949")
                    except UnicodeEncodeError:
                        warnings.append(f"{it['arc']}: cp949 로 쓸 수 없어 UTF-8 로 넣었습니다")
                await asyncio.to_thread(_add_to_zip, zf, real, it["arc"], cp949)
                written += size
                it.update(status="ready", size=size, error=None)
            except HTTPException as e:
                it.update(status="forbidden" if e.status_code in (401, 403, 404) else "failed",
                          error="권한 없음" if e.status_code in (401, 403) else ("없는 파일" if e.status_code == 404 else str(e.detail)))
            except FileNotFoundError:
                it.update(status="failed", error="없는 파일")
            except Exception as e:  # noqa: BLE001
                it.update(status="failed", error=(str(e) or e.__class__.__name__)[:200])
            if progress and time.monotonic() - last_emit > 1.0:
                job.items = _j(items)
                job.updated_at = _now()
                await db.commit()
                await _emit(db, job)
                last_emit = time.monotonic()
        manifest = _manifest(job, items, int(meta.get("skipped") or 0))
        minfo = (_CP949Info if cp949 else zipfile.ZipInfo)(MANIFEST_NAME)
        minfo.compress_type = zipfile.ZIP_DEFLATED
        await asyncio.to_thread(zf.writestr, minfo, manifest)
    finally:
        await asyncio.to_thread(zf.close)
    ok = sum(1 for x in items if x.get("status") == "ready")
    z = await _zip_artifact(db, job)
    meta["warnings"] = warnings[:50]
    job.meta = _j(meta)
    if ok:
        try:
            vp, real_target = await _place_zip(db, user, job, z, tmp, meta)
            z.saved_path = vp
            z.size = real_target.stat().st_size
            z.status, z.error = "ready", None
            z.info = _j({"files": ok, "source": "files", "real": str(real_target)})
            from app.mcp.tools.files_write_tool import _undo_for

            meta["undo"] = (await _undo_for(db, user, vp))["args"]
            job.meta = _j(meta)
        except HTTPException as e:
            z.status, z.error, z.size = "failed", str(e.detail)[:500], 0
        except ArtifactError as e:
            z.status, z.error, z.size = "failed", e.message, 0
    else:
        z.status, z.error, z.size = "failed", "압축할 수 있는 파일이 없습니다", 0
        z.info = _j({"files": 0, "source": "files"})
    try:
        os.remove(tmp)
    except FileNotFoundError:
        pass
    z.expires_at = _now() + LINK_TTL
    job.items = _j(items)
    _close(job, items)


async def _place_zip(db, user, job: AIArtifactJob, z: AIArtifact, tmp: str, meta: dict) -> tuple[str, Path]:
    """만든 zip 을 내 파일에 새 파일로 — 남의 파일은 덮지 않는다(다시 묶을 때 이 작업이 만든 zip 만 바꾼다)."""
    from app.files import activity as act
    from app.files import indexer
    from app.files import quota as file_quota
    from app.files import router as fr
    from app.files import service as fs

    size = os.path.getsize(tmp)
    if z.saved_path:                                    # [이것만 다시] — 이 작업이 만든 zip 을 바꾼다
        vp_parent, name = z.saved_path.rsplit("/", 1)
        own = True
    elif meta.get("dst"):
        vp_parent, name = meta["dst"].rsplit("/", 1)
        own = False
    else:
        vp_parent, name = await target_folder(db, user, job.conversation_id, job.created_at), job.name
        own = False
    fs.ensure_user_dir(user)
    parent_norm, real_dir, a = await fr._upload_target(db, vp_parent, user)
    q_user, q_vp = await fr._quota_subject(db, a, user)
    await file_quota.ensure_room(db, q_user, q_vp, size)
    name = fr._safe_filename(name)
    if not own and (real_dir / name).exists():
        if meta.get("dst"):
            raise ArtifactError("conflict", f"이미 있는 파일입니다: {meta['dst']} — 덮어쓰지 않습니다", 409)
        used = {p.name.lower() for p in real_dir.iterdir()}
        name = _unique(name, used)
    target = real_dir / name

    def _move():
        part = real_dir / f".{name}.{job.id[:8]}.part"
        shutil.copyfile(tmp, part)
        if own:
            os.replace(part, target)
        else:
            try:
                os.link(part, target)              # 그 사이 생긴 파일도 덮지 않는다
            finally:
                part.unlink(missing_ok=True)
    try:
        await asyncio.to_thread(_move)
    except FileExistsError:
        raise ArtifactError("conflict", "이미 있는 파일입니다 — 덮어쓰지 않습니다", 409)
    fs.invalidate_cache(real_dir)
    indexer.schedule_quick_index(add=[target])
    await act.record(fr._child_key(a, name), user.id, "upload", {"size": size, "via": "ai"})
    return f"{parent_norm}/{name}", target


def _manifest(job: AIArtifactJob, items: list[dict], skipped: int) -> str:
    ok = [x for x in items if x.get("status") == "ready"]
    dup = [x for x in items if x.get("status") == "deduped"]
    bad = [x for x in items if x.get("status") not in ("ready", "deduped")]
    lines = [f"{job.name} — 압축 목록", f"만든 시각: {_now().isoformat(timespec='seconds')}",
             f"담은 파일 {len(ok)}개 · 빠진 파일 {len(bad)}개" + (f" · 같은 내용이라 뺀 파일 {len(dup)}개" if dup else "")
             + (f" · 상한으로 제외 {skipped}개" if skipped else ""), ""]
    if ok:
        lines.append("[담은 파일]")
        lines += [f"  {x['arc']}  ({_human(int(x.get('size') or 0))})" for x in ok]
        lines.append("")
    if dup:
        lines.append("[같은 내용이라 뺀 파일]")
        lines += [f"  {x['path']} = {x.get('same_as')}" for x in dup]
        lines.append("")
    if bad:
        lines.append("[빠진 파일]")
        lines += [f"  {x['path']} — {x.get('error') or '실패'}" for x in bad]
    return "\n".join(lines) + "\n"


async def zip_summary(db, job: AIArtifactJob, absolute: bool = False, with_job: bool = True) -> dict:
    """files_zip 결과 — 요약이 맨 앞(path·size·files), 그 뒤 skipped·deduped·undo, 카드용 job 은 맨 뒤."""
    view = await job_view(db, job, absolute)
    items = _uj(job.items, []) or []
    meta = _uj(job.meta, {}) or {}
    z = view.get("zip") or {}
    skipped = [{"path": x["path"], "reason": x.get("error") or "실패"} for x in items
               if x.get("status") in ("failed", "forbidden")]
    deduped = [{"path": x["path"], "same_as": x.get("same_as")} for x in items if x.get("status") == "deduped"]
    out: dict = {
        "status": job.status,
        "job_id": job.id,
        "path": z.get("saved_path"),
        "size": _human(int(z.get("size") or 0)) if z.get("status") == "ready" else None,
        "files": view["ok"],
        "progress": f"{view['done']}/{view['total']}",
        "skipped_count": len(skipped) + int(meta.get("skipped") or 0),
        "deduped_count": len(deduped),
        "skipped": skipped[:200],
        "deduped": deduped[:200],
    }
    if meta.get("skipped"):
        out["over_limit"] = int(meta["skipped"])
    if meta.get("warnings"):
        out["warnings"] = meta["warnings"]
    if meta.get("undo"):
        out["undo"] = {"tool": "files_undo_create", **meta["undo"]}
    if z.get("download_url"):
        out["download_url"] = z["download_url"]
        out["expires_at"] = z.get("expires_at")
    if z.get("status") == "failed" and z.get("error"):
        out["error"] = z["error"]
    if with_job:
        out["job"] = view
    return out


# ── 내 파일에 저장 ────────────────────────────────────────────
def _folder_name(created_at, title: str, tz) -> str:
    d = (_aware(created_at) or _now()).astimezone(tz).strftime("%Y-%m-%d")
    t = _BAD_NAME.sub(" ", title or DEFAULT_TITLE).strip().strip(".").strip()
    t = re.sub(r"\s+", " ", t)[:80] or DEFAULT_TITLE
    return f"my/{ROOT_FOLDER}/{d} {t}"


async def target_folder(db, user, conversation_id: str | None, created_at=None) -> str:
    from app.mcp.tools._common import user_tz

    return _folder_name(created_at, await conversation_title(db, conversation_id), user_tz(user))


async def quota_room(db, user) -> int | None:
    from app.files import quota as file_quota

    return await file_quota.room_left(db, user, "my")


async def artifacts_for(db, user, artifact_ids: list[str] | None = None, job_id: str | None = None) -> list[AIArtifact]:
    """저장할 결과물 — 묶음이면 만든 파일들(파일 압축이면 zip 하나)."""
    out: list[AIArtifact] = []
    if job_id:
        job = await get_job(db, user, job_id)
        if job.kind == "files_zip":
            z = await db.get(AIArtifact, job.zip_artifact_id) if job.zip_artifact_id else None
            if z is not None:
                out.append(z)
        else:
            for it in _uj(job.items, []) or []:
                if it.get("status") == "ready" and it.get("artifact_id"):
                    a = await db.get(AIArtifact, it["artifact_id"])
                    if a is not None:
                        out.append(a)
    for aid in artifact_ids or []:
        out.append(await get_owned(db, user, aid))
    if not out:
        raise ArtifactError("not_found", "저장할 결과물이 없습니다", 404)
    for a in out:
        if state(a) != "ready":
            raise ArtifactError("expired", f"{a.name}: 링크가 만료돼 파일이 없습니다 — 다시 만든 뒤 저장하세요", 410)
    return out


async def save_to_files(db, user, arts: list[AIArtifact], job_id: str | None = None) -> dict:
    """my/AI 결과물/날짜 제목/ 에 복사. 이름이 겹치면 " (2)". 할당이 모자라면 413(HTTPException)."""
    from app.files import access as acc
    from app.files import activity as act
    from app.files import indexer
    from app.files import quota as file_quota
    from app.files import router as fr
    from app.files import service as fs

    folder = await target_folder(db, user, arts[0].conversation_id, arts[0].created_at)
    fs.ensure_user_dir(user)
    try:
        existed = (await acc.resolve(db, user, folder, "edit")).real.exists()
    except Exception:  # noqa: BLE001
        existed = False
    max_mb, max_bytes = await fr._upload_max_bytes(db)
    for a in arts:
        if a.size > max_bytes:
            raise ArtifactError("too_large", f"{a.name}: 업로드 상한({max_mb}MB)을 넘습니다", 413)
    parent_norm, real_dir, acc_ = await fr._upload_target(db, folder, user)
    q_user, q_vp = await fr._quota_subject(db, acc_, user)
    await file_quota.ensure_room(db, q_user, q_vp, sum(int(a.size or 0) for a in arts))
    used = {p.name.lower() for p in real_dir.iterdir()} if real_dir.is_dir() else set()
    saved = []
    for a in arts:
        name = _unique(fr._safe_filename(a.name), used)
        target = real_dir / name

        def _copy(src=real_path(a), dst=target):
            with open(src, "rb") as fsrc, open(dst, "xb") as fdst:
                shutil.copyfileobj(fsrc, fdst, 1024 * 1024)
        await asyncio.to_thread(_copy)
        vp = f"{parent_norm}/{name}"
        a.saved_path = vp
        saved.append({"artifact_id": a.id, "path": vp, "name": name})
        indexer.schedule_quick_index(add=[target])
        await act.record(fr._child_key(acc_, name), user.id, "upload", {"size": a.size, "via": "ai"})
    fs.invalidate_cache(real_dir)
    if job_id:
        job = await db.get(AIArtifactJob, job_id)
        if job is not None:
            job.saved_folder = parent_norm
    await db.commit()
    out = {"folder": parent_norm, "folder_label": _vp_label(parent_norm), "files": saved}
    # 되돌리기: 새로 만든 폴더면 폴더째, 파일 하나면 그 파일
    from app.mcp.tools.files_write_tool import _undo_for

    if not existed:
        out["_undo"] = await _undo_for(db, user, parent_norm)
    elif len(saved) == 1:
        out["_undo"] = await _undo_for(db, user, saved[0]["path"])
    return out


# ── 채팅 SSE ──────────────────────────────────────────────────
ARTIFACT_TOOLS = ("docs_create", "docs_create_bundle", "files_zip")


def sse_payloads(tool_name: str, res: dict) -> list[dict]:
    """도구 결과 → SSE ``artifact`` 이벤트 묶음(채팅 결과물 카드). 메시지 meta.artifacts 에도 같은 모양으로 저장."""
    if tool_name not in ARTIFACT_TOOLS or not isinstance(res, dict) or not res.get("ok"):
        return []
    r = res.get("result") or {}
    if r.get("status") != "executed":
        return []
    inner = r.get("result") or {}
    if isinstance(inner.get("artifact"), dict):
        return [{"type": "file", "artifact": inner["artifact"]}]
    if isinstance(inner.get("job"), dict):
        return [{"type": "bundle", "job": inner["job"]}]
    return []
