"""코드 저장소(Gitea) 구역.

install
  1. 버전 — 렌더링 단계에서 `.env` 의 `GITEA_IMAGE` 에 이미 기록되어 있다(verified = compose 의 고정 이미지, latest·지정 = 태그).
  2. 컨테이너를 기동하고 응답할 때까지 대기한다.
  3. 초기 설정 — `app.ini` 의 DB 를 워크스페이스의 PostgreSQL(`gitea` 데이터베이스)로 설정하고 재기동한다.
  4. 관리 계정(`jw-admin`)을 생성한다. 사람이 로그인하는 계정이 아니라 backend 가 사용하는 계정이다.

connect
  5. 관리 토큰을 발급하여 backend 설정(`GITEA_TOKEN`)에 기록한다 — backend 는 이 토큰 + Sudo 헤더로 사용자 권한을 대행한다.
  6. 워크스페이스 OAuth 에 클라이언트 `gitea` 를 등록한다(`OAUTH_CLIENTS_JSON`).
  7. Gitea 에 로그인 원본 `workspace`(OpenID Connect)를 등록한다.
  8. 프런트 경로(`/git/`)로 도달 가능한지 확인한다.
  `.env` 가 변경되었으므로 엔진이 backend 를 1회 재기동한다.

remove
  로그인 원본을 삭제하고, backend 설정에서 토큰·클라이언트를 제거하고, 컨테이너를 중지한다. 데이터 볼륨(`ws-gitea-data`)은 보존된다.

비밀값이 명령 인자에 노출되지 않도록 `--env-file` 과 표준 입력을 사용한다. 예외는 Gitea 의 `auth add-oauth --secret`
하나이다(Gitea CLI 가 다른 방법을 제공하지 않는다) — Gitea 컨테이너 내 프로세스 목록에 일시적으로 노출된다.
"""

from __future__ import annotations

import json
import secrets

from app import render
from app.engine import StepError
from app.state import write_private
from app.zones import clear_pending, default_install, default_remove, mark_pending

CONTAINER = "ws-gitea"
ADMIN_USER = "jw-admin"
AUTH_NAME = "workspace"
CLIENT_ID = "gitea"
APP_INI = "/data/gitea/conf/app.ini"
INTERNAL_URL = "http://gitea:3000"


def _gitea(ctx, *args: str, env_file: str | None = None, timeout: float = 120.0):
    return ctx.docker.exec(CONTAINER, ["gitea", "--config", APP_INI, *args], user="git", env_file=env_file,
                           timeout=timeout)


def _wait_http(ctx, timeout: float = 180.0) -> None:
    waited = 0.0
    while True:
        status, _ = ctx.http.get(f"{INTERNAL_URL}/api/healthz")
        if status == 200:
            return
        if waited >= timeout:
            raise StepError("git_not_responding", "see_container_log", container=CONTAINER)
        ctx.sleep(3)
        waited += 3


def token_valid(ctx, token: str) -> bool:
    if not token:
        return False
    status, _ = ctx.http.get(f"{INTERNAL_URL}/api/v1/user", headers={"Authorization": f"token {token}"})
    return status == 200


def install(ctx, zone_id: str) -> None:
    default_install(ctx, zone_id)
    _wait_http(ctx)

    # 초기 설정 — 이미지에 포함된 environment-to-ini 로 app.ini 를 수정한다(값은 env 파일로 전달한다).
    s = ctx.secrets()
    tmp = ctx.paths.state / "tmp" / f"gitea-{secrets.token_hex(4)}.env"
    write_private(tmp, "".join(f"{k}={v}\n" for k, v in {
        "GITEA__database__DB_TYPE": "postgres",
        "GITEA__database__HOST": "postgres:5432",
        "GITEA__database__NAME": "gitea",
        "GITEA__database__USER": "workspace",
        "GITEA__database__PASSWD": s.get("DB_PASSWORD", ""),
        "GITEA__server__OFFLINE_MODE": "true",
    }.items()))
    try:
        r = ctx.docker.exec(CONTAINER, ["environment-to-ini", "--config", APP_INI], user="git", env_file=str(tmp))
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    if not r.ok:
        ctx.log(r.text[-300:])
        raise StepError("git_config_failed", "see_log")
    ctx.docker.run(["restart", CONTAINER], timeout=120)
    ctx.wait_ready(CONTAINER)
    _wait_http(ctx)
    ctx.log("git: 초기 설정 완료(데이터베이스 연결)")

    r = _gitea(ctx, "admin", "user", "create", "--admin", "--username", ADMIN_USER,
               "--email", f"{ADMIN_USER}@{ctx.plan.env_domain}", "--random-password", "--must-change-password=false")
    if not r.ok and "already exists" not in r.text:
        ctx.log(r.err[-300:])
        raise StepError("git_admin_failed", "see_log")
    ctx.log("git: 관리 계정 준비 완료")


