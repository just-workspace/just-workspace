# rbi/mirror 의존성·라이선스 (P0 2026-10-22 확인, P1 2026-10-22 갱신)

모두 GPL 계열 아님. LGPL 은 libvips 하나 — sharp 가 **별도 공유 라이브러리 패키지**(`@img/sharp-libvips-linux-x64`)로 동적 링크하므로
교체 가능성이 유지돼 LGPL-3.0 의무(소스 제공 링크·고지)만 지키면 된다. 이미지를 바깥에 배포하지 않으면(사내 세션 이미지) 고지로 충분.

| 패키지 | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| playwright-core | 1.65.1 | Apache-2.0 | Chromium 소유(--remote-debugging-pipe)·CDP 세션 |
| sharp | 0.35.5 | Apache-2.0 | 이미지 디코드→WebP 재인코딩(메타데이터 제거) |
| @img/sharp-linux-x64 | 0.35.5 | Apache-2.0 | sharp 네이티브 바인딩 |
| @img/sharp-libvips-linux-x64 | 1.3.4 | LGPL-3.0-or-later | libvips(+libwebp BSD-3·libjpeg-turbo BSD·libpng·librsvg LGPL 등 묶음) |
| @img/colour · detect-libc · semver · @emnapi/runtime · tslib | — | MIT · Apache-2.0 · ISC · MIT · 0BSD | sharp 보조 |
| ws | 8.23.0 | MIT | WebSocket 서버 |
| (dev) typescript 7.0.2 · esbuild 0.28.2 · tsx 4.23.15 · @types/* | — | Apache-2.0 · MIT · MIT · MIT | 빌드 |

세션 이미지(Dockerfile, 버전은 전부 ARG 로 고정):

| 구성요소 | 버전 | 라이선스 | 비고 |
|---|---|---|---|
| node:22.23.5-bookworm-slim(다이제스트 고정) | 22.23.5 | MIT · Debian 12 패키지 각자 | 베이스 |
| chromium · chromium-common | 156.0.8078.79-1~deb12u1 | BSD-3-Clause 외 Chromium 고지 | 헤드리스, 관리 정책 |
| fonts-liberation2 | 2.1.5-1 | OFL-1.1 | 원격 렌더 + 고정 묶음(WOFF2 변환·unicode-range 서브셋) |
| fonts-dejavu-core | 2.37-6 | Bitstream Vera / Arev 계열 자유 라이선스 | 〃 |
| fonts-noto-cjk | 1:20220127+repack1-1 | OFL-1.1 | 〃(KS X 1001 상용·희귀·한자 조각) |
| iproute2 | 6.1.0-3 | GPL-2.0 | 별도 실행 파일(`ss`) |
| ca-certificates | 20250419~deb12u2 | MPL-2.0 · GPL-2.0+ | |
| (fonts 빌드 단계만) python3-fonttools 4.38.0 · python3-brotli 1.0.9 | — | MIT · MIT | 최종 이미지에 없음 |

KasmVNC(GPL-2.0)는 이 이미지에 없다. OFL 폰트는 변환(WOFF2)·서브셋 배포가 허용되고 Liberation·Noto 에 예약 글꼴 이름이 없어 원래 이름의 파일을 그대로 쓴다
(뷰에서는 `jw-<키>` 패밀리 이름으로 부를 뿐 글꼴 자체 이름은 바꾸지 않았다).

시험 페이지 전용(`devpages/vendor/`, dev 타깃에만 들어감 — prod 이미지에 없음): jsPlumb 2.15.6(MIT/GPL-2.0 이중 — MIT 로 사용), Bootstrap 3.4.1(MIT),
Font Awesome 4.7(폰트 OFL-1.1 · CSS MIT). 자세한 출처는 `devpages/vendor/README.md`.

인코더 메모: WebP 인코딩은 libvips 안의 **libwebp(BSD-3-Clause)**. SVG 래스터는 librsvg(LGPL-2.1+) — 버퍼 입력이라 외부 파일·URL 참조를 따라가지 않는다.
