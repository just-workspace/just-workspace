"""적용 엔진 — 응답에 따라 서버를 구성한다.

- 단계 목록은 응답에서 생성한다(`plan_steps`). 각 단계는 상태·시각·실패 원인(키)·해결(키)을 기록한다.
- 상태는 단계 전환 시마다 디스크(`apply.json`)에 기록한다. 브라우저를 닫거나 설치 관리자가 재시작해도
  이어서 진행한다(`resume`).
- 단계는 **멱등**하다 — 완료된 항목은 확인만 하고 통과한다. 따라서 실패한 단계부터 재실행해도 안전하다.
- 로그는 단계별 파일(`logs/<단계>.log`)에 기록하며, 알려진 비밀값은 마스킹한다.

단계: config(설정 파일·비밀 키) → storage(저장소 연결 — NFS·지정 폴더인 경우만) → pull(이미지 pull) →
database(데이터베이스 준비) → cert(인증서 — 프런트 프록시가 담당하면 생략) → zones(구역 기동) →
admin(관리자 계정) → lock(설치 마법사 잠금)
"""

from __future__ import annotations

import json
import re
import secrets as pysecrets
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from app import answers as ans
from app import certs, dkim, preflight, render, zones
from app.bundle import Bundle
from app.catalog import Catalog
from app.docker_api import Docker
from app.paths import Paths
from app.state import Store, now_iso, write_private
from app.tokens import TokenStore

STEP_ORDER = ("config", "storage", "pull", "database", "cert", "zones", "admin", "lock")
BACKEND_UID_GID = "1000:1000"
CERT_VOLUME = "ws-certbot-data"
HEALTH_TIMEOUT = 300
POLL_SECONDS = 3
LOG_NAME = re.compile(r"[a-z][a-z0-9_-]{0,40}")      # 단계 로그의 이름(설치·복원의 단계, gate, zone-<id>)


class StepError(Exception):
    """단계 실패 — cause 와 fix 는 화면이 문구로 변환하는 키."""

    def __init__(self, cause: str, fix: str | None = None, **vars):
        super().__init__(cause)
        self.cause, self.fix, self.vars = cause, fix, vars

    def as_dict(self) -> dict:
        return {"cause": self.cause, "fix": self.fix, "vars": self.vars}


class Http:
    """내부망 서비스에 접속하는 소형 HTTP 클라이언트(테스트에서 교체)."""

    def get(self, url: str, headers: dict | None = None, timeout: float = 10.0) -> tuple[int, str]:
        import httpx

        try:
            with httpx.Client(timeout=timeout, verify=False, follow_redirects=False) as client:  # noqa: S501 — 내부망
                r = client.get(url, headers=headers or {})
            return r.status_code, r.text
        except Exception:  # noqa: BLE001
            return 0, ""


