"""백업·복원 실행 — 계획(app/backup/plan.py)을 돌리고 형식(app/backup/format.py)으로 묶는다.

실행기(`Runner`)는 주입한다. 기본은 이 프로세스에서 docker CLI 를 부르는 `SubprocessRunner` 다
(backend 컨테이너에 docker CLI 와 소켓이 있다). 설치 관리자는 같은 계획을 자기 실행기로 돌릴 수 있다.

호출하는 곳:
- `python -m app.cli backup …` / `restore …` (정식 경로)
- 관리 화면의 "지금 백업"·예약 백업(app/backup/service.py)

복원은 backend 를 세워야 하므로 **실행 중인 backend 안에서는 돌지 않는다** — backend 이미지의 일회용
컨테이너에서 돈다(scripts/restore.sh, 설치 관리자).
"""

from __future__ import annotations

import io
import json
import os
import shutil
import socket
import subprocess
import tarfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Protocol
from urllib.parse import unquote, urlparse

from app.backup import format as fmt
from app.backup import plan as pl
from app.backup.format import BackupError
from app.backup.plan import StackConfig, Step

# 컨테이너 이름 = 접두어 + 서비스. 접두어는 환경변수 JW_CONTAINER_PREFIX(기본 "ws-" — compose 의 container_name).
ENV_PREFIX = "JW_CONTAINER_PREFIX"
DB_CONSUMER_SERVICES = ("backend", "sso", "ldap")        # 같은 DB 를 쓰는 서비스 — 복원하는 동안 세운다
SIGNING_VOLUME = "jw-android-signing"
# 프로젝트 폴더에서 설정으로 치는 경로(있는 것만 뜬다). 메일 계정·DKIM 은 mail 항목이 따로 뜬다.
CONFIG_CANDIDATES = (
    ".env", "docker-compose.override.yml", "docker-compose.site.yml",
    "nginx/site.d", "nginx/private.d", "livekit/livekit.yaml",
)
MAIL_CONFIG_PATH = "mailserver/config"

SAFETY_DIR = "_pre-restore"
SAFETY_KEEP = 2
_SPACE_MARGIN = 64 * 1024 * 1024

Log = Callable[[str], None]


# ─── 실행기 ───


@dataclass
class Completed:
    rc: int
    out: str = ""
    err: str = ""


class Runner(Protocol):
    def run(self, argv: tuple[str, ...] | list[str], *, stdin: Path | None = None, stdout: Path | None = None,
            timeout: int = 600) -> Completed: ...


class SubprocessRunner:
    """이 프로세스에서 명령을 돈다. stdout 을 파일로 받거나(큰 데이터) 문자열로 받는다(조회)."""

    def run(self, argv, *, stdin=None, stdout=None, timeout=600) -> Completed:
        fin = open(stdin, "rb") if stdin else None
        fout = open(stdout, "wb") if stdout else None
        try:
            proc = subprocess.run(
                list(argv), stdin=fin if fin else subprocess.DEVNULL,
                stdout=fout if fout else subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
            )
        except FileNotFoundError:
            return Completed(127, err=f"{argv[0]}: 명령을 찾을 수 없습니다")
        except subprocess.TimeoutExpired:
            return Completed(124, err=f"시간 초과({timeout}초)")
        finally:
            if fin:
                fin.close()
            if fout:
                fout.close()
        out = "" if fout else (proc.stdout or b"").decode("utf-8", "replace")
        return Completed(proc.returncode, out, (proc.stderr or b"").decode("utf-8", "replace")[-2000:])


@dataclass
class StepFailure:
    step: Step
    rc: int
    err: str

    def __str__(self) -> str:
        detail = self.err.strip().splitlines()
        return f"{self.step.id}({self.step.title}) 실패 — 종료 코드 {self.rc}" + (f": {detail[-1]}" if detail else "")


def run_steps(steps: list[Step], root: Path, runner: Runner, log: Log, *, stop_on_failure: bool) -> list[StepFailure]:
    """단계를 차례로 돈다. 실패한 단계의 항목은 남은 단계를 건너뛴다(always 단계는 돈다).

    stop_on_failure=True 면 첫 실패 뒤로는 always 단계만 돈다(복원). False 면 다른 항목은 계속한다(백업).
    """
    failures: list[StepFailure] = []
    broken: set[str] = set()
    for step in steps:
        if not step.always and (step.item in broken or (stop_on_failure and failures)):
            continue
        log(f"  · {step.title}")
        done = runner.run(
            step.argv, stdin=(root / step.stdin) if step.stdin else None,
            stdout=(root / step.stdout) if step.stdout else None, timeout=step.timeout,
        )
        if done.rc not in step.ok_codes:
            failures.append(StepFailure(step, done.rc, done.err))
            broken.add(step.item)
            if step.stdout:
                (root / step.stdout).unlink(missing_ok=True)
    return failures


