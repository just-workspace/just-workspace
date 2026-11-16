"""파일 도구 등록 공통 — 오류 변환·공통 입력 칸·카드 요약."""

from __future__ import annotations

import functools
import os

from app.mcp.tools._common import err, http_err

DST_FOLDER_PARAM = {
    "type": "string", "default": "",
    "description": "Folder to save the result in (virtual path, needs edit permission). Empty = the default "
                   "`my/AI 결과물/<YYYY-MM-DD> <conversation title>` folder.",
    "x-label": "저장 폴더", "x-editable": True,
}
OUTPUT_NAME_PARAM = {
    "type": "string", "default": "",
    "description": "File name for the result (extension added if missing). Empty = derived from the source "
                   "name, e.g. `report (merged).pdf`. Never overwrites — a taken name becomes `name (2)`.",
    "x-label": "결과 파일 이름", "x-editable": True,
}
RESULT_NOTE = (" The result is saved as a NEW file (the source is never modified) and returned as "
               "`{path, name, size, mime}` (plus `files` for several outputs).")


def guard(fn):
    """처리부 예외(code·message 보유)와 라우터 HTTPException 을 도구 오류로 변환."""
    @functools.wraps(fn)
    async def wrapper(*a, **kw):
        try:
            return await fn(*a, **kw)
        except Exception as e:  # noqa: BLE001
            code = getattr(e, "code", None)
            msg = getattr(e, "message", None)
            if isinstance(code, str) and isinstance(msg, str):
                return err(code, msg)
            he = http_err(e)
            if he:
                return he
            raise
    return wrapper


def base(p: object) -> str:
    return os.path.basename(str(p or "").rstrip("/")) or str(p or "")


def risk_overwrite(args: dict) -> str:
    """덮어쓰기면 high(승인 대기함), 새 파일이면 low."""
    v = (args or {}).get("overwrite")
    return "high" if (v is True or str(v).lower() in ("true", "1", "yes")) else "low"
