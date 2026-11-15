"""상태 저장 — `/data/state/*.json`. 쓰기는 임시 파일 뒤 바꿔치기(중간에 꺼져도 깨진 파일이 남지 않는다).

| 파일 | 내용 |
|---|---|
| `install.json` | 설치 id, 단계(`wizard` → `applying` → `installed`), 잠금 시각 |
| `answers.json` | 답변(비밀 제외) |
| `answers.secret.json` | 답변의 비밀(관리자 비밀번호·SMTP 비밀번호·AI 키) — 쓰고 나면 지운다 |
| `env.secret.json` | `.env` 에 들어가는 비밀값과 구역 훅이 채운 값 |
| `facts.json` | 감지값(메모리·CPU·공인 주소·DNS 확인 결과) |
| `apply.json` | 적용 단계의 상태 |
| `token.json` · `sessions.json` | 설치 토큰과 세션 |
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app import answers as ans
from app.paths import Paths

_lock = threading.RLock()


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_private(path: Path, text: str, mode: int = 0o600) -> None:
    """파일을 통째로 바꿔 쓴다(같은 폴더의 임시 파일 → rename). 권한은 mode."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        try:
            os.chmod(tmp, mode)
        except OSError:
            pass
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


class Store:
    def __init__(self, paths: Paths):
        self.paths = paths
        self.dir = paths.state

    # ─── 원시 읽기·쓰기 ───

    def read(self, name: str, default=None):
        try:
            return json.loads((self.dir / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def write(self, name: str, data) -> None:
        with _lock:
            write_private(self.dir / name, json.dumps(data, ensure_ascii=False, indent=2) + "\n")

    def delete(self, name: str) -> None:
        try:
            (self.dir / name).unlink()
        except OSError:
            pass

    # ─── 설치 ───

    def install(self) -> dict:
        with _lock:
            data = self.read("install.json")
            if not data:
                data = {"install_id": str(uuid.uuid4()), "phase": "wizard", "created_at": now_iso(), "locked_at": None}
                self.write("install.json", data)
            return data

    def set_phase(self, phase: str) -> dict:
        with _lock:
            data = self.install()
            data["phase"] = phase
            if phase == "installed" and not data.get("locked_at"):
                data["locked_at"] = now_iso()
            self.write("install.json", data)
            return data

    @property
    def locked(self) -> bool:
        return self.install().get("phase") == "installed"

    # ─── 답변 ───

    def answers_public(self) -> dict:
        return self.read("answers.json", {}) or {}

    def answer_secrets(self) -> dict:
        return self.read("answers.secret.json", {}) or {}

    def load_answers(self) -> ans.Answers:
        return ans.join(self.answers_public(), self.answer_secrets())

    def save_answers(self, answers: ans.Answers, *, keep_secrets: bool = True) -> None:
        """답변을 저장한다. 비밀은 따로 — 이번에 비어 온 비밀은 전에 넣은 값을 그대로 둔다."""
        public, secrets = ans.split(answers)
        with _lock:
            merged = {**self.answer_secrets(), **secrets} if keep_secrets else secrets
            self.write("answers.json", public)
            self.write("answers.secret.json", merged)

    def forget_answer_secret(self, key: str) -> None:
        with _lock:
            secrets = self.answer_secrets()
            if secrets.pop(key, None) is not None:
                self.write("answers.secret.json", secrets)

    # ─── .env 비밀값 · 감지값 ───

    def env_secrets(self) -> dict:
        return self.read("env.secret.json", {}) or {}

    def update_env_secrets(self, changes: dict) -> dict:
        with _lock:
            data = {**self.env_secrets(), **changes}
            self.write("env.secret.json", data)
            return data

    def facts(self) -> ans.Facts:
        data = self.read("facts.json", {}) or {}
        known = ans.Facts().__dict__.keys()
        return ans.Facts(**{k: val for k, val in data.items() if k in known})

    def update_facts(self, **changes) -> ans.Facts:
        with _lock:
            facts = self.facts()
            for key, value in changes.items():
                setattr(facts, key, value)
            self.write("facts.json", facts.as_dict())
            return facts
