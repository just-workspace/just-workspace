"""백업·복원 테스트용 가짜 실행기 — docker 없이 스택 하나를 흉내 낸다.

DB 는 "이름 → 내용(바이트)" 사전이다. pg_dump 는 그 내용을 내보내고 pg_restore 는 받아 넣는다.
볼륨·프로젝트 폴더도 같은 식이다(볼륨은 통째로 한 덩어리, 프로젝트 폴더는 경로 → 내용).
"""

from __future__ import annotations

import io
import json
import tarfile
from pathlib import Path

from app.backup.runner import Completed

IMAGE = "sha256:helper"
PROJECT = "/srv/stack"


def container(name: str, *, running: bool = True, mounts: dict[str, str] | None = None, labels: dict | None = None,
              health: str | None = None) -> dict:
    state: dict = {"Running": running, "Status": "running" if running else "exited"}
    if health:
        state["Health"] = {"Status": health}
    return {
        "Name": "/" + name, "Image": IMAGE, "Config": {"Image": "backend:1", "Labels": labels or {}},
        "State": state,
        "Mounts": [
            {"Type": "bind" if src.startswith("/") else "volume", "Name": src, "Source": src, "Destination": dest}
            for dest, src in (mounts or {}).items()
        ],
    }


class FakeStack:
    """runner.Runner 구현 — 명령을 해석해 사전을 고친다. events 에 한 일이 순서대로 남는다."""

    def __init__(self, *, mail: bool = True, gitea: bool = True, nfs: bool = False, hostname: str = "oneoff"):
        self.hostname = hostname
        self.events: list[str] = []
        self.fail: dict[str, int] = {}                  # argv 에 이 문자열이 있으면 그 종료 코드로 실패
        self.dbs: dict[str, bytes] = {"workspace": b"LIVE-DB", "gitea": b"GITEA-DB", "postgres": b""}
        self.users = 7
        self.pg_version = 160004
        self.volumes: dict[str, bytes] = {
            "ws-storage-data": b"FILES", "ws-plugins-data": b"PLUGINS", "ws-certbot-data": b"CERTS",
            "ws-mail-data": b"MAILBOXES", "ws-mail-state": b"MAILSTATE", "ws-gitea-data": b"REPOS",
        }
        self.volume_options: dict[str, dict] = {}
        if nfs:
            self.volume_options["ws-storage-data"] = {"type": "nfs", "o": "addr=nas.example,rw", "device": ":/export/jw"}
        self.project: dict[str, bytes] = {
            ".env": b"SECRET_KEY=original\nDB_PASSWORD=pw\n", "nginx/site.d/a.conf": b"# a\n",
            "mailserver/config/postfix-accounts.cf": b"kim@example.com|hash\n",
        }
        self.containers: dict[str, dict] = {
            "ws-postgres": container("ws-postgres", labels={"com.docker.compose.project.working_dir": PROJECT}),
            "ws-backend": container("ws-backend", health="healthy", mounts={
                "/storage": "ws-storage-data", "/plugins-data": "ws-plugins-data", "/backups": "ws-backups"}),
            "ws-nginx": container("ws-nginx", mounts={"/etc/letsencrypt": "ws-certbot-data"}),
            "ws-sso": container("ws-sso"),
            "oneoff": container("oneoff", mounts={"/storage": "ws-storage-data", "/plugins-data": "ws-plugins-data"}),
        }
        if mail:
            self.containers["ws-mailserver"] = container("ws-mailserver", mounts={
                "/var/mail": "ws-mail-data", "/var/mail-state": "ws-mail-state",
                "/tmp/docker-mailserver": PROJECT + "/mailserver/config"})
        if gitea:
            self.containers["ws-gitea"] = container("ws-gitea", mounts={"/data": "ws-gitea-data"})

    # ─── Runner ───

    def run(self, argv, *, stdin: Path | None = None, stdout: Path | None = None, timeout: int = 600) -> Completed:
        argv = list(argv)
        text = " ".join(argv)
        for needle, rc in self.fail.items():
            if needle in text:
                self.events.append(f"FAIL {needle}")
                if stdout:
                    Path(stdout).write_bytes(b"partial")
                return Completed(rc, err=f"simulated failure: {needle}")
        data = Path(stdin).read_bytes() if stdin else b""
        out = self._dispatch(argv, data)
        if isinstance(out, Completed):
            return out
        if stdout:
            Path(stdout).write_bytes(out)
            return Completed(0)
        return Completed(0, out.decode())

    def _dispatch(self, argv: list[str], data: bytes) -> bytes | Completed:
        if argv[:2] == ["docker", "inspect"]:
            name = self.hostname if argv[2] == "@self" else argv[2]
            info = self.containers.get(name)
            return json.dumps([info]).encode() if info else Completed(1, err="No such object")
        if argv[:3] == ["docker", "volume", "inspect"]:
            if argv[3] not in self.volumes:
                return Completed(1, err="no such volume")
            return json.dumps([{"Name": argv[3], "Options": self.volume_options.get(argv[3])}]).encode()
        if argv[:2] in (["docker", "stop"], ["docker", "start"]):
            running = argv[1] == "start"
            self.events.append(f"{argv[1]} {argv[2]}")
            state = self.containers[argv[2]]["State"]
            state.update(Running=running, Status="running" if running else "exited")
            return b""
        if argv[:2] == ["docker", "exec"]:
            return self._postgres(argv, data)
        if argv[:2] == ["docker", "run"]:
            return self._helper(argv, data)
        return Completed(127, err="unknown command: " + " ".join(argv))

    # ─── PostgreSQL ───

    def _postgres(self, argv: list[str], data: bytes) -> bytes | Completed:
        tool = next(a for a in argv if a in ("psql", "pg_dump", "pg_restore"))
        db = argv[argv.index("-d") + 1]
        if tool == "pg_dump":
            self.events.append(f"pg_dump {db}")
            return self.dbs[db] if db in self.dbs else Completed(1, err="database does not exist")
        if tool == "pg_restore":
            self.events.append(f"pg_restore {db}")
            if db not in self.dbs:
                return Completed(1, err="database does not exist")
            self.dbs[db] = data
            return b""
        answers = []
        for sql in [argv[i + 1] for i, a in enumerate(argv) if a == "-c"]:
            reply = self._sql(sql, db)
            if isinstance(reply, Completed):
                return reply
            if reply:
                answers.append(reply)
        return "\n".join(answers).encode()

    def _sql(self, sql: str, db: str) -> str | Completed:
        import re

        if m := re.fullmatch(r'DROP DATABASE IF EXISTS "(\w+)" WITH \(FORCE\)', sql):
            self.events.append(f"drop {m[1]}")
            self.dbs.pop(m[1], None)
            return ""
        if m := re.fullmatch(r'CREATE DATABASE "(\w+)"', sql):
            self.dbs[m[1]] = b""
            return ""
        if m := re.fullmatch(r'ALTER DATABASE "(\w+)" RENAME TO "(\w+)"', sql):
            if m[1] not in self.dbs or m[2] in self.dbs:
                return Completed(1, err=f"cannot rename {m[1]}")
            self.events.append(f"rename {m[1]}→{m[2]}")
            self.dbs[m[2]] = self.dbs.pop(m[1])
            return ""
        if m := re.fullmatch(r"SELECT 1 FROM pg_database WHERE datname = '(\w+)'", sql):
            return "1" if m[1] in self.dbs else ""
        if sql.startswith("SELECT pg_terminate_backend"):
            return ""
        if sql == "SELECT count(*) FROM users":
            return str(self.users)
        if sql.startswith("SELECT pg_database_size"):
            return str(len(self.dbs.get("workspace", b"")) * 1000)
        if sql == "SHOW server_version_num":
            return str(self.pg_version)
        if sql.startswith("SELECT to_regclass('public.users')"):
            return "t" if self.dbs.get(db) else "f"
        return Completed(1, err="unexpected SQL: " + sql)

    # ─── 도우미 컨테이너(tar·du·sh) ───

    def _helper(self, argv: list[str], data: bytes) -> bytes | Completed:
        mount = argv[argv.index("-v") + 1]
        source = mount.split(":")[0]
        entry = argv[argv.index("--entrypoint") + 1]
        rest = argv[argv.index(IMAGE) + 1:]
        is_project = source == PROJECT
        if entry == "du":
            return f"{len(self.volumes.get(source, b'')) or 1}\t/v\n".encode()
        if entry == "sh" and "for f in" in rest[1]:
            return "\n".join(c for c in rest[3:] if self._project_has(c)).encode()
        if entry == "tar":                                   # 뜨기
            paths = rest[rest.index("/v") + 1:]
            self.events.append(f"tar-out {source}")
            if not is_project:
                return self.volumes[source] if source in self.volumes else Completed(2, err="no such volume")
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz" if "-czf" in rest else "w:") as tar:
                for name, body in sorted(self.project.items()):
                    if any(name == p or name.startswith(p.rstrip("/") + "/") for p in paths):
                        info = tarfile.TarInfo(name)
                        info.size = len(body)
                        tar.addfile(info, io.BytesIO(body))
            return buf.getvalue()
        if entry == "sh":                                    # 풀기
            script = rest[1]
            self.events.append(f"tar-in {source}")
            if not is_project:
                self.volumes[source] = data
                return b""
            if "-delete" in script:
                wipe = script.split("find /v/")[1].split(" ")[0] if "find /v/" in script else ""
                for name in [n for n in self.project if n.startswith(wipe)]:
                    del self.project[name]
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tar:
                for member in tar:
                    if member.isfile():
                        self.project[member.name] = tar.extractfile(member).read()
            return b""
        return Completed(127, err="unknown helper: " + entry)

    def _project_has(self, path: str) -> bool:
        return any(n == path or n.startswith(path + "/") for n in self.project)
