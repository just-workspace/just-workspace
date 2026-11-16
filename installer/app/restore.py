"""백업에서 복원 — 타 서버에서 생성한 백업을 이 서버로 이전한다(docs/installer.md §14).

흐름:
  1. 백업 수신 — 브라우저로 업로드하거나(상태 폴더에 저장), 서버에 있는 파일의 **호스트 경로**를 지정한다.
     어느 경우에도 설치 관리자는 백업을 직접 열지 않는다. backend 이미지의 일회용 컨테이너에 읽기 전용으로 마운트하여
     `python -m app.cli backup inspect|verify|extract-config` 를 호출한다(형식의 단일 출처는 backend 이다).
  2. 내용 확인(`review`) — 생성 서버·시각·버전·구역·크기·저장소·파일 포함 여부, 버전 판정.
  3. 새 서버에서 재지정하는 항목(접속 주소·연결 형태·인증서·파일 저장 위치·내부 대역)만 입력받아 응답을 생성한다.
     구역·메일·관리자는 입력을 요구하지 않는다 — 백업의 설정(`.env`)에서 가져온다(app/restore_config.py).
  4. 적용 — 설치와 동일한 엔진(app/engine.py)이 복원용 단계 표(`STEPS`)로 실행한다. 상태·로그·재시도·SSE 가 동일하다.

단계: unpack(설정 파일 생성 — 백업 설정 + 새 응답) → storage(NFS·지정 폴더인 경우만) → pull(이미지 pull) →
database(빈 DB 를 기동하고 데이터 복원 — backend CLI `restore`, 이어서 스키마 정합) → files(백업에 파일이 있는 경우만) →
cert(인증서) → zones(구역 기동·연결 → 확인 → 설치 마법사 잠금)
"""

from __future__ import annotations

import json
import secrets as pysecrets
import shutil
from pathlib import Path, PurePosixPath
from typing import Callable

from app import answers as ans
from app import engine as eng
from app import render
from app import restore_config as rc
from app import validators as v
from app.state import now_iso, write_private
from app.update_release import valid_source_url

STEP_ORDER = ("unpack", "storage", "pull", "database", "files", "cert", "zones")
ARCHIVE_SUFFIX = ".jwbak"
SOURCE_MOUNT = "/restore-src"
FILES_MEMBER = "files.tar"                    # 백업 형식에서 정의한 이름(docs/data-safety.md)
# backend CLI 로 복원하는 항목(설정은 병합하여 별도 기록하고, 파일은 files 단계가 담당). certs 는 조건부.
DATA_ITEMS = ("db", "mail", "gitea", "plugins-data", "app-signing")
META = "restore.json"
MAX_PASSWORD = 1024


class RestoreError(Exception):
    """요청 수신 불가 — API 가 `{"code","vars"}` 로 반환한다."""

    def __init__(self, status: int, code: str, **vars):
        super().__init__(code)
        self.status, self.code, self.vars = status, code, vars


def _json_tail(text: str) -> dict:
    """출력의 마지막 JSON 블록(여러 줄로 출력된 것도 허용)."""
    text = (text or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except ValueError:
        pass
    for line in reversed(text.splitlines()):
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict):
            return data
    start = text.rfind("\n{")
    try:
        data = json.loads(text[start + 1:] if start >= 0 else text[text.index("{"):])
        return data if isinstance(data, dict) else {}
    except ValueError:
        return {}


