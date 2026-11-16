"""릴리스 도구 명령줄 — `python -m jwrelease <명령>` (또는 `release/tools/jwrelease.py`).

명령: images, make-manifest, sign, publish, promote, verify, refresh, bundle(plan·index·pack·verify)
어떤 명령도 git 커밋·푸시를 수행하지 않는다. 레지스트리에 접근하는 명령은 `promote --run` 과
`bundle plan --run`, `make-manifest --resolve-digests`·`--resolve-sizes`(조회만)뿐이다.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import shlex
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from . import builder, bundle, channelrepo, compose, semver, verify
from .config import Settings, load_settings
from .model import CHANNELS, FormatError, Manifest, manifest_rel_path, parse_time, utcnow
from .sign import SIG_SUFFIX, SigningError, load_private_key, public_key_pem, sig_path, sign_file

REPO_ROOT = Path(__file__).resolve().parents[2]
KEY_PASSWORD_ENV = "JWRELEASE_KEY_PASSWORD"


class CliError(Exception):
    pass


def _now(args) -> datetime:
    return parse_time(args.now) if getattr(args, "now", None) else utcnow()


def _settings(args) -> Settings:
    return load_settings(Path(args.config) if args.config else None, os.environ)


def _load_key(path: str | None):
    if not path:
        return None
    pem = Path(path).read_bytes()
    password = os.environ.get(KEY_PASSWORD_ENV)
    if b"ENCRYPTED" in pem and not password:
        password = getpass.getpass("비공개 키 암호: ")
    return load_private_key(pem, password.encode("utf-8") if password else None)


def _key_or_nosign(args):
    if args.no_sign:
        if args.key:
            raise CliError("--key 와 --no-sign 은 함께 쓸 수 없다")
        return None
    if not args.key:
        raise CliError("--key <비공개 키 PEM> 이 필요하다(다른 도구로 서명하려면 --no-sign)")
    return _load_key(args.key)


def _public_keys(paths: list[str] | None):
    return verify.load_public_keys(Path(p).read_bytes() for p in (paths or []))


def _version_arg(args) -> str:
    if args.version:
        return args.version
    path = Path(args.version_file) if args.version_file else REPO_ROOT / "VERSION"
    if not path.is_file():
        raise CliError(f"버전을 알 수 없다 — --version 을 주거나 {path} 를 둔다")
    return path.read_text(encoding="utf-8").strip()


def _changelog_text(args, version: str) -> str:
    """--changelog-file 의 내용. --changelog-section 을 지정하면 해당 버전의 절만 추출한다(값을 생략하면 이 릴리스의 버전)."""
    text = Path(args.changelog_file).read_text(encoding="utf-8").replace("\r\n", "\n")
    if args.changelog_section is None:
        return text
    return builder.changelog_section(text, args.changelog_section or version)


def _print_cmds(cmds: list[list[str]]) -> None:
    for cmd in cmds:
        print("  " + " ".join(shlex.quote(c) for c in cmd))


def _run_cmds(cmds: list[list[str]]) -> None:
    for cmd in cmds:
        print("+ " + " ".join(shlex.quote(c) for c in cmd), flush=True)
        subprocess.run(cmd, check=True)


def _after_repo_change(repo: Path, result: channelrepo.Result, settings: Settings, message: str) -> None:
    print("쓴 파일:")
    for rel in result.written:
        print(f"  {rel}")
    for note in result.notes:
        print(f"- {note}")
    if result.unsigned:
        print("\n서명이 아직 없다. 각 파일에 서명해 옆에 .sig 로 둔다:")
        for rel in result.unsigned:
            print(f"  python -m jwrelease sign --key <키> {shlex.quote(str(repo / rel))}")
            print(f"  (또는) cosign sign-blob --key <cosign 키> --tlog-upload=false --output-signature {shlex.quote(str(repo / rel) + SIG_SUFFIX)} {shlex.quote(str(repo / rel))}")
    print("\n다음에 할 일(이 도구는 커밋·푸시하지 않는다):")
    print(f"  1. 검증: python -m jwrelease verify --repo {shlex.quote(str(repo))} --pubkey <공개 키>")
    print(f"  2. 확인: git -C {shlex.quote(str(repo))} status && git -C {shlex.quote(str(repo))} diff --stat")
    print(f"  3. 커밋: git -C {shlex.quote(str(repo))} add channels releases && git -C {shlex.quote(str(repo))} commit -m {shlex.quote(message)}")
    print(f"  4. 푸시: git -C {shlex.quote(str(repo))} push   → {settings.channel_repo_url}")


# ── 명령 ─────────────────────────────────────────────────────


def cmd_images(args) -> int:
    settings = _settings(args)
    text = Path(args.compose).read_text(encoding="utf-8")
    images = compose.read_images(text, {"JW_REGISTRY": settings.registry, "JW_VERSION": args.tag})
    zone_of = compose.service_zones(json.loads(Path(args.zones).read_text(encoding="utf-8")))
    print("우리 이미지(빌드):")
    for i in compose.own_images(images):
        target = f" target={i.build.target}" if i.build.target else ""
        print(f"  {i.service:16} {i.ref.by_tag()}  ← {i.build.dockerfile_path}{target}")
    print("남의 이미지:")
    for i in compose.third_party_images(images):
        mark = "" if i.ref.pinned else "   ← 다이제스트 없음(태그만)"
        print(f"  {i.service:16} [{zone_of.get(i.service, '구역 없음')}] {i.ref}{mark}")
    loose = compose.unpinned_third_party(images)
    if loose:
        print(f"\n다이제스트 없이 태그로만 고정된 남의 이미지 {len(loose)}개 — 그대로는 manifest 를 만들 수 없다.")
    return 0


def cmd_make_manifest(args) -> int:
    settings = _settings(args)
    version = _version_arg(args)
    digests = builder.Digests.from_bytes(Path(args.digests).read_bytes())
    changelog = args.changelog or ""
    if args.changelog_file:
        changelog = _changelog_text(args, version)
    elif args.changelog_section is not None:
        raise CliError("--changelog-section 은 --changelog-file 과 함께 지정한다")
    pins = None
    if args.pins:
        pins = json.loads(Path(args.pins).read_text(encoding="utf-8"))
    resolver = None
    if args.resolve_digests:
        from .registry import resolve_digest

        def resolver(ref):
            digest = resolve_digest(ref)
            print(f"조회: {ref.by_tag()} → {digest}", file=sys.stderr)
            return digest

    apps = builder.collect_apps(Path(args.apps_dir), version, settings) if args.apps_dir else ()

    def attached(path: str | None):
        if not path:
            return None
        p = Path(path)
        return builder.file_ref(p, settings.download_url(version, p.name))

    if args.download_bytes is not None and args.resolve_sizes:
        raise CliError("--download-bytes 와 --resolve-sizes 는 함께 쓸 수 없다")
    if args.download_bytes is not None and args.download_bytes < 0:
        raise CliError("--download-bytes 는 0 이상이어야 한다")

    manifest = builder.make_manifest(
        version=version,
        digests=digests,
        compose_text=Path(args.compose).read_text(encoding="utf-8"),
        zones_raw=Path(args.zones).read_bytes(),
        settings=settings,
        published=_now(args),
        min_upgrade_from=args.min_upgrade_from,
        changelog=changelog,
        apps=apps,
        offline_bundle=attached(args.offline_bundle),
        installer_bundle=attached(args.installer_bundle),
        pins=pins,
        resolver=resolver,
        db_schema=args.db_schema,
        download_bytes=args.download_bytes,
    )
    if args.resolve_sizes:
        # 크기는 선택 값이다. 조회 실패 시 경고만 출력하고 항목을 포함하지 않는다(수신 측은 해당 줄을 숨긴다)
        from dataclasses import replace

        from .registry import image_size

        try:
            manifest = replace(manifest, download_bytes=builder.total_image_size(manifest, image_size))
        except compose.ComposeError as e:
            print(f"경고: 받을 용량을 조회하지 못해 download_bytes 를 싣지 않는다 — {e}", file=sys.stderr)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(manifest.to_bytes())
    print(f"{out}: 버전 {manifest.version}, 우리 이미지 {len(manifest.images)}개, "
          f"남의 이미지 {sum(len(m) for m in manifest.third_party.values())}개, 앱 파일 {len(manifest.apps)}개"
          + (f", 받을 용량 {manifest.download_bytes}바이트" if manifest.download_bytes is not None else ""))
    return 0


def cmd_sign(args) -> int:
    key = _load_key(args.key)
    for name in args.files:
        out = sign_file(Path(name), key)
        print(out)
    if args.print_public_key:
        sys.stdout.write(public_key_pem(key).decode("ascii"))
    return 0


def cmd_publish(args) -> int:
    settings = _settings(args)
    key = _key_or_nosign(args)
    repo = Path(args.repo)
    if not repo.is_dir():
        raise CliError(f"채널 리포 작업 디렉터리가 없다: {repo}")
    manifest_path = Path(args.manifest)
    data = manifest_path.read_bytes()
    manifest = Manifest.from_bytes(data)
    existing_sig = sig_path(manifest_path)
    result = channelrepo.publish(
        repo,
        data,
        args.channel,
        key=key,
        now=_now(args),
        expires_days=settings.expires_days,
        summary=args.summary if args.summary is not None else builder.summary_line(manifest.changelog),
        manifest_sig=existing_sig.read_bytes() if key is None and existing_sig.is_file() else None,
    )
    _after_repo_change(repo, result, settings, f"{manifest.version} ({args.channel})")
    return 0


def cmd_promote(args) -> int:
    settings = _settings(args)
    key = _key_or_nosign(args)
    repo = Path(args.repo)
    rel = manifest_rel_path(args.version)
    src = repo / rel
    if not src.is_file():
        raise CliError(f"{rel} 이 없다 — Beta 로 먼저 낸 릴리스만 승격한다")
    data = src.read_bytes()
    beta_channel = channelrepo.load_channel(repo, "beta")
    entry = beta_channel.find(args.version) if beta_channel else None
    if entry is None:
        raise CliError(f"beta 채널에 {args.version} 이 없다")
    keys = list(_public_keys(args.pubkey)) if args.pubkey else []
    if key is not None:
        keys = keys or [key.public_key()]
    if keys:
        sig_file = Path(str(src) + SIG_SUFFIX)
        if not sig_file.is_file():
            raise CliError(f"{rel}{SIG_SUFFIX} 이 없다")
        beta = verify.verify_manifest(data, sig_file.read_bytes(), keys, entry)
    else:
        print("주의: 공개 키가 없어 Beta manifest 의 서명을 확인하지 않았다(--pubkey).", file=sys.stderr)
        verify.verify_file_hash(data, entry.manifest_sha256, rel)
        beta = Manifest.from_bytes(data)

    kwargs = {}
    if args.no_min_upgrade_from:
        kwargs["min_upgrade_from"] = None
    elif args.min_upgrade_from:
        kwargs["min_upgrade_from"] = args.min_upgrade_from
    changelog = None
    if args.changelog_file:
        changelog = _changelog_text(args, semver.stable_of(args.version))
    elif args.changelog_section is not None:
        raise CliError("--changelog-section 은 --changelog-file 과 함께 지정한다")
    stable = builder.promote_manifest(beta, published=_now(args), changelog=changelog, **kwargs)
    if stable.images != beta.images or stable.third_party != beta.third_party:
        raise CliError("내부 오류: 승격에서 이미지가 달라졌다")

    result = channelrepo.publish(
        repo,
        stable.to_bytes(),
        "stable",
        key=key,
        now=_now(args),
        expires_days=settings.expires_days,
        summary=args.summary if args.summary is not None else (entry.summary or builder.summary_line(stable.changelog)),
    )
    print(f"승격: {beta.version} → {stable.version} (이미지 {len(stable.images)}개, 다이제스트 그대로)")
    if beta.offline_bundle is not None:
        print("주의: 오프라인 묶음은 싣지 않았다 — Stable manifest 로 다시 묶어 첨부한 뒤 새 버전으로 내거나 수동 배포한다.")
    cmds = builder.retag_commands(stable, stable.version)
    if args.run:
        print("\n이미지에 Stable 태그를 붙인다(다시 빌드하지 않는다):")
        _run_cmds(cmds)
    else:
        print("\n이미지에 Stable 태그 붙이기(다시 빌드하지 않는다) — 아래를 실행하거나 --run:")
        _print_cmds(cmds)
    print()
    _after_repo_change(repo, result, settings, f"{stable.version} (stable, {beta.version} 승격)")
    return 0


def _url_fetch(base: str) -> channelrepo.Fetch:
    base = base.rstrip("/")

    def fetch(rel: str) -> bytes:
        try:
            req = urllib.request.Request(f"{base}/{rel}", headers={"User-Agent": "jwrelease"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise FileNotFoundError(rel) from None
            raise

    return fetch


def cmd_verify(args) -> int:
    settings = _settings(args)
    keys = _public_keys(args.pubkey)
    if args.repo:
        fetch, where = channelrepo.dir_fetch(Path(args.repo)), args.repo
    else:
        url = args.url or settings.channel_base_url
        fetch, where = _url_fetch(url), url
    report = channelrepo.verify_all(fetch, keys, now=_now(args), channels=tuple(args.channel or CHANNELS))
    print(f"검증 대상: {where}")
    for line in report.ok:
        print(f"  통과  {line}")
    for line in report.errors:
        print(f"  실패  {line}")
    print("결과: " + ("전부 통과" if report.passed else f"실패 {len(report.errors)}건"))
    return 0 if report.passed else 1


def cmd_refresh(args) -> int:
    settings = _settings(args)
    key = _key_or_nosign(args)
    repo = Path(args.repo)
    result = channelrepo.refresh(
        repo, tuple(args.channel or CHANNELS), key=key, now=_now(args), expires_days=settings.expires_days
    )
    _after_repo_change(repo, result, settings, "채널 만료 갱신")
    return 0


def cmd_bundle_plan(args) -> int:
    manifest = Manifest.from_bytes(Path(args.manifest).read_bytes())
    if manifest.offline_bundle is not None:
        raise CliError("묶음에 넣는 manifest 는 offline_bundle 이 비어 있어야 한다")
    stage = Path(args.stage)
    cmds = bundle.save_commands(manifest, stage.as_posix(), args.include_third_party)
    if args.run:
        (stage / bundle.IMAGES_DIR).mkdir(parents=True, exist_ok=True)
        _run_cmds(cmds)
    else:
        print(f"# {stage}/ 에 manifest.json, manifest.json.sig 를 두고 {stage}/images/ 를 만든 뒤:")
        _print_cmds(cmds)
        print(f"# 그 다음: bundle index --stage {stage} --key <키>  →  bundle pack --stage {stage}")
    return 0


def cmd_bundle_index(args) -> int:
    stage = Path(args.stage)
    bundle.write_index(stage, _now(args), args.include_third_party)
    index = stage / bundle.INDEX
    print(index)
    if args.key:
        print(sign_file(index, _load_key(args.key)))
    else:
        print(f"서명 필요: python -m jwrelease sign --key <키> {index}")
    return 0


def cmd_bundle_pack(args) -> int:
    stage = Path(args.stage)
    index = json.loads((stage / bundle.INDEX).read_text(encoding="utf-8"))
    out = Path(args.output) if args.output else Path(bundle.bundle_filename(index["version"]))
    order = bundle.pack(stage, out)
    print(f"{out}: 파일 {len(order)}개")
    print("이 파일을 릴리스에 첨부하고, 그 크기·해시를 담은 manifest 를 만들 때는 make-manifest --offline-bundle 로 준다.")
    return 0


def cmd_bundle_verify(args) -> int:
    info = bundle.verify_bundle(Path(args.file), _public_keys(args.pubkey))
    print(f"통과: 버전 {info.version}, 이미지 {len(info.images)}개, 파일 {len(info.files)}개")
    return 0


# ── 인자 ─────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="jwrelease", description="릴리스를 만들고 채널에 올리는 도구")
    p.add_argument("--config", help="주소 설정 파일(JSON). 환경변수 JWRELEASE_* 가 이보다 우선")
    sub = p.add_subparsers(dest="command", required=True)

    def common_time(sp):
        sp.add_argument("--now", help=argparse.SUPPRESS)

    def signing(sp):
        sp.add_argument("--key", help=f"비공개 키 PEM(암호는 환경변수 {KEY_PASSWORD_ENV} 또는 입력)")
        sp.add_argument("--no-sign", action="store_true", help="서명하지 않고 파일만 쓴다(다른 도구로 서명)")

    sp = sub.add_parser("images", help="compose 의 이미지 목록(우리 것·남의 것·다이제스트 없는 것)")
    sp.add_argument("--compose", default=str(REPO_ROOT / "docker-compose.yml"))
    sp.add_argument("--zones", default=str(REPO_ROOT / "backend" / "app" / "zones.json"))
    sp.add_argument("--tag", default="latest")
    sp.set_defaults(func=cmd_images)

    sp = sub.add_parser("make-manifest", help="digests.json·compose·zones.json → manifest.json")
    sp.add_argument("--version", help="제품 버전(없으면 --version-file, 그것도 없으면 리포 루트 VERSION)")
    sp.add_argument("--version-file")
    sp.add_argument("--digests", required=True, help="빌드 서버가 낸 digests.json")
    sp.add_argument("--compose", default=str(REPO_ROOT / "docker-compose.yml"))
    sp.add_argument("--zones", default=str(REPO_ROOT / "backend" / "app" / "zones.json"))
    sp.add_argument("--apps-dir", help="앱 설치 파일 디렉터리(.exe, .apk)")
    sp.add_argument("--changelog-file", help="변경 내용 파일(마크다운). 기본은 파일 전체")
    sp.add_argument("--changelog-section", nargs="?", const="", metavar="버전",
                    help="--changelog-file 에서 해당 버전의 절(## <버전>)만 싣는다. 값을 생략하면 이 릴리스의 버전")
    sp.add_argument("--changelog", help="변경 내용(마크다운 문자열)")
    sp.add_argument("--min-upgrade-from", help="이 버전으로 바로 올라올 수 있는 최소 버전(없으면 제약 없음)")
    sp.add_argument("--offline-bundle", help="오프라인 묶음 파일(크기·해시를 적는다)")
    sp.add_argument("--installer-bundle", help="설치 관리자 번들 파일(크기·해시를 적는다)")
    sp.add_argument("--pins", help='태그만 있는 남의 이미지의 다이제스트 표(JSON: {"저장소:태그": "sha256:…"})')
    sp.add_argument("--resolve-digests", action="store_true", help="태그만 있는 남의 이미지를 레지스트리에서 조회해 채운다")
    sp.add_argument("--db-schema", type=int, help="이 릴리스의 DB 스키마 버전(backend 의 `python -m app.cli schema-version` 출력)")
    sp.add_argument("--download-bytes", type=int, help="받을 이미지의 압축 크기 합(바이트)을 직접 준다")
    sp.add_argument("--resolve-sizes", action="store_true",
                    help="받을 이미지의 압축 크기 합을 레지스트리에서 조회해 채운다(못 하면 경고만 하고 싣지 않는다)")
    sp.add_argument("-o", "--output", required=True)
    common_time(sp)
    sp.set_defaults(func=cmd_make_manifest)

    sp = sub.add_parser("sign", help="파일에 서명(.sig)")
    sp.add_argument("files", nargs="+")
    sp.add_argument("--key", required=True)
    sp.add_argument("--print-public-key", action="store_true")
    sp.set_defaults(func=cmd_sign)

    sp = sub.add_parser("publish", help="채널 리포 작업 디렉터리에 릴리스를 넣고 채널 파일 갱신·서명")
    sp.add_argument("--repo", required=True, help="채널 리포 작업 디렉터리")
    sp.add_argument("--manifest", required=True)
    sp.add_argument("--channel", required=True, choices=CHANNELS)
    sp.add_argument("--summary", help="요약 한 줄(없으면 변경 내용의 첫 줄)")
    signing(sp)
    common_time(sp)
    sp.set_defaults(func=cmd_publish)

    sp = sub.add_parser("promote", help="Beta 릴리스를 Stable 로(이미지는 다시 빌드하지 않는다)")
    sp.add_argument("--repo", required=True)
    sp.add_argument("--version", required=True, help="승격할 Beta 버전(X.Y.Z-beta.N)")
    sp.add_argument("--pubkey", action="append", help="Beta manifest 서명 확인용 공개 키(없으면 --key 의 짝)")
    sp.add_argument("--min-upgrade-from")
    sp.add_argument("--no-min-upgrade-from", action="store_true")
    sp.add_argument("--changelog-file", help="Stable 의 변경 내용 파일(없으면 Beta 의 변경 내용 그대로)")
    sp.add_argument("--changelog-section", nargs="?", const="", metavar="버전",
                    help="--changelog-file 에서 해당 버전의 절(## <버전>)만 싣는다. 값을 생략하면 승격 후의 Stable 버전")
    sp.add_argument("--summary")
    sp.add_argument("--run", action="store_true", help="이미지 태그 붙이기 명령을 실제로 실행")
    signing(sp)
    common_time(sp)
    sp.set_defaults(func=cmd_promote)

    sp = sub.add_parser("verify", help="채널 디렉터리 또는 주소를 공개 키로 전부 검증")
    g = sp.add_mutually_exclusive_group()
    g.add_argument("--repo", help="채널 리포 작업 디렉터리")
    g.add_argument("--url", help="채널 기준 주소(없으면 설정의 channel_base_url)")
    sp.add_argument("--pubkey", action="append", required=True, help="공개 키 PEM(현재·다음, 최대 2번)")
    sp.add_argument("--channel", action="append", choices=CHANNELS)
    common_time(sp)
    sp.set_defaults(func=cmd_verify)

    sp = sub.add_parser("refresh", help="릴리스 없이 채널 파일의 만료만 갱신(순번 +1)")
    sp.add_argument("--repo", required=True)
    sp.add_argument("--channel", action="append", choices=CHANNELS)
    signing(sp)
    common_time(sp)
    sp.set_defaults(func=cmd_refresh)

    bp = sub.add_parser("bundle", help="오프라인 묶음").add_subparsers(dest="bundle_command", required=True)
    sp = bp.add_parser("plan", help="이미지 저장 명령을 출력(--run 이면 실행)")
    sp.add_argument("--manifest", required=True)
    sp.add_argument("--stage", required=True, help="묶을 파일을 모으는 디렉터리")
    sp.add_argument("--include-third-party", action="store_true")
    sp.add_argument("--run", action="store_true")
    sp.set_defaults(func=cmd_bundle_plan)
    sp = bp.add_parser("index", help="bundle.json 을 만들고(--key 가 있으면) 서명")
    sp.add_argument("--stage", required=True)
    sp.add_argument("--include-third-party", action="store_true")
    sp.add_argument("--key")
    common_time(sp)
    sp.set_defaults(func=cmd_bundle_index)
    sp = bp.add_parser("pack", help="한 파일(tar)로 묶는다")
    sp.add_argument("--stage", required=True)
    sp.add_argument("-o", "--output")
    sp.set_defaults(func=cmd_bundle_pack)
    sp = bp.add_parser("verify", help="묶음 검증(묶음 서명 → manifest → 파일별 해시)")
    sp.add_argument("file")
    sp.add_argument("--pubkey", action="append", required=True)
    sp.set_defaults(func=cmd_bundle_verify)
    return p


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (
        CliError, builder.BuildError, compose.ComposeError, channelrepo.RepoError, bundle.BundleError,
        verify.VerifyError, SigningError, FormatError, semver.VersionError, FileNotFoundError, ValueError,
    ) as e:
        print(f"오류: {e}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as e:
        print(f"오류: 명령이 실패했다({e.returncode}): {' '.join(e.cmd)}", file=sys.stderr)
        return 2
