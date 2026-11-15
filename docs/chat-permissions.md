# 채팅 역할·권한 엔진

채팅에는 역할(role), 권한 비트, 채널·카테고리별 덮어쓰기로 이뤄진 권한 엔진이 있다(디스코드와 같은 방식).
코드: `backend/app/chat/permissions.py`(비트표·계산·검사) · `backend/app/chat/roles.py`(API) · `backend/app/chat/policy.py`(정책 토글).
화면은 채팅 › 채팅 설정의 "역할" · "카테고리 · 채널 권한" · "서버 전역 정책"이다.

> **먼저 알 것 — 기본값은 `shadow` 다.** 새로 설치한 워크스페이스에서 역할과 덮어쓰기를 만들 수는 있지만, 실제로 막는 것은
> 여전히 채널 멤버십 기준의 기본 검사다(엔진은 옆에서 계산만 하고 차이를 기록한다). 역할·덮어쓰기가 실제로 접근을 막게 하려면
> `.env` 에 `CHAT_PERMISSIONS_ENGINE=enforce` 를 두고 backend 를 다시 시작한다. 그 전에 [§6 알려진 한계](#6-알려진-한계)를 읽는다.

## 1. 데이터

| 테이블 | 내용 |
|---|---|
| `chat_roles` | id · name(100) · color(**팔레트 토큰 키**, hex 금지) · icon · position(높을수록 위, @everyone = 0) · permissions(BIGINT 비트) · hoist(멤버 목록 따로 묶음) · mentionable · group_id(있으면 **관리되는 역할** — 멤버 = 그 그룹) · is_default(@everyone, 1행, 삭제 불가) |
| `chat_member_roles` | user_id ↔ role_id (unique). @everyone·관리되는 역할은 행이 없다 |
| `chat_permission_overwrites` | target_kind(`channel`/`category`) · target_id · subject_kind(`role`/`user`) · subject_id · allow · deny |
| `chat_categories` | id · name · position · created_by |
| `channels` + | `category_id`(FK SET NULL) · `position` |

`channel_members.role`(owner/admin/member)과 `users.is_admin` 은 그대로 둔다.

스키마 기준선(`backend/app/db/baseline.py` — [data-safety.md](data-safety.md))이 한 번 하는 일: @everyone 행(없을 때만, 권한 = `DEFAULT_EVERYONE`), 기본 카테고리
"채널"·"음성"·"보관" + DM 아닌 채널 배치(`system_settings.chat.categories_seeded` 표시로 한 번만),
`channels.category_id` FK(NOT VALID)·인덱스. 관리자가 바꾼 @everyone 권한은 기동 때 되돌리지 않는다.

## 2. 권한 비트(35)

일반 `VIEW_CHANNEL` `MANAGE_CHANNELS` `MANAGE_ROLES` `MANAGE_EXPRESSIONS` `MANAGE_WEBHOOKS` `VIEW_AUDIT_LOG` `ADMINISTRATOR` ·
멤버 `CREATE_INVITE` `KICK_MEMBERS` `MODERATE_MEMBERS` ·
텍스트 `SEND_MESSAGES` `SEND_IN_THREADS` `CREATE_THREADS` `READ_HISTORY` `EMBED_LINKS` `ATTACH_FILES` `ADD_REACTIONS`
`USE_EXTERNAL_EMOJI` `MENTION_EVERYONE` `MANAGE_MESSAGES` `PIN_MESSAGES` `MANAGE_THREADS` `BYPASS_SLOWMODE` `SEND_POLLS` `USE_COMMANDS` ·
음성 `CONNECT` `SPEAK` `STREAM` `USE_VAD` `PRIORITY_SPEAKER` `MUTE_MEMBERS` `DEAFEN_MEMBERS` `MOVE_MEMBERS` `USE_SOUNDBOARD` `REQUEST_TO_SPEAK`.

번호는 `permissions.py` 한 곳에서만 정한다(디스코드 번호와 무관, 재사용 금지). 아직 쓰는 기능이 없는 비트
(슬로 모드·타임아웃·웹훅·사운드보드 …)는 자리만 잡아 두었다 — 그 기능이 생길 때 검사를 붙인다.

**@everyone 기본값 = 채널 멤버가 기본으로 할 수 있는 것 전부**: 보기·쓰기·답글·스레드·기록 읽기·임베드·첨부·리액션·외부 이모지·
@everyone·고정·초대·투표·명령·음성 접속/말하기/공유/VAD/사운드보드/발언 요청.
**채널 역할 암묵 권한**: 채널 owner·admin → `MANAGE_CHANNELS` · `KICK_MEMBERS`. 채널 삭제는 owner(또는 ADMINISTRATOR)만.

**정책 토글**(채팅 설정 › 서버 전역 정책, `GET·PUT /api/chat/policy`, 둘 다 기본 꺼짐):
`admin_channel_privileges` — 전역 관리자가 채널 안에서도 전부 할 수 있다(DM·비공개 채널 포함) ·
`owner_manage_messages` — 채널 owner 에게 `MANAGE_MESSAGES`(남의 글 삭제)를 준다. 바꾸면 최대 30초 안에 모든 워커에 반영된다.

## 3. 계산 순서

```
워크스페이스 범위(역할·카테고리 관리)
  전역 관리자 → 전부
  @everyone ∪ 내 역할(OR) ; ADMINISTRATOR 면 전부

채널 범위
  DM          → 멤버면 DM_PERMISSIONS(+채널 역할 암묵), 아니면 0. 역할·덮어쓰기 무시
  1 기본       = @everyone ∪ 내 역할(직접 + 그룹 연동)        ; ADMINISTRATOR 면 전부(짧은 길)
  2 멤버십: 채널 멤버가 아니면 VIEW_CHANNEL 제거
  3 카테고리 덮어쓰기: @everyone → 역할 합(deny 전부 뺀 뒤 allow 전부 더함) → 사용자
  4 채널 덮어쓰기:     @everyone → 역할 합(deny 후 allow)               → 사용자
  5 채널 역할 암묵 권한(owner/admin) + 정책 토글
  6 의존: VIEW 없으면 0 · SEND 없으면 첨부/임베드/@everyone/투표 0 · CONNECT 없으면 음성 비트 0
```

짧은 길(short-circuit) 세 가지: **ADMINISTRATOR 비트**(역할) = 채널 안에서도 전부, **전역 관리자** = 워크스페이스 범위만
(채널 안에서는 특권 없음 — 남의 DM·비공개 채널을 못 본다. 정책 토글 `admin_channel_privileges` 를 켜면 채널 안에서도 전부),
**채널 owner** = owner 전용 동작(채널 삭제).

동작 ↔ 비트(라우터가 부르는 이름, `ACTIONS`). "기본 검사"는 `legacy`·`shadow` 모드에서 실제로 막는 규칙, "엔진"은 `enforce` 에서 막는 규칙이다:

| 동작 | 기본 검사 | 엔진 |
|---|---|---|
| channel.view / channel.participate(팔로우·저장·안읽음·임시글·스레드 읽음) | 멤버 | VIEW_CHANNEL |
| message.read · file.download | 멤버 | VIEW + READ_HISTORY |
| message.send / message.reply / file.upload | 멤버 | VIEW + SEND / SEND_IN_THREADS / SEND + ATTACH |
| message.pin · reaction.add | 멤버 | VIEW + PIN_MESSAGES / ADD_REACTIONS |
| message.edit | 본인 | 본인(아무도 남의 글은 못 고친다) |
| message.delete · preview.dismiss | 본인 | 본인 또는 VIEW + MANAGE_MESSAGES |
| channel.manage · tabs.manage | owner/admin(탭: +만든 사람) | VIEW + MANAGE_CHANNELS(탭: +만든 사람) |
| channel.delete | owner | owner 또는 ADMINISTRATOR |
| member.invite / member.kick | 멤버 / owner·admin | CREATE_INVITE / KICK_MEMBERS |
| voice.connect | 멤버 | VIEW + CONNECT |
| mention.everyone | 누구나 | MENTION_EVERYONE |

## 4. 모드

`CHAT_PERMISSIONS_ENGINE` — `.env` 에 적고 backend 를 다시 시작하면 반영된다(`.env.example` 에는 없다 — 줄을 직접 더한다).

| 모드 | 실제로 막는 것 | 엔진 |
|---|---|---|
| `legacy` | 기본 검사(채널 멤버십·채널 역할) | 돌리지 않는다. @역할 멘션도 꺼진다 |
| `shadow`(기본) | 기본 검사 | 옆에서 계산하고, 결과가 다르면 `chat_perm_shadow_mismatch` 로그 + Redis `chat:perm:shadow:YYYYMMDD` 카운터 |
| `enforce` | 엔진 | 엔진 오류 = 거부(fail-closed) + `chat_perm_engine_error` 로그 |

역할·카테고리·덮어쓰기 API 와 @역할 멘션은 `legacy` 가 아니면 모드와 무관하게 동작한다.
엔진 쿼리는 PostgreSQL 에서 SAVEPOINT 안에서 돈다 — 실패해도 요청 트랜잭션은 살아 있다.

로그(개인정보 없음): `{"event":"chat_perm_shadow_mismatch","action","legacy","engine","channel_type","is_voice","channel_role","roles","overwrites","everyone_default","user":<해시12>,"channel":<해시12>}` — id 는 `SECRET_KEY` 섞은 sha256 앞 12자, 본문 없음.

### `enforce` 로 바꾸기

1. **`shadow` 에서 본다.** 역할·덮어쓰기를 하나도 만들지 않았다면 엔진 결과는 기본 검사와 같아야 한다(불일치 0).
   관리자로 `GET /api/chat/permissions/shadow-stats?days=14` → `days.*.mismatch`·`error`, 그리고 backend 로그에서
   `chat_perm_shadow_mismatch`·`chat_perm_engine_error` 를 찾는다.
   - 역할·덮어쓰기를 만들면 불일치가 **의도대로** 생긴다(예: `MANAGE_MESSAGES` 를 가진 역할 → `message.delete:0>1`).
     카운터 필드 `<동작>:<기본 검사>><엔진>` 으로 의도한 차이인지 본다. 의도 밖이면 멈추고 원인을 찾는다.
2. **바꾸기 전 점검**: [§6](#6-알려진-한계) — 특히 멤버에게서 `VIEW_CHANNEL` 을 빼거나 비멤버에게 주는 덮어쓰기가 없어야 한다.
3. **바꾼다**: `.env` 에 `CHAT_PERMISSIONS_ENGINE=enforce` → `docker compose up -d backend`. 확인: 채널 보기·보내기·
   리액션·고정·음성 접속·채널 설정.
4. **되돌리기**: `.env` 를 `shadow`(또는 `legacy`)로 → backend 재시작. 데이터가 바뀌지 않으므로 바로 원래대로다(역할·덮어쓰기 행은 남지만
   `shadow`·`legacy` 에서는 아무것도 막지 않는다).

## 5. API (`/api/chat`)

| 메서드·경로 | 권한 |
|---|---|
| `GET /permissions/catalog` — 비트표·묶음·위험·기본값·색 토큰·모드 | 로그인 |
| `GET /channels/{id}/permissions/me` — 내 실효 권한 | 로그인 |
| `GET /permissions/effective?user_id=&channel_id=` | 본인 / 전역 관리자 / MANAGE_ROLES |
| `GET /permissions/shadow-stats?days=` | 전역 관리자 |
| `GET /roles` · `POST /roles` · `PATCH /roles/{id}` · `DELETE /roles/{id}` · `PUT /roles/order` | 목록 = 로그인, 나머지 = 전역 관리자 또는 MANAGE_ROLES(+계층) |
| `GET /roles/{id}/members` · `PUT·DELETE /roles/{id}/members/{user_id}` | 〃 (관리되는 역할은 409) |
| `GET·PUT /users/{id}/roles` | 〃 |
| `POST /roles/sync-groups` `{group_ids?}` — 그룹 → 관리되는 역할 | 〃 |
| `GET /channels/{id}/permissions` · `PUT·DELETE /channels/{id}/permissions/{role|user}/{subject_id}` `{allow, deny}` | 전역 관리자 또는 그 채널 MANAGE_ROLES. DM 불가. subject `everyone` 별칭 |
| `GET /categories/{id}/permissions` · `PUT·DELETE …/{role|user}/{subject_id}` | 전역 관리자 또는 MANAGE_ROLES |
| `GET /categories` · `POST` · `PATCH /categories/{id}` · `DELETE` | 목록 = 로그인, 나머지 = MANAGE_CHANNELS |
| `PATCH /layout` `{categories:[{id,position}], channels:[{id,category_id,position}]}` | 카테고리 = MANAGE_CHANNELS, 채널 = 그 채널 MANAGE_CHANNELS(owner/admin 암묵) |
| `GET /channels/{id}/members/by-role` — hoist 역할별 묶음 + 사람마다 roles·color | channel.view |

`allow`/`deny`·`permissions` 는 정수 또는 이름 목록. 계층: 내 최고 역할보다 낮은 역할만, 내가 가진 비트만 줄 수 있다
(전역 관리자·ADMINISTRATOR 예외). 새 역할은 @everyone 바로 위(position 1). 채널 목록(`GET /channels`)의 각 채널에 `category_id`·`position` 이 실린다.

**@역할 멘션**: `@이름`(공백은 `-`, 대소문자 무시 — 예 "On Call" → `@on-call`). 사용자 이름이 먼저. `mentionable` 이거나 보낸 사람이
MENTION_EVERYONE 을 가지면 부를 수 있다. 받는 사람 = 역할 멤버 ∩ 채널 멤버(보낸 사람 제외) → 개인 멘션처럼 배지 + 알림
("OO님이 @역할 역할을 불렀습니다", `role_name` 필드). 이름이 예약어(everyone·here·채널·전체·모두 …)인 역할은 못 만든다.

**감사 로그**(`audit_logs`, `chat.` 접두): role.create/update/delete/reorder/assign/unassign/set_user/sync_group ·
channel.permission(_delete) · category.permission(_delete) · category.create/update/delete · layout.update. 바뀐 값의 이전/이후를 남긴다.

## 6. 알려진 한계

- **채널 밖의 여러 경로는 여전히 채널 멤버십을 기준으로 본다.** 실시간 이벤트 전달, 메시지 검색, 대시보드, 파일의 채널 공유,
  회의·할 일 연동, AI 도구가 `is_channel_member` 를 쓴다. 그래서 `enforce` 에서도 덮어쓰기로 **멤버의 `VIEW_CHANNEL` 을 빼면
  채팅 화면에서는 안 보이지만 실시간 이벤트·검색 결과로는 내용이 계속 간다**(누수). 반대로 비멤버에게 `VIEW_CHANNEL` 을 줘도 실시간 이벤트는 못 받는다.
  채널을 숨기려면 덮어쓰기가 아니라 **멤버에서 빼는 것**으로 한다.
- **비용**: 검사마다 쿼리 3~4개(역할·그룹·덮어쓰기)가 더 돈다(`shadow` 에서도). 결과 캐시는 없다.
- 채널 owner 는 기본으로는 남의 글을 지울 수 없다(정책 토글 `owner_manage_messages`). 채널에서 나간 뒤에도 자기 글은 고치고 지울 수 있다.
- 전역 관리자는 기본으로는 채널 안에서 특권이 없다(정책 토글 `admin_channel_privileges`).
- 그룹이 지워지면 그 그룹에 연동된 역할은 멤버 0 인 역할로 남는다.
- 역할·배치가 바뀌었다는 실시간 이벤트는 없다 — 다른 사람 화면에는 목록을 다시 불러올 때 반영된다.