class RestoreManager:
    """백업 1건(업로드한 파일 또는 서버 경로)을 수신하여 확인하고, 복원 적용을 시작한다."""

    def __init__(self, *, paths, store, docker, bundle, catalog, registry: str, image_tag: str,
                 engine: eng.Engine | None = None, dns_status: Callable[[str], str] | None = None):
        self.paths, self.store, self.docker, self.bundle, self.catalog = paths, store, docker, bundle, catalog
        self.registry, self.image_tag = registry, image_tag
        self.engine = engine                     # 적용 시작 시에만 사용(단계 내에서 생성한 관리자 객체에는 없음)
        self.dns_status = dns_status or (lambda domain: "unknown")
        self.dir = self.paths.state / "restore"

    @classmethod
    def for_engine(cls, engine: eng.Engine, **kw) -> "RestoreManager":
        return cls(paths=engine.paths, store=engine.store, docker=engine.docker, bundle=engine.bundle,
                   catalog=engine.catalog, registry=engine.registry, image_tag=engine.image_tag, engine=engine, **kw)

    @property
    def running(self) -> bool:
        return bool(self.engine is not None and self.engine.running)

    # ─── 경로 ───

    @property
    def upload_path(self) -> Path:
        return self.dir / "upload" / f"backup{ARCHIVE_SUFFIX}"

    @property
    def config_dir(self) -> Path:
        return self.dir / "config"

    @property
    def password_path(self) -> Path:
        return self.dir / "password"

    def host_path(self, inside: Path) -> str:
        """설치 관리자 컨테이너 내의 `/data/…` 경로 → 동일 파일의 호스트 경로(docker 데몬이 해석하는 이름)."""
        rel = inside.relative_to(self.paths.data)
        return str(PurePosixPath(self.paths.host_dir) / PurePosixPath(rel.as_posix()))

    def backend_image(self) -> str:
        return f"{self.registry}/just-workspace-backend:{self.image_tag}"

    # ─── 상태 ───

    def meta(self) -> dict:
        return self.store.read(META, {}) or {}

    def _save(self, **changes) -> dict:
        data = {**self.meta(), **changes, "updated_at": now_iso()}
        self.store.write(META, data)
        return data

    def info(self) -> dict:
        """화면에 전달하는 파일 상태 — `RestoreFileInfo`."""
        m = self.meta()
        status = m.get("status") or "none"
        source = m.get("source") or {}
        state = m.get("state") or {"ok": "ready", "none": "none"}.get(status, "failed")
        return {"status": status, "state": state, "name": source.get("name"), "size_bytes": source.get("size_bytes"),
                "source": source.get("kind"), "path": source.get("host_path") if source.get("kind") == "path" else None,
                "reason": m.get("reason")}

    @property
    def ready(self) -> bool:
        return self.meta().get("status") == "ok"

    def summary(self) -> dict:
        return self.meta().get("summary") or {}

    def backup_env(self) -> dict[str, str]:
        try:
            return rc.parse_env((self.config_dir / ".env").read_text(encoding="utf-8"))
        except OSError:
            return {}

    def source_host_path(self) -> str:
        return (self.meta().get("source") or {}).get("host_path") or ""

    # ─── backend 이미지의 일회용 컨테이너 ───

    def ensure_backend_image(self, log: Callable[[str], None] = lambda line: None) -> bool:
        """백업을 읽으려면 backend 이미지가 필요하다 — 없으면 해당 이미지 하나만 먼저 pull 한다."""
        image = self.backend_image()
        if self.docker.image_exists(image):
            return True
        log(f"backend 이미지를 받습니다: {image}")
        self.docker.pull(image, on_line=log)
        return self.docker.image_exists(image)

    def _cli(self, args: list[str], *, source: str | None = None, mounts: list[str] | None = None,
             timeout: float = 600.0):
        argv = ["run", "--rm", "--network", "none", "--user", "0", "--security-opt", "no-new-privileges:true",
                "--entrypoint", "python"]
        if source:
            argv += ["--mount", f"type=bind,source={source},target={SOURCE_MOUNT},readonly"]
        for m in mounts or []:
            argv += ["--mount", m]
        return self.docker.run([*argv, self.backend_image(), "-m", "app.cli", *args], timeout=timeout)

    def installer_schema(self) -> int | None:
        """본 설치 관리자가 설치하는 제품의 DB 스키마 버전 — backend 이미지에 조회한다."""
        r = self._cli(["schema-version"], timeout=120)
        try:
            return int(r.out.strip().splitlines()[-1]) if r.ok else None
        except (ValueError, IndexError):
            return None

    # ─── 백업 수신 ───

    def discard(self) -> dict:
        """수신한 백업과 추출한 설정을 삭제한다(서버 경로로 지정한 원본 파일은 변경하지 않는다)."""
        shutil.rmtree(self.dir, ignore_errors=True)
        self.store.delete(META)
        return self.info()

    def begin_upload(self, name: str, size: int | None) -> Path:
        """업로드 시작 — 불완전한 파일을 기록할 경로를 반환한다. 공간 부족 시 `RestoreError(507)` 발생."""
        if self.running:
            raise RestoreError(409, "apply_running")
        self.discard()
        target = self.upload_path.with_name(self.upload_path.name + ".part")
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            free = shutil.disk_usage(target.parent).free
        except OSError:
            free = None
        if size and free is not None and size > free:
            raise RestoreError(507, "no_space", need_bytes=size, free_bytes=free)
        self._save(status="none", state="uploading", reason=None, summary=None,
                   source={"kind": "upload", "name": safe_name(name), "size_bytes": size, "host_path": ""})
        return target

    def abort_upload(self, part: Path) -> None:
        try:
            part.unlink()
        except OSError:
            pass
        self.discard()

    def finish_upload(self, part: Path, name: str) -> dict:
        size = part.stat().st_size
        part.replace(self.upload_path)
        try:
            self.upload_path.chmod(0o600)
        except OSError:
            pass
        source = {"kind": "upload", "name": safe_name(name), "size_bytes": size,
                  "host_path": self.host_path(self.upload_path)}
        return self.check(source)

    def use_path(self, path: str, password: str | None = None) -> dict:
        """서버(호스트)에 이미 존재하는 백업 파일·폴더. 설치 폴더 하위 여부와 무관하게 읽기 전용으로 마운트하여 읽는다."""
        if self.running:
            raise RestoreError(409, "apply_running")
        self.discard()
        try:
            host = v.host_path(path)
        except v.Invalid:
            self._save(status="invalid", state="failed", reason="path_invalid",
                       source={"kind": "path", "name": None, "size_bytes": None, "host_path": ""})
            return self.info()
        if password:
            self._write_password(password)
        return self.check({"kind": "path", "name": PurePosixPath(host).name, "size_bytes": None, "host_path": host})

    def set_password(self, password: str) -> dict:
        m = self.meta()
        if m.get("status") not in ("password_required", "password_wrong"):
            raise RestoreError(409, "restore_password_not_needed")
        if not password or len(password) > MAX_PASSWORD or any(ch in password for ch in "\r\n\x00"):
            raise RestoreError(422, "password_invalid")
        self._write_password(password)
        return self.check(m["source"], verify=False, summary=m.get("summary"))

    def _write_password(self, password: str) -> None:
        write_private(self.password_path, password + "\n")

    def _password_mount(self) -> tuple[list[str], list[str]]:
        if not self.password_path.exists():
            return [], []
        return ([f"type=bind,source={self.host_path(self.password_path)},target=/restore-pass,readonly"],
                ["--password-file", "/restore-pass"])

    def check(self, source: dict, *, verify: bool = True, summary: dict | None = None) -> dict:
        """수신한 백업을 확인한다 — 형식(inspect) → 손상(verify) → 설정 추출(extract-config, 암호).

        결과는 상태 파일에 기록하고 `info()` 형식으로 반환한다. 원본은 읽기 전용으로만 마운트한다.
        """
        host = source["host_path"]
        self._save(source=source, status="none", state="checking", reason=None)

        def done(status: str, reason: str | None = None, **more) -> dict:
            state = "ready" if status == "ok" else "failed"
            self._save(status=status, state=state, reason=reason, checked_at=now_iso(), **more)
            return self.info()

        if not self.ensure_backend_image():
            return done("invalid", "backend_image_missing")
        if summary is None:
            r = self._cli(["backup", "inspect", SOURCE_MOUNT, "--json"], source=host, timeout=300)
            if not r.ok:
                low = r.text.lower()
                if any(k in low for k in ("bind source path does not exist", "no such file or directory",
                                          "invalid mount config", "찾을 수 없습니다")):
                    return done("not_found")
                if "손상" in r.text and "manifest" in r.text:
                    return done("corrupt")
                return done("invalid", "format_unsupported" if "형식 버전" in r.text else "not_a_backup")
            summary = _json_tail(r.out)
            if not summary:
                return done("invalid", "not_a_backup")
        source = {**source, "size_bytes": source.get("size_bytes") or summary.get("size_bytes")}
        self._save(source=source, summary=summary)
        if not summary.get("config_included"):
            return done("invalid", "no_config")
        if verify:
            r = self._cli(["backup", "verify", SOURCE_MOUNT, "--json"], source=host, timeout=6 * 3600)
            report = _json_tail(r.out)
            if not report.get("ok"):
                return done("corrupt", None, problems=[str(p)[:200] for p in (report.get("problems") or [])][:10])
        pw_mounts, pw_args = self._password_mount()
        if summary.get("config_encrypted") and not pw_args:
            return done("password_required")

        shutil.rmtree(self.config_dir, ignore_errors=True)
        self.config_dir.mkdir(parents=True, exist_ok=True)
        out_mount = f"type=bind,source={self.host_path(self.config_dir)},target=/restore-config"
        r = self._cli(["backup", "extract-config", SOURCE_MOUNT, "--out", "/restore-config", *pw_args],
                      source=host, mounts=[out_mount, *pw_mounts], timeout=600)
        if not r.ok:
            shutil.rmtree(self.config_dir, ignore_errors=True)
            if summary.get("config_encrypted"):
                try:
                    self.password_path.unlink()
                except OSError:
                    pass
                return done("password_wrong")
            return done("invalid", "config_unreadable")
        env = self.backup_env()
        if not env.get("SECRET_KEY"):
            return done("invalid", "no_config")
        return done("ok", None, installer_schema=self.installer_schema())

    # ─── 내용 확인 ───

    def _require_ready(self) -> None:
        if not self.ready:
            raise RestoreError(409, "restore_no_backup")

    def version_verdict(self) -> dict:
        m = self.meta()
        return rc.judge_version(self.summary(), installer_version=self.bundle.version,
                                installer_schema=m.get("installer_schema"))

    def blockers(self, answers: ans.Answers | None = None) -> list[dict]:
        out: list[dict] = []
        verdict = self.version_verdict()
        summary = self.summary()
        if verdict["status"] == "newer":
            out.append({"code": "version_newer", "vars": {
                "reason": verdict["reason"], "backup": summary.get("product_version"),
                "installer": self.bundle.version, "backup_schema": summary.get("schema_version"),
                "installer_schema": self.meta().get("installer_schema")}})
        zones, addons, unknown = rc.backup_zones(self.backup_env(), summary, self.catalog)
        if unknown:
            out.append({"code": "zone_unknown", "vars": {"zones": unknown}})
        memory = self.store.facts().memory_mb
        if memory:
            judged = self.catalog.judge([*zones, *addons], memory)
            if judged.below_minimum:
                out.append({"code": "memory_below_minimum", "vars": judged.as_dict()})
            elif not judged.ok:
                out.append({"code": "memory_insufficient", "vars": judged.as_dict()})
        return out

    def review(self, *, detected_network: str | None = None) -> dict:
        self._require_ready()
        summary, env = self.summary(), self.backup_env()
        verdict = self.version_verdict()
        zones, addons, _ = rc.backup_zones(env, summary, self.catalog)
        storage = summary.get("storage") or {"kind": "local"}
        from_nfs = storage.get("kind") == "nfs"
        return {
            "source_url": summary.get("source_url") or env.get("APP_URL") or None,
            "created_at": summary.get("created_at"),
            "backup_version": summary.get("product_version"),
            "installer_version": self.bundle.version,
            "version_status": verdict["status"],
            "version_reason": verdict["reason"],
            "schema_version": summary.get("schema_version"),
            "installer_schema_version": self.meta().get("installer_schema"),
            "kind": summary.get("kind"),
            "size_bytes": summary.get("size_bytes"),
            "zones": [*zones, *addons],
            "users": summary.get("users"),
            "data_bytes": summary.get("data_bytes"),
            "storage": {"kind": "nfs", "server": storage.get("server"), "export": storage.get("export")}
            if from_nfs else {"kind": "local"},
            "files_included": bool(summary.get("files_included")) and not from_nfs,
            "files_bytes": summary.get("files_bytes") if not from_nfs else None,
            "domain": rc.backup_host(env, summary),
            "mail_domain": env.get("DOMAIN") or None,
            "install_id": summary.get("install_id") or env.get("JW_INSTALL_ID") or None,
            "network": rc.network_of(env) if rc.network_of(env) == "proxy" else (detected_network or "direct"),
            "proxy_addresses": [],
            "subnet": rc.subnet_of(env),
            "blockers": self.blockers(),
        }

    # ─── 응답 생성 · 시작 ───

    def backup_install_id(self) -> str:
        return str(self.summary().get("install_id") or self.backup_env().get("JW_INSTALL_ID") or "")

    def build_answers(self, target: dict) -> tuple[ans.Answers, dict, list[ans.FieldError]]:
        """새 서버에서 지정한 값 + 백업 설정 → (응답, 응답의 비밀, 오류). 저장 작업 없음."""
        self._require_ready()
        summary, env = self.summary(), self.backup_env()
        target = dict(target)
        domain = str(target.get("domain") or rc.backup_host(env, summary)).strip()
        target["domain"] = domain
        network = target.get("network") or (rc.network_of(env) if rc.network_of(env) == "proxy" else "direct")
        target["network"] = network
        errors: list[ans.FieldError] = []
        if not target.get("cert"):
            if network == "proxy":
                target["cert"] = "proxy"
            elif domain and v.is_ip(domain):
                target["cert"] = "temporary"
            else:
                # 접속 주소가 아직 원래 서버를 가리키면 차단하지 않고 임시 인증서로 진행
                target["cert"] = "auto" if self._dns(domain) == "match" else "temporary"
        elif target["cert"] == "temporary" and not (domain and v.is_ip(domain)):
            self._dns(domain)
        livekit = None
        try:
            livekit = (self.config_dir / "livekit" / "livekit.yaml").read_text(encoding="utf-8")
        except OSError:
            pass
        try:
            answers, secrets = rc.answers_from_backup(env, summary, target, self.catalog, self.bundle,
                                                      turn=rc.turn_enabled(livekit))
        except ans.StructureError as e:
            return ans.Answers(mode="restore"), {}, list(e.errors)

        facts = self.store.facts()
        errors += ans.validate(ans.join(ans.split(answers)[0], secrets), self.catalog, facts)
        backup_storage = summary.get("storage") or {"kind": "local"}
        if backup_storage.get("kind") == "nfs" and answers.storage.kind != "nfs":
            errors.append(ans.FieldError("storage.kind", "storage_must_be_nfs"))
        if self.version_verdict()["status"] == "newer":
            errors.append(ans.FieldError("mode", "version_newer", self.blockers()[0]["vars"]))
        return answers, secrets, errors

    def _dns(self, domain: str) -> str:
        try:
            status = self.dns_status(domain)
        except Exception:  # noqa: BLE001 — 확인 실패 시 미확인으로 간주한다(차단하지 않음)
            status = "unknown"
        self.store.update_facts(dns_status=status)
        return status

    def marker_verdict(self, answers: ans.Answers) -> dict:
        """NFS 공유의 저장소 마커가 백업의 설치와 일치하는지 여부 — {"status": match|missing|mismatch|unknown, "install_id"}."""
        opts = render.storage_volume(answers)["opts"]
        found = read_nfs_marker(self.docker, opts)
        return judge_marker(found, self.backup_install_id())

    def prepare(self, target: dict) -> tuple[ans.Answers, dict, list[ans.FieldError]]:
        """`build_answers` + 저장소 마커 대조(NFS) — 화면의 시작과 응답 파일(무인)이 공통으로 사용한다."""
        answers, secrets, errors = self.build_answers(target)
        if not errors and answers.storage.kind == "nfs":
            verdict = self.marker_verdict(answers)
            from_nfs = (self.summary().get("storage") or {}).get("kind") == "nfs"
            if verdict["status"] == "mismatch":
                errors.append(ans.FieldError("storage", "storage_other_install"))
            elif verdict["status"] == "missing" and from_nfs:
                errors.append(ans.FieldError("storage", "storage_marker_missing"))
        return answers, secrets, errors

    def start(self, target: dict) -> dict:
        """복원 시작 — 응답을 생성하여 저장하고 엔진을 실행한다. 문제가 있으면 `RestoreError(422, restore_invalid)` 발생."""
        if self.running:
            raise RestoreError(409, "apply_running")
        answers, secrets, errors = self.prepare(target)
        if errors:
            raise RestoreError(422, "restore_invalid", errors=[e.as_dict() for e in errors])
        self.store.save_answers(ans.join(ans.split(answers)[0], secrets), keep_secrets=False)
        self.store.write("wizard.json", {"step": "apply"})
        self.store.delete("apply.json")
        if self.engine is None or not self.engine.start():
            raise RestoreError(409, "apply_running")
        return {"started": True}

    def cleanup(self) -> None:
        """완료 후 — 추출해 둔 설정(암호화 키가 평문으로 포함)·암호·업로드한 사본을 삭제한다. 요약은 보존한다."""
        for path in (self.config_dir, self.dir / "upload"):
            shutil.rmtree(path, ignore_errors=True)
        try:
            self.password_path.unlink()
        except OSError:
            pass


