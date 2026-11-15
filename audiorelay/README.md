# audiorelay — 무손실 음성채널 릴레이

Go 로 쓴 SFU 식 순수 포워더. 디코딩·트랜스코딩 없음. 프로토콜은 [PROTOCOL.md](PROTOCOL.md), 브라우저 클라이언트는
`frontend-react/src/lib/lossless/`, 토큰 발급은 백엔드 `POST /api/chat/channels/{id}/voice/relay-token`.

```
cmd/audiorelay        진입점·env·헬스체크(-check)
internal/proto        24 B 헤더 인코딩/디코딩, NACK, 스트림 프레이밍
internal/token        HMAC 토큰 검증(백엔드 app/chat/relay_token.py 와 벡터 공유)
internal/room         Hub/Room/Peer, 팬아웃, 재전송 캐시, 통계, 1 s 틱(핑·통계 푸시)
internal/wsrelay      WebSocket 전송(coder/websocket)
internal/wtrelay      WebTransport 전송(quic-go/webtransport-go)
internal/server       HTTP(health/info/stats/ws), 인증서(파일 또는 자가서명)
```

## 실행

```sh
RELAY_SECRET=$(openssl rand -hex 24) RELAY_WT_PUBLIC_URL=https://192.168.10.20:4433/audiorelay/wt \
RELAY_WT_SELF_SIGNED_HOSTS=192.168.10.20 go run ./cmd/audiorelay
```

env 는 `cmd/audiorelay/main.go` 머리 주석에. compose 에서는 `ws-audiorelay` 서비스(`profiles: audiorelay`)로 뜬다.

## 테스트

```sh
go vet ./... && go test ./...
```

`internal/server` 는 WebSocket 왕복(httptest), `internal/wtrelay` 는 실제 QUIC 루프백(자가서명)으로 데이터그램 중계·NACK 재전송을 검증한다.

## 이미지

`Dockerfile`: `golang:1.27.4-alpine` 빌드 → `gcr.io/distroless/static-debian13:nonroot`(쉘 없음, 65532). 헬스체크는 바이너리의 `-check`.