# ─── 구성 알아내기 ───


def _inspect(runner: Runner, kind: str, name: str) -> dict | None:
    done = runner.run(("docker", kind, "inspect", name) if kind != "container" else ("docker", "inspect", name))
    if done.rc != 0:
        return None
    try:
        data = json.loads(done.out)
        return data[0] if data else None
    except (ValueError, IndexError, TypeError):
        return None


def _mount(info: dict | None, dest: str) -> tuple[str, str]:
    """컨테이너의 dest 에 붙은 것 → (docker -v 에 줄 출발지, 종류 volume|bind). 없으면 ("", "")."""
    for m in (info or {}).get("Mounts", []):
        if m.get("Destination") == dest:
            if m.get("Type") == "volume":
                return m.get("Name", ""), "volume"
            return m.get("Source", ""), "bind"
    return "", ""


def _running(info: dict | None) -> bool:
    return bool((info or {}).get("State", {}).get("Running"))


def db_creds(database_url: str) -> tuple[str, str]:
    """DATABASE_URL → (사용자, DB 이름)."""
    try:
        u = urlparse(database_url.replace("+asyncpg", ""))
        return (unquote(u.username or "") or "workspace", (u.path or "").lstrip("/") or "workspace")
    except ValueError:
        return ("workspace", "workspace")


def _storage_info(runner: Runner, source: str, kind: str) -> dict:
    info: dict = {"kind": "local"}
    if kind != "volume" or not source:
        return info
    vol = _inspect(runner, "volume", source) or {}
    opts = vol.get("Options") or {}
    if "nfs" in str(opts.get("type", "")).lower():
        info["kind"] = "nfs"
        for part in str(opts.get("o", "")).split(","):
            if part.startswith("addr="):
                info["server"] = part[5:]
        device = str(opts.get("device", ""))
        if device:
            info["export"] = device.lstrip(":")
    return info


@dataclass
class Discovery:
    config: StackConfig
    storage: dict
    self_container: str = ""              # 이 프로세스가 도는 컨테이너 이름(컨테이너 밖이면 빈 값)
    backend: str = "ws-backend"           # backend 컨테이너 이름(복원 뒤 상태 확인)


def discover(runner: Runner, env: dict[str, str] | None = None) -> Discovery:
    """실행 중인 스택을 들여다보고 계획에 넣을 구성을 만든다(읽기만 한다)."""
    env = dict(os.environ if env is None else env)
    prefix = env.get(ENV_PREFIX) or "ws-"
    postgres_name, mail_name, gitea_name = prefix + "postgres", prefix + "mailserver", prefix + "gitea"
    me = _inspect(runner, "container", socket.gethostname())
    backend = _inspect(runner, "container", prefix + "backend")
    base = me or backend
    if base is None:
        raise BackupError("docker 로 스택을 볼 수 없습니다(backend 컨테이너 안에서, docker 소켓이 붙은 채로 실행하세요)")
    postgres = _inspect(runner, "container", postgres_name)
    if postgres is None or not _running(postgres):
        raise BackupError(f"DB 컨테이너({postgres_name})가 실행 중이 아닙니다")

    user, name = db_creds(env.get("DATABASE_URL", ""))
    labels = (postgres.get("Config") or {}).get("Labels") or {}
    project_dir = env.get("JW_PROJECT_DIR") or labels.get("com.docker.compose.project.working_dir", "")
    helper = base.get("Image") or (base.get("Config") or {}).get("Image", "")

    cfg: dict = {"helper_image": helper, "postgres": postgres_name, "db_user": user, "db_name": name,
                 "project_dir": project_dir}
    probe = StackConfig(**cfg)

    if project_dir:
        candidates = (*CONFIG_CANDIDATES, MAIL_CONFIG_PATH)
        done = runner.run(pl._helper(probe, [f"{project_dir}:/v:ro"], [
            "sh", "-c", 'cd /v && for f in "$@"; do [ -e "$f" ] && echo "$f"; done; true', "sh", *candidates]))
        found = [line.strip() for line in done.out.splitlines() if line.strip()] if done.rc == 0 else []
        cfg["config_paths"] = tuple(f for f in found if f in CONFIG_CANDIDATES)
        if MAIL_CONFIG_PATH in found:
            cfg["mail_config_path"] = MAIL_CONFIG_PATH

    mail = _inspect(runner, "container", mail_name)
    if mail is not None:
        cfg.update(mail_container=mail_name, mail_running=_running(mail),
                   mail_data=_mount(mail, "/var/mail")[0], mail_state=_mount(mail, "/var/mail-state")[0])
    else:
        cfg.pop("mail_config_path", None)

    gitea = _inspect(runner, "container", gitea_name)
    if gitea is not None:
        has_db = runner.run(pl._psql(probe, "SELECT 1 FROM pg_database WHERE datname = 'gitea'"))
        cfg.update(gitea_container=gitea_name, gitea_running=_running(gitea), gitea_data=_mount(gitea, "/data")[0],
                   gitea_database="gitea" if has_db.rc == 0 and has_db.out.strip() == "1" else "")

    ref = backend or me
    storage_src, storage_type = _mount(ref, "/storage")
    storage = _storage_info(runner, storage_src, storage_type)
    cfg.update(storage=storage_src, storage_kind=storage["kind"], plugins_data=_mount(ref, "/plugins-data")[0])
    cfg["certs"] = _mount(_inspect(runner, "container", prefix + "nginx"), "/etc/letsencrypt")[0]
    if _inspect(runner, "volume", SIGNING_VOLUME) is not None:
        cfg["app_signing"] = SIGNING_VOLUME
    cfg["db_consumers"] = tuple(
        prefix + svc for svc in DB_CONSUMER_SERVICES if _running(_inspect(runner, "container", prefix + svc)))

    self_name = ((me or {}).get("Name") or "").lstrip("/")
    return Discovery(StackConfig(**cfg), storage, self_name, prefix + "backend")


