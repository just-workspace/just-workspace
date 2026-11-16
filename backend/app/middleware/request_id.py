"""요청 번호(X-Request-ID) — 오류 화면의 "요청 번호"를 관리자가 로그에서 조회할 수 있도록 한다.

- 프런트 프록시(nginx 등)가 X-Request-ID 를 전달하면 해당 값을 사용하고(허용 문자·길이 한정), 없으면 신규 생성한다.
- 모든 응답에 X-Request-ID 헤더를 포함한다.
- 미처리 예외는 본 미들웨어에서 수신하여 500 JSON {"detail", "request_id"} 로 반환하고, 동일 번호로 트레이스백을 기록한다
  (Starlette 기본 500 은 본문이 평문 "Internal Server Error" 이므로 번호를 포함할 수 없다).

순수 ASGI 미들웨어 — BaseHTTPMiddleware 는 스트리밍 응답(파일 다운로드·SSE)을 래핑할 때 버퍼링 문제가 있어 사용하지 않는다.
"""

import json
import logging
import re
import secrets
from contextvars import ContextVar

logger = logging.getLogger(__name__)

HEADER = "x-request-id"
_VALID = re.compile(r"^[A-Za-z0-9._:-]{4,64}$")

# 로그·하위 코드가 현재 요청 번호를 조회하기 위한 변수(없으면 "")
current_request_id: ContextVar[str] = ContextVar("current_request_id", default="")


def new_request_id() -> str:
    """구두 전달이 용이한 짧은 번호 — "7f3a-91c2" 형식."""
    h = secrets.token_hex(4)
    return f"{h[:4]}-{h[4:]}"


def pick_request_id(incoming: str | None) -> str:
    """프런트 프록시가 전달한 값이 안전하면 그대로 사용하고, 아니면 신규 생성한다."""
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
                # 응답 전송이 이미 시작된 경우 변경 불가 — 연결이 종료되도록 예외를 재발생시킨다
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
