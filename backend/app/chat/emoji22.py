"""커스텀 이모지(chat22) — 검증·정규화·직렬화. 엔드포인트는 router22.

- 이름 `^[a-z0-9_]{2,32}$`, 워크스페이스 내 유일. 본문·리액션에서는 `:name:`.
- 형식 png·gif·webp·jpeg(Pillow 로 실제 형식을 확인한다 — 업로드 측이 전달한 Content-Type 은 신뢰하지 않는다), 256KB 이하.
- 128px 로 축소(정적 이미지만, 비율 유지). 애니메이션 gif/webp 는 원본 유지(프레임 재인코딩은 크기·품질이 저하된다).
"""

from __future__ import annotations

import io
import re

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ChatEmoji, User

NAME_RE = re.compile(r"^[a-z0-9_]{2,32}$")
CUSTOM_RE = re.compile(r"^:([a-z0-9_]{2,32}):$")
MAX_BYTES = 256 * 1024
MAX_EMOJIS = 200
SIZE = 128
_FORMATS = {"PNG": "image/png", "GIF": "image/gif", "WEBP": "image/webp", "JPEG": "image/jpeg"}


class EmojiError(ValueError):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def normalize(data: bytes) -> tuple[bytes, str, bool]:
    """(바이트, content_type, animated). Pillow 가 열지 못하면 bad_type."""
    if len(data) > MAX_BYTES:
        raise EmojiError(413, "too_large", "이모지는 256KB 이하여야 합니다")
    try:
        from PIL import Image
    except ImportError:   # 의존성에는 포함(requirements Pillow) — 없으면 검증 없이 png 만 허용
        if not data.startswith(b"\x89PNG"):
            raise EmojiError(400, "bad_type", "PNG·GIF·WebP·JPEG 이미지만 업로드할 수 있습니다")
        return data, "image/png", False
    try:
        im = Image.open(io.BytesIO(data))
        fmt = im.format
        im.load()
    except Exception:
        raise EmojiError(400, "bad_type", "PNG·GIF·WebP·JPEG 이미지만 업로드할 수 있습니다")
    if fmt not in _FORMATS:
        raise EmojiError(400, "bad_type", "PNG·GIF·WebP·JPEG 이미지만 업로드할 수 있습니다")
    animated = bool(getattr(im, "is_animated", False) and getattr(im, "n_frames", 1) > 1)
    if animated or (im.width <= SIZE and im.height <= SIZE):
        return data, _FORMATS[fmt], animated
    im.thumbnail((SIZE, SIZE))
    out = io.BytesIO()
    if fmt == "JPEG":
        im.convert("RGB").save(out, "JPEG", quality=90)
    elif fmt == "GIF":
        im.save(out, "GIF")
    else:
        im.save(out, fmt)
    return out.getvalue(), _FORMATS[fmt], False


def check_name(name: str) -> str:
    n = (name or "").strip().strip(":").lower()
    if not NAME_RE.fullmatch(n):
        raise EmojiError(400, "name_invalid", "이름은 영문 소문자·숫자·밑줄 2–32자입니다")
    return n


async def name_taken(db: AsyncSession, name: str, exclude_id: str | None = None) -> bool:
    q = select(ChatEmoji.id).where(ChatEmoji.name == name)
    if exclude_id:
        q = q.where(ChatEmoji.id != exclude_id)
    return (await db.execute(q.limit(1))).scalar_one_or_none() is not None


async def count(db: AsyncSession) -> int:
    return int((await db.execute(select(func.count(ChatEmoji.id)))).scalar() or 0)


def emoji_url(e: ChatEmoji) -> str:
    ts = int(e.updated_at.timestamp()) if e.updated_at else 0
    return f"/api/chat/emojis/{e.id}/image?v={ts}"


def to_dict(e: ChatEmoji, creator: User | None) -> dict:
    return {
        "id": e.id,
        "name": e.name,
        "url": emoji_url(e),
        "animated": bool(e.animated),
        "created_by": {"id": creator.id, "display_name": creator.display_name, "username": creator.username}
        if creator else None,
        "created_at": e.created_at,
    }


async def check_reaction_emoji(db: AsyncSession, emoji: str) -> bool:
    """리액션 값 검증 — `:name:` 형식이면 해당 커스텀 이모지가 존재해야 한다. 그 외(유니코드)는 그대로 통과."""
    m = CUSTOM_RE.fullmatch(emoji or "")
    if not m:
        return True
    try:
        return await name_taken(db, m.group(1))
    except Exception:
        return False