@dataclass
class Context:
    paths: Paths
    store: Store
    docker: Docker
    bundle: Bundle
    catalog: Catalog
    answers: ans.Answers
    facts: ans.Facts
    plan: render.Plan
    registry: str
    image_tag: str
    http: Http
    log: Callable[[str], None]
    sleep: Callable[[float], None] = time.sleep
    detail: dict = field(default_factory=dict)          # 현재 단계의 세부 진행(이미지별·구역별)
    save: Callable[[], None] = lambda: None             # detail 을 디스크에 반영
    env_dirty: bool = False                             # 구역 훅이 .env 값을 변경함 → backend 재기동
    warnings: list[dict] = field(default_factory=list)
    redact: Callable[..., None] = lambda *values: None  # 신규 생성된 비밀값을 로그 마스킹 목록에 추가
    _active: list[str] | None = None

    # ─── 구역 훅용 보조 함수 ───

    def secrets(self) -> dict:
        return self.store.env_secrets()

    def set_env(self, **changes: str) -> None:
        """구역 훅이 `.env` 에 기록할 값을 지정한다(다음 렌더링부터 적용)."""
        self.store.update_env_secrets(changes)
        self.env_dirty = True

    def warn(self, key: str, **vars) -> None:
        self.warnings.append({"key": key, "vars": vars})
        self.log(f"주의: {key} {vars or ''}")

    def active_services(self) -> list[str]:
        """현재 프로파일에서 활성화되는 compose 서비스 — compose 에 직접 조회한다."""
        if self._active is None:
            r = self.docker.compose("config", "--services", timeout=60)
            if not r.ok:
                raise StepError("compose_invalid", "see_log", detail=r.err[-300:])
            self._active = [line.strip() for line in r.out.splitlines() if line.strip()]
        return self._active

    def zone_services(self, zone_id: str) -> list[str]:
        active = set(self.active_services())
        return [s for s in self.catalog.services(zone_id) if s in active]

    def up(self, services: list[str], *, recreate: bool = False) -> None:
        if not services:
            return
        args = ["up", "-d", "--no-build"] + (["--force-recreate"] if recreate else []) + list(services)
        r = self.docker.compose(*args, timeout=900, on_line=self.log)
        if not r.ok:
            raise StepError("service_start_failed", "see_log", services=services, detail=r.err[-300:])

    def wait_ready(self, container: str, timeout: float = HEALTH_TIMEOUT) -> None:
        """컨테이너가 실행 중이고, healthcheck 가 있으면 healthy 가 될 때까지 대기한다."""
        waited = 0.0
        while True:
            st = self.docker.container_status(container)
            if st["running"] and st["health"] in ("", "healthy"):
                return
            if waited >= timeout:
                raise StepError("service_not_ready", "see_container_log", container=container,
                                health=st["health"] or ("stopped" if not st["running"] else ""))
            self.sleep(POLL_SECONDS)
            waited += POLL_SECONDS

    def stop(self, services: list[str]) -> None:
        if not services:
            return
        self.docker.compose("stop", *services, timeout=300, on_line=self.log)
        self.docker.compose("rm", "-f", *services, timeout=120, on_line=self.log)

    def detect_host_addresses(self) -> None:
        """격리 브라우저를 사용하나 이 서버의 주소가 미확인이면 이 시점에 감지한다(`RBI_PROTECTED` 에 포함된다).

        신규 설치는 사전 점검이 이미 감지한다. 본 함수는 사전 점검을 거치지 않는 경로(백업에서 복원, 설치 후 구역 활성화)용이다.
        감지 실패 시 그대로 둔다 — 값이 비어 있어도 출구 규칙을 적용하는 측이 자체 주소를 별도로 차단한다.
        """
        if self.facts.host_address or "rbi" not in ans.selected_zones(self.answers, self.catalog):
            return
        try:
            probe = helper_json(self.docker.helper(["host-probe", "--ports", ""], network="host", timeout=60))
        except Exception:  # noqa: BLE001
            return
        found = {k: val for k, val in (("host_address", probe.get("outbound_address")), ("gateway", probe.get("gateway"))) if val}
        if found:
            self.facts = self.store.update_facts(**found)

    def write_stack(self) -> render.Plan:
        """응답과 현재의 비밀값으로 스택 파일을 재작성한다."""
        env_secrets = dict(self.store.env_secrets())
        self.detect_host_addresses()
        render.settle_source_url(self.store, self.facts, self.paths.stack)
        self.plan = render.derive(self.answers, self.facts, self.catalog)
        if self.plan.mail_builtin:
            env_secrets["DKIM_PRIVATE_KEY"] = dkim.ensure(self.store, self.plan.mail_domain)["private_key"]
        files = render.render(self.answers, env_secrets, self.facts, self.bundle,
                              registry=self.registry, image_tag=self.image_tag)
        for rel, content in files.items():
            target = self.paths.stack / rel
            if rel in render.MERGE_FILES and target.exists():
                content = render.merge_lines(target.read_text(encoding="utf-8"), content)
            write_private(target, content, render.file_mode(rel))
        self._active = None
        self.env_dirty = False
        return self.plan


