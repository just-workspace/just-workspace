"""HTTP API — 마법사용(8443, HTTPS, 세션 필요)과 내부용(8444, 워크스페이스 내부망, 공유 키).

두 앱은 **서로 다른 포트**에서 뜬다. 8443 은 호스트에 게시하고, 8444 는 게시하지 않는다 — 브라우저는
내부 API 에 닿지 못한다. 설치가 끝나면 마법사 API 는 잠긴다(상태 조회만 남는다).

오류 응답은 모두 `{"code": "...", "vars": {...}}` 꼴이다. 문구는 화면이 가진다.
"""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from fastapi import Body, Depends, FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, StreamingResponse

from app import answers as ans
from app import api_cert, api_restore, api_update, certs, dkim, preflight, probes, render, update_release
from app import validators as v
from app.bundle import Bundle
from app.catalog import Catalog
from app.docker_api import Docker, Runner, SubprocessRunner
from app.engine import Engine, plan_steps
from app.paths import Paths
from app.state import Store, now_iso, write_private
from app.tokens import COOKIE_NAME, SESSION_TTL, TokenStore
from app.zonectl import ZoneManager, ZoneRequestError

# 받을 이미지 저장소의 기본값 — 이미지(Dockerfile 의 ARG JW_REGISTRY)와 같은 값. 실행할 때 JW_REGISTRY 로 바꾼다.
DEFAULT_REGISTRY = "ghcr.io/just-workspace"

KEY_HEADER = "x-jw-installer-key"
LOCAL_KEY_HEADER = "x-jw-local-key"


class ApiError(Exception):
    def __init__(self, status: int, code: str, **vars):
        super().__init__(code)
        self.status, self.code, self.vars = status, code, vars


@dataclass
class Services:
    paths: Paths
    store: Store
    docker: Docker
    bundle: Bundle
    catalog: Catalog
    engine: Engine
    tokens: TokenStore
    zones: ZoneManager
    registry: str
    resolver: probes.Resolver = field(default_factory=probes.DnsResolver)
    ip_fetchers: list[Callable[[], str | None]] | None = None
    smtp_factory: Callable | None = None
    ai_get: Callable | None = None
    preflight_kwargs: dict = field(default_factory=dict)
    ui_dir: Path | None = None                      # 마법사 화면 번들(installer.html · assets/ · icon.svg)
    cache: dict = field(default_factory=dict)       # 바뀌지 않는 조회값(자기 컨테이너 이름, 도커 데이터 폴더)

    def local_key(self) -> str:
        """같은 컨테이너의 `jw` 명령이 서버에 일을 시킬 때 쓰는 키(상태 폴더의 파일)."""
        path = self.store.dir / "local.key"
        try:
            return path.read_text(encoding="utf-8").strip()
        except OSError:
            import secrets

            key = secrets.token_hex(24)
            write_private(path, key + "\n")
            return key


def build_services(paths: Paths, *, runner: Runner | None = None, registry: str | None = None,
                   image_tag: str | None = None, **overrides) -> Services:
    paths.ensure_dirs()
    bundle = Bundle(paths.bundle)
    docker = Docker(runner or SubprocessRunner(), paths)
    registry = registry or os.environ.get("JW_REGISTRY") or DEFAULT_REGISTRY
    image_tag = image_tag or os.environ.get("JW_IMAGE_TAG") or None
    overrides.setdefault("ui_dir", Path(os.environ.get("JW_UI_DIR") or "/app/ui"))
    engine_kwargs = {k: overrides.pop(k) for k in ("http", "sleep") if k in overrides}
    preflight_kwargs = overrides.pop("preflight_kwargs", {})
    engine = Engine(paths, docker, bundle, registry=registry, image_tag=image_tag,
                    preflight_kwargs=preflight_kwargs, **engine_kwargs)
    return Services(paths=paths, store=engine.store, docker=docker, bundle=bundle, catalog=engine.catalog,
                    engine=engine, tokens=TokenStore(engine.store), zones=ZoneManager(engine), registry=registry,
                    preflight_kwargs=preflight_kwargs, **overrides)


