"""위키 실시간 협업 — Yjs WebSocket 릴레이.

페이지 하나가 방 하나(page_id)에 대응한다. 접속 중인 클라이언트 간에 Yjs 동기화 프레임을 송수신한다.

중계는 `app.collab.relay` 가 담당한다. 프로세스 메모리에만 방을 두면 워커가 분리되는 순간
상호 편집 내용이 전달되지 않기 때문이다(백엔드는 워커 8개로 기동한다). 상세 내용은 relay.py 참조.
"""

import asyncio
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.collab.relay import Relay
from app.db.models import User

logger = logging.getLogger(__name__)

router = APIRouter(tags=["wiki-collab"])

relay = Relay("wiki:collab")


async def _auth_ws(ws: WebSocket) -> User | None:
    """REST 와 동일한 세션 검증(2단계 임시 토큰·폐기된 세션 거부, Origin 확인)."""
    from app.auth.ws_auth import authenticate_ws
    try:
        return await authenticate_ws(ws)
    except Exception:
        return None


# 프레임 첫 바이트(WikiCollabEditor.tsx 와 동일 값)
MSG_UPDATE, MSG_SYNC_REQUEST, MSG_SYNC_RESPONSE, MSG_AWARENESS = 0, 1, 2, 3
# 서버 → 해당 소켓 하나에만 송신하는 제어 프레임: [4, 0|1] = 현재 권한(0 읽기 전용 · 1 편집 가능).
# 접속 중 권한이 변경되었을 때 통지한다. 구 클라이언트는 알 수 없는 종류를 무시한다.
# 클라이언트가 송신한 것은 중계하지 않는다(편집자가 방 전체를 읽기 전용으로 위장시키지 못하도록 함).
MSG_ACCESS = 4
_READER_ALLOWED = frozenset({MSG_SYNC_REQUEST, MSG_AWARENESS})
_LEVELS = {"reader": 0, "writer": 1, "admin": 2}


async def _access_for(db, user_id: str, is_admin: bool, page_id: str) -> str | None:
    """'write' | 'read' | None. 본문은 조회하지 않는다 — 페이지의 스페이스 id 와 역할만 조회한다(15초마다 실행되는 조회이다)."""
    from sqlalchemy import select

    from app.db.models import WikiPage
    from app.wiki import service

    space_id = await db.scalar(select(WikiPage.space_id).where(WikiPage.id == page_id))
    if not space_id:
        return None
    if is_admin:
        return "write"
    role = await service.get_user_role(db, space_id, user_id)
    lvl = _LEVELS.get(role or "", -1)
    if lvl >= _LEVELS["writer"]:
        return "write"
    if lvl >= _LEVELS["reader"]:
        return "read"
    return None


async def _page_access(user: User, page_id: str, db=None) -> str | None:
    """접속 시 — 웹 API 와 동일한 스페이스 역할 기준(관리자는 쓰기). user 는 직전에 인증한 객체."""
    if db is None:
        from app.db.session import async_session
        async with async_session() as session:
            return await _page_access(user, page_id, session)
    return await _access_for(db, str(user.id), bool(getattr(user, "is_admin", False)), page_id)


async def _current_access(user_id: str, page_id: str, db=None) -> str | None:
    """접속 중 재검사 — 사용자도 재조회한다.

    접속 시의 객체를 계속 사용하면 이후 계정이 비활성화되거나 사이트 관리자에서 제외되어도 반영되지 않는다.
    존재하지 않거나 비활성인 계정은 None(연결을 종료한다).
    """
    if db is None:
        from app.db.session import async_session
        async with async_session() as session:
            return await _current_access(user_id, page_id, session)
    from sqlalchemy import select

    row = (await db.execute(
        select(User.is_active, User.is_admin).where(User.id == user_id)
    )).first()
    if not row or not row[0]:
        return None
    return await _access_for(db, user_id, bool(row[1]), page_id)


def frame_allowed(access: str, data: bytes) -> bool:
    """읽기 전용 참여자는 동기화 요청·프레즌스만 송신할 수 있다(문서 변경 프레임은 폐기한다)."""
    if not data or data[0] == MSG_ACCESS:
        return False
    if access == "write":
        return True
    return data[0] in _READER_ALLOWED


# 접속 중 권한을 재검사하는 간격(초). 접속 시 1회만 검사하면 멤버에서 제외되거나 스페이스가
# 비공개로 변경된 후에도 열어 둔 문서로 타인의 편집이 계속 전달된다(REST 는 요청마다 검사한다).
ACCESS_RECHECK_SECONDS = 15


async def _watch_access(ws: WebSocket, user_id: str, page_id: str, state: dict) -> None:
    """권한이 소멸하면 소켓을 닫고(4003), 읽기↔쓰기가 변경되면 그 시점부터 적용하고 해당 소켓에 통지한다(MSG_ACCESS).

    통지하지 않으면 읽기로 강등된 사용자의 편집기는 계속 입력을 받으나 서버는 이를 무시하여, 작성한 내용이 소실된다.
    """
    while True:
        await asyncio.sleep(ACCESS_RECHECK_SECONDS)
        try:
            access = await _current_access(user_id, page_id)
        except Exception as e:
            # 일시적인 DB 장애로 편집을 중단하지 않음 — 다음 주기에 재검사
            logger.debug("wiki collab access recheck failed: %s", e)
            continue
        if access is None:
            try:
                await ws.close(code=4003, reason="Forbidden")
            except Exception:
                pass
            return
        if access != state["access"]:
            state["access"] = access
            try:
                await ws.send_bytes(bytes([MSG_ACCESS, 1 if access == "write" else 0]))
            except Exception:
                pass


@router.websocket("/ws/wiki/collab")
async def wiki_collab_ws(ws: WebSocket, page_id: str = Query(...)):
    user = await _auth_ws(ws)
    if not user:
        await ws.close(code=4001, reason="Unauthorized")
        return
    access = await _page_access(user, page_id)
    if access is None:
        await ws.close(code=4003, reason="Forbidden")
        return

    from app.auth.ws_auth import accept_subprotocol
    await ws.accept(subprotocol=accept_subprotocol(ws))
    member = await relay.join(page_id, ws, user.id)
    logger.info(
        "wiki collab: %s joined %s (local clients=%d)",
        user.username, page_id, relay.local_size(page_id),
    )

    state = {"access": access}
    watcher = asyncio.create_task(_watch_access(ws, str(user.id), page_id, state))
    try:
        while True:
            data = await ws.receive_bytes()
            if not frame_allowed(state["access"], data):
                continue
            await relay.publish(page_id, member, data)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.debug("wiki collab error: %s", e)
    finally:
        watcher.cancel()
        relay.leave(page_id, member)
        logger.info(
            "wiki collab: %s left %s (local clients=%d)",
            user.username, page_id, relay.local_size(page_id),
        )


def get_room_clients(page_id: str) -> int:
    """이 워커에 연결된 수."""
    return relay.local_size(page_id)
