"""외부 메일 아카이브 — 새 메일을 .eml 원본으로 파일 스토리지에 떨궈 둔다.

지금까지 외부 계정 메일은 우리 쪽에 하나도 안 남았다. 볼 때마다 IMAP 에서
실시간으로 끌어왔기 때문에, 계정이 정지되거나 해지되면 그대로 사라진다.

저장 위치를 파일 스토리지로 잡은 이유는, 파일 색인기가 이미 그 트리를 훑고 있어서
`.eml` 추출기만 붙이면 **메일 본문과 첨부가 기존 파일 검색에 그대로 편입**되기
때문이다. 별도 메일 검색 시스템을 만들 필요가 없다.

    my/메일보관/<계정주소>/<YYYY-MM>/<uid>_<제목>.eml
    my/메일보관/<계정주소>/<YYYY-MM>/첨부/<uid>_<파일명>

계정별로 끌 수 있고(MailAccount.archive_enabled) 기본값은 꺼짐이다.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from app.config import get_settings
from app.db.models import MailAccount

logger = logging.getLogger(__name__)
settings = get_settings()

def _client(account: MailAccount):
    """수신 프로토콜에 맞는 클라이언트. POP3 계정에 IMAP 을 쓰면 110 포트로 IMAP
    핸드셰이크를 시도하다 그대로 멈춘다(실제로 백필이 그렇게 걸렸다)."""
    from app.mail import imap_client, pop3_client
    return pop3_client if getattr(account, "protocol", "imap") == "pop3" else imap_client


ARCHIVE_DIRNAME = "메일보관"
ATTACH_DIRNAME = "첨부"

# 파일명에 쓸 수 없는 문자 + 제어문자
_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_MAX_NAME = 80


def _safe_name(s: str, fallback: str = "제목없음") -> str:
    s = _BAD_CHARS.sub("_", (s or "").strip())
    s = " ".join(s.split())
    s = s[:_MAX_NAME].rstrip(". ")
    return s or fallback


_UID_RE = re.compile(r"[A-Za-z0-9._-]{1,70}")
_USER_ID_RE = re.compile(r"[A-Za-z0-9-]{1,64}")


def uid_part(uid) -> str:
    """메시지 id → 파일 이름 조각. IMAP UID(숫자)는 그대로, 그 밖(POP3 UIDL 은 서버가 정한다)에
    경로 문자·상위 조각이 섞이면 해시로 바꾼다(같은 id 는 늘 같은 이름 — 중복 저장 판정 유지)."""
    u = str(uid)
    if _UID_RE.fullmatch(u) and u not in (".", "..") and not u.startswith(".."):
        return u
    import hashlib
    return "h" + hashlib.sha256(u.encode("utf-8", "surrogatepass")).hexdigest()[:32]


class ArchivePathError(ValueError):
    """보관 경로가 사용자 본인 보관 폴더를 벗어난다."""


def _user_root(user_id: str) -> Path:
    if not _USER_ID_RE.fullmatch(str(user_id or "")):
        raise ArchivePathError("invalid user id")
    return Path(settings.storage_root) / "users" / str(user_id)


def account_dir(user_id: str, account_email: str) -> Path:
    """계정 아카이브 루트. 사용자 파일 영역 안이라 파일 탭에서 그대로 보인다."""
    return _user_root(user_id) / ARCHIVE_DIRNAME / _safe_name(account_email, "account")


def ensure_within(path: Path, user_id: str, account_email: str) -> Path:
    """정규화한 최종 경로가 그 사용자·그 계정 보관 폴더 안인지(심볼릭 링크 포함)."""
    root = account_dir(user_id, account_email).resolve()
    real = path.resolve()
    if real != root and not real.is_relative_to(root):
        raise ArchivePathError("archive path escapes account dir")
    return path


def _month_dir(user_id: str, account_email: str, received_at: str | None) -> Path:
    dt = None
    if received_at:
        try:
            dt = datetime.fromisoformat(received_at.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            dt = None
    dt = dt or datetime.now(timezone.utc)
    return account_dir(user_id, account_email) / f"{dt.year:04d}-{dt.month:02d}"


def eml_path(user_id: str, account_email: str, uid: str, subject: str | None,
             received_at: str | None) -> Path:
    p = _month_dir(user_id, account_email, received_at) / f"{uid_part(uid)}_{_safe_name(subject or '')}.eml"
    return ensure_within(p, user_id, account_email)


def save_raw(user_id: str, account_email: str, uid: str, subject: str | None,
             received_at: str | None, raw: bytes) -> dict | None:
    """이미 받아 온 원본을 저장한다. 이미 있으면 None."""
    target = eml_path(user_id, account_email, uid, subject, received_at)
    if target.exists():
        return None
    target.parent.mkdir(parents=True, exist_ok=True)
    ensure_within(target, user_id, account_email)
    target.write_bytes(raw)
    n = _save_attachments(raw, target.parent, uid_part(uid), (user_id, account_email))
    return {"path": str(target), "attachments": n}


async def archive_many(account: MailAccount, messages: list[dict],
                       mailbox: str = "INBOX") -> dict:
    """여러 건을 연결 하나로 받아 저장한다(백필용)."""
    if not getattr(account, "archive_enabled", False):
        return {"saved": 0, "skipped": len(messages)}

    todo = []
    skipped = 0
    for m in messages:
        uid = str(m.get("id"))
        if eml_path(account.user_id, account.email, uid,
                    m.get("subject"), m.get("received_at")).exists():
            skipped += 1
            continue
        todo.append((uid, m))

    if not todo:
        return {"saved": 0, "skipped": skipped}

    raws = await _client(account).fetch_raw_many(account, mailbox, [u for u, _ in todo])

    saved = 0
    for uid, m in todo:
        raw = raws.get(uid)
        if not raw:
            skipped += 1
            continue
        try:
            if save_raw(account.user_id, account.email, uid,
                        m.get("subject"), m.get("received_at"), raw):
                saved += 1
            else:
                skipped += 1
        except Exception as e:
            logger.warning("[mailarchive] %s uid=%s 저장 실패: %s", account.email, uid, e)
            skipped += 1

    return {"saved": saved, "skipped": skipped}


async def archive_message(
    account: MailAccount,
    uid: str,
    subject: str | None,
    received_at: str | None,
    mailbox: str = "INBOX",
) -> dict | None:
    """메일 하나를 원본 그대로 저장한다. 이미 있으면 건너뛴다.

    폴러에서 불리므로 무슨 일이 있어도 예외를 올리지 않는다 — 아카이브가 실패했다고
    새 메일 감지가 멈추면 안 된다.
    """
    if not getattr(account, "archive_enabled", False):
        return None

    try:
        target = eml_path(account.user_id, account.email, uid, subject, received_at)
        if target.exists():
            return None

        raws = await _client(account).fetch_raw_many(account, mailbox, [uid])
        raw = raws.get(uid)
        if not raw:
            return None

        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)

        saved_attachments = _save_attachments(raw, target.parent, uid)
        logger.info("[mailarchive] %s uid=%s 저장 (첨부 %d)", account.email, uid, saved_attachments)
        return {"path": str(target), "attachments": saved_attachments}
    except Exception as e:
        logger.warning("[mailarchive] %s uid=%s 실패: %s", account.email, uid, e)
        return None


def _save_attachments(raw: bytes, month_dir: Path, uid: str, owner: tuple[str, str] | None = None) -> int:
    """첨부를 따로 떨군다. 파일 색인기가 PDF·docx 본문까지 이미 읽으므로
    이렇게만 해두면 첨부 내용으로도 검색된다."""
    import email
    from email import policy

    try:
        msg = email.message_from_bytes(raw, policy=policy.default)
    except Exception:
        return 0

    count = 0
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        filename = part.get_filename()
        if not filename:
            continue
        try:
            data = part.get_payload(decode=True)
        except Exception:
            continue
        if not isinstance(data, (bytes, bytearray)) or not data:
            continue
        try:
            att_dir = month_dir / ATTACH_DIRNAME
            att_dir.mkdir(parents=True, exist_ok=True)
            safe = _safe_name(filename, "attachment")
            # 확장자는 살려 둬야 색인기가 추출기를 고를 수 있다
            suffix = Path(filename).suffix[:16]
            if suffix and not safe.lower().endswith(suffix.lower()):
                safe = f"{safe}{suffix}"
            out = att_dir / f"{uid_part(uid)}_{safe}"
            if owner is not None:
                ensure_within(out, *owner)
            if not out.exists():
                out.write_bytes(data)
            count += 1
        except (OSError, ArchivePathError) as e:
            logger.debug("[mailarchive] 첨부 저장 실패 %s: %s", filename, e)
    return count


# ── 백필 작업 (백그라운드) ────────────────────────────────────
#
# IMAP 에서 수백 통을 받아 내리는 데 몇 분이 걸린다. 요청 안에서 하면 nginx 가
# 120초에 끊어 504 를 준다(실제로 그랬다). 작업은 백그라운드로 돌리고 진행상황만
# Redis 에 남겨 프런트가 폴링하게 한다.

_JOB_KEY = "mail:archive:job:{account_id}"
_JOB_TTL = 60 * 30
_CHUNK = 20          # 한 번에 받는 통수 — 메모리와 진행률 갱신 주기의 절충


async def _job_set(account_id: str, **fields) -> None:
    import json as _json
    from app.chat.redis_client import get_redis
    try:
        redis = await get_redis()
        await redis.setex(_JOB_KEY.format(account_id=account_id), _JOB_TTL,
                          _json.dumps(fields, ensure_ascii=False))
    except Exception:
        pass


async def backfill_status(account_id: str) -> dict:
    import json as _json
    from app.chat.redis_client import get_redis
    try:
        redis = await get_redis()
        raw = await redis.get(_JOB_KEY.format(account_id=account_id))
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode()
        if raw:
            return _json.loads(raw)
    except Exception:
        pass
    return {"state": "idle"}


async def _run_backfill(account: MailAccount, mailbox: str, limit: int) -> None:
    saved = skipped = scanned = 0
    try:
        await _job_set(account.id, state="running", saved=0, skipped=0, scanned=0)
        messages, _total = await _client(account).fetch_messages(
            account, mailbox, page=0, limit=limit
        )
        for i in range(0, len(messages), _CHUNK):
            chunk = messages[i:i + _CHUNK]
            r = await archive_many(account, chunk, mailbox)
            saved += r["saved"]
            skipped += r["skipped"]
            scanned += len(chunk)
            await _job_set(account.id, state="running",
                           saved=saved, skipped=skipped, scanned=scanned)
        await _job_set(account.id, state="done",
                       saved=saved, skipped=skipped, scanned=scanned)
        logger.info("[mailarchive] 백필 완료 %s: 저장 %d, 건너뜀 %d", account.email, saved, skipped)
    except Exception as e:
        logger.warning("[mailarchive] 백필 실패 %s: %s", account.email, e)
        await _job_set(account.id, state="error", error=str(e)[:200],
                       saved=saved, skipped=skipped, scanned=scanned)


async def start_backfill(account: MailAccount, mailbox: str, limit: int) -> bool:
    """이미 돌고 있으면 False. 작업 객체는 붙잡아 둬야 GC 가 중간에 취소하지 않는다."""
    import asyncio

    status = await backfill_status(account.id)
    if status.get("state") == "running":
        return False

    await _job_set(account.id, state="running", saved=0, skipped=0, scanned=0)
    task = asyncio.create_task(_run_backfill(account, mailbox, limit))
    _RUNNING.add(task)
    task.add_done_callback(_RUNNING.discard)
    return True


_RUNNING: set = set()