def safe_name(name: str) -> str:
    """업로드한 파일의 이름 — 표시용으로만 사용한다(저장 경로에는 사용하지 않는다)."""
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    base = "".join(ch for ch in base if ch.isprintable() and ch not in '<>:"|?*')[:120].strip()
    return base or f"backup{ARCHIVE_SUFFIX}"


# ─── NFS 저장소 마커 ───


def read_nfs_marker(docker, opts: dict) -> dict:
    """NFS 공유의 저장소 마커 파일을 읽는다 — 임시 볼륨으로 마운트한 뒤 삭제한다. {"status": found|missing|unreadable|error, "install_id"}."""
    name = f"jw-nfs-marker-{pysecrets.token_hex(6)}"
    created = docker.volume_create(name, opts, labels={"jw.temporary": "1"})
    if not created.ok:
        return {"status": "error", "install_id": None}
    try:
        r = docker.helper(["read-marker", "/mnt"], volumes=[f"{name}:/mnt:nocopy"], user=eng.BACKEND_UID_GID, timeout=90)
        data = eng.helper_json(r)
        return data if data.get("status") else {"status": "error", "install_id": None}
    finally:
        docker.volume_rm(name)


def judge_marker(found: dict, backup_install_id: str) -> dict:
    """저장소 마커와 백업의 설치 id 대조. 저장소 마커가 없으면 missing, 다른 설치이면 mismatch."""
    status, marker_id = found.get("status"), found.get("install_id") or ""
    if status == "missing":
        return {"status": "missing", "install_id": None}
    if status == "found":
        if backup_install_id and marker_id == backup_install_id:
            return {"status": "match", "install_id": marker_id}
        return {"status": "mismatch", "install_id": marker_id}
    return {"status": "unknown", "install_id": None}


