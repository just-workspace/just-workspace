"""설치된 서버에서 전체 백업을 **같은 서버에** 되돌린다 — `jw restore`.

새 서버로 옮기는 복원(마법사의 "백업에서 복원", `app/restore.py`)과 다르다. 여기서는 설치가 끝난 서버의
데이터만 백업 시점으로 되돌리고, 설정(`.env`·사이트 파일)은 건드리지 않는다 — 그것은 설치 관리자가 답변에서
만든 것이고, 백업 뒤에 구역·버전이 바뀌었을 수 있다.

실제 복원은 backend 가 한다(`python -m app.cli restore` — docs/data-safety.md 4절: 검증 → 버전 판정 →
지금 DB 덤프 → 서비스 정지 → DB 올리기 → 바꿔 끼우기 → 스키마 변경 단계 → 나머지 항목 → 서비스 시작 → 확인).
복원은 backend 를 세워야 하므로 backend 컨테이너 안이 아니라 같은 이미지의 일회용 컨테이너에서 돈다.
설치 관리자가 하는 일은 그 컨테이너를 띄우고, 도는 동안 점검 표식을 놓아 쓰기를 막고, 결과를 그대로 전하는 것이다.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Callable

from app import validators as v

SOURCE_MOUNT = "/restore-src"
PASSWORD_MOUNT = "/restore-pass"
BACKUP_ROOT = "/backups"                     # backend 컨테이너 안에서 백업 볼륨이 붙는 자리
BACKUP_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,200}")
RESTORE_TIMEOUT = 12 * 3600


class LocalRestoreError(Exception):
    """시작하기 전에 거부한다 — 아무것도 건드리지 않았다."""

    def __init__(self, code: str, **vars):
        super().__init__(code)
        self.code, self.vars = code, vars


@dataclass(frozen=True)
class Source:
    kind: str                # volume(백업 볼륨 안의 이름) | host(서버의 경로)
    inside: str              # 일회용 컨테이너 안에서의 경로
    run_args: tuple[str, ...]


def to_host(paths, path: str) -> str:
    """사용자가 적은 경로 → 호스트 경로. 설치 관리자 안의 이름(`/data/…`)으로 적어도 받는다."""
    host = v.host_path(path)
    data = paths.data.as_posix().rstrip("/")
    if data != paths.host_dir.rstrip("/") and (host == data or host.startswith(data + "/")):
        host = str(PurePosixPath(paths.host_dir) / host[len(data):].lstrip("/"))
    return host


def resolve_source(paths, text: str) -> Source:
    """백업을 가리키는 글자 — `/` 가 없으면 백업 볼륨 안의 이름, 있으면 서버의 절대 경로."""
    text = (text or "").strip()
    if not text:
        raise LocalRestoreError("backup_required")
    if "/" not in text:
        if not BACKUP_NAME.fullmatch(text) or text in (".", ".."):
            raise LocalRestoreError("backup_name_invalid", name=text)
        return Source("volume", f"{BACKUP_ROOT}/{text}", ())
    try:
        host = to_host(paths, text)
    except v.Invalid as e:
        raise LocalRestoreError("path_invalid", reason=e.code) from None
    return Source("host", SOURCE_MOUNT, ("-v", f"{host}:{SOURCE_MOUNT}:ro"))


def busy_reason(svc, updates) -> str | None:
    """복원을 시작하면 안 되는 사유(없으면 None). 설치 관리자 서버와는 다른 프로세스라 상태 파일로 본다."""
    if not svc.store.locked:
        return "not_installed"
    if svc.engine.status().get("status") == "running":
        return "apply_running"
    if updates.active() is not None:
        return "update_running"
    if any(job.get("status") == "running" for job in svc.zones.jobs().values()):
        return "zone_job_running"
    return None


def _json_line(text: str) -> dict:
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                data = json.loads(line)
            except ValueError:
                continue
            if isinstance(data, dict):
                return data
    return {}


def _json_doc(text: str):
    """여러 줄로 찍힌 JSON 하나(`backup inspect|list --json`). 앞에 다른 줄이 섞여 있어도 읽는다."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.startswith(("{", "[")):
            try:
                return json.loads("\n".join(lines[i:]))
            except ValueError:
                continue
    return None


def inspect(updates, source: Source) -> dict:
    """백업의 내용 요약(`backup inspect --json`). 읽지 못하면 `LocalRestoreError`."""
    r = updates._backend_run(["-m", "app.cli", "backup", "inspect", source.inside, "--json"], user="0",
                             timeout=600, run_args=list(source.run_args))
    data = _json_doc(r.out)
    if not r.ok or not isinstance(data, dict):
        raise LocalRestoreError("backup_unreadable", detail=(r.err or r.out).strip()[-400:])
    return data


def list_backups(updates) -> list[dict]:
    """백업 볼륨에 있는 백업(관리 화면의 "지금 백업"·예약 백업이 쌓는 곳)."""
    r = updates._backend_run(["-m", "app.cli", "backup", "list", "--json"], user="0", timeout=300)
    data = _json_doc(r.out)
    if not r.ok or not isinstance(data, list):
        raise LocalRestoreError("backup_list_failed", detail=(r.err or r.out).strip()[-400:])
    return data


def run(svc, updates, source: Source, *, items: list[str] | None = None, password_host_path: str | None = None,
        allow_key_mismatch: bool = False, log: Callable[[str], None] = lambda line: None) -> dict:
    """복원을 돌리고 backend 의 결과를 그대로 돌려준다.

    {"ok": True, "items", "schema": [전, 후], "safety_dump", "notes"} 또는
    {"ok": False, "stage", "error", "state"} — `stage` 는 backend 의 복원 단계 이름, `state` 는 그 뒤의 DB 상태.
    일회용 컨테이너가 결과 없이 끝났으면 {"ok": False, "stage": None, "error": <끝부분>, "exit_code"}.
    """
    reason = busy_reason(svc, updates)
    if reason:
        raise LocalRestoreError(reason)
    argv = ["-m", "app.cli", "restore", source.inside, "--yes", "--json"]
    if items:
        argv += ["--items", ",".join(items)]
    if allow_key_mismatch:
        argv.append("--allow-key-mismatch")
    run_args = list(source.run_args)
    if password_host_path:
        run_args += ["-v", f"{password_host_path}:{PASSWORD_MOUNT}:ro"]
        argv += ["--password-file", PASSWORD_MOUNT]
    updates.set_maintenance(True)            # 도는 동안의 쓰기는 복원과 함께 사라진다 — 앞단에서 막는다
    try:
        r = updates._backend_run(argv, user="0", timeout=RESTORE_TIMEOUT, on_line=log, run_args=run_args)
    finally:
        updates.set_maintenance(False)
    report = _json_line(r.out)
    if report.get("ok") and r.ok:
        return report
    if report and report.get("ok") is False:
        return {"ok": False, "stage": report.get("stage"), "error": report.get("error"), "state": report.get("state"),
                "exit_code": r.rc}
    return {"ok": False, "stage": None, "error": (r.err or r.out).strip()[-600:], "state": None, "exit_code": r.rc}
