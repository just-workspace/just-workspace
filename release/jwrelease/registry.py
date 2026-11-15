"""태그 → 다이제스트 조회(레지스트리 HTTP API v2). `make-manifest --resolve-digests` 일 때만 쓴다.

네트워크를 쓰는 유일한 모듈이다. 공개 이미지를 익명으로 조회한다(토큰 인증 방식의 레지스트리).
조회한 값은 그 시점에 태그가 가리키던 것이다 — manifest 에 적힌 뒤에는 다이제스트로만 받는다.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request

from .compose import DIGEST, ComposeError, ImageRef

ACCEPT = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)
DEFAULT_REGISTRY = "registry-1.docker.io"


def split_repository(repository: str) -> tuple[str, str]:
    """`저장소` → (레지스트리 호스트, 경로). 호스트가 없으면 Docker Hub."""
    first, _, rest = repository.partition("/")
    if rest and ("." in first or ":" in first or first == "localhost"):
        host, path = first, rest
    else:
        host, path = DEFAULT_REGISTRY, repository
    if host in ("docker.io", "index.docker.io"):
        host = DEFAULT_REGISTRY
    if host == DEFAULT_REGISTRY and "/" not in path:
        path = "library/" + path
    return host, path


def _head(url: str, token: str | None, timeout: float):
    req = urllib.request.Request(url, method="HEAD", headers={"Accept": ACCEPT, "User-Agent": "jwrelease"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    return urllib.request.urlopen(req, timeout=timeout)


def _token(challenge: str, timeout: float) -> str:
    params = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
    realm = params.pop("realm", None)
    if not challenge.lower().startswith("bearer") or not realm:
        raise ComposeError(f"레지스트리 인증 방식을 모른다: {challenge!r}")
    url = realm + "?" + urllib.parse.urlencode({k: v for k, v in params.items() if k in ("service", "scope")})
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "jwrelease"}), timeout=timeout) as r:
        body = json.loads(r.read().decode("utf-8"))
    token = body.get("token") or body.get("access_token")
    if not token:
        raise ComposeError("레지스트리 토큰을 받지 못했다")
    return token


def resolve_digest(ref: ImageRef, timeout: float = 20.0) -> str:
    """`저장소:태그` 가 지금 가리키는 다이제스트(`sha256:…`, 여러 아키텍처면 색인의 것)."""
    host, path = split_repository(ref.repository)
    url = f"https://{host}/v2/{path}/manifests/{ref.tag or 'latest'}"
    try:
        try:
            resp = _head(url, None, timeout)
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
            resp = _head(url, _token(e.headers.get("WWW-Authenticate", ""), timeout), timeout)
        with resp:
            digest = resp.headers.get("Docker-Content-Digest", "")
    except (urllib.error.URLError, OSError) as e:
        raise ComposeError(f"{ref.by_tag()}: 다이제스트를 조회하지 못했다({e})") from None
    if not DIGEST.fullmatch(digest):
        raise ComposeError(f"{ref.by_tag()}: 레지스트리가 다이제스트를 주지 않았다")
    return digest
