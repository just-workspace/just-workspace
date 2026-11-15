"""설치 관리자 서버 — `python -m app.server`.

- 8443: 마법사 API(HTTPS, 자체 서명 인증서 — 첫 기동 때 만들어 상태 폴더에 둔다)
- 8444: 내부 API(평문, 호스트에 게시하지 않는다 — 워크스페이스 내부망과 루프백 전용)

기동하면 로그에 접속 주소(설치 토큰 포함)와 인증서 지문을 찍는다.
"""

from __future__ import annotations

import asyncio
import os
import sys

from app import api, api_update, certs, engine, render
from app import paths as paths_mod
from app.state import write_private

WIZARD_PORT = 8443
CERT_WATCH_SECONDS = 3600


def ensure_tls(svc: api.Services) -> tuple[str, str, str]:
    """(인증서 경로, 키 경로, 지문). 없으면 만든다(10년)."""
    cert_path = svc.store.dir / "tls" / "cert.pem"
    key_path = svc.store.dir / "tls" / "key.pem"
    if not (cert_path.exists() and key_path.exists()):
        names = ["jw-installer", "localhost", "127.0.0.1"]
        extra = os.environ.get("JW_PUBLIC_HOST", "").strip()
        if extra:
            names.insert(0, extra)
        cert, key = certs.self_signed(names, days=3650, common_name="Just Workspace installer")
        write_private(cert_path, cert, 0o644)
        write_private(key_path, key)
    return str(cert_path), str(key_path), certs.fingerprint_sha256(cert_path.read_text(encoding="utf-8"))


def banner(svc: api.Services, fingerprint: str, port: int) -> str:
    host = os.environ.get("JW_PUBLIC_HOST") or "<서버 주소>"
    lines = ["", "=" * 72, f" Just Workspace 설치 관리자 {svc.bundle.version}"]
    if svc.store.locked:
        lines.append(" 설치가 끝난 서버입니다 — 마법사는 잠겨 있습니다.")
    else:
        token = svc.tokens.ensure()
        lines += [
            f" 브라우저에서 여세요:  https://{host}:{port}/?token={token}",
            " (설치 토큰은 24시간 동안 유효합니다. 다시 받기: docker exec jw-installer jw token)",
        ]
    lines += [
        " 이 주소의 인증서는 설치 관리자가 스스로 만든 것이라 브라우저가 경고합니다.",
        " 아래 지문과 같은지 확인하고 계속하세요.",
        f" SHA-256 지문: {fingerprint}",
        "=" * 72, "",
    ]
    return "\n".join(lines)


async def cert_watch(svc: api.Services) -> None:
    while True:
        await asyncio.sleep(CERT_WATCH_SECONDS)
        try:
            await asyncio.to_thread(engine.reload_after_renewal, svc.engine)
        except Exception as e:  # noqa: BLE001
            print(f"[certwatch] {type(e).__name__}", flush=True)


async def serve(svc: api.Services, cert: str, key: str, wizard_port: int, internal_port: int) -> None:
    import uvicorn

    wizard = uvicorn.Server(uvicorn.Config(api.create_wizard_app(svc), host="0.0.0.0", port=wizard_port,
                                           ssl_certfile=cert, ssl_keyfile=key, log_level="warning",
                                           access_log=False, server_header=False))
    internal = uvicorn.Server(uvicorn.Config(api.create_internal_app(svc), host="0.0.0.0", port=internal_port,
                                             log_level="warning", access_log=False, server_header=False))
    watcher = asyncio.create_task(cert_watch(svc))
    updates = asyncio.create_task(api_update.ticker(svc))
    try:
        await asyncio.gather(wizard.serve(), internal.serve())
    finally:
        watcher.cancel()
        updates.cancel()


def main() -> int:
    paths = paths_mod.from_env()
    try:
        paths_mod.ensure_host_alias(paths)
    except paths_mod.HostAliasError as e:
        print(f"시작할 수 없습니다: {e}", file=sys.stderr, flush=True)
        return 1
    if not os.environ.get("JW_HOST_DIR"):
        print("주의: JW_HOST_DIR 가 없습니다 — 호스트의 데이터 폴더 경로를 -e JW_HOST_DIR=… 로 알려 주세요.",
              file=sys.stderr, flush=True)
    svc = api.build_services(paths)
    if not (os.environ.get("JW_INSTALLER_VERSION") or "").strip():
        # 승격(Beta → Stable)한 이미지는 다시 빌드하지 않아 이미지 안의 VERSION 이 Beta 의 글자다(app/bundle.py)
        print(f"알림: JW_INSTALLER_VERSION 이 없어 이미지에 든 버전({svc.bundle.version})을 씁니다. "
              "이미지 태그와 다르면 -e JW_INSTALLER_VERSION=<버전> 을 주고 다시 띄우세요.", flush=True)
    if not os.path.exists("/var/run/docker.sock"):
        print("주의: /var/run/docker.sock 이 붙어 있지 않습니다 — 설치를 진행할 수 없습니다.", file=sys.stderr, flush=True)
    cert, key, fingerprint = ensure_tls(svc)
    wizard_port = int(os.environ.get("JW_PORT", WIZARD_PORT))
    internal_port = int(os.environ.get("JW_INTERNAL_PORT", render.INTERNAL_API_PORT))
    svc.local_key()
    print(banner(svc, fingerprint, wizard_port), flush=True)
    if svc.engine.resume():
        print("끊겼던 적용을 이어서 진행합니다.", flush=True)
    if api_update.manager(svc).resume():
        print("진행 중이던 업데이트 작업을 이어서 진행합니다.", flush=True)
    try:
        asyncio.run(serve(svc, cert, key, wizard_port, internal_port))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
