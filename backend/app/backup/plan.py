"""백업·복원 계획 — "무엇을 어떤 명령으로 백업하고 복원하는가".

순수 함수이다: 입력은 구성(`StackConfig`), 출력은 실행할 단계 목록(`Step`). 어떤 것도 실행하지 않으며, 파일과
DB 를 변경하지 않는다. 실행기는 별도로 주입한다(app/backup/runner.py — 현재는 backend 가 docker CLI 로 실행한다).
단계는 `to_dict()` 로 JSON 으로 직렬화되므로, 설치 관리자가 동일한 목록을 받아 자체 실행기로 실행할 수 있다
(`python -m app.cli backup plan --json`).

모든 단계는 `docker …` 명령 하나이다. 데이터는 표준 출력(백업) 또는 표준 입력(복원)으로 전달되며, 단계의
`stdout`/`stdin` 은 백업 디렉터리 내의 파일 이름이다.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from app.backup.format import ITEMS, KIND_FULL, KIND_PRE_UPDATE

# tar 는 읽는 도중 파일이 변경되면 종료 코드 1 을 반환한다("file changed as we read it"). 서비스를 중지하지 않고
# 백업하는 항목(메일함·파일)에서는 이를 실패로 처리하지 않는다 — 2 이상(읽기 실패)만 실패이다.
_LIVE_TAR_OK = (0, 1)


@dataclass(frozen=True)
class Step:
    id: str                               # 실패 보고에 사용하는 이름(예: "db.dump")
    item: str                             # 항목 id
    title: str                            # 사용자용 설명
    argv: tuple[str, ...]
    stdout: str | None = None             # 표준 출력을 저장할 파일(백업 디렉터리 기준)
    stdin: str | None = None              # 표준 입력으로 전달할 파일(백업 디렉터리 기준)
    role: str = ""                        # stdout 파일의 역할(manifest 의 files[].role)
    ok_codes: tuple[int, ...] = (0,)
    always: bool = False                  # 선행 단계가 실패해도 실행한다(중지한 서비스 재기동)
    timeout: int = 6 * 3600

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class StackConfig:
    """백업 대상의 위치 — app/backup/runner.py 의 `discover()` 가 설정한다(또는 설치 관리자가 직접 설정)."""

    helper_image: str                     # tar 를 실행할 이미지(backend 이미지 — 이미 pull 된 상태)
    postgres: str = "ws-postgres"         # DB 컨테이너
    db_user: str = "workspace"
    db_name: str = "workspace"
    # 설정: compose 프로젝트 폴더(호스트 경로)와 그 안에 실제로 존재하는 경로 목록
    project_dir: str = ""
    config_paths: tuple[str, ...] = ()
    # 메일 구역(없으면 전부 빈 값)
    mail_container: str = ""
    mail_running: bool = False
    mail_config_path: str = ""            # project_dir 기준(계정·DKIM 키)
    mail_data: str = ""                   # 볼륨 이름 또는 호스트 경로
    mail_state: str = ""
    # 코드 저장소 구역
    gitea_container: str = ""
    gitea_running: bool = False
    gitea_data: str = ""
    gitea_database: str = ""              # 동일 PostgreSQL 내의 DB 이름(없으면 빈 값 — 볼륨 내의 SQLite)
    # 기타 볼륨(없으면 빈 값)
    plugins_data: str = ""
    certs: str = ""
    app_signing: str = ""
    # 파일 저장소
    storage: str = ""
    storage_kind: str = "local"           # local | nfs
    # 복원 시 중지해야 하는, DB 를 사용하는 컨테이너(실행 중인 것만)
    db_consumers: tuple[str, ...] = ()


@dataclass
class BackupPlan:
    kind: str
    steps: list[Step] = field(default_factory=list)
    items: list[str] = field(default_factory=list)           # 백업 대상 항목
    skipped: dict[str, str] = field(default_factory=dict)    # 백업 제외 항목 → 사유

    def to_dict(self) -> dict:
        return {"kind": self.kind, "items": self.items, "skipped": self.skipped,
                "steps": [s.to_dict() for s in self.steps]}


# ─── 명령 구성 요소 ───


def _helper(cfg: StackConfig, mounts: list[str], command: list[str], *, stdin: bool = False) -> tuple[str, ...]:
    """헬퍼 컨테이너 1회 실행 — 네트워크 없이 볼륨만 마운트."""
    argv = ["docker", "run", "--rm", "--network", "none", "--user", "0"]
    if stdin:
        argv.append("-i")
    for m in mounts:
        argv += ["-v", m]
    return tuple(argv + ["--entrypoint", command[0], cfg.helper_image, *command[1:]])


def _tar_out(cfg: StackConfig, source: str, paths: tuple[str, ...] = (".",), *, gzip: bool = True) -> tuple[str, ...]:
    return _helper(cfg, [f"{source}:/v:ro"], ["tar", "-czf" if gzip else "-cf", "-", "-C", "/v", *paths])


def _tar_in(cfg: StackConfig, source: str, *, gzip: bool = True, wipe: str | None = "/v") -> tuple[str, ...]:
    """표준 입력의 tar 를 source 에 추출한다. wipe 지정 시 해당 폴더의 내용을 먼저 삭제한다(백업 시점 상태로 복원)."""
    untar = f"tar -x{'z' if gzip else ''}f - -C /v"
    script = f"mkdir -p {wipe} && find {wipe} -mindepth 1 -delete && {untar}" if wipe else untar
    return _helper(cfg, [f"{source}:/v"], ["sh", "-c", script], stdin=True)


def _psql(cfg: StackConfig, *sql: str, db: str = "postgres") -> tuple[str, ...]:
    argv = ["docker", "exec", cfg.postgres, "psql", "-U", cfg.db_user, "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-At"]
    for s in sql:
        argv += ["-c", s]
    return tuple(argv)


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _pg_dump(cfg: StackConfig, db: str) -> tuple[str, ...]:
    return ("docker", "exec", cfg.postgres, "pg_dump", "-U", cfg.db_user, "-d", db, "-Fc")


# ─── 백업 ───


def default_items(kind: str, *, include_files: bool = False) -> list[str]:
    if kind == KIND_PRE_UPDATE:
        return ["db", "config"]
    return [i for i in ITEMS if i != "files" or include_files]


def plan_backup(cfg: StackConfig, kind: str = KIND_FULL, *, include_files: bool = False,
                items: list[str] | None = None) -> BackupPlan:
    """백업 단계 목록. 구성에 없는 항목은 `skipped` 에 사유와 함께 기록된다."""
    wanted = items if items is not None else default_items(kind, include_files=include_files)
    plan = BackupPlan(kind=kind)

    def skip(item: str, reason: str) -> None:
        plan.skipped[item] = reason

    for item in ITEMS:
        if item not in wanted:
            if item == "files" and kind == KIND_FULL:
                skip("files", "nfs" if cfg.storage_kind == "nfs" else "not-requested")
            continue
        steps: list[Step] = []
        if item == "db":
            steps.append(Step("db.dump", "db", "DB 덤프(pg_dump -Fc)", _pg_dump(cfg, cfg.db_name),
                              stdout="db.dump", role="dump"))
        elif item == "config":
            if not cfg.project_dir or not cfg.config_paths:
                skip(item, "설정 폴더를 찾지 못했습니다(.env 를 따로 보관하십시오)")
                continue
            steps.append(Step("config.tar", "config", "설정 모음(.env 포함)",
                              _tar_out(cfg, cfg.project_dir, cfg.config_paths, gzip=False),
                              stdout="config.tar", role="config", timeout=600))
        elif item == "mail":
            if not cfg.mail_container:
                skip(item, "메일 구역이 없습니다")
                continue
            if cfg.project_dir and cfg.mail_config_path:
                steps.append(Step("mail.config", "mail", "메일 계정·DKIM 키",
                                  _tar_out(cfg, cfg.project_dir, (cfg.mail_config_path,)),
                                  stdout="mail-config.tar.gz", role="config", timeout=600))
            if cfg.mail_data:
                steps.append(Step("mail.data", "mail", "메일함", _tar_out(cfg, cfg.mail_data),
                                  stdout="mail-data.tar.gz", role="data", ok_codes=_LIVE_TAR_OK))
            if cfg.mail_state:
                steps.append(Step("mail.state", "mail", "메일 상태(필터 학습·큐)", _tar_out(cfg, cfg.mail_state),
                                  stdout="mail-state.tar.gz", role="state", ok_codes=_LIVE_TAR_OK))
        elif item == "gitea":
            if not cfg.gitea_container or not cfg.gitea_data:
                skip(item, "코드 저장소 구역이 없습니다")
                continue
            # 실행 중에 백업하면 저장소와 DB 가 불일치할 수 있다 — 일시 중지 후 백업하고 재기동한다
            if cfg.gitea_running:
                steps.append(Step("gitea.stop", "gitea", "코드 저장소 정지",
                                  ("docker", "stop", cfg.gitea_container), timeout=300))
            if cfg.gitea_database:
                steps.append(Step("gitea.db", "gitea", "코드 저장소 DB 덤프", _pg_dump(cfg, cfg.gitea_database),
                                  stdout="gitea-db.dump", role="dump"))
            steps.append(Step("gitea.data", "gitea", "코드 저장소 데이터", _tar_out(cfg, cfg.gitea_data),
                              stdout="gitea-data.tar.gz", role="data"))
            if cfg.gitea_running:
                steps.append(Step("gitea.start", "gitea", "코드 저장소 다시 시작",
                                  ("docker", "start", cfg.gitea_container), always=True, timeout=300))
        elif item in ("plugins-data", "certs", "app-signing"):
            source = {"plugins-data": cfg.plugins_data, "certs": cfg.certs, "app-signing": cfg.app_signing}[item]
            if not source:
                skip(item, "해당 볼륨이 없습니다")
                continue
            steps.append(Step(f"{item}.data", item, {"plugins-data": "플러그인 데이터", "certs": "인증서",
                                                      "app-signing": "앱 서명 키"}[item],
                              _tar_out(cfg, source), stdout=f"{item}.tar.gz", role="data",
                              ok_codes=_LIVE_TAR_OK if item == "plugins-data" else (0,)))
        elif item == "files":
            if cfg.storage_kind == "nfs":
                skip(item, "nfs")
                continue
            if not cfg.storage:
                skip(item, "파일 저장소 볼륨을 찾지 못했습니다")
                continue
            # 파일은 대부분 이미 압축된 형식이므로 재압축하지 않는다
            steps.append(Step("files.data", "files", "파일 저장소", _tar_out(cfg, cfg.storage, gzip=False),
                              stdout="files.tar", role="data", ok_codes=_LIVE_TAR_OK))
        plan.items.append(item)
        plan.steps += steps
    return plan


# ─── 복원 ───


def restore_db_name(cfg: StackConfig, suffix: str) -> str:
    return f"{cfg.db_name}_{suffix}"


def plan_db_load(cfg: StackConfig, *, dump: str = "db.dump") -> list[Step]:
    """덤프를 **별도 DB**(`<이름>_restore_new`)에 적재한다. 사용 중인 DB 는 변경하지 않는다."""
    new = restore_db_name(cfg, "restore_new")
    return [
        Step("db.prepare", "db", "복원용 DB 준비", _psql(
            cfg, f"DROP DATABASE IF EXISTS {_ident(new)} WITH (FORCE)", f"CREATE DATABASE {_ident(new)}"), timeout=600),
        Step("db.load", "db", "DB 덤프 올리기(pg_restore)",
             ("docker", "exec", "-i", cfg.postgres, "pg_restore", "-U", cfg.db_user, "-d", new,
              "--no-owner", "--no-acl", "--exit-on-error"), stdin=dump),
    ]


def plan_db_swap(cfg: StackConfig, *, live_exists: bool = True) -> list[Step]:
    """사용 중인 DB 를 `<이름>_restore_old` 로 이동하고 새로 적재한 DB 를 원래 이름으로 교체한다(이름 변경이므로 즉시 완료된다)."""
    new, old, live = restore_db_name(cfg, "restore_new"), restore_db_name(cfg, "restore_old"), cfg.db_name
    kick = ("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN "
            f"({_literal(live)}, {_literal(new)}) AND pid <> pg_backend_pid()")
    sql = [kick, f"DROP DATABASE IF EXISTS {_ident(old)} WITH (FORCE)"]
    if live_exists:
        sql.append(f"ALTER DATABASE {_ident(live)} RENAME TO {_ident(old)}")
    sql.append(f"ALTER DATABASE {_ident(new)} RENAME TO {_ident(live)}")
    return [Step("db.swap", "db", "DB 교체", _psql(cfg, *sql), timeout=600)]


def plan_db_rollback(cfg: StackConfig, *, swapped: bool) -> list[Step]:
    """복원을 롤백한다. swapped=True 이면 이동해 둔 원래 DB 를 원래 이름으로 복원하고, 아니면 적재 중이던 별도 DB 만 삭제한다."""
    new, old, live = restore_db_name(cfg, "restore_new"), restore_db_name(cfg, "restore_old"), cfg.db_name
    if not swapped:
        return [Step("db.discard", "db", "올리다 만 DB 삭제",
                     _psql(cfg, f"DROP DATABASE IF EXISTS {_ident(new)} WITH (FORCE)"), always=True, timeout=600)]
    kick = (f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = {_literal(live)} "
            "AND pid <> pg_backend_pid()")
    return [Step("db.rollback", "db", "원래 DB 로 롤백", _psql(
        cfg, kick, f"DROP DATABASE IF EXISTS {_ident(live)} WITH (FORCE)",
        f"ALTER DATABASE {_ident(old)} RENAME TO {_ident(live)}"), always=True, timeout=600)]


def plan_db_cleanup(cfg: StackConfig) -> list[Step]:
    return [Step("db.cleanup", "db", "옮겨 둔 원래 DB 삭제", _psql(
        cfg, f"DROP DATABASE IF EXISTS {_ident(restore_db_name(cfg, 'restore_old'))} WITH (FORCE)"), timeout=600)]


def plan_safety_dump(cfg: StackConfig, stdout: str) -> list[Step]:
    """복원 전에 현재 DB 를 덤프한다(복원 완료 후에도 보존한다 — 잘못된 백업을 복원한 경우의 롤백 수단)."""
    return [Step("safety.dump", "db", "복원 전 현재 DB 덤프", _pg_dump(cfg, cfg.db_name), stdout=stdout)]


def plan_stop(containers: tuple[str, ...] | list[str]) -> list[Step]:
    return [Step(f"stop.{c}", "services", f"{c} 정지", ("docker", "stop", c), timeout=300) for c in containers]


def plan_start(containers: tuple[str, ...] | list[str]) -> list[Step]:
    return [Step(f"start.{c}", "services", f"{c} 시작", ("docker", "start", c), always=True, timeout=300)
            for c in containers]


def restore_stops(cfg: StackConfig, items: list[str]) -> list[str]:
    """복원 중 중지해야 하는 컨테이너(실행 중인 것만, 중지 순서의 역순으로 재기동한다)."""
    stops = list(cfg.db_consumers) if "db" in items else []
    if "mail" in items and cfg.mail_running and cfg.mail_container:
        stops.append(cfg.mail_container)
    if "gitea" in items and cfg.gitea_running and cfg.gitea_container:
        stops.append(cfg.gitea_container)
    return stops


def plan_restore_items(cfg: StackConfig, files_by_item: dict[str, dict[str, str]], items: list[str]) -> list[Step]:
    """DB 외 항목을 복원하는 단계. files_by_item = {항목: {역할: 파일 이름}}(manifest 에서).

    볼륨 항목은 내용을 삭제한 후 백업 시점 상태로 추출한다. 이 단계들은 롤백이 불가하므로 실행기는
    DB 복원·스키마 변경이 모두 완료된 후에 실행한다. 설정(config)은 복호화가 필요할 수 있어 실행기가 직접 처리한다.
    """
    steps: list[Step] = []

    def need(value: str, what: str) -> str:
        if not value:
            raise ValueError(f"{what} 위치를 찾지 못해 복원할 수 없습니다")
        return value

    for item in ITEMS:
        if item not in items or item in ("db", "config"):
            continue
        roles = files_by_item.get(item, {})
        if item == "mail":
            if "config" in roles:
                steps.append(Step("mail.config", "mail", "메일 계정·DKIM 키 복원",
                                  _tar_in(cfg, need(cfg.project_dir, "설정 폴더"),
                                          wipe=f"/v/{cfg.mail_config_path}" if cfg.mail_config_path else None),
                                  stdin=roles["config"], timeout=600))
            if "data" in roles:
                steps.append(Step("mail.data", "mail", "메일함 복원",
                                  _tar_in(cfg, need(cfg.mail_data, "메일함 볼륨")), stdin=roles["data"]))
            if "state" in roles:
                steps.append(Step("mail.state", "mail", "메일 상태 복원",
                                  _tar_in(cfg, need(cfg.mail_state, "메일 상태 볼륨")), stdin=roles["state"]))
        elif item == "gitea":
            if "dump" in roles:
                db = need(cfg.gitea_database, "코드 저장소 DB")
                steps.append(Step("gitea.db.prepare", "gitea", "코드 저장소 DB 비우기", _psql(
                    cfg, f"DROP DATABASE IF EXISTS {_ident(db)} WITH (FORCE)", f"CREATE DATABASE {_ident(db)}"),
                    timeout=600))
                steps.append(Step("gitea.db", "gitea", "코드 저장소 DB 올리기",
                                  ("docker", "exec", "-i", cfg.postgres, "pg_restore", "-U", cfg.db_user, "-d", db,
                                   "--no-owner", "--no-acl", "--exit-on-error"), stdin=roles["dump"]))
            if "data" in roles:
                steps.append(Step("gitea.data", "gitea", "코드 저장소 데이터 복원",
                                  _tar_in(cfg, need(cfg.gitea_data, "코드 저장소 볼륨")), stdin=roles["data"]))
        elif item in ("plugins-data", "certs", "app-signing"):
            source = {"plugins-data": cfg.plugins_data, "certs": cfg.certs, "app-signing": cfg.app_signing}[item]
            if "data" in roles:
                steps.append(Step(f"{item}.data", item, f"{item} 복원",
                                  _tar_in(cfg, need(source, item + " 볼륨")), stdin=roles["data"]))
        elif item == "files":
            if "data" in roles:
                steps.append(Step("files.data", "files", "파일 저장소 복원",
                                  _tar_in(cfg, need(cfg.storage, "파일 저장소 볼륨"), gzip=False), stdin=roles["data"]))
    return steps


def plan_config_restore(cfg: StackConfig) -> list[Step]:
    """설정 묶음(tar, 표준 입력)을 프로젝트 폴더에 추출한다 — 동일한 이름의 파일만 덮어쓴다."""
    if not cfg.project_dir:
        raise ValueError("설정 폴더 위치를 찾지 못해 복원할 수 없습니다")
    return [Step("config.restore", "config", "설정 복원(.env 포함)",
                 _tar_in(cfg, cfg.project_dir, gzip=False, wipe=None), stdin="config.tar", timeout=600)]
