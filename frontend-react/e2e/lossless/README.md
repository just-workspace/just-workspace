# lossless e2e 하네스

`LosslessSession` 을 백엔드 없이 직접 모는 페이지. Playwright 러너(리포에 없음)가 헤드리스 크롬 두 컨텍스트에서
띄워 임시 릴레이에 붙이고 송신 프레임 해시 ↔ 수신 프레임 해시로 비트퍼펙트를, 같은 머신 wall clock 으로 지연을 잰다.

```sh
npx vite build --config e2e/lossless/vite.config.ts   # → e2e/lossless/dist (정적 서버로 서빙, localhost = secure context)
```

페이지 API: `window.jwHarness.join(grant, opts)` · `stats()` · `dump()` · `probeCapture()` · `leave()`.
grant 는 `/voice/relay-token` 응답 모양(토큰은 러너가 같은 HMAC 으로 만든다). 운영 빌드에는 들어가지 않는다.
