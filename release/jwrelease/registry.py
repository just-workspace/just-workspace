"""태그 → 다이제스트, 이미지 크기 조회(레지스트리 HTTP API v2). `make-manifest --resolve-digests`·`--resolve-sizes` 지정 시에만 사용한다.

네트워크를 사용하는 유일한 모듈이다. 공개 이미지를 익명으로 조회한다(토큰 인증 방식의 레지스트리).
조회한 값은 해당 시점에 태그가 참조하던 값이다 — manifest 에 기록된 이후에는 다이제스트로만 pull 한다.

이 서버 자체의 레지스트리(호스트가 `localhost`·`127.x.x.x`·`[::1]`)에는 docker 와 동일하게 평문 http 로 접속한다. 그 외는 https.
"""

from __future__ import annotations

import ipaddress
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from typing import Callable

from .compose import DIGEST, ComposeError, ImageRef

ACCEPT = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)
INDEX_TYPES = ("application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json")
DEFAULT_REGISTRY = "registry-1.docker.io"
PLATFORM = ("linux", "amd64")

# (메서드, 주소) → (응답 헤더 — 이름은 소문자, 본문). 테스트는 이를 교체하여 네트워크 없이 실행한다.
Fetch = Callable[[str, str], tuple[dict, bytes]]


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


def is_loopback_host(host: str) -> bool:
    """`호스트[:포트]` 가 이 서버 자체를 가리키는지 여부(`localhost`, `127.0.0.0/8`, `[::1]`)."""
    name = host
    if name.startswith("["):
        name = name[1:].split("]", 1)[0]
    elif name.count(":") == 1:
        name = name.split(":", 1)[0]
    if name == "localhost":
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return False


def base_url(host: str) -> str:
    return ("http://" if is_loopback_host(host) else "https://") + host


def _open(method: str, url: str, token: str | None, timeout: float):
    req = urllib.request.Request(url, method=method, headers={"Accept": ACCEPT, "User-Agent": "jwrelease"})
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


def http_fetch(timeout: float = 20.0) -> Fetch:
    """실제 조회 — 익명으로 요청하고, 401 이면 안내된 위치에서 토큰을 발급받아 1회 재요청한다."""

    def fetch(method: str, url: str) -> tuple[dict, bytes]:
        try:
            resp = _open(method, url, None, timeout)
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
            resp = _open(method, url, _token(e.headers.get("WWW-Authenticate", ""), timeout), timeout)
        with resp:
            return {k.lower(): v for k, v in resp.headers.items()}, resp.read()

    return fetch


def resolve_digest(ref: ImageRef, timeout: float = 20.0, fetch: Fetch | None = None) -> str:
    """`저장소:태그` 가 현재 참조하는 다이제스트(`sha256:…`, 다중 아키텍처면 색인의 값)."""
    host, path = split_repository(ref.repository)
    url = f"{base_url(host)}/v2/{path}/manifests/{ref.tag or 'latest'}"
    try:
        headers, _ = (fetch or http_fetch(timeout))("HEAD", url)
    except (urllib.error.URLError, OSError) as e:
        raise ComposeError(f"{ref.by_tag()}: 다이제스트를 조회하지 못했다({e})") from None
    digest = headers.get("docker-content-digest", "")
    if not DIGEST.fullmatch(digest):
        raise ComposeError(f"{ref.by_tag()}: 레지스트리가 다이제스트를 주지 않았다")
    return digest


def image_size(repository: str, digest: str, timeout: float = 20.0, fetch: Fetch | None = None) -> int:
    """`저장소@다이제스트` 를 pull 할 때의 압축 크기(바이트) — linux/amd64 의 config + 계층 크기의 합.

    다이제스트가 다중 아키텍처 색인을 참조하면 linux/amd64 항목을 따른다.
    조회 실패 또는 해당 플랫폼 부재 시 ComposeError.
    """
    host, path = split_repository(repository)
    fetch = fetch or http_fetch(timeout)
    label = f"{repository}@{digest}"

    def get(reference: str) -> dict:
        try:
            _, body = fetch("GET", f"{base_url(host)}/v2/{path}/manifests/{reference}")
            doc = json.loads(body.decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise ComposeError(f"{label}: 크기를 조회하지 못했다({e})") from None
        if not isinstance(doc, dict):
            raise ComposeError(f"{label}: 레지스트리의 답이 manifest 가 아니다")
        return doc

    doc = get(digest)
    if doc.get("mediaType") in INDEX_TYPES or "manifests" in doc:
        chosen = None
        for item in doc.get("manifests") or []:
            platform = (item.get("platform") or {}) if isinstance(item, dict) else {}
            if (platform.get("os"), platform.get("architecture")) == PLATFORM:
                chosen = item.get("digest")
                break
        if not isinstance(chosen, str) or not DIGEST.fullmatch(chosen):
            raise ComposeError(f"{label}: {'/'.join(PLATFORM)} 이미지가 없다")
        doc = get(chosen)
    layers = doc.get("layers")
    parts = [doc.get("config"), *layers] if isinstance(layers, list) and layers else []
    sizes = [p.get("size") if isinstance(p, dict) else None for p in parts]
    if not sizes or any(isinstance(n, bool) or not isinstance(n, int) or n < 0 for n in sizes):
        raise ComposeError(f"{label}: manifest 에 크기가 없다")
    return sum(sizes)
