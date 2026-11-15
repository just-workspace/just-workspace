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
EXPOSE 8090/tcp 4433/udp
USER nonroot:nonroot
ENTRYPOINT ["/audiorelay"]
