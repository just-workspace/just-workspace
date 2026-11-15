"""설치 뒤의 인증서 — 지금 무엇을 쓰고 있는지 보고, 다시 발급하거나 올린 것으로 바꾼다. 내부 API(`/internal/cert*`)가 부른다.

임시(자체 서명) 인증서로 설치한 서버를 신뢰되는 인증서로 바꾸는 길이다.

    reissue(auto)    Let's Encrypt 에 다시 요청한다(접속 주소가 이 서버를 가리키고 80 이 밖에서 닿아야 한다)
    reissue(upload)  가진 인증서·개인 키를 올린다(검증은 마법사의 인증서 확인과 같다)

성공하면 nginx 와 회의 서버가 새 인증서를 읽게 하고, **인증서 때문에 보류된 구역 연결**(코드 저장소의 로그인 연동)을
다시 시도한다. 실패하면 답변·설정을 되돌리고 쓰던 인증서를 다시 놓는다.

작업은 구역 작업과 같은 자리(`jobs.json`)에 남는다: `{"kind": "cert", "zone": null, "stages": issue → reload → reconnect}`.
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
    """인증서 한 장의 요약 — 만료일·남은 날·발급자·이름·자체 서명 여부. 읽지 못하면 빈 값."""
    empty = {"not_after": None, "days_left": None, "issuer": None, "names": [], "self_signed": False}
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
        return {"not_after": not_after.strftime("%Y-%m-%dT%H:%M:%SZ"), "days_left": (not_after - now).days,
                "issuer": issuer, "names": certs._names(cert), "self_signed": certs.is_self_signed(cert_pem)}
    except Exception:  # noqa: BLE001 — 깨진 파일이어도 상태 조회는 답한다
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
        info = describe(eng.read_cert(ctx, plan.cert_dir) if plan.domain else None)
        running = next((j for j in self.zones.jobs().values() if j.get("kind") == "cert" and j.get("status") == "running"), None)
        return {
            "managed": plan.tls,
            "mode": mode,
            # 임시 = 브라우저가 믿지 않는 인증서로 접속을 받고 있다(프록시가 맡는 설치는 해당 없음)
            "temporary": plan.tls and (mode == "temporary" or info["self_signed"]),
            "domain": plan.domain,
            "names": info["names"] or plan.cert_names,
            "wanted_names": plan.cert_names,
            "not_after": info["not_after"],
            "days_left": info["days_left"],
            "issuer": info["issuer"],
            "self_signed": info["self_signed"],
            "pending": sorted(zones.pending(self.store)),
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
        data["access"]["cert_path"] = data["access"]["key_path"] = None
        new = ans.load(data)
        domain = new.access.domain
        cert = key = None
        if mode == "auto":
            from app import validators as v

            if v.is_ip(domain):
                raise ZoneRequestError(422, "cert_auto_needs_domain")
        else:
            cert, key = str(body.get("cert") or ""), str(body.get("key") or "")
            if len(cert) > MAX_CERT or len(key) > MAX_KEY:
                raise ZoneRequestError(413, "file_too_large")
            plan = render.derive(old, self.store.facts(), self.engine.catalog)
            mail_host = f"mail.{plan.mail_domain}" if plan.mail_builtin else None
            report = certs.inspect(cert, key, domain, mail_host=mail_host)
            if not report["ok"]:
                raise ZoneRequestError(422, "cert_invalid", checks=report["checks"])
        return self.zones._start("cert", None, STAGES, self._run, old, new, cert, key)

    def _run(self, job: dict, old: ans.Answers, new: ans.Answers, cert: str | None, key: str | None) -> None:
        old_facts = self.store.facts()
        self.store.save_answers(new)
        if cert is not None:
            write_private(self.store.dir / "upload" / "cert.pem", cert)
            write_private(self.store.dir / "upload" / "key.pem", key or "")
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
                # 자동 발급으로 받은 폴더가 그 자리에 있다 — 올린 인증서는 검증을 통과했으니 치우고 놓는다
                ctx.docker.helper(["drop-cert", "--name", ctx.plan.cert_dir], volumes=volumes, timeout=60)
            eng.step_cert(ctx)
            zm._stage(job, "issue", "done")

        def reload() -> None:
            zm._stage(job, "reload", "running")
            active = ctx.active_services()
            if "certbot" in active:
                ctx.up(["certbot"])                       # 자동 발급으로 바뀌었으면 갱신 컨테이너가 필요하다
            ctx.docker.run(["restart", "ws-nginx"], timeout=120)
            ctx.wait_ready("ws-nginx", 120)
            if ctx.plan.turn and ctx.docker.container_status("ws-livekit")["running"]:
                ctx.docker.run(["restart", "ws-livekit"], timeout=120)
            if "gitea" in active and ctx.docker.container_status("ws-gitea")["running"]:
                # 믿게 할 발급 CA 가 생기거나 사라졌으면 여기서 컨테이너가 다시 만들어진다(바뀐 것이 없으면 그대로다)
                ctx.up(["gitea"])
                ctx.wait_ready("ws-gitea")
            ctx.up(["backend"])                           # `.env` 의 인증서에 딸린 값이 바뀌었으면 다시 만들어진다
            ctx.wait_ready("ws-backend")
            zm._stage(job, "reload", "done")

        def reconnect() -> None:
            zm._stage(job, "reconnect", "running")
            for zone_id in sorted(zones.pending(self.store)):
                if zone_id in zm.enabled():
                    ctx.log(f"{zone_id}: 보류된 연결을 다시 시도합니다")
                    zones.get(zone_id).connect(ctx, zone_id)
            if ctx.env_dirty:
                zm._restart_backend(ctx)
            zm._stage(job, "reconnect", "done")

        error = zm._guard(issue, job, ctx)
        if error is not None:
            # 되돌린다 — 답변·감지값·설정 파일, 그리고 쓰던 인증서(자동 발급을 시도하며 임시 인증서의 링크를 뗐을 수 있다)
            self.store.save_answers(old)
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
        error = zm._guard(reload, job, ctx) or zm._guard(reconnect, job, ctx)
        zm._finish(job, ctx, error)
