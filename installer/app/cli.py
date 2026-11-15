"""`jw` — 설치 관리자 컨테이너 안에서 쓰는 명령.

    jw token                                   설치 토큰 다시 발급(입력해 둔 답은 그대로)
    jw status                                  어디까지 했는지
    jw apply --answers <파일> [--dry-run]      답변 파일로 무인 설치(dry-run 은 검증·렌더링까지만)
    jw render --answers <파일> --out <폴더>    산출물을 폴더에 써 본다(비밀값은 견본)
    jw reset-admin <계정> [--disable-2fa]      관리자 임시 비밀번호 발급
    jw reinstall [--yes]                       처음부터 다시 설치할 수 있게 지운다(--yes 없이는 지울 목록만 보여 준다)
    jw restore <백업> [--yes]                  설치된 이 서버의 데이터를 백업 시점으로 되돌린다(--yes 없이는 내용만 보여 준다)
    jw restore --list                          백업 볼륨에 있는 백업 목록
    jw update-key [list | add <파일> | remove <이름>]   업데이트 채널의 서명을 확인할 공개 키
    jw update-channel [<주소> | --reset]       업데이트 채널 주소

답변 파일은 JSON 이다(화면의 "답변 파일 내려받기"와 같은 형식). 비밀은 파일에 적거나 환경변수로 준다:
JW_ADMIN_PASSWORD · JW_MAIL_PASSWORD · JW_AI_API_KEY

`"mode": "restore"` 면 백업에서 복원한다 — `restore.path`(서버의 백업 파일 경로)와 이 서버에서 다시 정할 값
(접속 주소·연결 형태·인증서·저장소·내부 대역)만 적는다. 구역·메일·관리자는 백업에서 온다.
설정이 암호로 보호된 백업은 `restore.password_file` 또는 환경변수 JW_BACKUP_PASSWORD.
"""

from __future__ import annotations

import argparse
import json
import os
import re
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


def prepare_restore(svc: api.Services, answers: ans.Answers, env: dict | None = None) -> ans.Answers | None:
    """답변 파일의 복원 — 백업을 확인하고, 백업 설정과 합친 답변을 돌려준다. 쓸 수 없으면 사유를 찍고 None."""
    from app import api_restore

    env = os.environ if env is None else env
    mgr = api_restore.manager(svc)
    if not answers.restore.path:
        print("  ✗ restore.path: required  (mode: restore 에는 서버에 있는 백업 파일의 경로가 필요합니다)")
        return None
    password = env.get("JW_BACKUP_PASSWORD") or None
    if not password and answers.restore.password_file:
        try:
            password = Path(answers.restore.password_file).read_text(encoding="utf-8").splitlines()[0].strip()
        except (OSError, IndexError):
            print(f"  ✗ restore.password_file: 읽을 수 없습니다 ({answers.restore.password_file})")
            return None
    print(f"백업을 확인합니다: {answers.restore.path}")
    info = mgr.use_path(answers.restore.path, password)
    if info["status"] != "ok":
        print(f"  ✗ 이 백업으로는 복원할 수 없습니다: {info['status']}" + (f" ({info['reason']})" if info.get("reason") else ""))
        return None
    review = mgr.review()
    print(f"  만든 서버 {review['source_url'] or '?'} · 버전 {review['backup_version']} · 구역 {', '.join(review['zones']) or '(기본만)'}"
          f" · 파일 {'포함' if review['files_included'] else '미포함'}")
    a = answers.access
    target = {"domain": a.domain or None, "network": a.network, "proxy_addresses": a.proxy_addresses, "cert": a.cert,
              "cert_path": a.cert_path, "key_path": a.key_path, "storage": answers.storage.model_dump(mode="json"),
              "subnet": answers.advanced.subnet, "restore": answers.restore.model_dump(mode="json")}
    built, secrets, errors = mgr.prepare(target)
    if errors:
        print("답변에 문제가 있습니다:")
        print_errors(errors)
        return None
    return ans.join(ans.split(built)[0], secrets)


