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
from dataclasses import dataclass, field
from typing import Callable

from fastapi import Body, Depends, FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse

from app import answers as ans
from app import certs, dkim, preflight, probes, render
from app import validators as v
from app.bundle import Bundle
from app.catalog import Catalog
from app.docker_api import Docker, Runner, SubprocessRunner
from app.engine import Engine, plan_steps
from app.paths import Paths
from app.state import Store, now_iso, write_private
from app.tokens import COOKIE_NAME, SESSION_TTL, TokenStore
from app.zonectl import ZoneManager, ZoneRequestError

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
    registry = registry or os.environ.get("JW_REGISTRY") or "localhost"
    image_tag = image_tag or os.environ.get("JW_IMAGE_TAG") or None
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
        "preflight": {"checked": bool(pre), "ok": bool(pre and pre.get("ok"))},
        "apply": {"status": apply.get("status"), "current": apply.get("current"),
                  "error": apply.get("error"), "alternatives": apply.get("alternatives", [])},
        "token_expires_at": svc.tokens.expires_at(),
    }


LANDING = """<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Just Workspace 설치 관리자</title>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.6">
<h1 style="font-size:1.25rem">Just Workspace 설치 관리자</h1>
<p>__MESSAGE__</p>
<p style="color:#666">설치 토큰은 서버에서 <code>docker logs jw-installer</code> 로 확인하고,
만료됐으면 <code>docker exec jw-installer jw token</code> 으로 다시 받습니다.</p>
</body></html>"""


# ─── 마법사 앱 ───


def create_wizard_app(svc: Services) -> FastAPI:
    app = FastAPI(title="Just Workspace installer", version=svc.bundle.version, docs_url=None, redoc_url=None,
                  openapi_url=None)
    _error_handlers(app)

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

    @app.get("/", response_class=HTMLResponse)
    def landing(request: Request, token: str | None = Query(default=None)):
        if svc.store.locked:
            return HTMLResponse(LANDING.replace("__MESSAGE__", "설치가 끝났습니다. 이제 워크스페이스 주소로 접속하세요."))
        if token is not None:
            try:
                sid = check_token(token)
            except ApiError as e:
                message = {"token_expired": "설치 토큰이 만료됐습니다.", "token_locked": "잠시 뒤 다시 시도하세요.",
                           }.get(e.code, "설치 토큰이 맞지 않습니다.")
                return HTMLResponse(LANDING.replace("__MESSAGE__", message), status_code=e.status)
            response = RedirectResponse("/", status_code=303)     # 토큰이 주소창·기록에 남지 않게
            set_cookie(response, sid)
            return response
        if svc.tokens.session_valid(request.cookies.get(COOKIE_NAME)):
            return HTMLResponse(LANDING.replace("__MESSAGE__", "설치 토큰을 확인했습니다. 설치 화면은 다음 단계에서 이 자리에 들어옵니다(지금은 API 만 있습니다)."))
        return HTMLResponse(LANDING.replace("__MESSAGE__", "설치 토큰이 붙은 주소로 접속하세요."), status_code=401)

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
            return {"phase": "installed", "locked": True, "version": svc.bundle.version,
                    "url": f"https://{domain}" if domain else None}
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
    def put_answers(patch: dict = Body(...)):
        if svc.engine.running:
            raise ApiError(409, "apply_running")
        current, _ = ans.split(svc.store.load_answers())
        merged = ans.load(ans.merge_patch(current, patch))        # 비밀은 patch 에 든 것만 새로 저장된다
        svc.store.save_answers(merged)
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
        answers = svc.store.load_answers()
        mail_domain = body.get("mail_domain") or answers.mail.mail_domain or answers.access.domain
        key = dkim.ensure(svc.store, mail_domain)
        ip = public_ip(svc).get("ip")
        return probes.probe_mail_records(key["domain"], ip, key["record_value"], svc.resolver, key["selector"])

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
        return probes.probe_nfs(svc.docker, body.get("server") or s.server or "", body.get("export") or s.export or "",
                                volume_opts=opts)

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

    # ── 복원(이번 단계 범위 밖) ──

    @app.post("/api/restore", dependencies=[Depends(unlocked)])
    @app.post("/api/restore/{rest:path}", dependencies=[Depends(unlocked)])
    def restore(rest: str = ""):
        raise ApiError(501, "restore_not_supported")

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
        return svc.zones.listing()

    @app.get("/internal/zones/{zone_id}/settings", dependencies=[Depends(keyed)])
    def zone_settings(zone_id: str):
        return svc.zones.get_settings(zone_id)

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

    return app
