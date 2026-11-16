"""설치 후 구역 관리 — 활성화·비활성화·설정 재편집. 내부 API(`/internal/*`)가 호출한다.

흐름(화면과 동일): 설정 → 메모리·포트 확인(`check`) → 수신/설정/연결 진행(`enable` 이 생성한 작업을 조회).
실패 시 해당 구역은 **비활성화 상태**로 롤백한다(답변·`.env`·컨테이너).

구역 활성화 창이 전송하는 값(`settings`)과 답변 항목의 대응:

| 구역 | settings | 답변 |
|---|---|---|
| mail | `kind`(builtin/external), `mail_domain` 또는 `host`·`port`·`security`·`username`·`password` | `mail.*` |
| meetings | `turn`(중계), `lossless_audio` | `meetings.*` (공인 주소는 감지값) |
| ai | `mode`(now/later), `provider`(openai/anthropic/google …), `api_key`, `model`, `base_url` | `ai.*` |
| git | `version`(tested/latest/custom), `custom_version` | `git.version` |
| 그 밖 | 없음 | — |
"""

from __future__ import annotations

import secrets
import threading

from app import answers as ans
from app import engine as eng
from app import render, zones
from app.state import now_iso

SECTIONS = ("mail", "meetings", "ai", "git")     # 설정이 있는 구역 = 답변의 동일 이름 항목
PROVIDER_ALIASES = {"google": "gemini"}
ENABLE_STAGES = ("pull", "configure", "connect")
DISABLE_STAGES = ("disconnect", "configure")
UPDATE_STAGES = ("configure", "connect")


class ZoneRequestError(Exception):
    def __init__(self, status: int, code: str, **vars):
        super().__init__(code)
        self.status, self.code, self.vars = status, code, vars


def settings_to_section(zone_id: str, settings: dict) -> dict:
    """화면이 전송한 값 → 답변 항목. 미정의 항목은 답변 모델이 거부한다."""
    s = dict(settings or {})
    if zone_id == "ai":
        mode = s.pop("mode", None)
        if mode is not None:
            s["mode"] = {"now": "provider", "later": "later"}.get(mode, mode)
        if s.get("provider"):
            s["provider"] = PROVIDER_ALIASES.get(s["provider"], s["provider"])
    elif zone_id == "git":
        version = s.pop("version", None)
        custom = s.pop("custom_version", None)
        if version in (None, "tested", "verified"):
            s["version"] = "verified"
        elif version == "custom":
            s["version"] = custom or ""
        else:
            s["version"] = version
    return s


def section_to_settings(zone_id: str, answers: ans.Answers, secret_flags: dict) -> dict:
    """답변 항목 → 화면이 재편집 시 표시하는 값(비밀은 제외하고 설정 여부만 반환한다)."""
    if zone_id not in SECTIONS:
        return {}
    data = getattr(answers, zone_id).model_dump(mode="json")
    for section, name in ans.SECRET_FIELDS:
        if section == zone_id:
            data.pop(name, None)
            data[f"{name}_set"] = bool(secret_flags.get(f"{section}.{name}"))
    if zone_id == "ai":
        data["mode"] = "now" if data.get("mode") == "provider" else "later"
        if data.get("provider") == "gemini":
            data["provider"] = "google"
    elif zone_id == "git":
        version = data.get("version", "verified")
        data = {"version": {"verified": "tested", "latest": "latest"}.get(version, "custom"),
                "custom_version": version if version not in ("verified", "latest") else None}
    return data