def connect(ctx, zone_id: str) -> None:
    s = ctx.secrets()

    # 관리 토큰 — 기존 토큰이 유효하면 재생성하지 않는다
    token = s.get("GITEA_TOKEN", "")
    if not token_valid(ctx, token):
        r = _gitea(ctx, "admin", "user", "generate-access-token", "--username", ADMIN_USER,
                   "--token-name", f"jw-backend-{secrets.token_hex(4)}", "--scopes", "all", "--raw")
        token = r.out.strip().splitlines()[-1].strip() if r.ok and r.out.strip() else ""
        if not token or not token.isalnum():
            raise StepError("git_token_failed", "see_log")
        ctx.redact(token)
        ctx.set_env(GITEA_TOKEN=token)
        ctx.log("git: 관리 토큰을 발급했습니다")

    # 워크스페이스 OAuth 클라이언트
    external = f"{ctx.plan.app_url}/git/"
    try:
        clients = json.loads(s.get("OAUTH_CLIENTS_JSON") or "{}")
    except ValueError:
        clients = {}
    entry = clients.get(CLIENT_ID) if isinstance(clients, dict) else None
    client_secret = (entry or {}).get("secret") or secrets.token_hex(24)
    wanted = {
        "secret": client_secret,
        "client_name": "코드 저장소",
        "trusted": True,
        "redirect_uris": [f"{external}user/oauth2/{AUTH_NAME}/callback"],
        "scopes": ["openid", "email", "profile"],
    }
    if entry != wanted:
        ctx.set_env(OAUTH_CLIENTS_JSON=render.oauth_clients(s.get("OAUTH_CLIENTS_JSON", ""), CLIENT_ID, wanted))

    # Gitea 의 로그인 원본 — 워크스페이스 주소로 접속하여 설정 문서를 조회하므로 신뢰되는 인증서가 필요하다.
    # 이미 있으면 현재 값으로 갱신한다(서버 이전으로 접속 주소가 변경된 경우 기존 주소를 가리키고 있다).
    discovery = f"{ctx.plan.app_url}/oauth/.well-known/openid-configuration"
    source = ["--name", AUTH_NAME, "--provider", "openidConnect", "--key", CLIENT_ID, "--secret", client_secret,
              "--auto-discover-url", discovery, "--scopes", "openid email profile"]
    listed = _gitea(ctx, "admin", "auth", "list")
    existing = next((p[0] for p in (line.split() for line in listed.out.splitlines()[1:])
                     if len(p) > 1 and p[1] == AUTH_NAME and p[0].isdigit()), None)
    if existing is not None:
        r = _gitea(ctx, "admin", "auth", "update-oauth", "--id", existing, *source)
    else:
        r = _gitea(ctx, "admin", "auth", "add-oauth", *source)
    if r.ok:
        clear_pending(ctx.store, zone_id)
        ctx.log("git: 워크스페이스 로그인 연동을 " + ("확인했습니다" if existing is not None else "걸었습니다"))
    else:
        # 임시 인증서이거나 접속 주소가 아직 본 서버를 가리키지 않으면 여기서 실패한다 — 설치는 계속한다.
        # 보류로 기록하고, 인증서 교체 후(또는 "다시 연결"로) 재시도한다.
        ctx.log(r.err[-300:])
        mark_pending(ctx, zone_id, "discovery_unreachable")
        ctx.warn("git_sso_pending", reason="discovery_unreachable")

    # 프런트 경로
    scheme = "https" if ctx.plan.tls else "http"
    status, _ = ctx.http.get(f"{scheme}://nginx/git/api/healthz", headers={"Host": ctx.plan.domain})
    if status != 200:
        ctx.warn("git_front_path_unverified", status=status)
    else:
        ctx.log("git: 앞단 경로(/git/) 확인")


def remove(ctx, zone_id: str) -> None:
    if ctx.docker.container_status(CONTAINER)["running"]:
        listed = _gitea(ctx, "admin", "auth", "list")
        for line in listed.out.splitlines()[1:]:
            parts = line.split()
            if len(parts) > 1 and parts[1] == AUTH_NAME and parts[0].isdigit():
                _gitea(ctx, "admin", "auth", "delete", "--id", parts[0])
                ctx.log("git: 로그인 연동을 지웠습니다")
    clear_pending(ctx.store, zone_id)
    s = ctx.secrets()
    ctx.set_env(GITEA_TOKEN="", OAUTH_CLIENTS_JSON=render.oauth_clients(s.get("OAUTH_CLIENTS_JSON", ""), CLIENT_ID, None))
    default_remove(ctx, zone_id)
