"""워크스페이스 파일 → 메일 첨부 (S4 파일 전달 확장).

AI 도구(mail_save_draft·mail_send 의 attachments=[path])가 쓴다. 매번 **보내는 사람 권한**으로 다시 열고,
일반 첨부 한도(파일 하나 15MB · 합계 25MB — 작성 창 업로드와 같은 기준)를 넘으면 거절한다.

  * 보내기: 경로 → 바이트 → 기존 임시 첨부(blob, 30분) → SendMessageRequest.attachments
  * 임시저장: 초안 행(mail_drafts.file_attachments)에 경로·이름·크기만 둔다. 작성 창이 초안을 열 때
    (GET /api/mail/drafts/{id}) 그때 권한을 다시 보고 임시 첨부로 바꿔 돌려준다 — 바이트를 초안에 복사하지 않는다.
"""

from __future__ import annotations

import json
import mimetypes

from fastapi import HTTPException

MAX_FILE = 15 * 1024 * 1024
MAX_TOTAL = 25 * 1024 * 1024
MAX_COUNT = 20


class AttachError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


async def resolve(db, user, paths) -> list[dict]:
    """경로 목록 검사 → [{path, name, size, type}]. 못 읽거나 크면 AttachError."""
    from app.files import access as acc

    if paths in (None, "", []):
        return []
    if isinstance(paths, str):
        paths = [paths]
    if not isinstance(paths, list):
        raise AttachError("invalid_argument", "attachments 는 파일 경로의 배열이어야 합니다")
    if len(paths) > MAX_COUNT:
        raise AttachError("too_large", f"첨부는 {MAX_COUNT}개까지입니다")
    out, total = [], 0
    for p in paths:
        vp = str(p or "").strip("/")
        try:
            real = (await acc.resolve(db, user, vp, "view")).real
        except HTTPException as e:
            raise AttachError("forbidden" if e.status_code in (401, 403) else "not_found",
                              f"첨부할 수 없습니다(권한 없음 또는 없는 파일): {vp}")
        if not real.is_file():
            raise AttachError("invalid_argument", f"파일만 첨부할 수 있습니다(폴더는 files_zip 으로 묶으세요): {vp}")
        size = real.stat().st_size
        if size > MAX_FILE:
            raise AttachError("too_large", f"{real.name}: 첨부 한 개는 15MB까지입니다 — files_share_external 링크를 쓰세요")
        total += size
        if total > MAX_TOTAL:
            raise AttachError("too_large", "첨부 합계는 25MB까지입니다 — 큰 파일은 공유 링크로 보내세요")
        out.append({"path": vp, "name": real.name, "size": size,
                    "type": mimetypes.guess_type(real.name)[0] or "application/octet-stream"})
    return out


async def to_blobs(db, user, metas: list[dict]) -> list[dict]:
    """[{path,...}] → 작성 창·보내기용 임시 첨부 [{blobId, name, type, size}] (권한·크기 다시 확인)."""
    from app.mail.router import _store_temp_attachment
    from app.files import access as acc

    fresh = await resolve(db, user, [m["path"] for m in metas])
    out = []
    for m in fresh:
        real = (await acc.resolve(db, user, m["path"], "view")).real
        data = real.read_bytes()
        out.append(await _store_temp_attachment(data, m["name"], m["type"], user.id))
    return out


def dumps(metas: list[dict]) -> str | None:
    return json.dumps(metas, ensure_ascii=False) if metas else None


def loads(raw: str | None) -> list[dict]:
    try:
        v = json.loads(raw or "[]")
        return [x for x in v if isinstance(x, dict) and x.get("path")] if isinstance(v, list) else []
    except Exception:  # noqa: BLE001
        return []