# ─── 단계 ───


def _mgr(ctx: eng.Context) -> RestoreManager:
    return RestoreManager(paths=ctx.paths, store=ctx.store, docker=ctx.docker, bundle=ctx.bundle, catalog=ctx.catalog,
                          registry=ctx.registry, image_tag=ctx.image_tag)


def _from_nfs(summary: dict) -> bool:
    return (summary.get("storage") or {}).get("kind") == "nfs"


def files_in_backup(summary: dict) -> bool:
    return bool(summary.get("files_included")) and not _from_nfs(summary)


def plan_steps(answers: ans.Answers, plan: render.Plan, store) -> list[str]:
    summary = (store.read(META, {}) or {}).get("summary") or {}
    steps = ["unpack"]
    if render.storage_volume(answers)["kind"] != "volume":
        steps.append("storage")
    steps += ["pull", "database"]
    if files_in_backup(summary):
        steps.append("files")
    if plan.tls or plan.cert_aliases:
        steps.append("cert")
    steps.append("zones")
    return steps


def outcome(answers: ans.Answers, store) -> dict:
    """완료 화면이 문구를 선택하는 데 사용하는 값."""
    meta = store.read(META, {}) or {}
    summary = meta.get("summary") or {}
    if _from_nfs(summary):
        files = "nfs"
    else:
        files = "restored" if summary.get("files_included") else "not_included"
    source = str(summary.get("source_url") or "")
    old_host = source.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0]
    return {"files": files, "storage_kind": answers.storage.kind, "cert": answers.access.cert,
            "domain_changed": bool(old_host) and old_host != answers.access.domain}