class ZoneManager:
    def __init__(self, engine: eng.Engine):
        self.engine = engine
        self.store = engine.store
        self.catalog = engine.catalog
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    # ─── 조회 ───

    def enabled(self, answers: ans.Answers | None = None) -> list[str]:
        return ans.selected_zones(answers or self.store.load_answers(), self.catalog)

    def server_memory_mb(self) -> int:
        info = self.engine.docker.info()
        mb = int(info.get("MemTotal") or 0) // (1024 * 1024)
        if mb:
            self.store.update_facts(memory_mb=mb)
        return mb or (self.store.facts().memory_mb or 0)

    def listing(self) -> dict:
        enabled = self.enabled()
        out = self.catalog.listing(enabled, self.server_memory_mb() or None)
        waiting = zones.pending(self.store)
        for row in (*out["zones"], *out["addons"]):
            row["enabled"] = row.pop("selected")
            row["has_settings"] = row["id"] in SECTIONS
            # 활성화되어 있으나 연결(로그인 연동)이 설정되지 않은 상태 — 신뢰되는 인증서로 교체된 후 재시도한다
            hold = waiting.get(row["id"]) if row["enabled"] else None
            row["pending"] = hold is not None
            row["pending_reason"] = (hold or {}).get("reason")
        return out

    def get_settings(self, zone_id: str) -> dict:
        self._known(zone_id)
        answers = self.store.load_answers()
        return {"zone": zone_id, "enabled": zone_id in self.enabled(answers),
                "settings": section_to_settings(zone_id, answers, ans.secrets_present(self.store.answer_secrets())),
                "detected": {"public_ip": self.store.facts().public_ip}}

    def jobs(self) -> dict:
        return self.store.read("jobs.json", {}) or {}

    def job(self, job_id: str) -> dict | None:
        return self.jobs().get(job_id)

    # ─── 확인(메모리·포트) ───

    def _known(self, zone_id: str) -> None:
        if not self.catalog.known(zone_id):
            raise ZoneRequestError(404, "zone_unknown", zone=zone_id)

    def _with_zone(self, answers: ans.Answers, zone_id: str, settings: dict | None, *, on: bool) -> ans.Answers:
        data = answers.model_dump(mode="json")
        current = self.enabled(answers)
        wanted = [z for z in current if z != zone_id] + ([zone_id] if on else [])
        data["zones"] = [z for z in self.catalog.zone_ids if z in wanted]
        data["addons"] = [z for z in self.catalog.addon_ids if z in wanted]
        data["preset"] = None
        if settings is not None and zone_id in SECTIONS:
            data[zone_id] = ans.merge_patch(data.get(zone_id, {}), settings_to_section(zone_id, settings))
        try:
            return ans.load(data)
        except ans.StructureError as e:
            raise ZoneRequestError(422, "settings_invalid", errors=[
                {**x.as_dict(), "field": x.field.split(".", 1)[-1] if x.field.startswith(zone_id + ".") else x.field}
                for x in e.errors]) from None

    def check(self, zone_id: str, settings: dict | None = None) -> dict:
        """활성화 가능 여부 — 설정 오류, 메모리, 신규 개방 포트. 변경은 수행하지 않는다."""
        self._known(zone_id)
        old = self.store.load_answers()
        new = self._with_zone(old, zone_id, settings, on=True)
        facts = self.store.facts()
        memory_mb = self.server_memory_mb()
        facts.memory_mb = memory_mb or facts.memory_mb
        errors = [e for e in ans.validate(new, self.catalog, facts) if e.field != "admin.password"]
        verdict = self.catalog.judge(self.enabled(new), facts.memory_mb or 0)
        old_plan = render.derive(old, facts, self.catalog)
        new_plan = render.derive(new, facts, self.catalog)
        memory_errors = [e for e in errors if e.code.startswith("memory_")]
        other = [e for e in errors if not e.code.startswith("memory_")]
        return {
            "zone": zone_id,
            "ok": not errors,
            "errors": [e.as_dict() for e in other],
            "memory": {**verdict.as_dict(), "ok": not memory_errors},
            "ports": [p for p in new_plan.ports if p not in old_plan.ports],
            "cautions": [c for c in new_plan.cautions if c not in old_plan.cautions],
        }

    # ─── 작업 ───

    def _start(self, kind: str, zone_id: str, stages: tuple[str, ...], target, *args, ports: list[str] | None = None) -> dict:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                raise ZoneRequestError(409, "busy")
            if self.engine.running:
                raise ZoneRequestError(409, "busy")
            job = {"id": secrets.token_hex(8), "kind": kind, "zone": zone_id, "status": "running",
                   "stages": [{"id": s, "status": "pending"} for s in stages], "error": None, "warnings": [],
                   "ports": ports or [], "started_at": now_iso(), "finished_at": None}
            self._save(job)
            self._thread = threading.Thread(target=target, args=(job, *args), name=f"jw-zone-{zone_id}", daemon=True)
            self._thread.start()
            return job

    def wait(self, timeout: float = 60.0) -> None:
        if self._thread is not None:
            self._thread.join(timeout)

    def _save(self, job: dict) -> None:
        jobs = self.jobs()
        jobs[job["id"]] = job
        for old in sorted(jobs, key=lambda k: jobs[k]["started_at"])[:-20]:      # 최근 20개만 유지
            jobs.pop(old)
        self.store.write("jobs.json", jobs)

    def _stage(self, job: dict, stage_id: str, status: str) -> None:
        for stage in job["stages"]:
            if stage["id"] == stage_id:
                stage["status"] = status
        self._save(job)

    def _finish(self, job: dict, ctx: eng.Context, error: eng.StepError | None = None) -> None:
        job["warnings"] = ctx.warnings
        job["finished_at"] = now_iso()
        if error is None:
            job["status"] = "done"
        else:
            job["status"] = "failed"
            job["error"] = error.as_dict()
            for stage in job["stages"]:
                if stage["status"] == "running":
                    stage["status"] = "failed"
        self._save(job)

    def _restart_backend(self, ctx: eng.Context) -> None:
        ctx.write_stack()
        ctx.up(["backend"])
        ctx.wait_ready("ws-backend")

    def _apply(self, job: dict, ctx: eng.Context, zone_id: str, *, pull: bool) -> None:
        """수신 → 설정 → 연결. 실패 시 StepError."""
        hook = zones.get(zone_id)
        if pull:
            self._stage(job, "pull", "running")
        ctx.write_stack()
        r = ctx.docker.compose("config", "-q", timeout=120)
        if not r.ok:
            raise eng.StepError("compose_invalid", "see_log", detail=r.err[-300:])
        if pull:
            eng.step_pull(ctx)
            self._stage(job, "pull", "done")
        self._stage(job, "configure", "running")
        if ctx.plan.tls or ctx.plan.cert_aliases:
            eng.step_cert(ctx)          # 구역에 따라 인증서에 포함할 이름이 추가된다(mail. · turn.)
        hook.install(ctx, zone_id)
        self._stage(job, "configure", "done")
        self._stage(job, "connect", "running")
        hook.connect(ctx, zone_id)
        self._restart_backend(ctx)
        if "onlyoffice" in ctx.zone_services(zone_id) and not eng.wait_docs_ready(ctx.http, ctx.sleep, ctx.log):
            ctx.warn("docs_not_ready")
        eng.configure_backend(ctx)
        self._stage(job, "connect", "done")

    def _guard(self, fn, job: dict, ctx: eng.Context) -> eng.StepError | None:
        try:
            fn()
            return None
        except eng.StepError as e:
            ctx.log(f"실패: {e.cause}")
            return e
        except Exception as e:  # noqa: BLE001
            ctx.log(f"실패(예상하지 못한 오류): {type(e).__name__}")
            return eng.StepError("unexpected_error", "see_log", type=type(e).__name__)

    # ─── 활성화 ───

    def enable(self, zone_id: str, settings: dict | None = None) -> dict:
        self._require_installed()
        self._known(zone_id)
        old = self.store.load_answers()
        if zone_id in self.enabled(old):
            raise ZoneRequestError(409, "already_enabled", zone=zone_id)
        report = self.check(zone_id, settings)
        if not report["memory"]["ok"]:
            raise ZoneRequestError(409, "memory_insufficient", **report["memory"])
        if report["errors"]:
            raise ZoneRequestError(422, "settings_invalid", errors=report["errors"])
        new = self._with_zone(old, zone_id, settings, on=True)
        return self._start("enable", zone_id, ENABLE_STAGES, self._run_enable, zone_id, old, new, ports=report["ports"])

    def _run_enable(self, job: dict, zone_id: str, old: ans.Answers, new: ans.Answers) -> None:
        old_secrets = self.store.answer_secrets()
        self.store.save_answers(new)
        ctx = self.engine._context(f"zone-{zone_id}", self.store.load_answers(), self.store.facts())
        ctx.log(f"── {zone_id} 켜기 ──")
        error = self._guard(lambda: self._apply(job, ctx, zone_id, pull=True), job, ctx)
        if error is not None:
            # 비활성화 상태로 롤백 — 답변·.env·컨테이너
            self.store.save_answers(old, keep_secrets=False)
            self.store.write("answers.secret.json", old_secrets)
            back = self.engine._context(f"zone-{zone_id}", self.store.load_answers(), self.store.facts())
            self._guard(lambda: zones.get(zone_id).remove(back, zone_id), job, back)
            self._guard(lambda: self._restart_backend(back), job, back)
            ctx.log(f"{zone_id}: 켜지 못해 꺼진 상태로 되돌렸습니다")
        self._finish(job, ctx, error)

    # ─── 비활성화 ───

    def disable(self, zone_id: str) -> dict:
        self._require_installed()
        self._known(zone_id)
        old = self.store.load_answers()
        if zone_id not in self.enabled(old):
            raise ZoneRequestError(409, "not_enabled", zone=zone_id)
        new = self._with_zone(old, zone_id, None, on=False)
        return self._start("disable", zone_id, DISABLE_STAGES, self._run_disable, zone_id, old, new)

    def _run_disable(self, job: dict, zone_id: str, old: ans.Answers, new: ans.Answers) -> None:
        ctx = self.engine._context(f"zone-{zone_id}", old, self.store.facts())
        ctx.log(f"── {zone_id} 끄기 ──")

        def work() -> None:
            self._stage(job, "disconnect", "running")
            zones.get(zone_id).remove(ctx, zone_id)
            self._stage(job, "disconnect", "done")
            self._stage(job, "configure", "running")
            self.store.save_answers(new)
            ctx.answers = self.store.load_answers()
            self._restart_backend(ctx)
            self._stage(job, "configure", "done")

        self._finish(job, ctx, self._guard(work, job, ctx))

    # ─── 설정 재편집 ───

    def put_settings(self, zone_id: str, settings: dict) -> dict:
        self._require_installed()
        self._known(zone_id)
        if zone_id not in SECTIONS:
            raise ZoneRequestError(422, "zone_has_no_settings", zone=zone_id)
        old = self.store.load_answers()
        if zone_id not in self.enabled(old):
            raise ZoneRequestError(409, "not_enabled", zone=zone_id)
        report = self.check(zone_id, settings)
        if report["errors"]:
            raise ZoneRequestError(422, "settings_invalid", errors=report["errors"])
        new = self._with_zone(old, zone_id, settings, on=True)
        return self._start("update", zone_id, UPDATE_STAGES, self._run_update, zone_id, old, new, ports=report["ports"])

    def _run_update(self, job: dict, zone_id: str, old: ans.Answers, new: ans.Answers) -> None:
        old_secrets = self.store.answer_secrets()
        self.store.save_answers(new)
        ctx = self.engine._context(f"zone-{zone_id}", self.store.load_answers(), self.store.facts())
        ctx.log(f"── {zone_id} 설정 변경 ──")
        error = self._guard(lambda: self._apply(job, ctx, zone_id, pull=False), job, ctx)
        if error is not None:
            self.store.save_answers(old, keep_secrets=False)
            self.store.write("answers.secret.json", old_secrets)
            back = self.engine._context(f"zone-{zone_id}", self.store.load_answers(), self.store.facts())
            self._guard(lambda: self._restart_backend(back), job, back)
            ctx.log(f"{zone_id}: 설정을 바꾸지 못해 이전 값으로 되돌렸습니다")
        self._finish(job, ctx, error)

    # ─── 재연결 ───

    def reconnect(self, zone_id: str) -> dict:
        """보류된 연결(코드 저장소의 로그인 연동)을 재시도한다. 계속 실패하면 작업이 실패로 기록된다."""
        self._require_installed()
        self._known(zone_id)
        if zone_id not in self.enabled():
            raise ZoneRequestError(409, "not_enabled", zone=zone_id)
        if zone_id not in zones.pending(self.store):
            raise ZoneRequestError(409, "not_pending", zone=zone_id)
        return self._start("reconnect", zone_id, ("connect",), self._run_reconnect, zone_id)

    def _run_reconnect(self, job: dict, zone_id: str) -> None:
        ctx = self.engine._context(f"zone-{zone_id}", self.store.load_answers(), self.store.facts())
        ctx.log(f"── {zone_id} 다시 연결 ──")

        def work() -> None:
            self._stage(job, "connect", "running")
            zones.get(zone_id).connect(ctx, zone_id)
            if ctx.env_dirty:
                self._restart_backend(ctx)
            hold = zones.pending(self.store).get(zone_id)
            if hold is not None:
                raise eng.StepError("connection_still_pending", "cert_use_trusted", zone=zone_id,
                                    reason=hold.get("reason"))
            self._stage(job, "connect", "done")

        self._finish(job, ctx, self._guard(work, job, ctx))

    def _require_installed(self) -> None:
        if not self.store.locked:
            raise ZoneRequestError(409, "not_installed")
