# 무손실 음성 시험 페이지

음성채널 무손실 클라이언트(`frontend-react/src/lib/lossless/` 의 `LosslessSession`)를 백엔드 없이 직접 구동하는 시험용 페이지이다
(무손실 음성의 개요는 [docs/voice-lossless.md](../../../docs/voice-lossless.md) 참조).
브라우저 자동화 도구로 두 개의 창에서 이 페이지를 열어 시험용 릴레이에 접속시키면, 송신 프레임과 수신 프레임의 해시를 비교해 비트 단위 일치 여부와
지연 시간을 측정할 수 있다. **이 페이지를 구동하는 자동화 스크립트는 리포에 포함되어 있지 않다** — 페이지와 그 API 만 제공한다.

```sh
cd frontend-react
npx vite build --config e2e/lossless/vite.config.ts   # → e2e/lossless/dist. 정적 서버로 띄운다(localhost 는 보안 컨텍스트로 취급된다)
```

페이지 API: `window.jwHarness.join(grant, opts)` · `stats()` · `dump()` · `probeCapture()` · `leave()`.
`grant` 의 형식은 백엔드 `POST /api/chat/channels/{id}/voice/relay-token` 응답과 동일하다(백엔드 없이 시험하는 경우 릴레이의 `RELAY_SECRET` 으로
토큰을 직접 생성한다 — 형식은 [audiorelay/PROTOCOL.md](../../../audiorelay/PROTOCOL.md) 6절). 이 페이지는 워크스페이스 본체 빌드에 포함되지 않는다.