def want_certs(answers: ans.Answers, summary: dict, env: dict) -> bool:
    """백업의 인증서 복원 여부 — 접속 주소가 동일하고 자동 발급을 사용하는 경우에만 복원한다(발급받은 인증서를 계속 사용).

    주소가 변경되었으면 이전 인증서는 사용할 수 없으며, 임시 인증서·프록시 구성은 인증서 볼륨을 새로 구성한다.
    """
    return ("certs" in (summary.get("items") or []) and answers.access.cert == "auto"
            and answers.access.domain == rc.backup_host(env, summary))


def step_unpack(ctx: eng.Context) -> None:
    mgr = _mgr(ctx)
    if not mgr.ready:
        raise eng.StepError("restore_backup_missing", "restore_upload_again")
    env = mgr.backup_env()
    if not env.get("SECRET_KEY"):
        raise eng.StepError("restore_config_failed", "restore_upload_again")
    sd = ctx.bundle.security_defaults
    have = ctx.store.env_secrets()

    # 1) 백업에서 가져오는 값 — 암호화 키·DB 비밀번호·구역 키·설치 id
    changes: dict = dict(rc.carried_secrets(env, ctx.bundle))
    ctx.redact(*[val for val in changes.values() if isinstance(val, str)])
    install = ctx.store.install()
    backup_id = mgr.backup_install_id()
    if backup_id and install["install_id"] != backup_id:
        install["install_id"] = backup_id               # 저장소 마커와 일치해야 함 — 백업의 값을 유지
        ctx.store.write("install.json", install)
        ctx.log("설치 id 를 백업의 것으로 맞췄습니다")
    changes["JW_INSTALL_ID"] = ctx.store.install()["install_id"]
    # 2) 신규 생성하는 값 — 설치 관리자 내부 키, 백업에 없던 비밀값
    if not have.get("JW_INSTALLER_KEY"):
        changes["JW_INSTALLER_KEY"] = pysecrets.token_hex(24)
    wanted = [*sd.names(default_only=True), "SMTP_PASSWORD"]
    missing = [n for n in wanted if not changes.get(n) and not have.get(n)]
    if missing:
        ctx.log(f"백업에 없는 비밀값 {len(missing)}개를 새로 만듭니다")
        changes.update(eng.generate_secrets(ctx, missing))
    # 3) 그대로 이전하는 설정 — 설치 관리자가 자체적으로 기록하는 변수는 새 응답에서 재생성한다
    plan = render.derive(ctx.answers, ctx.facts, ctx.catalog)
    managed = {key for _, pairs in render.env_sections(ctx.answers, {}, ctx.facts, plan, version="", registry="",
                                                        gitea_image="") for key, _ in pairs}
    managed.add("JW_SOURCE_URL")                       # 값이 없으면 render 가 포함하지 않는 변수 — 아래에서 별도로 승계
    extra = rc.extra_env(env, managed, ctx.bundle)
    changes[render.EXTRA_ENV_KEY] = extra
    # 소스 주소 — 백업을 생성한 서버가 수정판의 소스를 가리키고 있었으면 새 서버에서도 해당 주소를 가리켜야 한다.
    # 새 설치 관리자에 지정한 값(-e JW_SOURCE_URL)이 있으면 해당 값이 우선한다(render.settle_source_url).
    carried_source = valid_source_url(env.get("JW_SOURCE_URL"))
    if carried_source:
        ctx.facts.source_url = carried_source
        ctx.store.update_facts(source_url=carried_source)
    ctx.store.update_env_secrets(changes)
    ctx.log(f"백업의 설정을 가져왔습니다 — 비밀값 {len(rc.carried_secrets(env, ctx.bundle))}개, "
            f"그대로 옮긴 변수 {len(extra)}개")

    plan = ctx.write_stack()
    ctx.log(f"설정 파일을 썼습니다 — 접속 주소 {plan.domain}, 구역: {', '.join(plan.zones) or '(기본만)'}")
    r = ctx.docker.compose("config", "-q", timeout=120)
    if not r.ok:
        raise eng.StepError("compose_invalid", "see_log", detail=r.err[-500:])
    if render.storage_volume(ctx.answers)["kind"] == "volume":
        eng.prepare_storage(ctx)