def helper_json(result) -> dict:
    if not result.ok:
        return {}
    try:
        return json.loads(result.out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {}


# ─── 단계 ───


def generate_secrets(ctx: Context, names: list[str]) -> dict:
    """비밀값 — backend 이미지의 생성기를 1회 실행하여 수신한다. 사용 불가 시 번들의 동일 표로 생성한다."""
    sd = ctx.bundle.security_defaults
    image = f"{ctx.registry}/just-workspace-backend:{ctx.image_tag}"
    values: dict = {}
    if not ctx.docker.image_exists(image):
        ctx.log(f"backend 이미지를 받습니다: {image}")
        ctx.docker.pull(image, on_line=ctx.log)
    if ctx.docker.image_exists(image):
        r = ctx.docker.run(["run", "--rm", "--network", "none", "--entrypoint", "python", image,
                            "-m", "app.cli", "gen-secrets", "--format", "json", "--only", *names], timeout=120)
        if r.ok:
            try:
                values = json.loads(r.out)
            except ValueError:
                values = {}
    good = {n: values[n] for n in names
            if isinstance(values.get(n), str) and sd.weakness(sd.spec(n), values[n]) is None}
    if len(good) == len(names):
        ctx.log(f"비밀값 {len(names)}개를 backend 이미지의 생성기로 만들었습니다")
        return good
    ctx.log("backend 이미지의 생성기를 쓸 수 없어 번들의 같은 표로 비밀값을 만듭니다")
    return {**sd.generate(names), **good}


def prepare_storage(ctx: Context) -> None:
    """저장소 볼륨을 생성하고(없는 경우만) 루트에 저장소 마커 파일을 기록한다."""
    spec = render.storage_volume(ctx.answers)
    install_id = ctx.store.install()["install_id"]
    existing = ctx.docker.volume_inspect(spec["name"])
    if existing is None:
        r = ctx.docker.volume_create(spec["name"], spec["opts"], labels={"jw.install": install_id})
        if not r.ok:
            raise StepError("storage_volume_create_failed", "see_log", detail=r.err[-300:])
        ctx.log(f"저장소 볼륨을 만들었습니다({spec['kind']})")
    else:
        have = {k: v for k, v in (existing.get("Options") or {}).items()}
        if have != spec["opts"]:
            raise StepError("storage_volume_mismatch", "storage_volume_remove_or_keep", volume=spec["name"])
        ctx.log("저장소 볼륨이 이미 있습니다")
    # 도커 볼륨(신규 생성한 빈 볼륨)은 이미지의 /storage 소유권(1000:1000)을 상속하도록 옵션 없이 마운트한다.
    # NFS·지정 폴더는 `nocopy` — 도커가 외부 저장소 루트의 소유자·권한을 변경하려 시도하지 않도록 한다
    # (root 권한을 강등하는 NFS 내보내기에서는 해당 시도가 거부되어 마운트부터 실패한다).
    mount = f"{spec['name']}:/storage" + ("" if spec["kind"] == "volume" else ":nocopy")
    r = ctx.docker.helper(["write-marker", "/storage", "--install-id", install_id],
                          volumes=[mount], user=BACKEND_UID_GID, timeout=120)
    if not r.ok:
        from app.probes import classify_mount_error

        cause = classify_mount_error(r.text) if spec["kind"] == "nfs" else "storage_mount_failed"
        raise StepError(cause, "storage_check_connection", detail=r.text[-300:])
    data = helper_json(r)
    status = data.get("status")
    if status == "other_install":
        raise StepError("storage_other_install", "storage_use_empty_or_adopt")
    if status not in ("written", "exists"):
        cause = "read_only" if data.get("error") == "EROFS" else "permission_denied"
        raise StepError(cause, "storage_grant_write", uid_gid=BACKEND_UID_GID, error=data.get("error"))
    ctx.log("저장소 표식을 확인했습니다")


def step_config(ctx: Context) -> None:
    sd = ctx.bundle.security_defaults
    install = ctx.store.install()
    have = ctx.store.env_secrets()
    wanted = [*sd.names(default_only=True), "SMTP_PASSWORD"]
    missing = [n for n in wanted if not have.get(n)]
    changes: dict = {}
    if missing:
        changes.update(generate_secrets(ctx, missing))
    if not have.get("JW_INSTALLER_KEY"):
        changes["JW_INSTALLER_KEY"] = pysecrets.token_hex(24)
    if have.get("JW_INSTALL_ID") != install["install_id"]:
        changes["JW_INSTALL_ID"] = install["install_id"]
    if changes:
        ctx.store.update_env_secrets(changes)
    plan = ctx.write_stack()
    ctx.log(f"설정 파일을 썼습니다 — 구역: {', '.join(plan.zones) or '(기본만)'}")
    r = ctx.docker.compose("config", "-q", timeout=120)
    if not r.ok:
        raise StepError("compose_invalid", "see_log", detail=r.err[-500:])
    if render.storage_volume(ctx.answers)["kind"] == "volume":
        prepare_storage(ctx)


def step_storage(ctx: Context) -> None:
    prepare_storage(ctx)


def step_pull(ctx: Context) -> None:
    r = ctx.docker.compose("config", "--images", timeout=120)
    if not r.ok:
        raise StepError("compose_invalid", "see_log", detail=r.err[-300:])
    images = sorted({line.strip() for line in r.out.splitlines() if line.strip()})
    ctx.detail["images"] = [{"image": i, "status": "pending", "progress": ""} for i in images]
    ctx.save()
    for row in ctx.detail["images"]:
        image = row["image"]
        if image.startswith("localhost/") and ctx.docker.image_exists(image):
            row["status"] = "present"
            ctx.save()
            continue
        row["status"] = "pulling"
        ctx.save()
        last = [0.0]

        def on_line(line: str, row=row) -> None:
            row["progress"] = line[-120:]
            if time.monotonic() - last[0] > 1.0:
                last[0] = time.monotonic()
                ctx.save()

        result = ctx.docker.pull(image, on_line=on_line)
        if result.ok:
            row["status"], row["progress"] = "done", ""
        elif ctx.docker.image_exists(image):
            row["status"], row["progress"] = "present", ""       # pull 은 실패했으나 서버에 이미 존재(오프라인 설치)
            ctx.warn("image_not_refreshed", image=image)
        else:
            row["status"] = "failed"
            ctx.save()
            ctx.log(result.err[-500:])
            raise StepError("image_pull_failed", "check_network_or_registry", image=image)
        ctx.save()
    ctx.log(f"이미지 {len(images)}개 준비 완료")


def step_database(ctx: Context) -> None:
    ctx.up(["postgres", "redis"])
    try:
        ctx.wait_ready("ws-postgres", 180)
        ctx.wait_ready("ws-redis", 120)
    except StepError as e:
        raise StepError("database_not_ready", "see_container_log", **e.vars) from None
    migrate_database(ctx)


def migrate_database(ctx: Context) -> None:
    """DB 스키마를 이 버전의 코드에 맞춘다 — backend 이미지의 일회용 컨테이너로 `python -m app.cli migrate` 실행.

    backend 기동 전에 여기서 명시적으로 실행하고 종료 코드를 확인한다(backend 는 기동 시 "같음"만 확인하고 통과한다).
    실패 시 backend 를 기동하지 않고 이 단계에서 중단한다 — 원인은 단계 로그에 기록된다.
    """
    r = ctx.docker.compose("run", "--rm", "--no-deps", "-T", "--entrypoint", "python", "backend",
                           "-m", "app.cli", "migrate", timeout=1800, on_line=ctx.log)
    if not r.ok:
        ctx.log(r.text[-800:])
        raise StepError("database_migrate_failed", "see_log", exit_code=r.rc)
    ctx.log("데이터베이스 스키마를 맞췄습니다")


def _place(ctx: Context, name: str, aliases: list[str], cert: str | None = None, key: str | None = None) -> None:
    args = ["place-cert", "--name", name, "--aliases", ",".join(aliases)]
    payload = None
    if cert is None:
        args.append("--link-only")
    else:
        payload = json.dumps({"cert": cert, "key": key})
    image = ctx.docker.self_image()
    if not image:
        raise StepError("installer_image_unknown", "see_log")
    argv = ["run", "--rm", "--network", "none", "--entrypoint", "python"]
    if payload is not None:
        argv.append("-i")
    argv += ["-v", f"{CERT_VOLUME}:/etc/letsencrypt", image, "-m", "app.helper", *args]
    r = ctx.docker.run(argv, input=payload, timeout=120)
    status = helper_json(r).get("status")
    if status == "managed_by_certbot":
        raise StepError("cert_dir_managed", "cert_remove_existing", name=name)
    if status != "placed":
        raise StepError("cert_place_failed", "see_log", detail=r.text[-300:])


def uploaded_ca(ctx: Context) -> str:
    """별도 업로드한 CA 인증서(없으면 빈 문자열) — 응답 파일의 `access.ca_path`, 없으면 화면·내부 API 가 수신해 둔 파일."""
    path = ctx.answers.access.ca_path or str(ctx.paths.state / "upload" / "ca.pem")
    try:
        return open(path, encoding="utf-8").read()
    except OSError:
        return ""


def set_site_ca(ctx: Context, chain: str) -> None:
    """업로드한 인증서의 발급 CA 를 이 서버의 컨테이너(코드 저장소·backend)가 신뢰하도록 설정한다 — 없으면 제거한다.

    사설 CA 발급 인증서를 업로드하면 코드 저장소(Gitea)는 접속 주소의 인증서를 신뢰하지 못하여 로그인 연동이 보류된다.
    발급 CA 가 확인되면(인증서 파일에 체인이 동반되었거나 CA 인증서를 별도 업로드 — certs.trust_pem) 이를 스택 폴더에 저장하고
    사이트 조각이 컨테이너의 신뢰 저장소에 마운트한다(app/render.py 의 site_compose).
    서버 인증서 1건만 업로드한 경우 신뢰 대상 CA 를 확인할 수 없으므로 아무 작업도 수행하지 않는다.
    """
    target = ctx.paths.stack / render.SITE_CA_FILE
    have = bool(chain)
    if have:
        write_private(target, chain, 0o644)             # 컨테이너의 비루트 프로세스가 읽음(공개 정보)
    else:
        target.unlink(missing_ok=True)
    if ctx.facts.site_ca != have:
        ctx.facts.site_ca = have
        ctx.store.update_facts(site_ca=have)
        ctx.write_stack()                               # 사이트 조각의 마운트 줄이 추가 또는 제거됨
        ctx.log("올린 인증서의 발급 CA 를 코드 저장소와 backend 가 믿게 합니다" if have else "따로 믿게 한 CA 를 걷어 냅니다")


def read_cert(ctx: Context, name: str) -> str | None:
    r = ctx.docker.helper(["read-cert", "--name", name], volumes=[f"{CERT_VOLUME}:/etc/letsencrypt"], timeout=60)
    return helper_json(r).get("cert")


def step_cert(ctx: Context) -> None:
    plan = ctx.plan
    name, names, aliases = plan.cert_dir, plan.cert_names, plan.cert_aliases
    mode = plan.cert_mode
    existing = read_cert(ctx, name)
    if mode != "upload":
        set_site_ca(ctx, "")                 # 업로드한 인증서 사용 중 다른 방식으로 전환

    def remember(cert_pem: str, kind: str) -> None:
        ctx.store.write("cert.json", {"name": name, "kind": kind, "fingerprint": certs.fingerprint_sha256(cert_pem),
                                      "checked_at": now_iso()})

    if mode == "proxy":
        # 웹은 프런트 프록시가 담당한다. 메일·회의 서버가 조회하는 위치에는 자체 서명 인증서를 배치한다.
        side = names[1:]
        if existing and certs.covers(existing, side):
            _place(ctx, name, aliases)
        else:
            cert, key = certs.self_signed(side or names)
            _place(ctx, name, aliases, cert, key)
            existing = cert
        remember(existing, "self_signed")
        ctx.warn("side_certs_self_signed", names=side)
        return

    if mode == "temporary":
        if existing and certs.is_self_signed(existing) and certs.covers(existing, names):
            _place(ctx, name, aliases)
        else:
            cert, key = certs.self_signed(names)
            _place(ctx, name, aliases, cert, key)
            existing = cert
        remember(existing, "self_signed")
        ctx.log("임시(자체 서명) 인증서를 놓았습니다")
        return

    if mode == "upload":
        a = ctx.answers.access
        cert_path = a.cert_path or str(ctx.paths.state / "upload" / "cert.pem")
        key_path = a.key_path or str(ctx.paths.state / "upload" / "key.pem")
        try:
            cert = open(cert_path, encoding="utf-8").read()
            key = open(key_path, encoding="utf-8").read()
        except OSError:
            raise StepError("cert_upload_missing", "cert_upload_again") from None
        ca = uploaded_ca(ctx)
        report = certs.inspect(cert, key, plan.domain, ca_pem=ca)
        if not report["ok"]:
            failed = [c["fix"]["key"] for c in report["checks"] if c["status"] == "fail" and c["fix"]]
            raise StepError("cert_invalid", "cert_upload_again", problems=failed)
        _place(ctx, name, aliases, cert, key)
        remember(cert, "upload")
        ctx.log("올린 인증서를 놓았습니다")
        set_site_ca(ctx, certs.trust_pem(cert, ca))
        return

    # auto — Let's Encrypt
    if existing and not certs.is_self_signed(existing) and certs.covers(existing, names):
        _place(ctx, name, aliases)
        remember(existing, "auto")
        ctx.log("쓸 수 있는 인증서가 이미 있습니다")
        return
    if existing and certs.is_self_signed(existing):
        ctx.docker.helper(["unlink-cert", "--name", name], volumes=[f"{CERT_VOLUME}:/etc/letsencrypt"], timeout=60)
    email = ctx.answers.access.acme_email or f"admin@{plan.env_domain}"
    certbot = ["certonly", "--non-interactive", "--agree-tos", "--no-eff-email", "--email", email,
               "--cert-name", name, "--keep-until-expiring", "--expand"]
    for n in names:
        certbot += ["-d", n]
    if ctx.docker.container_status("ws-nginx")["running"]:
        run = ["run", "--rm", "--no-deps", "--entrypoint", "certbot", "certbot", *certbot,
               "--webroot", "-w", "/var/www/certbot"]
    else:
        # nginx 미기동 상태 — certbot 이 80 을 직접 수신
        run = ["run", "--rm", "--no-deps", "--publish", "80:80", "--entrypoint", "certbot", "certbot", *certbot,
               "--standalone"]
    ctx.log("인증서를 요청합니다: " + ", ".join(names))
    r = ctx.docker.compose(*run, timeout=600, on_line=ctx.log)
    issued = read_cert(ctx, name) if r.ok else None
    if not r.ok or not issued:
        ctx.store.update_facts(cert_issue_failed=True)
        raise StepError("cert_issue_failed", "cert_retry_or_temporary", names=names, alternative="use_temporary_cert")
    _place(ctx, name, aliases)
    remember(issued, "auto")
    ctx.log("인증서를 받았습니다")


def configure_backend(ctx: Context) -> None:
    """DB 에 저장되는 설정(외부 SMTP 의 보안 방식, AI 제공자) — backend 의 CLI 에 표준 입력으로 전달한다."""
    payload: dict = {}
    zones_on = set(ctx.plan.zones)
    if "mail" in zones_on and ctx.answers.mail.kind == "external":
        payload["settings"] = {"smtp.security": ctx.answers.mail.security}
    ai = ctx.answers.ai
    if "ai" in zones_on and ai.mode == "provider" and ai.provider:
        payload["ai"] = {"kind": ai.provider, "model": ai.model or "", "base_url": ai.base_url or "",
                         "api_key": ai.api_key or ""}
    if not payload:
        return
    r = ctx.docker.exec("ws-backend", ["python", "-m", "app.cli", "configure"], user="appuser",
                        input=json.dumps(payload), timeout=120)
    if not r.ok:
        ctx.warn("backend_settings_not_applied", parts=sorted(payload))
        ctx.log(r.err[-300:])
        return
    ctx.log("backend 설정을 넣었습니다: " + ", ".join(sorted(payload)))
    if "ai" in payload:
        ctx.store.forget_answer_secret("ai.api_key")


def step_zones(ctx: Context, *, configure: bool = True) -> None:
    ctx.up(["backend", "frontend-react", "nginx"])
    ctx.wait_ready("ws-backend")
    ctx.wait_ready("ws-nginx", 120)
    r = ctx.docker.connect_self(render.INSTALLER_ALIAS)
    if not r.ok:
        ctx.warn("installer_not_on_network", detail=r.err[-200:])

    rows = [{"id": z, "status": "pending"} for z in ctx.plan.zones]
    ctx.detail["zones"] = rows
    ctx.save()
    for row in rows:
        row["status"] = "installing"
        ctx.save()
        try:
            zones.get(row["id"]).install(ctx, row["id"])
        except StepError as e:
            row["status"] = "failed"
            ctx.save()
            raise StepError(e.cause, e.fix, zone=row["id"], **e.vars) from None
        row["status"] = "installed"
        ctx.save()
    for row in rows:
        row["status"] = "connecting"
        ctx.save()
        try:
            zones.get(row["id"]).connect(ctx, row["id"])
        except StepError as e:
            row["status"] = "failed"
            ctx.save()
            raise StepError(e.cause, e.fix, zone=row["id"], **e.vars) from None
        row["status"] = "done"
        ctx.save()

    if ctx.env_dirty:
        ctx.write_stack()
        ctx.log("연동 값이 바뀌어 backend 를 다시 띄웁니다")
        ctx.up(["backend"])
        ctx.wait_ready("ws-backend")
    if configure:
        configure_backend(ctx)


def step_admin(ctx: Context) -> None:
    admin = ctx.answers.admin
    password = admin.password
    if not password:
        # 계정 생성 및 비밀번호 삭제 후 재실행한 경우 — 계정 존재 여부만 확인
        ctx.log("관리자 비밀번호가 남아 있지 않습니다 — 이미 만든 계정으로 봅니다")
        return
    tmp = ctx.paths.state / "tmp" / f"admin-{pysecrets.token_hex(4)}.env"
    write_private(tmp, f"ADMIN_PASSWORD={password}\n")
    try:
        r = ctx.docker.exec("ws-backend", ["python", "-m", "app.cli", "seed-admin", "--username", admin.username,
                                           "--display-name", admin.name or admin.username],
                            user="appuser", env_file=str(tmp), timeout=180)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    if not r.ok:
        ctx.log(r.text[-300:])
        if "관리자가 아닙니다" in r.text:
            raise StepError("admin_username_taken", "admin_choose_other_name", username=admin.username)
        raise StepError("admin_create_failed", "see_log")
    ctx.store.forget_answer_secret("admin.password")
    ctx.log(f"관리자 계정 준비 완료: {admin.username}")


def step_lock(ctx: Context) -> None:
    ctx.docker.connect_self(render.INSTALLER_ALIAS)
    ctx.store.set_phase("installed")
    TokenStore(ctx.store).revoke_all()
    ctx.log("설치가 끝났습니다 — 마법사를 잠갔습니다")


STEPS: dict[str, Callable[[Context], None]] = {
    "config": step_config, "storage": step_storage, "pull": step_pull, "database": step_database,
    "cert": step_cert, "zones": step_zones, "admin": step_admin, "lock": step_lock,
}


def plan_steps(answers: ans.Answers, plan: render.Plan) -> list[str]:
    steps = ["config"]
    if render.storage_volume(answers)["kind"] != "volume":
        steps.append("storage")
    steps += ["pull", "database"]
    if plan.tls or plan.cert_aliases:
        steps.append("cert")
    steps += ["zones", "admin", "lock"]
    return steps


# ─── 엔진 ───


class Redactor:
    def __init__(self):
        self.values: set[str] = set()

    def add(self, *values) -> None:
        for value in values:
            if isinstance(value, str) and len(value) >= 6:
                self.values.add(value)

    def __call__(self, text: str) -> str:
        for value in sorted(self.values, key=len, reverse=True):
            if value in text:
                text = text.replace(value, "***")
        return text


class Engine:
    def __init__(self, paths: Paths, docker: Docker, bundle: Bundle, *, registry: str = "localhost",
                 image_tag: str | None = None, http: Http | None = None,
                 sleep: Callable[[float], None] = time.sleep, preflight_kwargs: dict | None = None):
        self.paths = paths
        self.docker = docker
        self.bundle = bundle
        self.catalog = Catalog(bundle.zones)
        self.store = Store(paths)
        self.registry = registry
        self.image_tag = image_tag or bundle.version
        self.http = http or Http()
        self.sleep = sleep
        self.preflight_kwargs = preflight_kwargs or {}
        self.redact = Redactor()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    # ─── 상태 ───

    def status(self) -> dict:
        return self.store.read("apply.json") or {"status": "idle", "steps": [], "current": None, "error": None,
                                                 "notes": [], "warnings": [], "alternatives": []}

    def _save(self, state: dict) -> None:
        state["updated_at"] = now_iso()
        self.store.write("apply.json", state)

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # ─── 로그 ───

    def log_path(self, step: str):
        return self.paths.logs / f"{step}.log"

    def _logger(self, step: str) -> Callable[[str], None]:
        path = self.log_path(step)
        path.parent.mkdir(parents=True, exist_ok=True)

        def log(text: str) -> None:
            line = self.redact(str(text)).rstrip()
            if not line:
                return
            with open(path, "a", encoding="utf-8", newline="") as f:
                f.write(f"{now_iso()} {line}\n")
        return log

    def read_log(self, step: str, tail: int = 500) -> list[str]:
        if not LOG_NAME.fullmatch(step or ""):
            return []
        try:
            lines = self.log_path(step).read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        return lines[-tail:]

    # ─── 준비 ───

    def _context(self, step: str, answers: ans.Answers, facts: ans.Facts) -> Context:
        self.redact.add(*self.store.env_secrets().values(), *self.store.answer_secrets().values())
        return Context(
            paths=self.paths, store=self.store, docker=self.docker, bundle=self.bundle, catalog=self.catalog,
            answers=answers, facts=facts, plan=render.derive(answers, facts, self.catalog),
            registry=self.registry, image_tag=self.image_tag, http=self.http, log=self._logger(step), sleep=self.sleep,
            redact=self.redact.add,
        )

    def prepare(self) -> tuple[ans.Answers, ans.Facts, list[dict]]:
        """응답을 읽고(빠른 설치이면 프리셋을 결정하고) 검증한다. 문제가 있으면 `StepError` 발생."""
        try:
            answers = self.store.load_answers()
        except ans.StructureError as e:
            raise StepError("answers_invalid", "fix_answers", errors=[x.as_dict() for x in e.errors]) from None
        facts = self.store.facts()
        answers, notes = ans.resolve_quick(answers, self.catalog, facts)
        if notes:
            self.store.save_answers(answers)
        installed = self.status().get("admin_done", False)
        errors = ans.validate(answers, self.catalog, facts)
        if installed:
            errors = [e for e in errors if e.field != "admin.password"]
        if errors:
            raise StepError("answers_invalid", "fix_answers", errors=[e.as_dict() for e in errors])
        return answers, facts, notes

    def gate(self, answers: ans.Answers) -> None:
        """사전 점검 — fail 이 하나라도 있으면 시작하지 않는다. 메모리·CPU 감지값도 여기서 갱신한다."""
        report = preflight.run(self.docker, answers, self.catalog, registry=self.registry, **self.preflight_kwargs)
        self.store.write("preflight.json", {**report, "checked_at": now_iso()})
        facts = preflight.preflight_facts(report)
        if facts:
            self.store.update_facts(**facts)
        failed = [i["id"] for i in report["items"] if i["status"] == "fail"]
        if failed:
            raise StepError("preflight_failed", "fix_preflight", items=failed)

    def steps_for(self, answers: ans.Answers, plan: render.Plan) -> tuple[dict, list[str]]:
        """(단계 함수 표, 실행할 단계 id) — 복원은 자체 단계 표를 사용한다(app/restore.py). 엔진의 나머지는 동일하다."""
        if answers.mode == "restore":
            from app import restore

            return restore.STEPS, restore.plan_steps(answers, plan, self.store)
        return STEPS, plan_steps(answers, plan)

    # ─── 실행 ───

    def start(self, from_step: str | None = None, *, rerun: tuple[str, ...] = ()) -> bool:
        """백그라운드로 실행한다. 이미 실행 중이면 False.

        반환 전에 상태를 `running` 으로 기록한다 — 시작(또는 재시도) 요청에 202 를 수신한 화면이 즉시
        상태를 조회했을 때 이전의 `failed`·`idle` 이 노출되어서는 안 된다(화면은 이를 "끝났다"로 해석한다).
        """
        with self._lock:
            if self.running:
                return False
            state = self.status()
            if state.get("status") != "running":
                for step in state.get("steps", []):
                    if step["status"] == "failed":
                        step.update(status="pending", error=None)
                state.update(status="running", error=None, alternatives=[], finished_at=None)
                self._save(state)
            self._thread = threading.Thread(target=self.run, kwargs={"from_step": from_step, "rerun": rerun},
                                            name="jw-apply", daemon=True)
            self._thread.start()
            return True

    def resume(self) -> bool:
        """설치 관리자 재시작 시 — 진행 중이던 적용이 있으면 중단된 단계부터 재개한다."""
        state = self.status()
        if state.get("status") != "running":
            return False
        # 단계가 아직 없으면(시작 직후 중단) 처음부터 실행 — 단계는 멱등하다
        step = next((s["id"] for s in state["steps"] if s["status"] in ("running", "pending")), None)
        if step is None and state["steps"]:
            return False
        for s in state["steps"]:
            if s["status"] == "running":
                s["status"] = "pending"
                s["interrupted"] = True
        self._save(state)
        return self.start(step)

    def retry(self, *, use_temporary_cert: bool = False) -> bool:
        """실패한 단계부터 재실행. `use_temporary_cert` 이면 임시 인증서로 전환하여 계속한다."""
        state = self.status()
        failed = next((s["id"] for s in state.get("steps", []) if s["status"] == "failed"), None)
        if state.get("status") != "failed":
            return False
        rerun: tuple[str, ...] = ()
        if use_temporary_cert:
            answers = self.store.load_answers()
            if answers.access.network == "proxy":
                return False
            answers.access.cert = "temporary"
            self.store.save_answers(answers)
            self.store.update_facts(cert_issue_failed=True)
            rerun = ("config", "unpack")       # nginx 설정·프로파일이 변경됨(복원에서는 unpack 이 설정을 기록)
        return self.start(failed, rerun=rerun)

    def run(self, from_step: str | None = None, rerun: tuple[str, ...] = ()) -> dict:
        """적용을 완료(또는 실패) 시점까지 실행한다. 최종 상태를 반환한다."""
        previous = self.status()
        state = {"status": "running", "started_at": previous.get("started_at") or now_iso(), "finished_at": None,
                 "current": None, "error": None, "notes": previous.get("notes", []), "warnings": [],
                 "alternatives": [], "steps": previous.get("steps", []),
                 "admin_done": previous.get("admin_done", False)}
        gate_log = self._logger("gate")
        try:
            answers, facts, notes = self.prepare()
            if notes:
                state["notes"] = notes
            self.gate(answers)
            facts = self.store.facts()
            errors = [e for e in ans.validate(answers, self.catalog, facts)
                      if not (state["admin_done"] and e.field == "admin.password")]
            if errors:
                raise StepError("answers_invalid", "fix_answers", errors=[e.as_dict() for e in errors])
        except StepError as e:
            gate_log(f"시작하지 못했습니다: {e.cause}")
            state.update(status="failed", error=e.as_dict(), finished_at=now_iso())
            self._save(state)
            return state

        plan = render.derive(answers, facts, self.catalog)
        table, wanted = self.steps_for(answers, plan)
        state["mode"] = answers.mode
        if answers.mode == "restore":
            from app import restore

            state["restore"] = restore.outcome(answers, self.store)
        old = {s["id"]: s for s in state["steps"]}
        start_index = wanted.index(from_step) if from_step in wanted else 0
        steps = []
        for i, step_id in enumerate(wanted):
            prev = old.get(step_id)
            keep = prev is not None and prev["status"] == "done" and i < start_index and step_id not in rerun
            fresh = {"id": step_id, "status": "pending", "started_at": None, "finished_at": None, "error": None, "detail": {}}
            if prev is not None and prev.get("interrupted"):
                fresh["interrupted"] = True         # 설치 관리자 재시작으로 중단되었던 단계 — 화면이 "이어서 진행"을 표시
            steps.append(prev if keep else fresh)
        state["steps"] = steps
        self._save(state)
        if self.store.install()["phase"] == "wizard":
            self.store.set_phase("applying")

        for step in steps:
            if step["status"] == "done":
                continue
            ctx = self._context(step["id"], self.store.load_answers(), self.store.facts())
            ctx.detail = step["detail"]
            ctx.save = lambda: self._save(state)
            step.update(status="running", started_at=now_iso(), finished_at=None, error=None)
            state["current"] = step["id"]
            self._save(state)
            ctx.log(f"── {step['id']} 시작 ──")
            try:
                table[step["id"]](ctx)
            except StepError as e:
                ctx.log(f"실패: {e.cause}")
                step.update(status="failed", finished_at=now_iso(), error=e.as_dict())
                state.update(status="failed", error={"step": step["id"], **e.as_dict()}, finished_at=now_iso())
                state["warnings"] += ctx.warnings
                if e.vars.get("alternative"):
                    state["alternatives"] = [{"key": e.vars["alternative"]}]
                self._save(state)
                return state
            except Exception as e:  # noqa: BLE001 — 예상하지 못한 오류도 단계 실패로 기록
                ctx.log(f"실패(예상하지 못한 오류): {type(e).__name__}: {self.redact(str(e))[:300]}")
                err = {"cause": "unexpected_error", "fix": "see_log", "vars": {"type": type(e).__name__}}
                step.update(status="failed", finished_at=now_iso(), error=err)
                state.update(status="failed", error={"step": step["id"], **err}, finished_at=now_iso())
                self._save(state)
                return state
            step.update(status="done", finished_at=now_iso())
            state["warnings"] += ctx.warnings
            if step["id"] == "admin":
                state["admin_done"] = True
            ctx.log(f"── {step['id']} 완료 ──")
            self._save(state)

        state.update(status="done", current=None, finished_at=now_iso())
        self._save(state)
        return state


# ─── 인증서 갱신 후 재적재 ───


def reload_after_renewal(engine: Engine) -> str:
    """인증서가 변경되었으면 서비스들이 새 파일을 다시 읽도록 한다. `unchanged` | `reloaded` | `skipped`.

    갱신 자체는 certbot 컨테이너가 수행한다(12시간 주기). 설치 관리자는 주기적으로 지문을 확인하고, 변경된 경우
    개인 키 권한을 재설정한 뒤 nginx 를 reload, 회의 서버를 재시작한다(메일 서버와 음성 릴레이는 자체적으로 다시 읽는다).
    """
    known = engine.store.read("cert.json")
    if not known or not engine.store.locked:
        return "skipped"
    answers, facts = engine.store.load_answers(), engine.store.facts()
    ctx = engine._context("certwatch", answers, facts)
    current = read_cert(ctx, known["name"])
    if not current:
        return "skipped"
    fingerprint = certs.fingerprint_sha256(current)
    if fingerprint == known.get("fingerprint"):
        return "unchanged"
    if known.get("kind") == "auto":
        _place(ctx, known["name"], ctx.plan.cert_aliases)
    if ctx.plan.tls:
        engine.docker.exec("ws-nginx", ["nginx", "-s", "reload"], timeout=60)
    if ctx.plan.turn:
        engine.docker.run(["restart", "ws-livekit"], timeout=120)
    engine.store.write("cert.json", {**known, "fingerprint": fingerprint, "checked_at": now_iso()})
    ctx.log("인증서가 바뀌어 서비스에 다시 읽혔습니다")
    return "reloaded"