def _query(runner: Runner, cfg: StackConfig, sql: str, db: str | None = None) -> str | None:
    done = runner.run(pl._psql(cfg, sql, db=db or cfg.db_name))
    return done.out.strip() if done.rc == 0 else None


def _int(value: str | None) -> int | None:
    try:
        return int(value) if value not in (None, "") else None
    except ValueError:
        return None


def _du_bytes(runner: Runner, cfg: StackConfig, source: str) -> int | None:
    done = runner.run(pl._helper(cfg, [f"{source}:/v:ro"], ["du", "-sk", "/v"]), timeout=1800)
    if done.rc == 0 and done.out.split():
        kb = _int(done.out.split()[0])
        return kb * 1024 if kb is not None else None
    return None


def collect_stats(runner: Runner, cfg: StackConfig, *, measure_storage: bool = False) -> dict:
    """요약 화면에 쓸 값들 — 백업을 만들 때 manifest 에 넣어 둔다.

    파일 저장소 크기는 전체 백업에서 로컬 저장소일 때만 잰다(파일이 많으면 오래 걸린다 — 업데이트 직전
    백업은 빨라야 하고, NFS 는 네트워크 너머를 훑어야 한다). 재지 않으면 None.
    """
    return {
        "users": _int(_query(runner, cfg, "SELECT count(*) FROM users")),
        "db_bytes": _int(_query(runner, cfg, f"SELECT pg_database_size({pl._literal(cfg.db_name)})")),
        "storage_bytes": _du_bytes(runner, cfg, cfg.storage)
        if measure_storage and cfg.storage and cfg.storage_kind == "local" else None,
    }


def postgres_version(runner: Runner, cfg: StackConfig) -> int | None:
    return _int(_query(runner, cfg, "SHOW server_version_num", db="postgres"))


# ─── 사전 검사 ───


def estimate_bytes(runner: Runner, cfg: StackConfig, plan: pl.BackupPlan, stats: dict) -> int:
    """예상 크기(넉넉하게 — 압축 전 크기로 센다)."""
    total = int(stats.get("db_bytes") or 0) if "db" in plan.items else 0
    sources = {
        "mail": [cfg.mail_data, cfg.mail_state], "gitea": [cfg.gitea_data], "plugins-data": [cfg.plugins_data],
        "certs": [cfg.certs], "app-signing": [cfg.app_signing], "files": [cfg.storage],
    }
    for item in plan.items:
        for source in filter(None, sources.get(item, [])):
            if item == "files" and stats.get("storage_bytes") is not None:
                total += int(stats["storage_bytes"])          # 이미 쟀다
            else:
                total += _du_bytes(runner, cfg, source) or 0
    return total