def step_storage(ctx: eng.Context) -> None:
    mgr = _mgr(ctx)
    if ctx.answers.storage.kind == "nfs":
        verdict = judge_marker(read_nfs_marker(ctx.docker, render.storage_volume(ctx.answers)["opts"]),
                               mgr.backup_install_id())
        if verdict["status"] == "mismatch":
            raise eng.StepError("storage_other_install", "storage_use_same_share")
        if verdict["status"] == "missing" and _from_nfs(mgr.summary()):
            raise eng.StepError("storage_marker_missing", "storage_use_same_share")
        ctx.log(f"저장소 표식: {verdict['status']}")
    eng.prepare_storage(ctx)


def _create_only(ctx: eng.Context, services: list[str]) -> None:
    """컨테이너를 생성만 한다 — 복원이 해당 컨테이너의 볼륨을 찾아 데이터를 기록한다(기동은 구역 단계에서 수행)."""
    if not services:
        return
    r = ctx.docker.compose("up", "--no-start", "--no-deps", "--no-build", *services, timeout=900, on_line=ctx.log)
    if not r.ok:
        raise eng.StepError("service_start_failed", "see_log", services=services, detail=r.err[-300:])


def step_database(ctx: eng.Context) -> None:
    mgr = _mgr(ctx)
    summary, env = mgr.summary(), mgr.backup_env()
    source = mgr.source_host_path()
    if not mgr.ready or not source:
        raise eng.StepError("restore_backup_missing", "restore_upload_again")
    ctx.up(["postgres", "redis"])
    try:
        ctx.wait_ready("ws-postgres", 180)
        ctx.wait_ready("ws-redis", 120)
    except eng.StepError as e:
        raise eng.StepError("database_not_ready", "see_container_log", **e.vars) from None

    active = set(ctx.active_services())
    in_backup = list(summary.get("items") or [])
    items = [i for i in DATA_ITEMS if i in in_backup]
    need: list[str] = []
    for item, service in (("mail", "mailserver"), ("gitea", "gitea")):
        if item in items:
            if service in active:
                need.append(service)
            else:
                items.remove(item)
                ctx.log(f"{item}: 이 구성에서는 켜지지 않는 구역이라 되돌리지 않습니다")
    if want_certs(ctx.answers, summary, env) and "nginx" in active:
        items.append("certs")
        need.append("nginx")
    _create_only(ctx, need)

    ctx.log("데이터를 되돌립니다: " + ", ".join(items))
    r = ctx.docker.compose(
        "run", "--rm", "--no-deps", "-T", "--user", "0", "--entrypoint", "python",
        "-v", f"{source}:{SOURCE_MOUNT}:ro", "backend",
        "-m", "app.cli", "restore", SOURCE_MOUNT, "--yes", "--json", "--items", ",".join(items),
        timeout=12 * 3600, on_line=ctx.log)
    report = _json_tail(r.out)
    if not r.ok or not report.get("ok"):
        ctx.log(r.text[-800:])
        raise eng.StepError("restore_database_failed", "see_log", stage=report.get("stage") or "",
                            detail=str(report.get("error") or r.err[-300:])[:300], state=report.get("state") or "")
    ctx.detail["items"] = report.get("items") or items
    ctx.detail["schema"] = report.get("schema")
    ctx.save()

    # 메일 서명 키(DKIM)는 백업의 것을 계속 사용한다 — 등록된 DNS 레코드와 일치해야 한다
    if ctx.plan.mail_builtin and "mail" in items:
        restored = ctx.paths.stack / "mailserver" / "config" / "rspamd" / "dkim" / f"{render.DKIM_SELECTOR}.private"
        try:
            pem = restored.read_text(encoding="utf-8")
            write_private(ctx.store.dir / "dkim" / f"{v.domain(ctx.plan.mail_domain)}.pem", pem)
            ctx.log("메일 서명 키를 백업의 것으로 맞췄습니다")
        except (OSError, v.Invalid):
            ctx.log("백업에 메일 서명 키가 없습니다 — 새 키를 씁니다(메일 레코드를 다시 등록해야 합니다)")
            ctx.warn("restore_dkim_regenerated", mail_domain=ctx.plan.mail_domain)
    ctx.write_stack()                    # 메일 설정 폴더가 백업 시점으로 복원됨 — 이 버전의 파일을 다시 기록
    eng.migrate_database(ctx)


