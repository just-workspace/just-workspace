# Prebuilt 이미지 (build / pull 이중 트랙)

자체 빌드 이미지(backend · frontend-react · sso · ldap · mailserver)는 **소스 빌드(개발)** 와 **prebuilt pull(패키지/VM)** 둘 다 지원한다.
compose가 `image:` + `build:` 를 동시에 가지므로 모드만 바꾸면 된다. 그 외 컨테이너(postgres·redis·nginx·gitea·livekit·…)는 공개 이미지를 digest 로 고정해 받는다.

## 변수
| 변수 | 기본 | 의미 |
|---|---|---|
| `JW_IMAGE_SOURCE` | `build` | `build`=소스 빌드 / `pull`=레지스트리 prebuilt |
| `JW_REGISTRY` | `localhost` | 레지스트리 호스트/네임스페이스 (예: `ghcr.io/your-org`) |
| `JW_VERSION` | `latest` | 이미지 태그 |

→ compose 이미지 참조: `${JW_REGISTRY}/just-workspace-backend:${JW_VERSION}`

## 모드별 동작
- `JW_IMAGE_SOURCE=build` → `docker compose up -d --build` (로컬 빌드)
- `JW_IMAGE_SOURCE=pull`  → `docker compose pull && up -d` (레지스트리에서 받음)

```bash
# 개발/소스 설치
docker compose up -d --build

# prebuilt 설치 — .env 에 JW_IMAGE_SOURCE=pull JW_REGISTRY=ghcr.io/your-org JW_VERSION=1.0.0
docker compose pull && docker compose up -d
```

## 발행 (CI)
`.github/workflows/build-images.yml` — 태그 `v*` push 또는 수동 실행 시 멀티아치(amd64/arm64) 빌드해 레지스트리에 push.

repo에 설정 필요:
- Variables: `JW_REGISTRY`(예 `ghcr.io`), `JW_IMAGE_NS`(예 오너)
- Secrets: `REGISTRY_USER`, `REGISTRY_TOKEN`

태그 한 번 = `…/just-workspace-<service>:<version>` + `:latest` 두 태그 push.

> 현재 매트릭스는 `backend`·`frontend-react` 두 개만 들어 있다. pull 모드로 전체 스택을 올리려면 `sso`·`ldap`·`mailserver` 를 매트릭스에 더해야 한다 — 그 전까지 pull 모드는 미완.

## 레지스트리 선택지
- **GHCR (`ghcr.io`)** — 공개 배포 표준, 무료 공개 패키지, CI 친화
- **자체 Gitea registry** — origin 이 Gitea 라 사내 폐쇄망에 적합
- **Docker Hub** — 무난하나 pull rate limit 주의

`JW_REGISTRY` 한 줄로 전환. 상품화는 하지 않으므로 선택 기준은 "자체 인프라에 편한가" 하나다.