def check_destination(dest: Path, need_bytes: int) -> None:
    """쓸 수 있는지, 자리가 넉넉한지. 아니면 BackupError — 시작하지 않는다."""
    try:
        dest.mkdir(parents=True, exist_ok=True)
        probe = dest / f".write-test-{os.getpid()}"
        probe.write_bytes(b"")
        probe.unlink()
    except OSError as e:
        raise BackupError(f"백업 위치에 쓸 수 없습니다: {dest} ({e.strerror or e})") from None
    free = shutil.disk_usage(dest).free
    need = int(need_bytes * 1.05) + _SPACE_MARGIN
    if free < need:
        raise BackupError(
            f"백업 위치의 여유 공간이 모자랍니다: 필요 약 {_human(need)}, 남은 공간 {_human(free)} ({dest})"
        )


def _human(n: int) -> str:
    value = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f}{unit}" if unit == "B" else f"{value:.1f}{unit}"
        value /= 1024
    return f"{n}B"


# ─── 백업 만들기 ───


@dataclass
class BackupResult:
    path: Path
    manifest: dict
    status: str                                   # success | partial
    failures: list[str] = field(default_factory=list)
    size_bytes: int = 0


def _product_version() -> str:
    from app.version import APP_VERSION

    return APP_VERSION


def _schema_version() -> int:
    from app.db.schema_version import SCHEMA_VERSION

    return SCHEMA_VERSION


def _zones(env: dict[str, str]) -> list[str]:
    """설치된 구역 id — JW_ZONES 가 있으면 그것, 없으면 전부(app/zones.py 와 같은 규칙)."""
    listed = [z.strip() for z in env.get("JW_ZONES", "").split(",") if z.strip()]
    if listed:
        return listed
    try:
        from app import zones

        return list(zones.all_zone_ids())
    except Exception:  # noqa: BLE001
        return []


def create_backup(
    dest_root: Path,
    *,
    kind: str = fmt.KIND_FULL,
    include_files: bool = False,
    password: str | None = None,
    runner: Runner | None = None,
    env: dict[str, str] | None = None,
    log: Log = print,
    check_space: bool = True,
    now: datetime | None = None,
) -> BackupResult:
    """백업 하나를 만든다. DB 를 못 뜨면(또는 사전 검사에 걸리면) BackupError — 디렉터리를 남기지 않는다.

    그 밖의 항목이 실패하면 그 항목을 빼고 status="partial" 로 돌려준다(무엇이 빠졌는지 manifest 와 결과에 있다).
    """
    runner = runner or SubprocessRunner()
    env = dict(os.environ if env is None else env)
    now = now or datetime.now(timezone.utc)
    found = discover(runner, env)
    cfg = found.config
    plan = pl.plan_backup(cfg, kind, include_files=include_files)
    stats = collect_stats(runner, cfg, measure_storage=kind == fmt.KIND_FULL)
    if check_space:
        check_destination(dest_root, estimate_bytes(runner, cfg, plan, stats))
    else:
        check_destination(dest_root, 0)

    base = f"{now.strftime('%Y%m%d_%H%M%S')}-{kind}"
    root = dest_root / base
    serial = 1
    while root.exists() or root.with_name(root.name + fmt.ARCHIVE_SUFFIX).exists():   # 같은 초에 두 번
        serial += 1
        root = dest_root / f"{base}-{serial}"
    root.mkdir(parents=True)
    fmt.restrict(root)
    log(f"[backup] {kind} 백업을 만듭니다: {root}")
    try:
        failures = run_steps(plan.steps, root, runner, log, stop_on_failure=False)
        failed_items = {f.step.item for f in failures if not f.step.always or f.step.stdout}
        if "db" in failed_items:
            raise BackupError("DB 를 뜨지 못했습니다 — " + "; ".join(str(f) for f in failures if f.step.item == "db"))

        manifest = fmt.new_manifest(
            kind=kind, product_version=_product_version(), schema_version=_schema_version(),
            install_id=env.get("JW_INSTALL_ID", "").strip(), domain=env.get("DOMAIN", ""),
            app_url=env.get("APP_URL", ""), zones=_zones(env), storage=found.storage, stats=stats,
            postgres_version=postgres_version(runner, cfg),
            secret_key_fingerprint=fmt.secret_fingerprint(env.get("SECRET_KEY", "")), created_at=now,
        )
        manifest["skipped"] = dict(plan.skipped)
        for item in plan.items:
            if item in failed_items:
                for step in plan.steps:
                    if step.item == item and step.stdout:
                        (root / step.stdout).unlink(missing_ok=True)
                continue
            files = [(s.stdout, s.role) for s in plan.steps if s.item == item and s.stdout]
            extra: dict = {}
            if item == "config" and password:
                plain = root / "config.tar"
                (root / "config.tar.enc").write_bytes(fmt.encrypt_bytes(plain.read_bytes(), password))
                plain.unlink()
                files, extra = [("config.tar.enc", "config")], {"encrypted": True, "encryption": fmt.ENCRYPTION_LABEL}
            elif item == "config":
                extra = {"encrypted": False}
            fmt.add_item(manifest, root, item, files, **extra)
        manifest["warnings"] = [str(f) for f in failures]
        if "config" in manifest["items"]:
            manifest["warnings"].insert(0, fmt.SECRET_WARNING)
        for item in failed_items:
            manifest["skipped"][item] = "failed"
        fmt.write_manifest(root, manifest)

        problems = fmt.verify(fmt.open_backup(root), password=password)
        if problems:
            raise BackupError("만든 백업이 자체 검증을 통과하지 못했습니다 — " + "; ".join(problems))
    except BaseException:
        shutil.rmtree(root, ignore_errors=True)
        raise
    size = sum(f.stat().st_size for f in root.iterdir() if f.is_file())
    status = "partial" if failures or ("config" in plan.skipped and "config" not in manifest["items"]) else "success"
    log(f"[backup] 끝: {status}, {_human(size)}")
    return BackupResult(root, manifest, status, [str(f) for f in failures], size)


