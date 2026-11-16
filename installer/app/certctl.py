"""설치 후의 인증서 — 현재 사용 중인 인증서를 조회하고, 재발급하거나 업로드한 것으로 교체한다. 내부 API(`/internal/cert*`)가 호출한다.

임시(자체 서명) 인증서로 설치한 서버를 신뢰 가능한 인증서로 전환하는 경로이다.

    reissue(auto)    Let's Encrypt 에 재요청한다(접속 주소가 이 서버를 가리키고 80 이 외부에서 접근 가능해야 한다)
    reissue(upload)  보유한 인증서·개인 키를 업로드한다(검증은 설치 마법사의 인증서 확인과 동일). 사설 CA 발급 인증서이면 CA 인증서도 함께 업로드한다
    set_ca           업로드한 인증서를 사용하는 설치에 발급 CA 인증서만 추가하거나 제거한다(인증서·키는 유지)

성공 시 nginx 와 회의 서버가 새 인증서를 다시 읽도록 하고, **인증서 문제로 보류된 구역 연결**(코드 저장소의 로그인 연동)을
재시도한다. 실패 시 응답·설정을 롤백하고 기존 인증서를 복원한다.

작업은 구역 작업과 동일한 위치(`jobs.json`)에 기록된다: `{"kind": "cert", "zone": null, "stages": issue → reload → reconnect}`.
"""

from __future__ import annotations

import datetime as dt

from app import answers as ans
from app import certs, render, zones
from app import engine as eng
from app.state import write_private
from app.zonectl import ZoneManager, ZoneRequestError

STAGES = ("issue", "reload", "reconnect")
MAX_CERT, MAX_KEY = 200_000, 50_000


def describe(cert_pem: str | None, now: dt.datetime | None = None) -> dict:
    """인증서 1건의 요약 — 만료일·잔여 일수·발급자·이름·자체 서명 여부. 읽기 실패 시 빈 값."""
    empty = {"not_before": None, "not_after": None, "days_left": None, "issuer": None, "names": [], "self_signed": False}
    if not cert_pem:
        return empty
    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID

        cert = x509.load_pem_x509_certificate(cert_pem.encode())
        not_after = cert.not_valid_after_utc
        issuer = None
        for oid in (NameOID.ORGANIZATION_NAME, NameOID.COMMON_NAME):
            found = cert.issuer.get_attributes_for_oid(oid)
            if found:
                issuer = str(found[0].value)
                break
        now = now or dt.datetime.now(dt.timezone.utc)
        return {"not_before": cert.not_valid_before_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "not_after": not_after.strftime("%Y-%m-%dT%H:%M:%SZ"), "days_left": (not_after - now).days,
                "issuer": issuer, "names": certs._names(cert), "self_signed": certs.is_self_signed(cert_pem)}
    except Exception:  # noqa: BLE001 — 손상된 파일이어도 상태 조회에는 응답한다
        return empty


