# 채팅 역할·권한 엔진

채팅은 역할(role), 권한 비트, 채널·카테고리별 덮어쓰기(overwrite)로 구성된 권한 엔진을 제공한다(디스코드와 동일한 방식).
코드: `backend/app/chat/permissions.py`(비트표·계산·검사) · `backend/app/chat/roles.py`(API) · `backend/app/chat/policy.py`(정책 토글).
해당 화면은 채팅 › 채팅 설정의 "역할" · "카테고리 · 채널 권한" · "서버 전역 정책"이다.

> **유의 사항 — 기본값은 `shadow` 다.** 신규 설치한 워크스페이스에서 역할과 덮어쓰기를 생성할 수는 있으나, 접근 통제는
> 여전히 채널 멤버십 기준의 기본 검사가 수행한다(엔진은 병행 계산만 수행하고 차이를 기록한다). 역할·덮어쓰기를 실제 접근 통제에 적용하려면
> `.env` 에 `CHAT_PERMISSIONS_ENGINE=enforce` 를 설정하고 backend 를 재시작한다. 적용 전에 [§6 알려진 제한 사항](#6-알려진-제한-사항)을 확인하여야 한다.

## 1. 데이터

| 테이블 | 내용 |
|---|---|
| `chat_roles` | id · name(100) · color(**팔레트 토큰 키**, hex 금지) · icon · position(높을수록 위, @everyone = 0) · permissions(BIGINT 비트) · hoist(멤버 목록에서 별도 그룹으로 표시) · mentionable · group_id(지정 시 **관리되는 역할** — 멤버 = 해당 그룹) · is_default(@everyone, 1행, 삭제 불가) |
| `chat_member_roles` | user_id ↔ role_id (unique). @everyone·관리되는 역할에는 행이 없다 |
| `chat_permission_overwrites` | target_kind(`channel`/`category`) · target_id · subject_kind(`role`/`user`) · subject_id · allow · deny |
| `chat_categories` | id · name · position · created_by |
| `channels` + | `category_id`(FK SET NULL) · `position` |

`channel_members.role`(owner/admin/member)과 `users.is_admin` 은 변경 없이 유지한다.

스키마 기준선(`backend/app/db/baseline.py` — [data-safety.md](data-safety.md))이 1회 수행하는 작업: @everyone 행 생성(부재 시에 한함, 권한 = `DEFAULT_EVERYONE`), 기본 카테고리
"채널"·"음성"·"보관" 생성 및 DM 이 아닌 채널의 배치(`system_settings.chat.categories_seeded` 표시로 1회만 수행),
`channels.category_id` FK(NOT VALID)·인덱스 생성. 관리자가 변경한 @everyone 권한은 기동 시 초기화하지 않는다.

## 2. 권한 비트(35)

일반 `VIEW_CHANNEL` `MANAGE_CHANNELS` `MANAGE_ROLES` `MANAGE_EXPRESSIONS` `MANAGE_WEBHOOKS` `VIEW_AUDIT_LOG` `ADMINISTRATOR` ·
멤버 `CREATE_INVITE` `KICK_MEMBERS` `MODERATE_MEMBERS` ·
텍스트 `SEND_MESSAGES` `SEND_IN_THREADS` `CREATE_THREADS` `READ_HISTORY` `EMBED_LINKS` `ATTACH_FILES` `ADD_REACTIONS`
`USE_EXTERNAL_EMOJI` `MENTION_EVERYONE` `MANAGE_MESSAGES` `PIN_MESSAGES` `MANAGE_THREADS` `BYPASS_SLOWMODE` `SEND_POLLS` `USE_COMMANDS` ·
음성 `CONNECT` `SPEAK` `STREAM` `USE_VAD` `PRIORITY_SPEAKER` `MUTE_MEMBERS` `DEAFEN_MEMBERS` `MOVE_MEMBERS` `USE_SOUNDBOARD` `REQUEST_TO_SPEAK`.

비트 번호는 `permissions.py` 에서만 정의한다(디스코드 번호와 무관, 재사용 금지). 대응 기능이 아직 없는 비트
(슬로 모드·타임아웃·웹훅·사운드보드 …)는 예약만 되어 있다 — 해당 기능의 구현 시점에 검사를 추가한다.

**@everyone 기본값 = 채널 멤버에게 기본 허용되는 동작 전체**: 보기·쓰기·답글·스레드·기록 읽기·임베드·첨부·리액션·외부 이모지·
@everyone·고정·초대·투표·명령·음성 접속/말하기/공유/VAD/사운드보드/발언 요청.
**채널 역할 암묵 권한**: 채널 owner·admin → `MANAGE_CHANNELS` · `KICK_MEMBERS`. 채널 삭제는 owner(또는 ADMINISTRATOR)만.

**정책 토글**(채팅 설정 › 서버 전역 정책, `GET·PUT /api/chat/policy`, 모두 기본 비활성):
`admin_channel_privileges` — 전역 관리자에게 채널 내부에서도 전체 권한을 부여한다(DM·비공개 채널 포함) ·
`owner_manage_messages` — 채널 owner 에게 `MANAGE_MESSAGES`(타인 메시지 삭제)를 부여한다. 변경 사항은 최대 30초 이내에 전체 워커에 반영된다.

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

단락 평가(short-circuit, 위 계산 순서의 "짧은 길") 3종: **ADMINISTRATOR 비트**(역할) = 채널 내부에서도 전체 권한, **전역 관리자** = 워크스페이스 범위에 한정
(채널 내부에서는 특권 없음 — 타인의 DM·비공개 채널을 열람할 수 없다. 정책 토글 `admin_channel_privileges` 를 활성화하면 채널 내부에서도 전체 권한),
**채널 owner** = owner 전용 동작(채널 삭제).

동작 ↔ 비트 대응(라우터가 호출하는 이름, `ACTIONS`). "기본 검사"는 `legacy`·`shadow` 모드에서 접근 통제에 적용되는 규칙이며, "엔진"은 `enforce` 모드에서 적용되는 규칙이다:

| 동작 | 기본 검사 | 엔진 |
|---|---|---|
| channel.view / channel.participate(팔로우·저장·안읽음·임시글·스레드 읽음) | 멤버 | VIEW_CHANNEL |
| message.read · file.download | 멤버 | VIEW + READ_HISTORY |
| message.send / message.reply / file.upload | 멤버 | VIEW + SEND / SEND_IN_THREADS / SEND + ATTACH |
| message.pin · reaction.add | 멤버 | VIEW + PIN_MESSAGES / ADD_REACTIONS |
| message.edit | 본인 | 본인(타인의 메시지는 누구도 수정할 수 없다) |
| message.delete · preview.dismiss | 본인 | 본인 또는 VIEW + MANAGE_MESSAGES |
| channel.manage · tabs.manage | owner/admin(탭: +생성자) | VIEW + MANAGE_CHANNELS(탭: +생성자) |
| channel.delete | owner | owner 또는 ADMINISTRATOR |
| member.invite / member.kick | 멤버 / owner·admin | CREATE_INVITE / KICK_MEMBERS |
| voice.connect | 멤버 | VIEW + CONNECT |
| mention.everyone | 제한 없음 | MENTION_EVERYONE |

## 4. 모드

`CHAT_PERMISSIONS_ENGINE` — `.env` 에 설정하고 backend 를 재시작하면 반영된다(`.env.example` 에는 포함되어 있지 않으므로 해당 행을 직접 추가한다).

| 모드 | 접근 통제 주체 | 엔진 |
|---|---|---|
| `legacy` | 기본 검사(채널 멤버십·채널 역할) | 실행하지 않는다. @역할 멘션도 비활성화된다 |
| `shadow`(기본) | 기본 검사 | 병행 계산하며, 결과가 불일치하면 `chat_perm_shadow_mismatch` 로그 + Redis `chat:perm:shadow:YYYYMMDD` 카운터 |
| `enforce` | 엔진 | 엔진 오류 = 거부(fail-closed) + `chat_perm_engine_error` 로그 |

역할·카테고리·덮어쓰기 API 와 @역할 멘션은 `legacy` 가 아니면 모드와 무관하게 동작한다.
엔진 쿼리는 PostgreSQL 의 SAVEPOINT 내에서 실행된다 — 실패하더라도 요청 트랜잭션은 유지된다.

로그(개인정보 없음): `{"event":"chat_perm_shadow_mismatch","action","legacy","engine","channel_type","is_voice","channel_role","roles","overwrites","everyone_default","user":<해시12>,"channel":<해시12>}` — id 는 `SECRET_KEY` 를 혼합한 sha256 의 앞 12자이며, 본문은 포함하지 않는다.

### `enforce` 전환 절차

1. **`shadow` 모드에서 검증한다.** 역할·덮어쓰기를 생성하지 않은 상태에서는 엔진 결과가 기본 검사와 일치하여야 한다(불일치 0).
   관리자 권한으로 `GET /api/chat/permissions/shadow-stats?days=14` → `days.*.mismatch`·`error` 를 조회하고, backend 로그에서
   `chat_perm_shadow_mismatch`·`chat_perm_engine_error` 를 확인한다.
   - 역할·덮어쓰기를 생성하면 **의도된** 불일치가 발생한다(예: `MANAGE_MESSAGES` 를 가진 역할 → `message.delete:0>1`).
     카운터 필드 `<동작>:<기본 검사>><엔진>` 으로 의도된 차이인지 확인한다. 의도하지 않은 차이인 경우 전환을 중단하고 원인을 규명한다.
2. **전환 전 점검**: [§6](#6-알려진-제한-사항) — 특히 멤버의 `VIEW_CHANNEL` 을 제거하거나 비멤버에게 부여하는 덮어쓰기가 없어야 한다.
3. **전환**: `.env` 에 `CHAT_PERMISSIONS_ENGINE=enforce` → `docker compose up -d backend`. 확인: 채널 보기·보내기·
   리액션·고정·음성 접속·채널 설정.
4. **원복**: `.env` 를 `shadow`(또는 `legacy`)로 변경 → backend 재시작. 데이터는 변경되지 않으므로 즉시 이전 동작으로 복귀한다(역할·덮어쓰기 행은 유지되나
   `shadow`·`legacy` 에서는 접근 통제에 적용되지 않는다).

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
| `GET /channels/{id}/members/by-role` — hoist 역할별 그룹 + 사용자별 roles·color | channel.view |

`allow`/`deny`·`permissions` 는 정수 또는 이름 목록이다. 계층 규칙: 요청자의 최상위 역할보다 낮은 역할에 한하여, 요청자가 보유한 비트만 부여할 수 있다
(전역 관리자·ADMINISTRATOR 예외). 신규 역할은 @everyone 바로 위(position 1)에 생성된다. 채널 목록(`GET /channels`)의 각 채널에는 `category_id`·`position` 이 포함된다.

**@역할 멘션**: `@이름`(공백은 `-`, 대소문자 무시 — 예 "On Call" → `@on-call`). 사용자 이름이 우선한다. `mentionable` 이거나 발신자가
MENTION_EVERYONE 을 보유한 경우 멘션할 수 있다. 수신자 = 역할 멤버 ∩ 채널 멤버(발신자 제외) → 개인 멘션과 동일하게 배지 + 알림
("OO님이 @역할 역할을 불렀습니다", `role_name` 필드). 이름이 예약어(everyone·here·채널·전체·모두 …)인 역할은 생성할 수 없다.

**감사 로그**(`audit_logs`, `chat.` 접두): role.create/update/delete/reorder/assign/unassign/set_user/sync_group ·
channel.permission(_delete) · category.permission(_delete) · category.create/update/delete · layout.update. 변경 전후의 값을 기록한다.

## 6. 알려진 제한 사항

- **채널 외부의 여러 경로는 여전히 채널 멤버십을 기준으로 판정한다.** 실시간 이벤트 전달, 메시지 검색, 대시보드, 파일의 채널 공유,
  회의·할 일 연동, AI 도구가 `is_channel_member` 를 사용한다. 따라서 `enforce` 에서도 덮어쓰기로 **멤버의 `VIEW_CHANNEL` 을 제거하면
  채팅 화면에는 표시되지 않으나 실시간 이벤트·검색 결과로는 내용이 계속 전달된다**(누수). 반대로 비멤버에게 `VIEW_CHANNEL` 을 부여하더라도 실시간 이벤트는 수신되지 않는다.
  채널을 비공개로 하려면 덮어쓰기가 아니라 **멤버에서 제외**하는 방법을 사용한다.
- **비용**: 검사 1회당 쿼리 3~4개(역할·그룹·덮어쓰기)가 추가로 실행된다(`shadow` 포함). 결과 캐시는 없다.
- 채널 owner 는 기본 설정에서 타인의 메시지를 삭제할 수 없다(정책 토글 `owner_manage_messages`). 채널에서 탈퇴한 후에도 본인의 메시지는 수정·삭제할 수 있다.
- 전역 관리자는 기본 설정에서 채널 내부의 특권이 없다(정책 토글 `admin_channel_privileges`).
- 그룹이 삭제되면 해당 그룹에 연동된 역할은 멤버가 0 인 역할로 잔존한다.
- 역할·배치 변경에 대한 실시간 이벤트는 없다 — 다른 사용자의 화면에는 목록을 다시 조회하는 시점에 반영된다.