def _error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError):
        return JSONResponse({"code": exc.code, "vars": exc.vars}, status_code=exc.status)

    @app.exception_handler(v.Invalid)
    async def _invalid(request: Request, exc: v.Invalid):
        return JSONResponse({"code": exc.code, "vars": exc.vars}, status_code=422)

    @app.exception_handler(ZoneRequestError)
    async def _zone_error(request: Request, exc: ZoneRequestError):
        return JSONResponse({"code": exc.code, "vars": exc.vars}, status_code=exc.status)

    @app.exception_handler(ans.StructureError)
    async def _structure(request: Request, exc: ans.StructureError):
        return JSONResponse({"code": "answers_invalid", "vars": {"errors": [e.as_dict() for e in exc.errors]}},
                            status_code=422)


# ─── 감지값 ───


def public_ip(svc: Services, *, refresh: bool = False) -> dict:
    facts = svc.store.facts()
    if facts.public_ip and not refresh:
        return {"status": "detected", "ip": facts.public_ip, "source": "cached"}
    local = (svc.store.read("preflight.json") or {}).get("facts", {}).get("outbound_address")
    got = probes.detect_public_ip(svc.ip_fetchers, local_address=local)
    if got["ip"]:
        svc.store.update_facts(public_ip=got["ip"])
    return got


def run_preflight(svc: Services) -> dict:
    answers = svc.store.load_answers()
    report = preflight.run(svc.docker, answers, svc.catalog, registry=svc.registry, **svc.preflight_kwargs)
    svc.store.write("preflight.json", {**report, "checked_at": now_iso()})
    known = {k: val for k, val in report["facts"].items() if val and k in ("memory_mb", "cpus")}
    if known:
        svc.store.update_facts(**known)
    return report


def summary(svc: Services) -> dict:
    answers = svc.store.load_answers()
    facts = svc.store.facts()
    answers, notes = ans.resolve_quick(answers, svc.catalog, facts)
    errors = ans.validate(answers, svc.catalog, facts)
    plan = render.derive(answers, facts, svc.catalog)
    pre = svc.store.read("preflight.json")
    zones = [{"id": z, "name": svc.catalog.get(z)["name"]} for z in plan.zones]
    return {
        "ready": not errors and bool(pre and pre.get("ok")),
        "errors": [e.as_dict() for e in errors],
        "preflight": {"checked": bool(pre), "ok": bool(pre and pre.get("ok")), "checked_at": (pre or {}).get("checked_at")},
        "mode": answers.mode,
        "access": {"domain": plan.domain, "url": plan.app_url, "network": answers.access.network, "cert": plan.cert_mode,
                   "cert_names": plan.cert_names},
        "storage": render.storage_volume(answers) if not any(e.field.startswith("storage") for e in errors) else None,
        "zones": zones,
        "mail": {"kind": answers.mail.kind, "mail_domain": plan.mail_domain} if "mail" in plan.zones else None,
        "admin": {"name": answers.admin.name, "username": answers.admin.username},
        "memory": svc.catalog.judge(plan.zones, facts.memory_mb).as_dict() if facts.memory_mb else None,
        "ports": plan.ports,
        "cautions": plan.cautions,
        "notes": notes,
        "steps": plan_steps(answers, plan) if not errors else [],
        "version": svc.bundle.version,
    }


STEP_ID = re.compile(r"[a-z][a-z0-9_-]{0,31}")


def self_name(svc: Services) -> str:
    """설치 관리자 컨테이너의 이름 — 화면에 보여 줄 명령에 쓴다(못 알아내면 문서의 기본 이름)."""
    if "self_name" not in svc.cache:
        data = svc.docker.inspect("container", svc.docker.self_ref) or {}
        name = str(data.get("Name") or "").lstrip("/")
        svc.cache["self_name"] = name if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name) else "jw-installer"
    return svc.cache["self_name"]


def commands(svc: Services) -> dict:
    """서버 터미널에서 치는 명령 — 화면은 이 글자를 그대로 보여 준다."""
    name = self_name(svc)
    return {
        "reissue_token": f"docker exec {name} jw token",
        "reset_admin": f"docker exec {name} jw reset-admin",
        # 비밀번호는 명령에 적지 않는다 — 셸 변수 JW_ADMIN_PASSWORD 를 그대로 넘긴다(답변 파일은 설치 폴더에 둔다)
        "install_from_answers": f"docker exec -e JW_ADMIN_PASSWORD {name} jw apply --answers /data/answers.json",
        "reinstall": f"docker exec {name} jw reinstall --yes",
    }


