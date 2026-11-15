"""`jw` — 설치 관리자 컨테이너 안에서 쓰는 명령.

    jw token                                   설치 토큰 다시 발급(입력해 둔 답은 그대로)
    jw status                                  어디까지 했는지
    jw apply --answers <파일> [--dry-run]      답변 파일로 무인 설치(dry-run 은 검증·렌더링까지만)
    jw render --answers <파일> --out <폴더>    산출물을 폴더에 써 본다(비밀값은 견본)
    jw reset-admin <계정> [--disable-2fa]      관리자 임시 비밀번호 발급
    jw reinstall [--yes]                       처음부터 다시 설치할 수 있게 지운다(--yes 없이는 지울 목록만 보여 준다)

답변 파일은 JSON 이다(화면의 "답변 파일 내려받기"와 같은 형식). 비밀은 파일에 적거나 환경변수로 준다:
JW_ADMIN_PASSWORD · JW_MAIL_PASSWORD · JW_AI_API_KEY
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from app import answers as ans
from app import api, probes, render
from app import paths as paths_mod
from app import validators as v
from app.state import write_private
from app.tokens import TokenStore

ENV_SECRETS = {"admin.password": "JW_ADMIN_PASSWORD", "mail.password": "JW_MAIL_PASSWORD", "ai.api_key": "JW_AI_API_KEY"}
LOCAL_API = "http://127.0.0.1:{port}"


def _services(args) -> api.Services:
    return api.build_services(paths_mod.from_env())


def read_answers(path: str, env: dict | None = None) -> ans.Answers:
    env = os.environ if env is None else env
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as e:
        raise SystemExit(f"답변 파일을 읽지 못했습니다: {e}") from None
    except ValueError as e:
        raise SystemExit(f"답변 파일이 JSON 이 아닙니다: {e}") from None
    if isinstance(data, dict):
        for dotted, name in ENV_SECRETS.items():
            section, key = dotted.split(".")
            if env.get(name) and not (data.get(section) or {}).get(key):
                data.setdefault(section, {})[key] = env[name]
    try:
        return ans.load(data)
    except ans.StructureError as e:
        for err in e.errors:
            print(f"  {err.field}: {err.code}", file=sys.stderr)
        raise SystemExit("답변 파일의 모양이 맞지 않습니다") from None


def sample_secrets(bundle) -> dict:
    """dry-run·render 용 견본 비밀값(실제 설치에는 쓰지 않는다)."""
    sd = bundle.security_defaults
    values = sd.generate([*sd.names(default_only=True), "SMTP_PASSWORD"])
    values.update(JW_INSTALL_ID="00000000-0000-0000-0000-000000000000", JW_INSTALLER_KEY="0" * 48)
    return values


def print_errors(errors) -> None:
    for e in errors:
        extra = f" {json.dumps(e.vars, ensure_ascii=False)}" if e.vars else ""
        print(f"  ✗ {e.field}: {e.code}{extra}")


def cmd_token(args) -> int:
    svc = _services(args)
    if svc.store.locked:
        print("설치가 이미 끝났습니다 — 설치 토큰은 더 필요하지 않습니다.")
        return 1
    token = TokenStore(svc.store).issue()
    host = os.environ.get("JW_PUBLIC_HOST") or "<서버 주소>"
    print(f"새 설치 토큰: {token}  (24시간 동안 유효)")
    print(f"접속 주소:    https://{host}:{os.environ.get('JW_PORT', '8443')}/?token={token}")
    return 0


def cmd_status(args) -> int:
    svc = _services(args)
    st = api.state(svc)
    print(f"버전 {st['version']} · 단계 {st['phase']} · 사전 점검 {'통과' if st['preflight']['ok'] else '미통과/미실행'}")
    apply = svc.engine.status()
    print(f"적용: {apply.get('status')}")
    for step in apply.get("steps", []):
        line = f"  {step['id']:<9} {step['status']}"
        if step.get("error"):
            line += f"  ← {step['error']['cause']} (해결: {step['error'].get('fix')})"
        print(line)
    if args.json:
        print(json.dumps({"state": st, "apply": apply}, ensure_ascii=False, indent=2))
    return 0 if apply.get("status") != "failed" else 1


def _plan_report(svc: api.Services, answers: ans.Answers, facts: ans.Facts) -> tuple[list, render.Plan]:
    answers, notes = ans.resolve_quick(answers, svc.catalog, facts)
    errors = ans.validate(answers, svc.catalog, facts)
    plan = render.derive(answers, facts, svc.catalog)
    for note in notes:
        print(f"  참고: {note['key']} {json.dumps(note['vars'], ensure_ascii=False)}")
    return errors, plan


def cmd_render(args) -> int:
    svc = _services(args)
    answers = read_answers(args.answers)
    facts = svc.store.facts()
    if facts.dns_status is None:
        facts.dns_status = "unknown"
    errors, _ = _plan_report(svc, answers, facts)
    structural = [e for e in errors if not e.code.startswith("memory_")]
    if structural:
        print_errors(structural)
        return 1
    answers, _ = ans.resolve_quick(answers, svc.catalog, facts)
    files = render.render(answers, sample_secrets(svc.bundle), facts, svc.bundle, registry=svc.registry,
                          image_tag=svc.engine.image_tag)
    out = Path(args.out)
    for rel, content in files.items():
        write_private(out / rel, content, render.file_mode(rel))
    print(f"{len(files)}개 파일을 {out} 에 썼습니다(비밀값은 견본입니다 — 실제 설치에 쓰지 마세요)")
    return 0


def cmd_apply(args) -> int:
    svc = _services(args)
    answers = read_answers(args.answers)

    if args.dry_run:
        facts = svc.store.facts()
        if facts.dns_status is None:
            facts.dns_status = "unknown"       # dry-run 은 바깥에 묻지 않는다
        errors, plan = _plan_report(svc, answers, facts)
        if errors:
            print("답변에 문제가 있습니다:")
            print_errors(errors)
            return 1
        answers, _ = ans.resolve_quick(answers, svc.catalog, facts)
        files = render.render(answers, sample_secrets(svc.bundle), facts, svc.bundle, registry=svc.registry,
                              image_tag=svc.engine.image_tag)
        from app.engine import plan_steps

        print("검증 통과 — 적용하면 이렇게 됩니다(아무것도 바꾸지 않았습니다)")
        print(f"  접속 주소  {plan.app_url}  (인증서: {plan.cert_mode}, 이름: {', '.join(plan.cert_names)})")
        print(f"  구역       {', '.join(plan.zones) or '(기본만)'}")
        print(f"  프로파일   {', '.join(plan.profiles) or '(없음)'}")
        print(f"  여는 포트  {', '.join(plan.ports)}")
        print(f"  저장소     {render.storage_volume(answers)['kind']}")
        print(f"  단계       {' → '.join(plan_steps(answers, plan))}")
        for c in plan.cautions:
            print(f"  주의: {c['key']} {json.dumps(c['vars'], ensure_ascii=False) if c['vars'] else ''}")
        print("  산출물:")
        for row in render.summarize(files):
            print(f"    {row['mode']}  {row['bytes']:>7}  {row['path']}")
        return 0

    if svc.store.locked:
        print("설치가 이미 끝났습니다.")
        return 1
    svc.store.save_answers(answers)
    # 감지값 — 공인 주소와 접속 주소 확인(임시 인증서 허용 여부, 회의 서버 주소에 쓴다)
    got = api.public_ip(svc)
    try:
        dns = probes.probe_dns(answers.access.domain, got.get("ip"), svc.resolver)
        svc.store.update_facts(dns_status=dns["status"])
        print(f"접속 주소 확인: {dns['status']}")
    except v.Invalid:
        pass

    port = os.environ.get("JW_INTERNAL_PORT", str(render.INTERNAL_API_PORT))
    via_server = False
    try:
        import httpx

        r = httpx.post(LOCAL_API.format(port=port) + "/local/apply", headers={api.LOCAL_KEY_HEADER: svc.local_key()}, timeout=5)
        via_server = r.status_code == 202
        if r.status_code == 409:
            print("이미 적용이 돌고 있습니다 — 진행 상황을 따라갑니다")
            via_server = True
    except Exception:  # noqa: BLE001 — 서버가 떠 있지 않으면 이 프로세스에서 직접 돌린다
        via_server = False

    if not via_server:
        final = svc.engine.run()
        return _report(final)

    seen: dict[str, str] = {}
    while True:
        st = svc.engine.status()
        for step in st.get("steps", []):
            if seen.get(step["id"]) != step["status"]:
                seen[step["id"]] = step["status"]
                print(f"  {step['id']:<9} {step['status']}")
        if st.get("status") in ("done", "failed"):
            return _report(st)
        time.sleep(2)


def _report(st: dict) -> int:
    if st.get("status") == "done":
        print("설치가 끝났습니다.")
        return 0
    err = st.get("error") or {}
    print(f"실패: {err.get('step', '시작 전')} — {err.get('cause')} (해결: {err.get('fix')})")
    if err.get("vars"):
        print("  " + json.dumps(err["vars"], ensure_ascii=False))
    for alt in st.get("alternatives", []):
        print(f"  대안: {alt['key']}")
    return 1


def cmd_reset_admin(args) -> int:
    svc = _services(args)
    username = v.username(args.username)
    argv = ["python", "-m", "app.cli", "reset-admin", username] + (["--disable-2fa"] if args.disable_2fa else [])
    r = svc.docker.exec("ws-backend", argv, user="appuser", timeout=120)
    sys.stdout.write(r.out)
    sys.stderr.write(r.err)
    return r.rc


REINSTALL_KEEP = ("tls",)        # 설치 관리자 자신의 인증서 — 지문이 바뀌지 않게 남긴다


def reinstall_targets(svc: api.Services) -> dict:
    """다시 설치하려면 지워야 하는 것 — 워크스페이스의 컨테이너·볼륨·내부망. 이름으로 돌려준다."""
    from app.engine import CERT_VOLUME
    from app.paths import NETWORK_NAME, PROJECT_NAME

    docker = svc.docker
    label = f"label=com.docker.compose.project={PROJECT_NAME}"
    r = docker.run(["ps", "-a", "--filter", label, "--format", "{{.Names}}"], timeout=30)
    containers = sorted(n for n in r.out.split() if n) if r.ok else []
    r = docker.run(["volume", "ls", "-q", "--filter", label], timeout=30)
    volumes = {n for n in r.out.split() if n} if r.ok else set()
    for extra in (render.STORAGE_VOLUME, CERT_VOLUME):          # compose 밖에서 만든 볼륨
        if docker.volume_inspect(extra) is not None:
            volumes.add(extra)
    network = NETWORK_NAME if docker.inspect("network", NETWORK_NAME) is not None else None
    storage = docker.volume_inspect(render.STORAGE_VOLUME) or {}
    external = bool((storage.get("Options") or {}).get("type"))  # NFS·지정 폴더 — 볼륨을 지워도 파일은 남는다
    return {"containers": containers, "volumes": sorted(volumes), "network": network, "storage_external": external}


def cmd_reinstall(args) -> int:
    """워크스페이스를 지우고 설치 관리자를 처음 상태로 돌린다. **데이터가 지워진다.**"""
    import shutil

    svc = _services(args)
    if svc.engine.status().get("status") == "running":
        print("적용이 돌고 있습니다 — 끝난 뒤에 다시 실행하세요.")
        return 1
    found = reinstall_targets(svc)
    print("다시 설치하려면 아래를 지웁니다. 워크스페이스의 데이터(계정·파일·메일·대화)가 모두 사라집니다.")
    print(f"  컨테이너 {len(found['containers'])}개: {' '.join(found['containers']) or '(없음)'}")
    print(f"  볼륨 {len(found['volumes'])}개: {' '.join(found['volumes']) or '(없음)'}")
    print(f"  내부망: {found['network'] or '(없음)'}")
    print("  설치 폴더의 설정(stack)과 설치 상태(state) — 설치 관리자의 인증서는 남깁니다")
    if found["storage_external"]:
        print("  파일 저장소가 네트워크 저장소·지정 폴더입니다 — 그 안의 파일은 지우지 않고, 저장소 표식만 지웁니다.")
    if not args.yes:
        print("지우려면 --yes 를 붙여 다시 실행하세요. (아무것도 지우지 않았습니다)")
        return 1

    docker = svc.docker
    from app.helper import MARKER_NAME

    if found["storage_external"]:
        # 표식이 남아 있으면 다음 설치가 "다른 설치의 저장소"로 보고 멈춘다
        docker.run(["run", "--rm", "--network", "none", "--entrypoint", "rm", "-v",
                    f"{render.STORAGE_VOLUME}:/storage:nocopy", docker.self_image(), "-f", f"/storage/{MARKER_NAME}"],
                   timeout=120)
    failed = False
    if found["containers"]:
        failed |= not docker.run(["rm", "-f", "-v", *found["containers"]], timeout=300).ok
    if found["network"]:
        docker.run(["network", "disconnect", "-f", found["network"], docker.self_ref], timeout=60)
        failed |= not docker.run(["network", "rm", found["network"]], timeout=60).ok
    for name in found["volumes"]:
        failed |= not docker.volume_rm(name).ok
    if failed:
        print("일부를 지우지 못했습니다 — `docker ps -a`, `docker volume ls` 로 남은 것을 확인하고 다시 실행하세요.")
        return 1
    shutil.rmtree(svc.paths.stack, ignore_errors=True)
    for entry in svc.paths.state.iterdir():
        if entry.name in REINSTALL_KEEP:
            continue
        shutil.rmtree(entry, ignore_errors=True) if entry.is_dir() else entry.unlink(missing_ok=True)
    print("지웠습니다. 설치 관리자를 다시 시작합니다 — 새 설치 토큰은 `docker logs` 의 맨 끝에 나옵니다.")
    sys.stdout.flush()
    docker.run(["restart", docker.self_ref], timeout=120)       # 이 명령도 여기서 함께 끝난다
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="jw", description="Just Workspace 설치 관리자")
    sub = p.add_subparsers(dest="command")
    sub.add_parser("token", help="설치 토큰 다시 발급").set_defaults(func=cmd_token)
    s = sub.add_parser("status", help="설치 진행 상태")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_status)
    s = sub.add_parser("apply", help="답변 파일로 설치")
    s.add_argument("--answers", required=True)
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(func=cmd_apply)
    s = sub.add_parser("render", help="산출물을 폴더에 써 본다")
    s.add_argument("--answers", required=True)
    s.add_argument("--out", required=True)
    s.set_defaults(func=cmd_render)
    s = sub.add_parser("reset-admin", help="관리자 임시 비밀번호 발급")
    s.add_argument("username")
    s.add_argument("--disable-2fa", action="store_true")
    s.set_defaults(func=cmd_reset_admin)
    s = sub.add_parser("reinstall", help="처음부터 다시 설치할 수 있게 지운다(데이터 삭제)")
    s.add_argument("--yes", action="store_true", help="목록을 확인했고 지운다")
    s.set_defaults(func=cmd_reinstall)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    try:
        return args.func(args)
    except v.Invalid as e:
        print(f"값이 올바르지 않습니다: {e.code}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
