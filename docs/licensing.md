# Licensing Guide

## Just-Workspace 라이선스

Just-Workspace 코어(이 저장소의 소스)는 **MIT License**로 배포된다.

- 자유롭게 사용·복사·수정·병합·배포·서브라이선스·판매 가능
- 유일한 의무: 저작권 고지와 라이선스 전문을 사본에 포함
- 무보증(AS IS)

상품화(에디션 분리·라이선스 키)는 2026-08-31 폐기했다 — 전체 기능이 하나의 MIT 리포다.

## 코어 이미지에 들어가는 비-permissive 라이브러리

소스는 MIT 지만 **backend 컨테이너 이미지**에는 아래가 함께 설치된다. 자체 운영에는 제약이 없다. 수정한 이미지를 남에게 배포할 때만 조건이 붙는다.

| 라이브러리 | 라이선스 | 비고 |
|---|---|---|
| `aioimaplib` (IMAP 클라이언트) | **GPL-3.0-only** | 가장 강한 조건. 수정 배포 시 소스 제공 |
| `ldap3` (외부 LDAP/AD 로그인) · `psycopg` (ws-ldap) | LGPL-3.0 | 라이브러리로 쓰는 한 추가 의무 없음 |
| `pywebpush` · `py-vapid` (웹 푸시) | MPL-2.0 | 파일 단위 — 수정하지 않으면 추가 의무 없음 |
| `@livekit/krisp-noise-filter` (프런트, 회의 노이즈 제거) | LiveKit 이용약관 | 오픈소스가 아니다. LiveKit 약관 안에서만 사용 |

## 선택적(외부) 컨테이너 라이선스

일부 기능은 **별도 컨테이너 이미지**로 실행된다. 네트워크/WOPI/LDAP 으로 호출할 뿐 코어에 링크되지 않으므로 코어의 MIT 에는 영향이 없다.
단 **해당 컴포넌트를 활성화·배포할지는 운영자의 선택과 책임**이다.

> **문서·시트·프레젠테이션 편집은 ONLYOFFICE(AGPL, 선택 프로파일 `onlyoffice`)** 가 맡는다(2026-10-15 자체 편집기 폐기, Collabora 는 그 전에 제거).
> 끄면 오피스 파일은 업로드·내려받기·검색만 되고 편집은 안 된다 — AGPL 컴포넌트 없이 운영하려면 이 기능을 포기해야 한다.

| 컨테이너 | 라이선스 | 비고 |
|-----------|---------|------|
| ONLYOFFICE Docs CE | **AGPL-3.0** | 오피스 편집(선택, 기본 off) |
| SearXNG | **AGPL-3.0** | AI 웹 검색(선택 `aitools`, 기본 off) |
| Redis 8 | RSALv2 / SSPLv1 / AGPL-3.0 삼중 | 코어. 자체 운영은 무방 |
| PostgreSQL · Nginx · Gitea · LiveKit/Egress · certbot · docker-mailserver(Postfix·Dovecot·Rspamd) | PostgreSQL License · BSD-2 · MIT · Apache-2.0 · Apache-2.0 · MIT(+IBM PL·LGPL·Apache) | Permissive |

> AGPL/GPL 컨테이너(ONLYOFFICE, SearXNG)를 켜지 않으면 선택 프로파일은 permissive 로만 구성된다. 코어 backend 의 GPL 라이브러리(aioimaplib)는 그래도 남는다.

## 전체 의존성

버전·패키지 단위 목록은 [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md).