def step_files(ctx: eng.Context) -> None:
    mgr = _mgr(ctx)
    source = mgr.source_host_path()
    if not source:
        raise eng.StepError("restore_backup_missing", "restore_upload_again")
    spec = render.storage_volume(ctx.answers)
    mount = f"{spec['name']}:/storage" + ("" if spec["kind"] == "volume" else ":nocopy")
    uid, gid = eng.BACKEND_UID_GID.split(":")
    ctx.log("파일 저장소를 되돌립니다")
    r = ctx.docker.helper(["restore-files", SOURCE_MOUNT, "/storage", "--member", FILES_MEMBER,
                           "--uid", uid, "--gid", gid],
                          mounts=[f"type=bind,source={source},target={SOURCE_MOUNT},readonly"], volumes=[mount],
                          timeout=24 * 3600)
    data = eng.helper_json(r)
    if data.get("status") != "restored":
        ctx.log(r.text[-500:])
        raise eng.StepError("restore_files_failed", "see_log", error=data.get("error") or "",
                            detail=str(data.get("detail") or r.err[-200:])[:200])
    ctx.detail["entries"], ctx.detail["bytes"] = data.get("entries"), data.get("bytes")
    ctx.save()
    ctx.log(f"파일 {data.get('entries')}개 항목을 되돌렸습니다")
    eng.prepare_storage(ctx)             # 저장소 마커가 백업에 없던 설치도 존재 — 재확인 후 없으면 기록