def list_backups(dest_root: Path) -> list[dict]:
    """dest_root 아래의 백업 요약(새것부터). 읽을 수 없는 것은 건너뛴다."""
    found = []
    if not dest_root.is_dir():
        return found
    for entry in dest_root.iterdir():
        if entry.name.startswith(("_", ".")):
            continue
        if not (entry.is_dir() or entry.name.endswith(fmt.ARCHIVE_SUFFIX)):
            continue
        try:
            found.append({"path": str(entry), **fmt.summarize(entry)})
        except BackupError:
            continue
    return sorted(found, key=lambda s: s.get("created_at") or "", reverse=True)


def extract_config(path: Path, out_dir: Path, password: str | None = None) -> list[str]:
    """백업의 설정 묶음을 out_dir 에 푼다(DB·docker 없이). 돌려주는 값: 푼 경로들.

    새 서버로 옮길 때 설치 관리자가 스택을 띄우기 **전에** 부른다 — `.env` 의 암호화 키와 DB 비밀번호가
    있어야 복원한 DB 를 읽을 수 있다.
    """
    raw = fmt.read_config_tar(fmt.open_backup(path), password)
    out_dir.mkdir(parents=True, exist_ok=True)
    names: list[str] = []
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tar:
        for member in tar:
            parts = Path(member.name).parts
            if member.name.startswith("/") or ".." in parts or not (member.isfile() or member.isdir()):
                raise BackupError(f"설정 묶음에 허용되지 않는 항목이 있습니다: {member.name}")
            target = out_dir.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "wb") as f:
                shutil.copyfileobj(tar.extractfile(member), f)  # type: ignore[arg-type]
            fmt.restrict(target)
            names.append(member.name)
    return names


# ─── 복원 ───


class RestoreError(Exception):
    """복원이 실패했다. stage = 실패한 단계 이름, state = 그 뒤 DB 가 어떤 상태인지."""

    def __init__(self, stage: str, cause: str, *, state: str = "", done: list[str] | None = None):
        self.stage = stage
        self.cause = cause
        self.state = state
        self.done = done or []
        super().__init__(f"복원 실패 — 단계 '{stage}': {cause}" + (f" ({state})" if state else ""))


@dataclass
class RestoreResult:
    items: list[str]
    stages: list[str]
    schema_from: int
    schema_to: int
    safety_dump: str = ""
    config_restored: bool = False
    notes: list[str] = field(default_factory=list)


STATE_UNTOUCHED = "기존 데이터는 그대로입니다"
STATE_ROLLED_BACK = "DB 를 복원 전 상태로 되돌렸습니다"
STATE_ROLLBACK_FAILED = "DB 를 되돌리지 못했습니다 — 복원 전 덤프로 직접 되돌려야 합니다"


