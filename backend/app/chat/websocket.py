"""옛 import 경로 — 실시간 소켓은 코어(app/realtime/socket.py)로 옮겼다.

소켓과 연결 관리자는 채팅 구역이 없어도 쓰이므로 코어에 있다. 채팅 전용 프레임 처리는
app/chat/ws_handlers.py. 이 모듈은 기존 코드가 쓰던 이름을 그대로 내보내기만 한다.
"""

from app.realtime.socket import (  # noqa: F401
    PUBSUB_MSG,
    PUBSUB_NOTIFICATION,
    PUBSUB_PRESENCE,
    PUBSUB_TYPING,
    ConnectionManager,
    _authenticate_ws,
    _Conn,
    chat_ws,
    manager,
    router,
)