class CertManager:
    def __init__(self, engine: eng.Engine, zone_manager: ZoneManager):
        self.engine = engine
        self.store = engine.store
        self.zones = zone_manager

    def _ctx(self, answers: ans.Answers | None = None) -> eng.Context:
        return self.engine._context("cert-reissue", answers or self.store.load_answers(), self.store.facts())

    def status(self) -> dict:
        answers = self.store.load_answers()
        ctx = self._ctx(answers)
        plan = ctx.plan
        mode = answers.access.cert
        pem, record = eng.read_cert_state(ctx, plan.cert_dir) if plan.domain else (None, None)
        info = describe(pem)
        running = next((j for j in self.zones.jobs().values() if j.get("kind") == "cert" and j.get("status") == "running"), None)
        return {
            "managed": plan.tls,
            "mode": mode,
            # 임시 = 브라우저가 신뢰하지 않는 인증서로 접속을 수신 중(프록시가 담당하는 설치는 해당 없음)
            "temporary": plan.tls and (mode == "temporary" or info["self_signed"]),
            "domain": plan.domain,
            "names": info["names"] or plan.cert_names,
            "wanted_names": plan.cert_names,
            "not_after": info["not_after"],
            "days_left": info["days_left"],
            "issuer": info["issuer"],
            "self_signed": info["self_signed"],
            # 이 서버의 컨테이너(코드 저장소·backend)가 신뢰하도록 설정된 발급 CA 의 존재 여부 — 업로드한 인증서에 체인이 동반되었거나 CA 를 별도 업로드한 경우
            "site_ca": bool(plan.tls and mode == "upload" and self.store.facts().site_ca),
            # 발급 CA 를 별도 업로드할 수 있는 설치인지 여부(업로드한 인증서를 사용하며, 그것이 자체 서명이 아닌 경우)
            "ca_uploadable": bool(plan.tls and mode == "upload" and not info["self_signed"]),
            "pending": sorted(zones.pending(self.store)),
            # 자동 갱신 서비스(자동 발급 설치에만 해당) — 동작 여부·최종 갱신 시도·다음 갱신 예정(추정)
            "renewal": eng.renewal_status(self.engine, plan, info["not_before"], info["not_after"], record),
            "job": running,
        }

    def reissue(self, body: dict) -> dict:
        if not self.store.locked:
            raise ZoneRequestError(409, "not_installed")
        mode = str(body.get("mode") or "")
        if mode not in ("auto", "upload"):
            raise ZoneRequestError(422, "cert_mode_invalid", mode=mode)
        old = self.store.load_answers()
        if old.access.network == "proxy":
            raise ZoneRequestError(409, "cert_managed_by_proxy")
        data = old.model_dump(mode="json")
        data["access"]["cert"] = mode
        data["access"]["cert_path"] = data["access"]["key_path"] = data["access"]["ca_path"] = None
        new = ans.load(data)
        domain = new.access.domain
        cert = key = ca = None
        if mode == "auto":
            from app import validators as v

            if v.is_ip(domain):
                raise ZoneRequestError(422, "cert_auto_needs_domain")
        else:
            cert, key, ca = str(body.get("cert") or ""), str(body.get("key") or ""), str(body.get("ca") or "")
            if len(cert) > MAX_CERT or len(key) > MAX_KEY or len(ca) > MAX_CERT:
                raise ZoneRequestError(413, "file_too_large")
            plan = render.derive(old, self.store.facts(), self.engine.catalog)
            mail_host = f"mail.{plan.mail_domain}" if plan.mail_builtin else None
            report = certs.inspect(cert, key, domain, mail_host=mail_host, ca_pem=ca)
            if not report["ok"]:
                raise ZoneRequestError(422, "cert_invalid", checks=report["checks"])
        return self.zones._start("cert", None, STAGES, self._run, old, new, cert, key, ca)

    def set_ca(self, body: dict) -> dict:
        """업로드한 인증서를 사용하는 설치에 발급 CA 인증서만 추가한다(빈 값이면 별도 업로드한 것을 제거한다) — 인증서·키는 유지.

        서버 인증서 1건만 업로드하여 코드 저장소의 로그인 연동이 보류된 경우, 인증서를 재업로드하지 않고 CA 만 지정하는 경로이다.
        """
        if not self.store.locked:
            raise ZoneRequestError(409, "not_installed")
        answers = self.store.load_answers()
        if answers.access.network == "proxy":
            raise ZoneRequestError(409, "cert_managed_by_proxy")
        if answers.access.cert != "upload":
            raise ZoneRequestError(409, "cert_ca_needs_upload", mode=answers.access.cert)
        ca = str(body.get("ca") or "")
        if len(ca) > MAX_CERT:
            raise ZoneRequestError(413, "file_too_large")
        ctx = self._ctx(answers)
        current = eng.read_cert(ctx, ctx.plan.cert_dir) or ""
        if ca.strip():
            checks = certs.inspect_ca(ca, current)
            if any(c["status"] == "fail" for c in checks):
                raise ZoneRequestError(422, "cert_invalid", checks=checks)
        return self.zones._start("cert", None, STAGES, self._run_ca, answers, current, ca)

    def _ca_file(self):
        return self.store.dir / "upload" / "ca.pem"

    def _put_ca(self, ca: str | None) -> None:
        if (ca or "").strip():
            write_private(self._ca_file(), ca, 0o644)
        else:
            self._ca_file().unlink(missing_ok=True)

    def _run_ca(self, job: dict, answers: ans.Answers, current: str, ca: str) -> None:
        zm = self.zones
        before = self._ca_file().read_text(encoding="utf-8") if self._ca_file().exists() else ""
        if answers.access.ca_path:                       # 응답 파일로 지정한 경로보다 방금 업로드한 것이 우선
            data = answers.model_dump(mode="json")
            data["access"]["ca_path"] = None
            self.store.save_answers(ans.load(data))
        ctx = self._ctx()
        ctx.log("── 발급 CA 인증서 " + ("올리기" if ca.strip() else "걷어 내기") + " ──")

        def issue() -> None:
            zm._stage(job, "issue", "running")
            self._put_ca(ca)
            eng.set_site_ca(ctx, certs.trust_pem(current, ca))
            r = ctx.docker.compose("config", "-q", timeout=120)
            if not r.ok:
                raise eng.StepError("compose_invalid", "see_log", detail=r.err[-300:])
            zm._stage(job, "issue", "done")

        error = zm._guard(issue, job, ctx)
        if error is not None:
            self.store.save_answers(answers)
            self._put_ca(before)
            back = self._ctx()
            zm._guard(lambda: eng.set_site_ca(back, certs.trust_pem(current, before)), job, back)
            zm._finish(job, ctx, error)
            return
        error = zm._guard(lambda: self._reload(job, ctx), job, ctx) or zm._guard(lambda: self._reconnect(job, ctx), job, ctx)
        zm._finish(job, ctx, error)

    def _reload(self, job: dict, ctx: eng.Context) -> None:
        zm = self.zones
        zm._stage(job, "reload", "running")
        active = ctx.active_services()
        ctx.docker.run(["restart", "ws-nginx"], timeout=120)
        ctx.wait_ready("ws-nginx", 120)
        if "certbot" in active:
            ctx.docker.connect_self(render.INSTALLER_ALIAS)   # 동적 주소로 연결된 상태이면 예약 주소로 이전한다
            ctx.up(["certbot"])                       # 자동 발급으로 전환된 경우 갱신 컨테이너 필요(webroot — nginx 기동 후)
        elif ctx.docker.container_status(eng.RENEWAL_CONTAINER)["exists"]:
            ctx.stop(["certbot"])                     # 자동 발급에서 다른 방식으로 전환된 경우 갱신 컨테이너 제거
        if ctx.plan.turn and ctx.docker.container_status("ws-livekit")["running"]:
            ctx.docker.run(["restart", "ws-livekit"], timeout=120)
        if "gitea" in active and ctx.docker.container_status("ws-gitea")["running"]:
            # 신뢰 대상 발급 CA 가 추가 또는 제거된 경우 여기서 컨테이너가 재생성된다(변경이 없으면 유지)
            ctx.up(["gitea"])
            ctx.wait_ready("ws-gitea")
        if "onlyoffice" in active and ctx.docker.container_status("ws-onlyoffice")["running"]:
            # 인증서 종류가 변경되면 회귀 접속의 인증서 검증 설정이 달라진다(변경이 없으면 유지)
            ctx.up(["onlyoffice"])
            ctx.wait_ready("ws-onlyoffice")
        ctx.up(["backend"])                           # `.env` 의 인증서 관련 값 또는 신뢰 대상 CA 가 변경된 경우 재생성
        ctx.wait_ready("ws-backend")
        zm._stage(job, "reload", "done")

    def _reconnect(self, job: dict, ctx: eng.Context) -> None:
        zm = self.zones
        zm._stage(job, "reconnect", "running")
        for zone_id in sorted(zones.pending(self.store)):
            if zone_id in zm.enabled():
                ctx.log(f"{zone_id}: 보류된 연결을 다시 시도합니다")
                zones.get(zone_id).connect(ctx, zone_id)
        if ctx.env_dirty:
            zm._restart_backend(ctx)
        zm._stage(job, "reconnect", "done")

    def _run(self, job: dict, old: ans.Answers, new: ans.Answers, cert: str | None, key: str | None,
             ca: str | None = None) -> None:
        old_facts = self.store.facts()
        old_ca = self._ca_file().read_text(encoding="utf-8") if self._ca_file().exists() else ""
        self.store.save_answers(new)
        if cert is not None:
            write_private(self.store.dir / "upload" / "cert.pem", cert)
            write_private(self.store.dir / "upload" / "key.pem", key or "")
            self._put_ca(ca)
            self.store.update_facts(upload_cert_ok=True)
        ctx = self._ctx()
        mode = new.access.cert
        ctx.log(f"── 인증서 다시 발급({mode}) ──")
        zm = self.zones
        volumes = [f"{eng.CERT_VOLUME}:/etc/letsencrypt"]

        def issue() -> None:
            zm._stage(job, "issue", "running")
            ctx.write_stack()
            r = ctx.docker.compose("config", "-q", timeout=120)
            if not r.ok:
                raise eng.StepError("compose_invalid", "see_log", detail=r.err[-300:])
            if mode == "upload" and old.access.cert == "auto":
                # 자동 발급으로 받은 폴더가 해당 위치에 존재한다 — 업로드한 인증서는 검증을 통과했으므로 삭제 후 배치한다
                ctx.docker.helper(["drop-cert", "--name", ctx.plan.cert_dir], volumes=volumes, timeout=60)
            eng.step_cert(ctx)
            zm._stage(job, "issue", "done")

        error = zm._guard(issue, job, ctx)
        if error is not None:
            # 롤백 — 응답·감지값·설정 파일 및 기존 인증서(자동 발급 시도 중 임시 인증서의 링크가 제거되었을 수 있음)
            self.store.save_answers(old)
            if cert is not None:
                self._put_ca(old_ca)                      # 기존 CA 인증서도 롤백(아래 step_cert 가 다시 읽음)
            self.store.update_facts(cert_issue_failed=old_facts.cert_issue_failed, upload_cert_ok=old_facts.upload_cert_ok)
            if old.access.cert == "temporary":
                self.store.update_facts(cert_issue_failed=True)
            back = self._ctx()

            def put_back() -> None:
                back.write_stack()
                eng.step_cert(back)
                back.docker.exec("ws-nginx", ["nginx", "-s", "reload"], timeout=60)

            zm._guard(put_back, job, back)
            ctx.log("인증서를 바꾸지 못해 이전 상태로 되돌렸습니다")
            zm._finish(job, ctx, error)
            return
        self.store.update_facts(cert_issue_failed=False)
        error = zm._guard(lambda: self._reload(job, ctx), job, ctx) or zm._guard(lambda: self._reconnect(job, ctx), job, ctx)
        zm._finish(job, ctx, error)
