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
# 라이선스 고지 — 이미지를 배포하면 고지도 함께 가야 한다. 두 파일은 빌드 문맥 밖(리포 루트)에 있어
# 이름 붙인 문맥 `licenses` 로 받는다: compose 의 build.additional_contexts, 직접 빌드할 때는
# `docker build --build-context licenses=<리포 루트> …`.
COPY --from=licenses --chmod=0644 LICENSE THIRD_PARTY_LICENSES.md /licenses/

EXPOSE 8090/tcp 4433/udp
USER nonroot:nonroot
ENTRYPOINT ["/audiorelay"]