def detected_facts(svc: Services, pre: dict | None) -> dict:
    """감지값 — 모르는 것은 null. 연결 형태: 나가는 주소가 공인이면 direct, 사설이면 router(프록시 뒤인지는 알 수 없다)."""
    facts = svc.store.facts()
    lan = ((pre or {}).get("facts") or {}).get("outbound_address") or None
    detected = None
    if lan:
        try:
            detected = "direct" if ipaddress.ip_address(lan).is_global else "router"
        except ValueError:
            detected = None
    disk = next((i.get("value") for i in (pre or {}).get("items", []) if i.get("id") == "disk"), None)
    free = None
    if isinstance(disk, dict):
        free = disk.get("free_gb") if isinstance(disk.get("free_gb"), (int, float)) else None
    return {"memory_mb": facts.memory_mb, "public_ip": facts.public_ip, "lan_ip": lan,
            "detected_network": detected, "disk_free_gb": free}


def mail_records(svc: Services, body: dict) -> dict:
    """메일 도메인에 등록할 레코드의 기대값과 현재값. DKIM 값은 설치 때 만든(또는 지금 만드는) 키에서 나온다."""
    answers = svc.store.load_answers()
    mail_domain = body.get("mail_domain") or answers.mail.mail_domain or answers.access.domain
    key = dkim.ensure(svc.store, mail_domain)
    ip = public_ip(svc).get("ip")
    return probes.probe_mail_records(key["domain"], ip, key["record_value"], svc.resolver, key["selector"])


def storage_info(svc: Services) -> dict:
    """파일 저장소가 무엇인가 — {kind: local|nfs, location, install_id}. 위치는 NFS 면 `서버:/경로`, 아니면 호스트 폴더."""
    s = svc.store.load_answers().storage
    if s.kind == "nfs":
        kind, location = "nfs", f"{s.server}:{s.export}"
    elif s.path:
        kind, location = "local", s.path
    else:
        kind, location = "local", default_storage_path(svc)
    return {"kind": kind, "location": location, "volume": render.STORAGE_VOLUME,
            "install_id": svc.store.install()["install_id"]}


def default_storage_path(svc: Services) -> str | None:
    """기본 저장소(도커 볼륨)가 호스트의 어디에 놓이는지 — 도커 데이터 폴더 아래."""
    if "docker_root" not in svc.cache:
        svc.cache["docker_root"] = str(svc.docker.info().get("DockerRootDir") or "")
    root = svc.cache["docker_root"]
    return f"{root.rstrip('/')}/volumes/{render.STORAGE_VOLUME}/_data" if root else None


def state(svc: Services) -> dict:
    install = svc.store.install()
    apply = svc.engine.status()
    pre = svc.store.read("preflight.json")
    public = svc.store.answers_public()
    return {
        "version": svc.bundle.version,
        "phase": install["phase"],
        "locked": install["phase"] == "installed",
        "install_id": install["install_id"],
        "has_answers": bool(public),
        "mode": public.get("mode"),
        "step": (svc.store.read("wizard.json") or {}).get("step"),
        "preflight": {"checked": bool(pre), "ok": bool(pre and pre.get("ok"))},
        "apply": {"status": apply.get("status"), "current": apply.get("current"),
                  "error": apply.get("error"), "alternatives": apply.get("alternatives", [])},
        "token_expires_at": svc.tokens.expires_at(),
        "facts": detected_facts(svc, pre),
        "info": {
            "git_verified_version": svc.bundle.gitea_verified_version,
            "default_storage_path": default_storage_path(svc),
            "commands": commands(svc),
            "backup_file_format": ".jwbak",
            "source_url": update_release.source_url(),
        },
    }


# ─── 화면 번들(정적 파일) ───

# 화면은 인라인 스크립트 없이 돈다. 스타일은 속성(style="…")만 인라인을 허용한다(React 가 쓴다).
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; "
       "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; "
       "base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",            # 주소에 설치 토큰이 실려 올 수 있다
    "Cross-Origin-Opener-Policy": "same-origin",
}
NO_UI = "설치 화면 번들이 이 이미지에 없습니다(개발 실행). API 는 그대로 동작합니다.\n"


def ui_file(svc: Services, relative: str) -> Path | None:
    """화면 번들 안의 파일(폴더 밖을 가리키면 None)."""
    if svc.ui_dir is None:
        return None
    root = svc.ui_dir.resolve()
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        return None
    return target if target.is_file() else None


# ─── 마법사 앱 ───


