"""요청 번호(X-Request-ID) — 오류 화면의 "요청 번호"를 관리자가 로그에서 찾을 수 있게.

- 앞단(nginx 등)이 X-Request-ID 를 붙여 보내면 그 값을 쓰고(허용 문자·길이만), 없으면 새로 만든다.
- 모든 응답에 X-Request-ID 헤더를 단다.
- 처리 안 된 예외는 여기서 받아 500 JSON {"detail", "request_id"} 로 돌려주고, 같은 번호로 트레이스백을 남긴다
  (Starlette 기본 500 은 본문이 평문 "Internal Server Error" 라 번호를 실을 수 없다).

순수 ASGI 미들웨어 — BaseHTTPMiddleware 는 스트리밍 응답(파일 내려받기·SSE)을 감싸면서 버퍼링 문제가 있어 피한다.
"""

import json
import logging
import re
import secrets
from contextvars import ContextVar

logger = logging.getLogger(__name__)

HEADER = "x-request-id"
_VALID = re.compile(r"^[A-Za-z0-9._:-]{4,64}$")

# 로그·하위 코드가 지금 요청 번호를 읽을 수 있게(없으면 "")
current_request_id: ContextVar[str] = ContextVar("current_request_id", default="")


def new_request_id() -> str:
    """사람이 불러 주기 쉬운 짧은 번호 — "7f3a-91c2" 꼴."""
    h = secrets.token_hex(4)
    return f"{h[:4]}-{h[4:]}"


def pick_request_id(incoming: str | None) -> str:
    """앞단이 준 값이 안전하면 그대로, 아니면 새로."""
    if incoming and _VALID.match(incoming):
        return incoming
    return new_request_id()


class RequestIdMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = None
        for k, v in scope.get("headers") or []:
            if k == b"x-request-id":
                try:
                    incoming = v.decode("latin-1")
                except Exception:
                    incoming = None
                break
        rid = pick_request_id(incoming)
        scope.setdefault("state", {})["request_id"] = rid
        token = current_request_id.set(rid)
        started = False

        async def send_wrapper(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"x-request-id"]
                headers.append((b"x-request-id", rid.encode("latin-1")))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            logger.exception("처리 안 된 오류 [req %s] %s %s", rid, scope.get("method"), scope.get("path"))
            if started:
                # 응답이 이미 나가기 시작했으면 바꿀 수 없다 — 연결을 끊게 다시 던진다
                raise
            body = json.dumps(
                {"detail": "Internal Server Error", "request_id": rid}, ensure_ascii=False
            ).encode("utf-8")
            await send({
                "type": "http.response.start",
                "status": 500,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                    (b"x-request-id", rid.encode("latin-1")),
                ],
            })
            await send({"type": "http.response.body", "body": body})
        finally:
            current_request_id.reset(token)
