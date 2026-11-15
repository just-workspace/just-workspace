# 무손실 음성 시험 페이지

음성채널 무손실 클라이언트(`frontend-react/src/lib/lossless/` 의 `LosslessSession`)를 백엔드 없이 직접 모는 시험용 페이지다
(무손실 음성이 무엇인지는 [docs/voice-lossless.md](../../../docs/voice-lossless.md)).
브라우저 자동화 도구로 두 창에서 이 페이지를 띄워 시험용 릴레이에 붙이면, 보낸 프레임과 받은 프레임의 해시를 견줘 비트 단위로 같은지,
그리고 지연이 얼마인지 잴 수 있다. **이 페이지를 모는 자동화 스크립트는 리포에 들어 있지 않다** — 페이지와 그 API 만 있다.

```sh
cd frontend-react
npx vite build --config e2e/lossless/vite.config.ts   # → e2e/lossless/dist. 정적 서버로 띄운다(localhost 는 보안 컨텍스트로 취급된다)
```

페이지 API: `window.jwHarness.join(grant, opts)` · `stats()` · `dump()` · `probeCapture()` · `leave()`.
`grant` 는 백엔드 `POST /api/chat/channels/{id}/voice/relay-token` 응답과 같은 모양이다(백엔드 없이 시험할 때는 릴레이의 `RELAY_SECRET` 으로
토큰을 직접 만든다 — 형식은 [audiorelay/PROTOCOL.md](../../../audiorelay/PROTOCOL.md) 6절). 이 페이지는 워크스페이스 본체 빌드에 들어가지 않는다.
