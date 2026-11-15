"""설치 토큰과 세션.

- 토큰: 영문 대문자·숫자 12자리(헷갈리는 0/O/1/I 제외), 24시간 뒤 만료.
- 주소의 `?token=` 이나 `POST /api/session` 으로 확인하면 세션 쿠키를 준다(HttpOnly·Secure).
- 틀린 것과 만료된 것을 구분해 알려 준다. 5번 틀리면 30초 동안 받지 않는다(무차별 대입 완화).
- `jw token` 으로 다시 발급하면 옛 토큰은 못 쓴다. 입력해 둔 답과 이미 열린 세션은 그대로다.
- 설치가 끝나면 토큰과 세션을 모두 없앤다.

토큰은 상태 폴더(root 만 읽는다)에 그대로 둔다 — 재시작 뒤 로그에 다시 보여 줘야 한다.
"""

from __future__ import annotations

import hmac
import secrets
import time
from typing import Callable

from app.state import Store

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"      # 0·O·1·I 없음
TOKEN_LENGTH = 12
TOKEN_TTL = 24 * 3600
MAX_FAILURES = 5
LOCK_SECONDS = 30
SESSION_TTL = 24 * 3600
COOKIE_NAME = "jw_installer_session"


def generate() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(TOKEN_LENGTH))


def normalize(candidate: str) -> str:
    """사람이 옮겨 적은 꼴을 받아 준다 — 소문자, 사이의 공백·줄표."""
    return "".join(ch for ch in (candidate or "").upper() if ch not in " -\t")


class TokenStore:
    def __init__(self, store: Store, clock: Callable[[], float] = time.time):
        self.store = store
        self.clock = clock

    # ─── 토큰 ───

    def _data(self) -> dict:
        return self.store.read("token.json", {}) or {}

    def issue(self) -> str:
        """새 토큰을 만든다(옛 토큰은 무효). 실패 횟수도 지운다."""
        token = generate()
        now = self.clock()
        self.store.write("token.json", {"token": token, "created": now, "expires": now + TOKEN_TTL,
                                         "failures": 0, "locked_until": 0})
        return token

    def current(self) -> str | None:
        """아직 쓸 수 있는 토큰(없거나 만료면 None)."""
        data = self._data()
        if data.get("token") and self.clock() < data.get("expires", 0):
            return data["token"]
        return None

    def ensure(self) -> str:
        return self.current() or self.issue()

    def expires_at(self) -> float | None:
        return self._data().get("expires")

    def check(self, candidate: str) -> tuple[str, int]:
        """(`ok` | `wrong` | `expired` | `locked` | `none`, 다시 시도까지 남은 초)."""
        data = self._data()
        now = self.clock()
        if not data.get("token"):
            return "none", 0
        if now < data.get("locked_until", 0):
            return "locked", int(data["locked_until"] - now) + 1
        given = normalize(candidate)
        match = hmac.compare_digest(given.encode(), data["token"].encode())
        if match and now >= data.get("expires", 0):
            return "expired", 0
        if match:
            if data.get("failures"):
                data["failures"] = 0
                data["locked_until"] = 0
                self.store.write("token.json", data)
            return "ok", 0
        data["failures"] = int(data.get("failures", 0)) + 1
        retry = 0
        if data["failures"] >= MAX_FAILURES:
            data["locked_until"] = now + LOCK_SECONDS
            retry = LOCK_SECONDS
        self.store.write("token.json", data)
        return "wrong", retry

    # ─── 세션 ───

    def _sessions(self) -> dict:
        return self.store.read("sessions.json", {}) or {}

    def new_session(self) -> str:
        sid = secrets.token_urlsafe(32)
        now = self.clock()
        sessions = {k: exp for k, exp in self._sessions().items() if exp > now}
        sessions[sid] = now + SESSION_TTL
        self.store.write("sessions.json", sessions)
        return sid

    def session_valid(self, sid: str | None) -> bool:
        if not sid:
            return False
        for known, expires in self._sessions().items():
            if hmac.compare_digest(known.encode(), sid.encode()):
                return self.clock() < expires
        return False

    def revoke_all(self) -> None:
        """설치가 끝났을 때 — 토큰도 세션도 더는 쓸 수 없다."""
        self.store.delete("token.json")
        self.store.delete("sessions.json")