def cmd_apply(args) -> int:
    svc = _services(args)
    answers = read_answers(args.answers)
    if answers.mode == "restore":
        if svc.store.locked:
            print("설치가 이미 끝났습니다.")
            return 1
        answers = prepare_restore(svc, answers)
        if answers is None:
            return 1

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
        print("검증 통과 — 적용하면 이렇게 됩니다(아무것도 바꾸지 않았습니다)")
        print(f"  접속 주소  {plan.app_url}  (인증서: {plan.cert_mode}, 이름: {', '.join(plan.cert_names)})")
        print(f"  구역       {', '.join(plan.zones) or '(기본만)'}")
        print(f"  프로파일   {', '.join(plan.profiles) or '(없음)'}")
        print(f"  여는 포트  {', '.join(plan.ports)}")
        print(f"  저장소     {render.storage_volume(answers)['kind']}")
        print(f"  단계       {' → '.join(svc.engine.steps_for(answers, plan)[1])}")
        for c in plan.cautions:
            print(f"  주의: {c['key']} {json.dumps(c['vars'], ensure_ascii=False) if c['vars'] else ''}")
        print("  산출물:")
        for row in render.summarize(files):
            print(f"    {row['mode']}  {row['bytes']:>7}  {row['path']}")
        if answers.mode == "restore":
            from app import api_restore

            api_restore.manager(svc).discard()       # 확인하려고 꺼내 둔 백업 설정을 남기지 않는다
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


# ─── 같은 서버에 되돌리기 ───

RESTORE_ERRORS = {
    "not_installed": "설치가 끝난 서버에서만 쓸 수 있습니다. 새 서버로 옮기려면 설치 마법사의 \"백업에서 복원\"을 쓰세요.",
    "apply_running": "설치가 돌고 있습니다 — 끝난 뒤에 다시 실행하세요.",
    "update_running": "업데이트 작업이 진행 중입니다 — 끝난 뒤에 다시 실행하세요(관리 › 업데이트).",
    "zone_job_running": "구역 작업이 진행 중입니다 — 끝난 뒤에 다시 실행하세요(관리 › 구역).",
    "backup_required": "백업을 지정하세요 — 서버의 절대 경로, 또는 백업 볼륨 안의 이름(`jw restore --list`).",
    "backup_name_invalid": "백업 이름이 올바르지 않습니다.",
    "path_invalid": "경로가 올바르지 않습니다(절대 경로, `..`·특수 문자·시스템 폴더는 받지 않습니다).",
    "backup_unreadable": "백업을 읽지 못했습니다.",
    "backup_list_failed": "백업 목록을 읽지 못했습니다.",
}