def create_wizard_app(svc: Services) -> FastAPI:
    app = FastAPI(title="Just Workspace installer", version=svc.bundle.version, docs_url=None, redoc_url=None,
                  openapi_url=None)
    _error_handlers(app)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for key, value in SECURITY_HEADERS.items():
            response.headers.setdefault(key, value)
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    def set_cookie(response, sid: str) -> None:
        response.set_cookie(COOKIE_NAME, sid, max_age=SESSION_TTL, httponly=True, secure=True, samesite="strict", path="/")

    def check_token(token: str) -> str:
        if svc.store.locked:
            raise ApiError(423, "locked")
        result, retry = svc.tokens.check(token)
        if result == "ok":
            return svc.tokens.new_session()
        if result == "locked":
            raise ApiError(429, "token_locked", retry_after=retry)
        if result == "expired":
            raise ApiError(401, "token_expired")
        raise ApiError(401, "token_wrong", retry_after=retry)

    def session(request: Request) -> None:
        if not svc.tokens.session_valid(request.cookies.get(COOKIE_NAME)):
            raise ApiError(401, "auth_required")

    def unlocked(request: Request) -> None:
        if svc.store.locked:
            raise ApiError(423, "locked")
        session(request)

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    def page():
        """화면(SPA) — 세션이 없어도 내준다. 토큰 입력·잠김 안내도 이 화면이 그린다."""
        path = ui_file(svc, "installer.html")
        if path is None:
            return PlainTextResponse(NO_UI, status_code=503)
        return FileResponse(path, media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-cache"})

    @app.get("/")
    def landing(token: str | None = Query(default=None)):
        if token is None:
            return page()
        # 토큰이 실린 주소 — 확인하고 토큰 없는 주소로 넘긴다(주소창·방문 기록에 남지 않게).
        # 맞으면 세션 쿠키를 준다. 틀리면 화면이 사유를 알리도록 상태만 실어 넘긴다(화면이 같은 토큰으로 또 묻지 않게).
        if svc.store.locked:
            return RedirectResponse("/", status_code=302)
        try:
            sid = check_token(token)
        except ApiError as e:
            status = {"token_expired": "expired", "token_locked": "locked"}.get(e.code, "wrong")
            retry = e.vars.get("retry_after")
            return RedirectResponse(f"/?token_status={status}" + (f"&retry_after={int(retry)}" if retry else ""),
                                    status_code=302)
        response = RedirectResponse("/", status_code=302)
        set_cookie(response, sid)
        return response

    @app.get("/installer.html")
    def page_alias():
        return page()

    @app.get("/icon.svg")
    def icon():
        path = ui_file(svc, "icon.svg")
        if path is None:
            raise ApiError(404, "not_found")
        return FileResponse(path, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})

    @app.get("/assets/{name:path}")
    def asset(name: str):
        path = ui_file(svc, f"assets/{name}")
        if path is None:
            raise ApiError(404, "not_found")
        # 자산 파일 이름에는 내용 해시가 들어 있다 — 바뀌면 이름이 바뀐다
        return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})

    @app.post("/api/session")
    def create_session(body: dict = Body(...)):
        sid = check_token(str(body.get("token", "")))
        response = JSONResponse({"ok": True})
        set_cookie(response, sid)
        return response

    @app.get("/api/state")
    def get_state(request: Request):
        if svc.store.locked:
            answers = svc.store.answers_public()
            domain = (answers.get("access") or {}).get("domain")
            cmds = commands(svc)
            return {"phase": "installed", "locked": True, "version": svc.bundle.version,
                    "url": f"https://{domain}" if domain else None,
                    "info": {"commands": {"reinstall": cmds["reinstall"], "reset_admin": cmds["reset_admin"]},
                             "source_url": update_release.source_url()}}
        session(request)
        return state(svc)

    # ── 답변 ──

    def answers_view() -> dict:
        answers = svc.store.load_answers()
        public, _ = ans.split(answers)
        errors = ans.validate(answers, svc.catalog, svc.store.facts(), final=False)
        return {"answers": public, "secrets_set": ans.secrets_present(svc.store.answer_secrets()),
                "errors": [e.as_dict() for e in errors]}

    @app.get("/api/answers", dependencies=[Depends(unlocked)])
    def get_answers():
        return answers_view()

    @app.put("/api/answers", dependencies=[Depends(unlocked)])
    def put_answers(patch: dict = Body(...), step: str | None = Query(default=None)):
        if svc.engine.running:
            raise ApiError(409, "apply_running")
        if step is not None and not STEP_ID.fullmatch(step):
            raise ApiError(422, "step_invalid")
        current, _ = ans.split(svc.store.load_answers())
        merged = ans.load(ans.merge_patch(current, patch))        # 비밀은 patch 에 든 것만 새로 저장된다
        svc.store.save_answers(merged)
        if step is not None:
            svc.store.write("wizard.json", {"step": step})        # 이어 할 화면 — GET /api/state 의 step
        return answers_view()

    @app.get("/api/answers/export", dependencies=[Depends(unlocked)])
    def export_answers():
        public, _ = ans.split(svc.store.load_answers())
        body = json.dumps(public, ensure_ascii=False, indent=2) + "\n"
        return StreamingResponse(iter([body.encode("utf-8")]), media_type="application/json", headers={
            "Content-Disposition": 'attachment; filename="just-workspace-answers.json"', "Cache-Control": "no-store"})

    # ── 점검 · 구역 · 요약 ──

    @app.post("/api/preflight", dependencies=[Depends(unlocked)])
    def post_preflight():
        return run_preflight(svc)

    @app.get("/api/zones", dependencies=[Depends(unlocked)])
    def get_zones():
        answers = svc.store.load_answers()
        return svc.catalog.listing(ans.selected_zones(answers, svc.catalog), svc.store.facts().memory_mb)

    @app.get("/api/summary", dependencies=[Depends(unlocked)])
    def get_summary():
        return summary(svc)

    # ── 확인 ──

    @app.get("/api/probe/public-ip", dependencies=[Depends(unlocked)])
    def probe_public_ip(refresh: bool = False):
        return public_ip(svc, refresh=refresh)

    @app.post("/api/probe/dns", dependencies=[Depends(unlocked)])
    def probe_dns(body: dict = Body(default={})):
        domain = body.get("domain") or svc.store.load_answers().access.domain
        ip = public_ip(svc, refresh=bool(body.get("refresh"))).get("ip")
        result = probes.probe_dns(domain, ip, svc.resolver)
        if domain == svc.store.load_answers().access.domain:
            svc.store.update_facts(dns_status=result["status"])
        return result

    @app.post("/api/probe/mail-records", dependencies=[Depends(unlocked)])
    def probe_mail(body: dict = Body(default={})):
        return mail_records(svc, body)

    @app.post("/api/probe/cert", dependencies=[Depends(unlocked)])
    def probe_cert(body: dict = Body(...)):
        answers = svc.store.load_answers()
        domain = v.address(body.get("domain") or answers.access.domain)
        cert, key = str(body.get("cert", "")), str(body.get("key", ""))
        if len(cert) > 200_000 or len(key) > 50_000:
            raise ApiError(413, "file_too_large")
        chosen = ans.selected_zones(answers, svc.catalog)
        mail_host = None
        if "mail" in chosen and answers.mail.kind == "builtin":
            mail_host = f"mail.{answers.mail.mail_domain or domain}"
        report = certs.inspect(cert, key, domain, mail_host=mail_host)
        if report["ok"]:
            write_private(svc.store.dir / "upload" / "cert.pem", cert)
            write_private(svc.store.dir / "upload" / "key.pem", key)
        svc.store.update_facts(upload_cert_ok=bool(report["ok"]))
        return report

    @app.post("/api/probe/smtp", dependencies=[Depends(unlocked)])
    def probe_smtp(body: dict = Body(default={})):
        return smtp_probe(svc, body)

    @app.post("/api/probe/ai", dependencies=[Depends(unlocked)])
    def probe_ai(body: dict = Body(default={})):
        return ai_probe(svc, body)

    @app.post("/api/probe/nfs", dependencies=[Depends(unlocked)])
    def probe_nfs(body: dict = Body(default={})):
        s = svc.store.load_answers().storage
        opts = lambda server, export: render.storage_volume(  # noqa: E731
            ans.load({"storage": {"kind": "nfs", "server": server, "export": export}}))["opts"]
        server, export = body.get("server") or s.server or "", body.get("export") or s.export or ""
        # 복원 중이면 표식 파일의 설치 id 가 백업의 것과 같은지도 본다
        return api_restore.nfs_probe(svc, probes.probe_nfs(svc.docker, server, export, volume_opts=opts), server, export)

    @app.post("/api/probe/local-path", dependencies=[Depends(unlocked)])
    def probe_local(body: dict = Body(default={})):
        return probes.probe_local_path(svc.docker, body.get("path") or svc.store.load_answers().storage.path or "")

    # ── 적용 ──

    @app.post("/api/apply", dependencies=[Depends(unlocked)], status_code=202)
    def post_apply():
        if svc.engine.running:
            raise ApiError(409, "apply_running")
        svc.engine.start()
        return {"started": True}

    @app.post("/api/apply/retry", dependencies=[Depends(unlocked)], status_code=202)
    def post_retry(body: dict = Body(default={})):
        if svc.engine.running:
            raise ApiError(409, "apply_running")
        if not svc.engine.retry(use_temporary_cert=bool(body.get("use_temporary_cert"))):
            raise ApiError(409, "nothing_to_retry")
        return {"started": True}

    @app.get("/api/apply", dependencies=[Depends(unlocked)])
    def get_apply():
        return svc.engine.status()

    @app.get("/api/apply/log", dependencies=[Depends(unlocked)])
    def get_log(step: str, tail: int = Query(default=500, ge=1, le=5000)):
        return {"step": step, "lines": svc.engine.read_log(step, tail)}

    @app.get("/api/apply/stream", dependencies=[Depends(session)])
    async def stream():
        async def events():
            last = None
            idle = 0
            while True:
                data = svc.engine.status()
                stamp = json.dumps(data, ensure_ascii=False, sort_keys=True)
                if stamp != last:
                    last = stamp
                    idle = 0
                    yield f"event: status\ndata: {stamp}\n\n"
                    if data.get("status") in ("done", "failed") and not svc.engine.running:
                        yield "event: end\ndata: {}\n\n"
                        return
                else:
                    idle += 1
                    if idle % 15 == 0:
                        yield ": keep-alive\n\n"
                await asyncio.sleep(1)
        return StreamingResponse(events(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    # ── 복원 — app/api_restore.py ──
    api_restore.register(app, svc, unlocked=unlocked, session=session, stream=stream)

    return app


def smtp_probe(svc: Services, body: dict) -> dict:
    m = svc.store.load_answers().mail
    password = body.get("password") or svc.store.answer_secrets().get("mail.password") or ""
    return probes.probe_smtp(body.get("host") or m.host or "", body.get("port") or m.port,
                             body.get("security") or m.security, body.get("username") or m.username or "",
                             password, smtp_factory=svc.smtp_factory)


def ai_probe(svc: Services, body: dict) -> dict:
    a = svc.store.load_answers().ai
    provider = body.get("provider") or a.provider or ""
    provider = {"google": "gemini"}.get(provider, provider)
    key = body.get("api_key") or svc.store.answer_secrets().get("ai.api_key") or ""
    return probes.probe_ai(provider, key, body.get("base_url") or a.base_url, get=svc.ai_get)


# ─── 내부 앱 ───


def create_internal_app(svc: Services) -> FastAPI:
    """워크스페이스 backend 가 내부망에서 공유 키로 부르는 API. 호스트에 게시하지 않는다."""
    app = FastAPI(title="Just Workspace installer (internal)", docs_url=None, redoc_url=None, openapi_url=None)
    _error_handlers(app)

    def client_allowed(request: Request) -> bool:
        host = request.client.host if request.client else ""
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            return False
        if ip.is_loopback:
            return True
        try:
            return ip in ipaddress.ip_network(svc.store.load_answers().advanced.subnet)
        except ValueError:
            return False

    def keyed(request: Request) -> None:
        expected = svc.store.env_secrets().get("JW_INSTALLER_KEY", "")
        given = request.headers.get(KEY_HEADER, "")
        # 키가 없으면(설치 전) 닫혀 있다. 워크스페이스 내부 대역 밖에서 온 요청도 받지 않는다.
        if not expected or not client_allowed(request) or not hmac.compare_digest(given.encode(), expected.encode()):
            raise ApiError(404, "not_found")

    def local(request: Request) -> None:
        host = request.client.host if request.client else ""
        given = request.headers.get(LOCAL_KEY_HEADER, "")
        if host not in ("127.0.0.1", "::1") or not hmac.compare_digest(given.encode(), svc.local_key().encode()):
            raise ApiError(404, "not_found")

    @app.get("/internal/health")
    def health():
        return {"ok": True, "version": svc.bundle.version, "installed": svc.store.locked}

    @app.get("/internal/zones", dependencies=[Depends(keyed)])
    def zones_list():
        return {**svc.zones.listing(), "git_verified_version": svc.bundle.gitea_verified_version}

    @app.get("/internal/zones/{zone_id}/settings", dependencies=[Depends(keyed)])
    def zone_settings(zone_id: str):
        out = svc.zones.get_settings(zone_id)
        if zone_id == "git":
            out["verified_version"] = svc.bundle.gitea_verified_version      # "검증된 버전"이 몇 버전인지
        return out

    @app.get("/internal/jobs", dependencies=[Depends(keyed)])
    def jobs_list():
        """구역 작업 — 진행 중인 것과 최근 것(새것부터, 20개까지 기억한다)."""
        jobs = sorted(svc.zones.jobs().values(), key=lambda j: j.get("started_at") or "", reverse=True)
        return {"jobs": jobs}

    @app.get("/internal/storage", dependencies=[Depends(keyed)])
    def storage():
        return storage_info(svc)

    @app.put("/internal/zones/{zone_id}/settings", dependencies=[Depends(keyed)], status_code=202)
    def zone_settings_put(zone_id: str, body: dict = Body(...)):
        return svc.zones.put_settings(zone_id, body.get("settings") or {})

    @app.post("/internal/zones/{zone_id}/check", dependencies=[Depends(keyed)])
    def zone_check(zone_id: str, body: dict = Body(default={})):
        return svc.zones.check(zone_id, body.get("settings"))

    @app.post("/internal/zones/{zone_id}/enable", dependencies=[Depends(keyed)], status_code=202)
    def zone_enable(zone_id: str, body: dict = Body(default={})):
        return svc.zones.enable(zone_id, body.get("settings"))

    @app.post("/internal/zones/{zone_id}/disable", dependencies=[Depends(keyed)], status_code=202)
    def zone_disable(zone_id: str):
        return svc.zones.disable(zone_id)

    @app.get("/internal/jobs/{job_id}", dependencies=[Depends(keyed)])
    def job(job_id: str):
        found = svc.zones.job(job_id)
        if not found:
            raise ApiError(404, "job_unknown")
        return found

    @app.get("/internal/jobs/{job_id}/log", dependencies=[Depends(keyed)])
    def job_log(job_id: str, tail: int = Query(default=300, ge=1, le=5000)):
        found = svc.zones.job(job_id)
        if not found:
            raise ApiError(404, "job_unknown")
        try:
            lines = svc.engine.log_path(f"zone-{found['zone']}").read_text(encoding="utf-8").splitlines()[-tail:]
        except OSError:
            lines = []
        return {"lines": lines}

    # 구역 켜기 창의 "연결 확인"
    @app.post("/internal/probe/smtp", dependencies=[Depends(keyed)])
    def internal_smtp(body: dict = Body(default={})):
        return smtp_probe(svc, body)

    @app.post("/internal/probe/ai", dependencies=[Depends(keyed)])
    def internal_ai(body: dict = Body(default={})):
        return ai_probe(svc, body)

    # 설치 뒤의 관리 화면(메일 레코드 표, 회의의 공인 주소)
    @app.post("/internal/probe/mail-records", dependencies=[Depends(keyed)])
    def internal_mail_records(body: dict = Body(default={})):
        return mail_records(svc, body)

    @app.get("/internal/probe/public-ip", dependencies=[Depends(keyed)])
    def internal_public_ip(refresh: bool = False):
        return public_ip(svc, refresh=refresh)

    # 인증서 다시 발급 · 보류된 구역 연결 — app/api_cert.py
    api_cert.register(app, svc, keyed=keyed)

    # 같은 컨테이너의 `jw` 명령용(루프백 + 상태 폴더의 키)
    @app.post("/local/apply", dependencies=[Depends(local)], status_code=202)
    def local_apply():
        if svc.store.locked:
            raise ApiError(423, "locked")
        if not svc.engine.start():
            raise ApiError(409, "apply_running")
        return {"started": True}

    @app.get("/local/apply", dependencies=[Depends(local)])
    def local_status():
        return svc.engine.status()

    # 업데이트 — app/api_update.py
    api_update.register(app, svc, keyed, client_allowed)
    return app
