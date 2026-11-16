# devpages/vendor — 시험용 제3자 파일(개발 이미지 `dev` 대상에만 포함, 운영 이미지 `prod` 에는 미포함)

격리 브라우저 미러 모드([docs/rbi.md](../../../../docs/rbi.md) 6절)의 시험 페이지(`rbi/mirror/devpages/`)에서 사용할 목적으로 포함한 라이브러리이다.
구형 웹 관리 화면에서 널리 사용되는 라이브러리(jsPlumb·Bootstrap 3·Font Awesome 4)로서, 해당 화면의 DOM 구조·아이콘 폰트·jsPlumb SVG 를 재현해 미러의 렌더링 정확성을 검증하는 용도이다.
수정하지 않은 배포본 원본이다. 현재 `devpages/` 의 시험 페이지 중 이 파일을 로드하는 페이지는 없다.

| 파일 | 출처 | 버전 | 라이선스 |
|---|---|---|---|
| js/jsplumb.min.js | npm jsplumb | 2.15.6 | MIT 또는 GPL-2.0(이중) — MIT 로 사용 |
| css/bootstrap.min.css · fonts/glyphicons-halflings-regular.woff2 | npm bootstrap | 3.4.1 | MIT |
| css/font-awesome.min.css · fonts/fontawesome-webfont.woff2 | npm font-awesome | 4.7.0 | CSS MIT · 폰트 OFL-1.1 |