def _size(n) -> str:
    if not isinstance(n, (int, float)):
        return "?"
    for unit in ("B", "KB", "MB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def cmd_restore(args) -> int:
    """설치된 서버의 데이터를 백업 시점으로 되돌린다(설정은 건드리지 않는다). **지금 데이터가 바뀐다.**"""
    from app import api_update
    from app import restore_local as rl

    svc = _services(args)
    updates = api_update.manager(svc)
    try:
        reason = rl.busy_reason(svc, updates)
        if reason:
            raise rl.LocalRestoreError(reason)
        if args.list:
            rows = rl.list_backups(updates)
            if not rows:
                print("백업 볼륨에 백업이 없습니다. 서버의 다른 곳에 둔 파일은 절대 경로로 지정하세요.")
                return 0
            for row in rows:
                name = str(row.get("path") or "").rsplit("/", 1)[-1]
                print(f"  {name}  {row.get('created_at') or '?'}  {row.get('kind') or '?'}  "
                      f"버전 {row.get('product_version') or '?'}  {_size(row.get('size_bytes'))}")
            return 0
        source = rl.resolve_source(svc.paths, args.backup or "")
        password = None
        if args.password_file:
            try:
                password = rl.to_host(svc.paths, args.password_file)
            except v.Invalid:
                raise rl.LocalRestoreError("path_invalid") from None
        items = [i.strip() for i in (args.items or "").split(",") if i.strip()] or None
        summary = rl.inspect(updates, source)
    except rl.LocalRestoreError as e:
        print(RESTORE_ERRORS.get(e.code, e.code), file=sys.stderr)
        if e.vars.get("detail"):
            print("  " + str(e.vars["detail"]).replace("\n", "\n  "), file=sys.stderr)
        return 1

    in_backup = [i for i in (summary.get("items") or []) if i != "config"]
    chosen = [i for i in in_backup if not items or i in items]
    print(f"백업: {args.backup}")
    print(f"  만든 서버 {summary.get('domain') or '?'} · 만든 때 {summary.get('created_at') or '?'} · "
          f"버전 {summary.get('product_version') or '?'} · 스키마 버전 {summary.get('schema_version')}")
    print(f"  사용자 {summary.get('users') if summary.get('users') is not None else '?'}명 · "
          f"파일 {'포함' if summary.get('files_included') else '미포함'} · 크기 {_size(summary.get('size_bytes'))}")
    print(f"  되돌릴 항목: {', '.join(chosen) or '(없음)'}")
    for item, why in (summary.get("skipped") or {}).items():
        print(f"  백업에 없는 항목: {item} ({why})")
    missing = [i for i in (items or []) if i not in in_backup]
    if missing:
        print(f"백업에 없는 항목을 골랐습니다: {', '.join(missing)}", file=sys.stderr)
        return 1
    if not chosen:
        print("되돌릴 항목이 없습니다.", file=sys.stderr)
        return 1
    print("이 서버의 지금 데이터를 위 백업의 내용으로 바꿉니다. 백업 뒤에 생긴 계정·파일·메일·대화는 사라집니다.")
    print("설정(.env)은 건드리지 않습니다. 도는 동안 서비스가 멈추고, 끝나면 모든 사용자가 다시 로그인해야 합니다.")
    if not args.yes:
        print("진행하려면 --yes 를 붙여 다시 실행하세요. (아무것도 바꾸지 않았습니다)")
        return 1

    def log(line: str) -> None:
        if line and not line.lstrip().startswith("{"):
            print(f"  {line}", flush=True)

    try:
        result = rl.run(svc, updates, source, items=items, password_host_path=password,
                        allow_key_mismatch=args.allow_key_mismatch, log=log)
    except rl.LocalRestoreError as e:
        print(RESTORE_ERRORS.get(e.code, e.code), file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    if not result.get("ok"):
        if result.get("stage"):
            print(f"복원 실패 — 단계 '{result['stage']}': {result.get('error')}", file=sys.stderr)
            if result.get("state"):
                print(f"  지금 상태: {result['state']}", file=sys.stderr)
        else:
            print(f"복원이 끝나지 않았습니다(종료 코드 {result.get('exit_code')}):", file=sys.stderr)
            print("  " + str(result.get("error") or "").replace("\n", "\n  "), file=sys.stderr)
        print("서비스 상태를 확인하세요: docker ps -a --filter name=ws-", file=sys.stderr)
        return 1
    schema = result.get("schema") or [None, None]
    print(f"되돌렸습니다: {', '.join(result.get('items') or [])}")
    if schema[0] != schema[1]:
        print(f"  스키마 버전 {schema[0]} → {schema[1]}(백업이 옛 버전의 것이라 변경 단계를 적용했습니다)")
    if result.get("safety_dump"):
        print(f"  복원 전의 DB 는 여기에 떠 두었습니다(백업 볼륨): {result['safety_dump']}")
    for note in result.get("notes") or []:
        print(f"  참고: {note}")
    st = svc.docker.container_status("ws-backend")
    ready = st["running"] and st["health"] in ("", "healthy")
    print("backend 가 준비됐습니다. 모든 사용자는 다시 로그인해야 합니다." if ready
          else "주의: backend 가 아직 준비되지 않았습니다 — docker logs ws-backend 를 확인하세요.")
    return 0 if ready else 1


# ─── 업데이트 채널 · 공개 키 ───

KEY_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


def _key_dir(svc: api.Services) -> Path:
    return svc.store.dir / "update" / "keys"


def _key_fingerprint(pem: bytes) -> str:
    """공개 키의 지문 — DER(SubjectPublicKeyInfo)의 SHA-256 앞 16자리. 릴리스를 내는 쪽과 맞대어 볼 때 쓴다."""
    import hashlib

    from cryptography.hazmat.primitives import serialization

    key = serialization.load_pem_public_key(pem)
    der = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return hashlib.sha256(der).hexdigest()[:16]


def _print_keys(svc: api.Services) -> None:
    from app import update_release as rel

    files = rel.key_files(svc.store.dir)
    if not files:
        print("공개 키가 없습니다 — 업데이트 확인은 \"구성되지 않음\"으로 답합니다.")
        return
    where = "설치 폴더(state/update/keys)" if files[0].parent == _key_dir(svc) else "이미지에 든 것"
    print(f"쓰는 공개 키 — {where}:")
    for path in files:
        try:
            print(f"  {path.name}  지문 {_key_fingerprint(path.read_bytes())}")
        except Exception:  # noqa: BLE001 — 읽지 못하는 파일은 그대로 알린다
            print(f"  {path.name}  (공개 키로 읽을 수 없습니다 — 이 파일이 있으면 업데이트 확인이 \"구성되지 않음\"이 됩니다)")


def cmd_update_key(args) -> int:
    from app import update_release as rel

    svc = _services(args)
    folder = _key_dir(svc)
    if args.action == "list":
        _print_keys(svc)
        return 0
    if args.action == "remove":
        name = args.target or ""
        if not KEY_NAME.fullmatch(name) or not (folder / name).is_file():
            print(f"그 이름의 키가 설치 폴더에 없습니다: {name}", file=sys.stderr)
            return 1
        (folder / name).unlink()
        print(f"지웠습니다: {name}")
        _print_keys(svc)
        return 0
    source = args.target or ""
    if not source:
        print("넣을 공개 키 파일을 주세요: jw update-key add <파일>  (- 는 표준 입력)", file=sys.stderr)
        return 2
    try:
        pem = sys.stdin.buffer.read() if source == "-" else Path(source).read_bytes()
    except OSError as e:
        print(f"키 파일을 읽지 못했습니다: {e}\n  설치 관리자 컨테이너 안의 경로여야 합니다 — 설치 폴더에 두고 /data/<파일> 로 적거나, "
              "표준 입력으로 주세요: docker exec -i jw-installer jw update-key add - < release.pub", file=sys.stderr)
        return 1
    if len(pem) > 16 * 1024:
        print("공개 키 파일이 아닙니다(너무 큽니다).", file=sys.stderr)
        return 1
    if b"PRIVATE KEY" in pem:
        print("비공개 키입니다 — 서버에는 공개 키(.pub)만 둡니다. 아무것도 저장하지 않았습니다.", file=sys.stderr)
        return 1
    try:
        rel.verify.load_public_keys([pem])
        fingerprint = _key_fingerprint(pem)
    except Exception as e:  # noqa: BLE001 — 릴리스 도구의 검증 오류·형식 오류
        print(f"쓸 수 있는 공개 키가 아닙니다: {e}", file=sys.stderr)
        return 1
    name = args.name or ("release.pub" if source == "-" else Path(source).name)
    if name.endswith(".pem"):
        name = name[:-4]
    if not name.endswith(".pub"):
        name += ".pub"
    if not KEY_NAME.fullmatch(name):
        print(f"키 이름이 올바르지 않습니다: {name} (--name 으로 정하세요)", file=sys.stderr)
        return 1
    try:
        existing = sorted(p.name for p in folder.iterdir() if p.is_file() and p.suffix in (".pub", ".pem"))
    except OSError:
        existing = []
    if name not in existing and len(existing) >= rel.MAX_KEYS:
        print(f"공개 키는 {rel.MAX_KEYS}개까지입니다(현재·다음). 먼저 하나를 지우세요: jw update-key remove <이름>", file=sys.stderr)
        _print_keys(svc)
        return 1
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(pem)
    os.chmod(folder / name, 0o644)
    print(f"넣었습니다: {name}  지문 {fingerprint}")
    print("이 지문이 릴리스를 내는 쪽이 알린 것과 같은지 확인하세요. 설치 폴더에 키가 있으면 이미지에 든 키는 쓰지 않습니다.")
    _print_keys(svc)
    print("다음 확인(여섯 시간마다, 또는 관리 › 업데이트의 \"지금 확인\")부터 쓰입니다.")
    return 0


def cmd_update_channel(args) -> int:
    from urllib.parse import urlsplit

    from app import update_release as rel

    svc = _services(args)
    path = svc.store.dir / rel.CHANNEL_URL_FILE
    if not args.url and not args.reset:
        override = rel.channel_url_override(svc.store.dir)
        print(f"채널 주소: {rel.channel_base_url(svc.store.dir)}")
        print("  (jw update-channel 로 정한 값)" if override else "  (환경변수 JW_UPDATE_CHANNEL_URL 또는 설치 관리자의 기본값)")
        return 0
    if args.reset:
        path.unlink(missing_ok=True)
    else:
        url = args.url.strip().rstrip("/")
        try:
            parts = urlsplit(url)
            bad = parts.scheme not in ("https", "http") or not parts.hostname or parts.query or parts.fragment \
                or "@" in parts.netloc
        except ValueError:
            bad = True
        if bad or any(ch.isspace() or ord(ch) < 32 for ch in url) or len(url) > 2000:
            print("채널 주소가 올바르지 않습니다 — https://<호스트>[/<경로>] 꼴이어야 합니다.", file=sys.stderr)
            return 1
        if parts.scheme == "http":
            print("주의: http 주소입니다. 채널 파일은 서명으로 확인하므로 변조는 걸러지지만, 무엇을 받는지는 드러납니다.")
        write_private(path, url + "\n")
    # 채널이 바뀌면 옛 채널에서 기억한 순번·확인 결과는 뜻이 없다(새 채널의 순번이 더 낮을 수 있다)
    (svc.store.dir / "update" / "check.json").unlink(missing_ok=True)
    print(f"채널 주소: {rel.channel_base_url(svc.store.dir)}")
    print("앞 채널에서 기억해 둔 확인 결과와 순번을 지웠습니다. 다음 확인(관리 › 업데이트의 \"지금 확인\")부터 쓰입니다.")
    if not rel.key_files(svc.store.dir):
        print("공개 키가 없습니다 — 이 채널의 공개 키를 넣으세요: jw update-key add <파일>")
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
    s = sub.add_parser("restore", help="이 서버의 데이터를 백업 시점으로 되돌린다(설정은 그대로)")
    s.add_argument("backup", nargs="?", help="서버에 있는 백업 파일·폴더의 절대 경로, 또는 백업 볼륨 안의 이름")
    s.add_argument("--list", action="store_true", help="백업 볼륨에 있는 백업 목록")
    s.add_argument("--items", metavar="a,b", help="이 항목만(기본: 백업에 든 것 전부, 설정 제외)")
    s.add_argument("--password-file", metavar="F",
                   help="암호로 보호된 백업의 암호 파일. 암호는 설정 항목에만 걸리고 이 명령은 설정을 되돌리지 않으므로 없어도 된다")
    s.add_argument("--allow-key-mismatch", action="store_true", help="백업과 이 서버의 암호화 키가 달라도 진행한다")
    s.add_argument("--yes", action="store_true", help="내용을 확인했고 되돌린다")
    s.add_argument("--json", action="store_true", help="결과를 JSON 한 줄로도 찍는다")
    s.set_defaults(func=cmd_restore)
    s = sub.add_parser("update-key", help="업데이트 채널의 서명을 확인할 공개 키")
    s.add_argument("action", nargs="?", default="list", choices=("list", "add", "remove"))
    s.add_argument("target", nargs="?", help="add: 공개 키 파일(컨테이너 안 경로, - 는 표준 입력) · remove: 키 이름")
    s.add_argument("--name", help="add: 저장할 이름(기본: 파일 이름, 표준 입력이면 release.pub)")
    s.set_defaults(func=cmd_update_key)
    s = sub.add_parser("update-channel", help="업데이트 채널 주소 보기·바꾸기")
    s.add_argument("url", nargs="?")
    s.add_argument("--reset", action="store_true", help="기본값(환경변수 또는 이미지의 값)으로 되돌린다")
    s.set_defaults(func=cmd_update_channel)
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