def step_cert(ctx: eng.Context) -> None:
    if ctx.plan.cert_mode == "temporary":
        existing = eng.read_cert(ctx, ctx.plan.cert_dir)
        from app import certs

        if existing and not certs.is_self_signed(existing):
            # 백업에서 복원한 인증서 폴더가 남아 있다(자동 발급 → 임시로 전환하여 재시도한 경우) — 비운 뒤 임시 인증서를 배치한다
            ctx.docker.helper(["drop-cert", "--name", ctx.plan.cert_dir],
                              volumes=[f"{eng.CERT_VOLUME}:/etc/letsencrypt"], timeout=60)
    eng.step_cert(ctx)


def step_zones(ctx: eng.Context) -> None:
    mgr = _mgr(ctx)
    # DB 에 저장되는 설정(외부 SMTP 의 보안 방식·AI 제공자)은 백업에 포함되어 있다 — 덮어쓰지 않는다
    eng.step_zones(ctx, configure=False)

    # 확인 — 프런트 경유로 backend 에 접근 가능한지, 사용자 수가 백업과 동일한지
    scheme = "https" if ctx.plan.tls else "http"
    status, _ = ctx.http.get(f"{scheme}://nginx/api/health", headers={"Host": ctx.plan.domain})
    if status != 200:
        ctx.warn("restore_front_unverified", status=status)
    expected = mgr.summary().get("users")
    r = ctx.docker.exec("ws-postgres", ["psql", "-U", "workspace", "-d", "workspace", "-At", "-c",
                                        "SELECT count(*) FROM users"], timeout=60)
    found = r.out.strip() if r.ok else ""
    if found.isdigit():
        ctx.detail["users"] = int(found)
        ctx.save()
        if isinstance(expected, int) and int(found) != expected:
            ctx.warn("restore_users_mismatch", expected=expected, found=int(found))
        ctx.log(f"확인: 사용자 {found}명")
    else:
        ctx.warn("restore_check_skipped")

    eng.step_lock(ctx)
    mgr.cleanup()
    ctx.log("복원이 끝났습니다")


STEPS: dict[str, Callable[[eng.Context], None]] = {
    "unpack": step_unpack, "storage": step_storage, "pull": eng.step_pull, "database": step_database,
    "files": step_files, "cert": step_cert, "zones": step_zones,
}
