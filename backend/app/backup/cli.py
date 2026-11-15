"""`python -m app.cli backup …` / `restore …` — 백업·복원의 정식 경로.

    backup create [--kind full|pre-update] [--dest DIR] [--include-files] [--pack] [--json]
    backup list [--dest DIR] [--json]
    backup inspect <백업> [--json]            내용 요약(풀지 않는다, DB·docker 없이)
    backup verify <백업>                      모든 파일을 manifest 의 SHA-256 과 견준다
    backup pack <백업 폴더> [<파일>]          tar 한 개(.jwbak)로 묶는다
    backup extract-config <백업> --out DIR    설정 묶음(.env …)만 꺼낸다(새 서버로 옮길 때, DB·docker 없이)
    backup plan [--kind …] [--json]           실행할 단계 목록만 보여 준다(설치 관리자용)
    restore <백업> [--items a,b] [--with-config] [--yes] [--json]

암호는 명령 인자로 받지 않는다 — `--password-file <파일>` 또는 환경변수 `JW_BACKUP_PASSWORD`.

종료 코드: 0 성공 · 1 실패 · 2 일부 항목이 빠진 백업(무엇이 빠졌는지 출력) / 잘못된 사용법 · 3 확인 질문에서 취소.
복원은 backend 를 세우므로 실행 중인 backend 안에서는 돌지 않는다 — scripts/restore.sh 가 일회용
컨테이너에서 부른다.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

EXIT_OK, EXIT_FAILED, EXIT_PARTIAL, EXIT_CANCELLED = 0, 1, 2, 3
ENV_PASSWORD = "JW_BACKUP_PASSWORD"


def _err(line: str) -> None:
    print(line, file=sys.stderr, flush=True)


def _dest(args) -> Path:
    return Path(getattr(args, "dest", None) or os.environ.get("BACKUP_ROOT", "/backups"))


def _password(args) -> str | None:
    path = getattr(args, "password_file", None)
    if path:
        with open(path, encoding="utf-8") as f:
            return f.read().strip("\r\n") or None
    return os.environ.get(ENV_PASSWORD) or None


def _human(n: int | None) -> str:
    from app.backup.runner import _human as human

    return "?" if n is None else human(int(n))


def _print_summary(s: dict) -> None:
    names = {"full": "전체", "pre-update": "업데이트 직전"}
    storage = s.get("storage") or {}
    where = storage.get("kind", "local")
    if where == "nfs":
        where += f" ({storage.get('server', '?')}:{storage.get('export', '?')})"
    print(f"종류:        {names.get(s['kind'], s['kind'])}")
    print(f"만든 시각:   {s['created_at']}")
    print(f"만든 서버:   {s['domain'] or '?'}" + (f"  (설치 id {s['install_id']})" if s["install_id"] else ""))
    print(f"제품 버전:   {s['product_version']}   스키마 버전: {s['schema_version']}")
    print(f"구역:        {', '.join(s['zones']) or '(기본만)'}")
    print(f"사용자 수:   {s['users'] if s['users'] is not None else '?'}")
    print(f"데이터 크기: DB {_human(s['data_bytes'])}, 파일 저장소 {_human(s['storage_bytes'])}")
    print(f"저장소:      {where}")
    print(f"들어 있는 항목: {', '.join(s['items'])}")
    print("파일 포함:   " + (f"예 ({_human(s['files_bytes'])})" if s["files_included"] else "아니오"))
    if s["config_included"]:
        print("설정(.env):  포함" + (" — 암호로 보호됨" if s["config_encrypted"] else " — 암호화 키가 평문으로 들어 있음"))
    for item, reason in (s.get("skipped") or {}).items():
        print(f"빠진 항목:   {item} ({reason})")
    print(f"백업 크기:   {_human(s['size_bytes'])}")


def _cmd_backup(args) -> int:
    from app.backup import format as fmt
    from app.backup import plan as pl
    from app.backup import runner
    from app.backup.format import BackupError

    try:
        if args.action == "create":
            result = runner.create_backup(
                _dest(args), kind=args.kind, include_files=args.include_files, password=_password(args),
                check_space=not args.skip_space_check, log=_err,
            )
            path = result.path
            if args.pack:
                packed = fmt.pack(path, path.with_name(path.name + fmt.ARCHIVE_SUFFIX))
                import shutil

                shutil.rmtree(path)
                path = packed
            summary = {"path": str(path), "status": result.status, "failures": result.failures,
                       **fmt.summarize(path)}
            if args.json:
                print(json.dumps(summary, ensure_ascii=False, indent=2))
            else:
                print(f"백업: {path}")
                _print_summary(summary)
                for line in result.failures:
                    _err(f"경고: {line}")
                if summary["config_included"]:
                    _err("주의: " + fmt.SECRET_WARNING)
            return EXIT_OK if result.status == "success" else EXIT_PARTIAL

        if args.action == "list":
            rows = runner.list_backups(_dest(args))
            if args.json:
                print(json.dumps(rows, ensure_ascii=False, indent=2))
            else:
                for r in rows:
                    print(f"{r['created_at']}  {r['kind']:<10}  {_human(r['size_bytes']):>9}  "
                          f"v{r['product_version']} 스키마 {r['schema_version']}  {r['path']}")
                if not rows:
                    print(f"백업이 없습니다: {_dest(args)}")
            return EXIT_OK

        if args.action == "inspect":
            summary = fmt.summarize(args.path)
            if args.json:
                print(json.dumps(summary, ensure_ascii=False, indent=2))
            else:
                _print_summary(summary)
            return EXIT_OK

        if args.action == "verify":
            backup = fmt.open_backup(args.path)
            problems = fmt.verify(backup, password=_password(args))
            if args.json:
                print(json.dumps({"ok": not problems, "problems": problems}, ensure_ascii=False))
            elif problems:
                for line in problems:
                    _err(f"문제: {line}")
            else:
                print(f"온전합니다: 파일 {len(backup.manifest.files())}개의 크기·SHA-256 이 기록과 같습니다")
            return EXIT_FAILED if problems else EXIT_OK

        if args.action == "pack":
            src = Path(args.path)
            out = Path(args.out) if args.out else src.with_name(src.name + fmt.ARCHIVE_SUFFIX)
            print(fmt.pack(src, out))
            return EXIT_OK

        if args.action == "extract-config":
            names = runner.extract_config(Path(args.path), Path(args.out), _password(args))
            print("\n".join(names))
            _err("주의: " + fmt.SECRET_WARNING)
            return EXIT_OK

        if args.action == "plan":
            found = runner.discover(runner.SubprocessRunner())
            plan = pl.plan_backup(found.config, args.kind, include_files=args.include_files)
            if args.json:
                print(json.dumps(plan.to_dict(), ensure_ascii=False, indent=2))
            else:
                for step in plan.steps:
                    print(f"{step.id:<18} {step.title}" + (f"  → {step.stdout}" if step.stdout else ""))
                for item, reason in plan.skipped.items():
                    print(f"(건너뜀) {item}: {reason}")
            return EXIT_OK
    except BackupError as e:
        _err(f"ERROR: {e}")
        return EXIT_FAILED
    except OSError as e:
        _err(f"ERROR: {e}")
        return EXIT_FAILED
    return EXIT_PARTIAL


def _cmd_restore(args) -> int:
    from app.backup import format as fmt
    from app.backup import runner
    from app.backup.format import BackupError

    items = [i.strip() for i in args.items.split(",") if i.strip()] if args.items else None
    unknown = [i for i in (items or []) if i not in fmt.ITEMS]
    if unknown:
        _err("ERROR: 모르는 항목: " + ", ".join(unknown) + f" (쓸 수 있는 항목: {', '.join(fmt.ITEMS)})")
        return EXIT_PARTIAL
    try:
        summary = fmt.summarize(args.path)
    except BackupError as e:
        _err(f"ERROR: 복원 실패 — 단계 'verify': {e} (기존 데이터는 그대로입니다)")
        return EXIT_FAILED
    if not args.json:
        _print_summary(summary)
    if not args.yes:
        if not sys.stdin.isatty():
            _err("ERROR: 지금 데이터를 이 백업으로 바꿉니다 — 확인 없이 진행하려면 --yes 를 붙이세요")
            return EXIT_PARTIAL
        if input("\n지금 데이터를 이 백업의 내용으로 바꿉니다. 계속하려면 RESTORE 를 입력하세요: ").strip() != "RESTORE":
            print("취소했습니다")
            return EXIT_CANCELLED
    try:
        result = runner.restore_backup(
            Path(args.path), work_root=_dest(args), items=items, with_config=args.with_config,
            password=_password(args), allow_key_mismatch=args.allow_key_mismatch, log=_err,
            health_seconds=args.health_timeout,
        )
    except runner.RestoreError as e:
        if args.json:
            print(json.dumps({"ok": False, "stage": e.stage, "error": e.cause, "state": e.state, "done": e.done},
                             ensure_ascii=False))
        _err(f"ERROR: {e}")
        return EXIT_FAILED
    if args.json:
        print(json.dumps({"ok": True, "items": result.items, "stages": result.stages,
                          "schema": [result.schema_from, result.schema_to], "safety_dump": result.safety_dump,
                          "config_restored": result.config_restored, "notes": result.notes}, ensure_ascii=False))
    else:
        print(f"복원했습니다: {', '.join(result.items)}")
        if result.schema_from != result.schema_to:
            print(f"스키마 {result.schema_from} → {result.schema_to}")
        if result.safety_dump:
            print(f"복원 전 DB 덤프: {result.safety_dump}")
        for note in result.notes:
            print(f"참고: {note}")
    return EXIT_OK


def add_parsers(sub) -> None:
    """app/cli.py 의 하위 명령에 backup · restore 를 더한다."""
    from app.backup.format import KIND_FULL, KINDS

    def password_opt(p) -> None:
        p.add_argument("--password-file", metavar="FILE",
                       help=f"설정 항목을 보호하는 암호가 든 파일(또는 환경변수 {ENV_PASSWORD})")

    backup = sub.add_parser("backup", help="백업 만들기·확인(형식은 docs/data-safety.md)")
    actions = backup.add_subparsers(dest="action", required=True)

    create = actions.add_parser("create", help="백업을 만든다")
    create.add_argument("--kind", choices=KINDS, default=KIND_FULL,
                        help="full = 전체(서버 이전용), pre-update = DB 와 설정만(업데이트 직전)")
    create.add_argument("--dest", metavar="DIR", help="백업을 둘 위치(기본: $BACKUP_ROOT 또는 /backups)")
    create.add_argument("--include-files", action="store_true",
                        help="파일 저장소도 넣는다(로컬 저장소일 때만 — NFS 는 넣지 않는다)")
    create.add_argument("--pack", action="store_true", help="끝나면 tar 한 개(.jwbak)로 묶는다")
    create.add_argument("--skip-space-check", action="store_true", help="여유 공간 검사를 건너뛴다")
    create.add_argument("--json", action="store_true")
    password_opt(create)

    lst = actions.add_parser("list", help="백업 목록")
    lst.add_argument("--dest", metavar="DIR")
    lst.add_argument("--json", action="store_true")

    for name, text in (("inspect", "내용 요약(풀지 않는다)"), ("verify", "파일을 manifest 의 해시와 견준다")):
        p = actions.add_parser(name, help=text)
        p.add_argument("path", help="백업 폴더 또는 .jwbak 파일")
        p.add_argument("--json", action="store_true")
        if name == "verify":
            password_opt(p)

    pack = actions.add_parser("pack", help="백업 폴더를 tar 한 개(.jwbak)로 묶는다")
    pack.add_argument("path")
    pack.add_argument("out", nargs="?")

    ext = actions.add_parser("extract-config", help="설정 묶음(.env …)만 꺼낸다")
    ext.add_argument("path")
    ext.add_argument("--out", required=True, metavar="DIR")
    password_opt(ext)

    plan = actions.add_parser("plan", help="실행할 단계 목록만 보여 준다")
    plan.add_argument("--kind", choices=KINDS, default=KIND_FULL)
    plan.add_argument("--include-files", action="store_true")
    plan.add_argument("--json", action="store_true")
    backup.set_defaults(func=_cmd_backup)

    restore = sub.add_parser("restore", help="백업에서 복원한다(backend 밖에서 — scripts/restore.sh)")
    restore.add_argument("path", help="백업 폴더 또는 .jwbak 파일")
    restore.add_argument("--items", metavar="a,b", help="이 항목만(기본: 백업에 든 것 전부, 설정 제외)")
    restore.add_argument("--with-config", action="store_true",
                         help="설정(.env — 암호화 키 포함)도 되돌린다")
    restore.add_argument("--allow-key-mismatch", action="store_true",
                         help="백업과 지금의 암호화 키가 달라도 진행한다(암호화된 값은 못 읽게 된다)")
    restore.add_argument("--dest", metavar="DIR", help="작업 폴더·복원 전 덤프를 둘 위치(기본: $BACKUP_ROOT)")
    restore.add_argument("--health-timeout", type=int, default=300, metavar="초")
    restore.add_argument("--yes", action="store_true", help="확인 질문 없이 진행")
    restore.add_argument("--json", action="store_true")
    password_opt(restore)
    restore.set_defaults(func=_cmd_restore)