def check_compat(manifest: fmt.Manifest, *, schema_version: int, pg_version: int | None,
                 secret_key: str, items: list[str], with_config: bool, allow_key_mismatch: bool = False) -> None:
    """이 백업을 이 코드·이 서버에 복원해도 되는가. 안 되면 BackupError."""
    if manifest.schema_version > schema_version:
        raise BackupError(
            f"백업의 스키마 버전({manifest.schema_version})이 지금 제품이 아는 버전({schema_version})보다 높습니다 — "
            f"이 백업을 만든 버전({manifest.data.get('product_version') or '?'}) 이상의 제품에서 복원하세요"
        )
    theirs = manifest.data.get("postgres_version")
    if "db" in items and theirs and pg_version and theirs // 10000 > pg_version // 10000:
        raise BackupError(
            f"백업을 만든 PostgreSQL({theirs // 10000})이 지금 것({pg_version // 10000})보다 새 버전입니다 — "
            "더 낮은 버전으로는 덤프를 올릴 수 없습니다"
        )
    missing = [i for i in items if i not in manifest.items]
    if missing:
        raise BackupError("백업에 없는 항목입니다: " + ", ".join(missing))
    theirs_fp = manifest.data.get("secret_key_fingerprint") or ""
    if "db" in items and not with_config and not allow_key_mismatch and theirs_fp \
            and theirs_fp != fmt.secret_fingerprint(secret_key):
        raise BackupError(
            "이 백업은 다른 암호화 키(SECRET_KEY)로 만든 것입니다. 지금 키로는 DB 안의 암호화된 값"
            "(외부 메일 비밀번호·2단계 비밀·저장소 키)을 풀 수 없습니다. 백업의 설정까지 되돌리려면 "
            "--with-config 를 붙이고, 그래도 진행하려면 --allow-key-mismatch 를 붙이세요"
        )


def _default_migrate() -> tuple[int, int]:
    """복원한 DB 에 스키마 변경 단계를 적용한다 → (전, 후)."""
    import asyncio

    async def _go() -> tuple[int, int]:
        from app.db import migrate as mg
        from app.db.session import engine

        try:
            result = await mg.migrate(engine)
            return result.from_version, result.to_version
        finally:
            await engine.dispose()

    return asyncio.run(_go())


def _wait_healthy(runner: Runner, container: str, seconds: int, sleep: Callable[[float], None]) -> str | None:
    """컨테이너가 healthy 가 될 때까지 기다린다. 문제가 있으면 그 설명, 없으면 None."""
    deadline = time.monotonic() + seconds
    last = "상태를 읽지 못했습니다"
    while True:
        info = _inspect(runner, "container", container) or {}
        state = info.get("State") or {}
        health = (state.get("Health") or {}).get("Status")
        if state.get("Running") and health in (None, "healthy"):
            return None
        last = f"실행={bool(state.get('Running'))}, 상태={health or state.get('Status')}"
        if not state.get("Running") and state.get("Status") == "exited":
            return f"컨테이너가 종료됐습니다({last})"
        if time.monotonic() >= deadline:
            return f"{seconds}초 안에 정상 상태가 되지 않았습니다({last})"
        sleep(3)


