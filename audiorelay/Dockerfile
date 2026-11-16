# audiorelay — lossless audio relay (Go, static binary, distroless)
FROM golang:1.27.4-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
      -ldflags "-s -w -X just-workspace/audiorelay/internal/server.Version=${VERSION}" \
      -o /out/audiorelay ./cmd/audiorelay

# distroless static: no shell, no package manager; runs as nonroot (65532).
# The health check is the binary itself (`audiorelay -check`).
FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/audiorelay /audiorelay
# 라이선스 고지 — 이미지 배포 시 고지를 함께 포함해야 한다. 세 파일은 빌드 컨텍스트 밖(리포 루트)에 있으므로
# 명명된 컨텍스트 `licenses` 로 전달받는다: compose 의 build.additional_contexts, 직접 빌드 시에는
# `docker build --build-context licenses=<리포 루트> …`.
# 디렉터리(/licenses)를 0755 로 먼저 생성한다 — `--chmod=0644` 는 신규 생성되는 상위 디렉터리에도 적용되어
# 실행 비트가 없는 디렉터리가 되고, 비루트 사용자가 고지 파일을 읽지 못한다. 파일은 다음 줄에서 0644 로 덮어쓴다.
COPY --from=licenses --chmod=0755 LICENSE /licenses/
COPY --from=licenses --chmod=0644 LICENSE NOTICE THIRD_PARTY_LICENSES.md /licenses/

EXPOSE 8090/tcp 4433/udp
USER nonroot:nonroot
ENTRYPOINT ["/audiorelay"]