def restore_backup(
    path: Path,
    *,
    work_root: Path,
    items: list[str] | None = None,
    with_config: bool = False,
    password: str | None = None,
    allow_key_mismatch: bool = False,
    runner: Runner | None = None,
    env: dict[str, str] | None = None,
    migrate: Callable[[], tuple[int, int]] | None = None,
    log: Log = print,
    health_seconds: int = 300,
    sleep: Callable[[float], None] = time.sleep,
    now: datetime | None = None,
) -> RestoreResult:
    """백업에서 복원한다. 어느 단계든 실패하면 RestoreError(단계 이름·원인·그 뒤 상태).

    순서: 검증 → 버전 판정 → (tar 면 풀기) → 현재 DB 안전 덤프 → 서비스 정지 → DB 를 옆에 올리기 →
    바꿔 끼우기 → 스키마 변경 단계 → 나머지 항목 → 서비스 시작 → 확인 → 정리.
    DB 는 스키마 변경 단계까지 통과해야 확정되고, 그 전에 실패하면 원래 DB 로 돌아간다.
    """
    runner = runner or SubprocessRunner()
    env = dict(os.environ if env is None else env)
    now = now or datetime.now(timezone.utc)
    migrate = migrate or _default_migrate
    stages: list[str] = []
    stamp = now.strftime("%Y%m%d_%H%M%S")

    def fail(stage: str, cause: object, state: str = STATE_UNTOUCHED) -> RestoreError:
        return RestoreError(stage, str(cause), state=state, done=list(stages))

    # 1) 검증
    log("[restore] 백업을 검증합니다")
    try:
        backup = fmt.open_backup(path)
        manifest = backup.manifest
        chosen = list(items) if items is not None else [i for i in manifest.items if i != "config"]
        want_config = with_config or "config" in chosen
        chosen = [i for i in fmt.ITEMS if i in chosen and i != "config"]
        problems = fmt.verify(backup, password=password if want_config else None)
        if problems:
            raise BackupError("; ".join(problems))
        if want_config and "config" not in manifest.items:
            raise BackupError("이 백업에는 설정 항목이 없습니다")
        if want_config and manifest.config_encrypted and not password:
            raise BackupError("이 백업의 설정 항목은 암호로 보호돼 있습니다 — 암호가 필요합니다")
    except BackupError as e:
        raise fail("verify", e) from None
    stages.append("verify")

    # 2) 버전 판정
    try:
        found = discover(runner, env)
        cfg = found.config
        check_compat(manifest, schema_version=_schema_version(), pg_version=postgres_version(runner, cfg),
                     secret_key=env.get("SECRET_KEY", ""), items=chosen, with_config=want_config,
                     allow_key_mismatch=allow_key_mismatch)
        stops = pl.restore_stops(cfg, chosen)
        if found.self_container and found.self_container in stops:
            raise BackupError(
                f"실행 중인 {found.self_container} 안에서는 복원할 수 없습니다(복원하려면 자신을 세워야 합니다). "
                "서버에서 scripts/restore.sh 를 쓰거나 설치 관리자의 복원을 쓰세요"
            )
        files_by_item = {i: {f["role"]: f["name"] for f in manifest.items[i]["files"]} for i in chosen}
        item_steps = pl.plan_restore_items(cfg, files_by_item, chosen)
        config_steps = pl.plan_config_restore(cfg) if want_config else []
    except (BackupError, ValueError) as e:
        raise fail("compat", e) from None
    stages.append("compat")

    # 3) tar 면 작업 폴더에 푼다
    work = work_root / f"_restore-{stamp}"
    cleanup_work = False
    try:
        if backup.is_archive or want_config:
            check_destination(work_root, backup.total_bytes if backup.is_archive else 0)
        root = fmt.extract(backup, work) if backup.is_archive else backup.path
        cleanup_work = backup.is_archive
    except (BackupError, OSError) as e:
        shutil.rmtree(work, ignore_errors=True)
        raise fail("extract", e) from None
    stages.append("extract")

    def cleanup() -> None:
        if cleanup_work:
            shutil.rmtree(work, ignore_errors=True)

    def strict(steps: list[Step], base: Path) -> StepFailure | None:
        failures = run_steps(steps, base, runner, log, stop_on_failure=True)
        return failures[0] if failures else None

    result = RestoreResult(items=chosen + (["config"] if want_config else []), stages=stages, schema_from=0, schema_to=0)
    restore_db = "db" in chosen
    live_exists = _query(runner, cfg, f"SELECT 1 FROM pg_database WHERE datname = {pl._literal(cfg.db_name)}",
                         db="postgres") == "1"

    # 4) 안전 덤프 — 지금 DB 에 데이터가 있을 때만
    if restore_db and live_exists and _query(runner, cfg, "SELECT to_regclass('public.users') IS NOT NULL") == "t":
        safety_dir = work_root / SAFETY_DIR
        try:
            need = _int(_query(runner, cfg, f"SELECT pg_database_size({pl._literal(cfg.db_name)})")) or 0
            check_destination(safety_dir, need)
            fmt.restrict(safety_dir)
        except BackupError as e:
            cleanup()
            raise fail("safety-dump", e) from None
        name = f"{stamp}.dump"
        log("[restore] 지금 DB 를 떠 둡니다(되돌림용)")
        bad = strict(pl.plan_safety_dump(cfg, name), safety_dir)
        if bad:
            cleanup()
            raise fail("safety-dump", bad)
        fmt.restrict(safety_dir / name)
        result.safety_dump = str(safety_dir / name)
        for old in sorted(safety_dir.glob("*.dump"), reverse=True)[SAFETY_KEEP:]:
            old.unlink(missing_ok=True)
        stages.append("safety-dump")

    # 5) 서비스 정지 — 여기서부터는 무슨 일이 있어도 다시 띄운다
    log("[restore] 서비스를 세웁니다: " + (", ".join(stops) or "(없음)"))
    start_steps = pl.plan_start(list(reversed(stops)))

    def start_services() -> list[StepFailure]:
        return run_steps(start_steps, root, runner, log, stop_on_failure=False)

    def abort(stage: str, cause: object, state: str) -> RestoreError:
        start_services()
        cleanup()
        return fail(stage, cause, state)

    bad = strict(pl.plan_stop(stops), root)
    if bad:
        raise abort("stop", bad, STATE_UNTOUCHED)
    stages.append("stop")

    if restore_db:
        # 6) 옆 DB 에 올린다 — 실패해도 쓰던 DB 는 그대로다
        log("[restore] DB 를 올립니다")
        bad = strict(pl.plan_db_load(cfg, dump=files_by_item["db"]["dump"]), root)
        if bad:
            run_steps(pl.plan_db_rollback(cfg, swapped=False), root, runner, log, stop_on_failure=False)
            raise abort("db-load", bad, STATE_UNTOUCHED)
        stages.append("db-load")

        def roll_back() -> str:
            if not live_exists:
                return STATE_ROLLBACK_FAILED
            failed = run_steps(pl.plan_db_rollback(cfg, swapped=True), root, runner, log, stop_on_failure=False)
            return STATE_ROLLBACK_FAILED if failed else STATE_ROLLED_BACK

        # 7) 바꿔 끼운다
        bad = strict(pl.plan_db_swap(cfg, live_exists=live_exists), root)
        if bad:
            # 이름 바꾸기가 중간에 멈췄을 수 있다 — 원래 DB 가 옮겨졌으면 되돌린다
            moved = _query(runner, cfg, "SELECT 1 FROM pg_database WHERE datname = "
                           + pl._literal(pl.restore_db_name(cfg, "restore_old")), db="postgres") == "1"
            still = _query(runner, cfg, f"SELECT 1 FROM pg_database WHERE datname = {pl._literal(cfg.db_name)}",
                           db="postgres") == "1"
            state = roll_back() if moved and not still else STATE_UNTOUCHED
            run_steps(pl.plan_db_rollback(cfg, swapped=False), root, runner, log, stop_on_failure=False)
            raise abort("db-swap", bad, state)
        stages.append("db-swap")

        # 8) 스키마 변경 단계 — 백업이 더 낮은 버전이면 여기서 올라온다
        log("[restore] 스키마 변경 단계를 적용합니다")
        try:
            result.schema_from, result.schema_to = migrate()
        except Exception as e:  # noqa: BLE001 — 무엇이든 실패면 원래 DB 로
            raise abort("migrate", e, roll_back()) from None
        stages.append("migrate")

    # 9) 나머지 항목 — 되돌릴 수 없으므로 되돌릴 수 있는 것이 다 끝난 뒤에 한다
    kept = ("복원한 DB 는 그대로 두었습니다. 복원 전 DB 는 "
            f"{pl.restore_db_name(cfg, 'restore_old')} 와 {result.safety_dump or '(안전 덤프 없음)'} 에 있습니다"
            ) if restore_db else "DB 는 건드리지 않았습니다"
    if item_steps:
        log("[restore] 나머지 항목을 되돌립니다")
        bad = strict(item_steps, root)
        if bad:
            raise abort("items", bad, kept)
        stages.append("items")
    if config_steps:
        # 설정 묶음은 (암호를 풀어) 작업 폴더에 잠깐 꺼내 놓고 넘긴 뒤 바로 지운다
        plain = work / "config.tar"
        try:
            work.mkdir(parents=True, exist_ok=True)
            fmt.restrict(work)
            plain.write_bytes(fmt.read_config_tar(backup, password))
            fmt.restrict(plain)
            bad = strict(config_steps, work)
        except (BackupError, OSError) as e:
            raise abort("config", e, kept) from None
        finally:
            plain.unlink(missing_ok=True)
            if not cleanup_work:
                shutil.rmtree(work, ignore_errors=True)
        if bad:
            raise abort("config", bad, kept)
        stages.append("config")
        result.config_restored = True
        result.notes.append("설정(.env)을 되돌렸습니다 — 컨테이너에 반영하려면 스택을 다시 만드세요(docker compose up -d)")

    # 10) 서비스 시작
    log("[restore] 서비스를 다시 띄웁니다")
    failed = start_services()
    if failed:
        cleanup()
        raise fail("start", failed[0], kept)
    stages.append("start")

    # 11) 확인
    if found.backend in stops:
        problem = _wait_healthy(runner, found.backend, health_seconds, sleep)
        if problem:
            cleanup()
            raise fail("check", f"{found.backend}: {problem}", kept)
        stages.append("check")

    # 12) 정리 — 옮겨 둔 원래 DB 는 여기서 지운다(안전 덤프는 남긴다)
    if restore_db:
        if run_steps(pl.plan_db_cleanup(cfg), root, runner, log, stop_on_failure=False):
            result.notes.append(f"옮겨 둔 원래 DB({pl.restore_db_name(cfg, 'restore_old')})를 지우지 못했습니다 — 직접 지우세요")
    cleanup()
    result.notes.insert(0, "세션은 백업하지 않습니다 — 모든 사용자가 다시 로그인해야 합니다")
    if "files" in chosen and manifest.data.get("install_id"):
        result.notes.append("파일 저장소의 설치 표식은 백업을 만든 설치의 것입니다 — 설치 id(JW_INSTALL_ID)가 다르면 맞춰야 합니다")
    log("[restore] 끝났습니다")
    return result
