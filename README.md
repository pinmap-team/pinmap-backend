# Pinmap 콘텐츠 추출 백엔드

이 저장소는 핀맵의 서버 측 코드를 관리합니다. 공개 웹 UI는 [`pinmap-web-prototype`](https://github.com/pinmap-team/pinmap-web-prototype)에 있으며, 별도의 모바일 앱은 비공개 `pinmap` 저장소에 있습니다.

백엔드 Vercel 프로젝트는 공식 핀맵의 API를 제공합니다. 별도 테스트 웹 화면은 운영하지 않으며, 로그인 계정에서 장소·일정 추출과 저장을 시험할 수 있습니다. Vercel 프로젝트와 `/api/*` 경로는 공식 웹의 로그인·저장·분석 기능에 필요합니다.

## 회원 탈퇴 API

`DELETE /api/account-delete`는 로그인한 사용자의 Supabase 토큰을 확인합니다. 공용 팀 테스트 계정은 삭제하지 않습니다. 결제 확인 중인 거래가 있으면 탈퇴를 잠시 중단하고, 활성 구독이 있으면 Paddle에서 즉시 해지한 뒤 Supabase 계정을 삭제합니다. 저장 콘텐츠·설정·코스·분석 한도·구독 행은 계정 삭제에 따라 정리됩니다. 구독을 참조하는 분석 사용 행은 계정 삭제 전에 제거합니다. 어느 단계든 실패하면 오류를 반환하므로 사용자는 로그인 상태에서 다시 시도할 수 있습니다. 기존 `005_billing.sql`과 서버 전용 Supabase 비밀 키가 필요합니다.

## 모듈

| 디렉터리 | 배포 위치 | 역할 |
| --- | --- | --- |
| `api/` | Vercel | 개발자 테스트 경로, 인증이 필요한 콘텐츠 추출과 계정별 저장·목록·삭제 API를 제공하고, 브라우저에 공개해도 되는 지도 및 Supabase 설정을 반환합니다. |
| `extractor/` | Google Cloud Run | 공개 인스타그램 미디어를 가져와 캡션과 이미지 프레임을 분석하고, 장소와 행사 날짜를 각각 추출하며 지도 검색 후보를 찾습니다. |
| `packages/multiuser/` | 별도로 선택해 실행하는 Node 서비스. Vercel 배포에서는 제외 | 이전 로컬 백엔드에서 가져온 계정별 ZIP·미디어 가져오기, 영속 작업, 오디오·시각 분석 기능입니다. 공개 핀맵 UI에는 연결되지 않습니다. |
| `database/` | 공식 Supabase 프로젝트에 적용 | 계정별 저장 콘텐츠와 접근 권한을 관리합니다. 기존 횟수 제한 SQL은 이력으로 보관합니다. 쓰기 작업은 서버에서만 허용합니다. |
| `tests/`, `extractor/tests/` | CI·로컬 | API 경계, 장소 검색, OCR, 행사 일정 파싱을 검사합니다. |

## 요청 흐름

### OpenAI 분석 제공자

Cloud Run의 `pinmap-place-extract-test` 서비스에 `OPENAI_API_KEY`를 서버 전용 환경변수로 등록한 뒤 `MULTIUSER_AI_PROVIDER=openai`로 전환한다. `PINMAP_PLACE_AI_MODEL`을 지정하지 않으면 `gpt-4.1-mini`를 사용한다. 장소·일정·콘텐츠 설명, 장소 사진 매칭, 분류와 불확실한 지도 후보 검증은 선택한 제공자의 코드 경로를 사용한다. Gemini 경로는 유지한다. 다시 사용하려면 `MULTIUSER_AI_PROVIDER=gemini`, `GEMINI_API_KEY`, `MULTIUSER_MODEL`만 설정하면 된다. 전환 전에 실제 키로 분석 요청을 확인하고, 오류가 나면 제공자 설정을 이전 값으로 되돌린다. 키를 웹 앱, Vercel 브라우저 환경변수, Git에 넣지 않는다.

OpenAI 제공자에서는 영상 음성을 `gpt-transcribe`로 전사하고 화면 글자 인식과 동시에 실행한다. `PINMAP_OPENAI_TRANSCRIBE_MODEL`로 모델을 바꿀 수 있다. 전사 API가 실패하면 이미지에 포함된 로컬 Whisper로 재시도한다. OpenAI 전사 결과에는 구간별 시각이 없으므로 음성 근거의 `time_seconds`와 `end_seconds`는 `null`로 둔다. Gemini 제공자는 기존 로컬 Whisper 전사를 유지한다.

1. 개발자 테스트 API는 인스타그램 게시물·릴스 URL, 테스트 코드, `content_types: ["place", "event"]`를 `POST /api/place-extract`에서 받습니다. 서비스 자체의 일일 분석 횟수 제한은 없습니다. `content_types`를 생략하는 기존 호출은 장소만 분석합니다.
2. 공식 `POST /api/content-save` 경로는 Supabase 사용자 액세스 토큰을 요구합니다. 사용자를 인증하고 저장 테이블을 확인한 뒤 횟수 제한 없이 Cloud Run에 분석을 요청합니다. 기본적으로 장소와 행사 두 종류를 모두 분석합니다. `POST /api/content-extract`는 일일 횟수 제한이 없는 인증된 추출 전용 경로로 유지됩니다.
3. Vercel은 URL을 검증하고 서버 전용 토큰을 사용해 Cloud Run의 `/extract-link`로 요청을 전달합니다. Cloud Run은 지도 핀에 사용할 `places`와 `map_locations`를 반환합니다. 날짜, 시간 문구, 장소, 근거, 검토 필요 여부가 포함된 `events`도 별도로 반환합니다. 연도가 없거나 날짜가 불확실하면 검토할 수 있도록 구조화하지 않은 원문으로 남깁니다.
4. 공식 저장 경로는 서버 전용 비밀 키를 사용해, 허용된 필드와 크기로 제한한 분석 결과를 로그인한 사용자의 Supabase 행에 저장합니다. 브라우저는 분석 필드를 데이터베이스에 직접 쓸 수 없습니다. `GET /api/content-save`는 저장 항목을 불러오고 `DELETE /api/content-save`는 항목을 삭제합니다. 분석에 실패한 링크도 `content_kind: "unknown"`으로 저장할 수 있지만, 같은 링크의 이전 성공 결과를 덮어쓰지는 않습니다. 테스트 코드로 호출하는 개발자 경로는 결과를 영구 저장하지 않습니다. 별도의 다중 사용자 서비스는 자체 저장소와 인증 방식을 사용합니다.

## 인스타그램 수집 방식

Cloud Run 추출기는 먼저 Scrapling HTTP 요청으로 지정된 공개 사진 게시물을 해석하고, 최대 6개의 동시 전송으로 전체 사진을 다운로드합니다. 게시물 ID가 일치하고, 지원하는 이미지 전용 미디어이며, 사진 세트가 완전한 경우만 결과를 받아들입니다. 캡션과 미디어 요청은 같은 임시 요청 디렉터리 안에서 캐시를 공유합니다. 결과와 브라우저 세션은 사용자 간에 공유하지 않습니다.

공개 데이터를 사용할 수 없거나, 로그인 제한·페이지 구조 변경·사진 누락·지원하지 않는 게시물 또는 동영상 게시물·의존성 오류·이미지 다운로드 실패가 발생하면 기존 브라우저 수집기로 자동 전환합니다. 이미지 다운로드는 HTTPS 인스타그램 CDN 호스트만 허용하고 파일 형식을 확인하며, 기존의 이미지별·전체 크기 제한을 유지합니다. 프로필 이미지는 선택 사항이며 짧은 제한 시간을 적용합니다. HTTP 방식의 OCR 대상 이미지는 1080px입니다. OCR, AI, 지도 검색, 콘텐츠 저장 동작은 변경되지 않습니다.

구조화된 Cloud Run 표준 오류 로그에는 `stage=collection`, 수집 방식인 `method=scrapling_http` 또는 `browser_fallback`, 소요 시간, 제한된 범위의 대체 경로 전환 사유가 기록됩니다. 캡션, 토큰, 서명된 이미지 URL은 기록하지 않습니다. Cloud Run에서 `PINMAP_SCRAPLING_ENABLED=0`으로 설정하면 이전 브라우저 방식만 사용합니다. 버전을 고정한 Scrapling 의존성은 컨테이너 이미지의 Python 가상 환경에서 실행됩니다. Vercel만 배포해서는 이 코드가 활성화되지 않으므로 `extractor/`도 Cloud Run에 배포해야 합니다.

## 설정과 배포

캡처 화면 분석·저장을 켜기 전에 같은 Supabase 프로젝트에 `database/007_capture_content.sql`과 `database/008_capture_uuid_constraint.sql`을 순서대로 적용합니다. 008은 007의 캡처 UUID 패턴에서 빠진 네 번째 4자리 구간을 보완합니다. 계정용 `POST /api/content-save`는 `capture_id`(UUID)와 `capture_image`(JPEG data URL)를 받아 Cloud Run `/extract-capture`에서 장소·일정·설명을 분석합니다. 브라우저는 업로드 전에 이미지를 최대 1600px로 축소합니다. 서버는 원본 이미지를 DB에 저장하지 않고 작은 표지와 분석 결과만 보관합니다. 캡처 항목은 `pinmap://capture/<UUID>` 식별자로 계정별 저장·삭제하며, 원본 외부 링크로 열지 않습니다. Vercel API와 Cloud Run 추출기를 모두 배포해야 이 기능이 동작합니다.

### API 키 보관

운영 키의 단일 저장 파일은 [`extractor/production-keys.enc.json`](extractor/production-keys.enc.json)입니다. GitHub에는 AES-256-GCM으로 암호화된 값만 올라갑니다. Vercel과 Cloud Run에는 복호화용 `PINMAP_KEYS_MASTER_KEY`(64자리 16진수)를 **각각 서버 전용 환경 변수**로 등록합니다. 이 변수가 있으면 서버의 `config/keys.cjs`와 추출기의 `extractor/runtime_keys.py`가 같은 파일의 값을 우선 읽습니다. 변수가 없는 기존 배포는 이전 개별 환경 변수로 계속 동작합니다. 브라우저에는 지도용 공개 키만 기존 설정 API를 통해 전달합니다.

키를 교체할 때는 Git에서 제외되는 `.env.keys.local`(권한 `600`)에서 해당 줄 하나를 수정하고 `node scripts/seal-keys.cjs`를 실행한 다음, 변경된 암호화 파일 하나만 커밋합니다. 복호화용 `.keys-master.local`(권한 `600`)도 로컬에 따로 두며 Git에 올리지 않습니다. `.env.keys.example`은 파일 형식 예시입니다. 로컬에서 암호화 파일을 쓰지 않을 때만 `PINMAP_KEYS_FILE`로 비공개 파일을 지정할 수 있습니다. `SUPABASE_URL`, `PINMAP_EXTRACTOR_ORIGIN` 같은 일반 설정은 기존 환경 변수로 유지합니다. 키 자체가 아니라 복호화 키를 바꾸면 두 서버의 `PINMAP_KEYS_MASTER_KEY`도 함께 변경해야 합니다.

같은 JSON 파일의 `keys` 목록에 사용 중이거나 선택적으로 지원하는 키와 관련 인증값을 모두 적었습니다. 각 항목의 `source`가 `encrypted`이면 암호문에서 읽고, `environment`이면 표시된 환경 변수를 참조합니다. `external`은 Supabase처럼 외부 서비스가 직접 관리하므로 Pinmap 서버가 값을 읽지 않는 항목입니다. `comment`는 실제 값이 없는 이유와 사용 위치를 기록합니다. JSON은 주석 문법을 지원하지 않아 설명 필드를 사용합니다. `PINMAP_KEYS_MASTER_KEY`는 파일을 여는 복호화 키라 파일 안에 넣을 수 없으며 `bootstrap` 항목에 따로 표시했습니다.

구글 로그인용 `GOOGLE_OAUTH_CLIENT_ID`와 `GOOGLE_OAUTH_CLIENT_SECRET`은 `external` 항목입니다. 웹의 `auth-page.js`는 `signInWithOAuth({provider:'google'})`을 호출하고, 실제 OAuth 자격 정보는 Google Cloud에서 발급해 Supabase 프로젝트의 Authentication → Sign In / Providers → Google에 설정합니다. 지도용 Google Maps 키와는 별개이며 Pinmap의 Vercel 환경 변수나 암호문에 복사하지 않습니다.

현재 암호문에는 Vercel에서 값을 확인할 수 있었던 `GOOGLE_MAPS_BROWSER_KEY`, `KAKAO_MAP_JAVASCRIPT_KEY`, `NAVER_MAP_CLIENT_ID`, `SUPABASE_PUBLISHABLE_KEY`가 들어 있습니다. Vercel이 `[SENSITIVE]`로 가려 반환하는 `GOOGLE_MAPS_SERVER_KEY`, `PINMAP_EXTRACTOR_TOKEN`, `PINMAP_TEST_ACCESS_CODE`, `SUPABASE_SECRET_KEY`와 Cloud Run 추출기의 별도 키는 **파일 목록에는 있지만 암호문에는 없습니다**. 이 값들은 목록에 적힌 기존 환경 변수로 읽습니다. 실제 값을 확인해 로컬 비공개 편집 파일에 넣은 뒤 다시 암호화하면 `source`가 자동으로 `encrypted`로 바뀝니다. 가려진 문자열을 키로 저장하지 마세요.

1. `SUPABASE_URL`이 가리키는 Supabase 프로젝트에 [`database/002_saved_content.sql`](database/002_saved_content.sql)을 적용합니다. 저장 콘텐츠는 계정당 100개로 제한됩니다. 분석 결과 행은 백엔드만 쓰며, 사용자는 자기 계정의 저장 항목만 읽을 수 있습니다. `001_content_extraction_quota.sql`과 `003_developer_test_quota.sql`은 이전 배포 이력이며 현재 API는 해당 횟수 제한 함수를 호출하지 않습니다. 기존 테이블의 기록은 삭제하지 않습니다.
2. `extractor/`의 Dockerfile을 사용해 Cloud Run에 배포합니다. `PINMAP_TEST_TOKEN`에는 Vercel의 `PINMAP_EXTRACTOR_TOKEN`과 동일한 서버 전용 값을 설정합니다. AI 키와 지도 제공자 키는 Git이 아닌 Cloud Run에 설정합니다. Cloud Run 배포 버전은 별도로 배포하고 확인해야 합니다. Vercel의 Git 배포는 Cloud Run을 업데이트하지 않습니다.

   추출기 이미지에는 `whisper.cpp` v1.9.5의 `whisper-cli`와 다국어 `base` 모델을 포함합니다. 모델의 SHA-1을 빌드 중 확인하고, 컨테이너 안에서 한국어 모드의 WAV→JSON 전사 연동 검사를 통과해야 이미지가 완성됩니다. 모델 경로 기본값은 이미지의 `PINMAP_WHISPER_MODEL=/opt/pinmap-models/ggml-base.bin`입니다. Cloud Run 배포 때 같은 경로를 명시하고, 음성이 있는 새 영상 분석에서 `audio_transcripts`가 생성되는지 확인합니다. 이미 저장한 게시물은 재분석해야 기존 분석 안내가 바뀝니다. 캡션만으로 충분하다고 판단한 빠른 경로는 기존 정책대로 미디어·음성 분석을 생략합니다.
3. 이 저장소를 Vercel 프로젝트에 연결하고 `.env.example`에 설명된 Vercel 환경 변수들을 설정합니다. `SUPABASE_PUBLISHABLE_KEY`는 설계상 공개 키입니다. 새 API 경로를 배포하기 전에 `SUPABASE_SECRET_KEY`(`sb_secret_…`)를 **서버 전용** Vercel 환경 변수로 설정합니다. 이 값을 브라우저, Git, URL, 채팅에 넣지 마세요. 추출기 토큰은 서버에만 보관합니다. 개발자 테스트 코드는 Vercel에 설정하고 `X-Pinmap-Test-Code` 요청 헤더에만 넣으며, Git이나 공개 링크에는 넣지 않습니다.
4. Cloud Run의 `GET /health`, `GET /api/map-config`, `GET /api/auth/config`, 인증된 개발자의 `POST /api/place-extract`, 그리고 공개 웹의 동일 출처 재작성 경로를 통한 인증된 `POST`·`GET`·`DELETE` 요청을 `/api/content-save`에서 확인합니다. 두 번째 계정이 첫 번째 계정의 행을 읽을 수 없는지, Supabase에 조작한 분석 결과를 직접 쓸 수 없는지, 공식·개발자 분석이 이전 일일 한도를 넘어 실행되는지 확인합니다. 날짜가 일부만 있는 행사와 좌표가 모호한 장소도 검사합니다. 어느 쪽에도 근거 없는 날짜나 지도 핀이 추가되어서는 안 됩니다.

공식 추출 API 요청은 `POST /api/content-extract`입니다. `Authorization: Bearer <Supabase user access token>`, `Content-Type: application/json`, 요청 본문 `{"url":"https://www.instagram.com/p/.../","content_types":["place","event"]}`를 사용합니다. 응답은 기존 `results[0].places`와 `results[0].map_locations`를 유지하고 `results[0].events`와 `results[0].content_kind`를 추가합니다. 각 행사에는 `event_type`(`exhibition`, `pop_up`, `other`), `start_date`, `end_date`, `date_text`, `time_text`, `venue_name`, `address`, `evidence`, `needs_review`, `notes`를 사용합니다. 검토가 필요하다고 표시된 지도 좌표와 행사 날짜는 확인된 사실이 아닌 후보로 취급합니다.

공식 저장 API인 `POST /api/content-save`는 동일한 Bearer 토큰과 요청 본문을 사용하며 `{item, analysis_status, analysis_notes, warnings}`를 반환합니다. `GET /api/content-save?limit=2&offset=0`은 `{items, next_offset}`을 반환합니다. 두 매개변수는 선택 사항이며, 포함된 이미지 데이터가 함수 응답 크기 제한을 넘지 않도록 페이지당 최대 2개 항목을 반환합니다. `DELETE /api/content-save`는 `{"url":"https://www.instagram.com/p/.../"}`를 받아 `{deleted}`를 반환합니다. 분석 오류가 발생하면 링크는 검토가 필요한 상태로 저장할 수 있습니다. 데이터베이스에는 원본 동영상, 캡션 전문, OCR 결과 전문을 저장하지 않습니다. 프로필·표지·장소 썸네일에는 각각 명시적인 크기 제한이 있고, 생략된 썸네일은 `warnings`에 표시됩니다. 로그인한 브라우저에는 Supabase 공개 키만 전달됩니다. 백엔드는 저장용 비밀 키를 사용하기 전에 액세스 토큰을 별도로 검증합니다.

이 저장소는 `pinmap-team`에서 공개되어 있으며, 기존 `pinmap-backend` Vercel 프로젝트에 직접 연결되어 있습니다. `main`에 푸시하면 Vercel API가 배포되고, 풀 리퀘스트에는 미리보기 배포가 제공됩니다. GitHub의 `Backend tests` 워크플로가 코드를 검사하지만 Vercel의 기본 Git 배포는 이 워크플로가 통과할 때까지 기다리지 않습니다. 미리보기 환경에 서버 전용 테스트 자격 정보가 있으므로 Vercel 프로젝트의 Git Fork Protection을 활성화된 상태로 유지합니다.

Vercel의 Git 배포는 별도의 Cloud Run 추출기를 다시 배포하지 않습니다. `.vercel/`과 로컬 테스트 접근 코드 파일을 Git에 올리지 마세요. 배포에 실패하면 다시 변경하기 전에 Vercel 프로젝트의 배포 로그와 GitHub 테스트 결과를 확인합니다.

이전 로컬 AI 백엔드는 `packages/multiuser/`에 별도 서비스로 보관되어 있습니다. 자체 API, SQLite 저장소, 작업자는 Vercel API 경로나 공식 사이트의 인증 체계를 공유하지 않습니다. `.vercelignore`는 이 소스가 Vercel에 배포되지 않도록 제외하며, CI 워크플로는 해당 서비스의 테스트를 별도로 실행합니다. 실행 방법은 패키지 README를 참고하세요. 공개 인스타그램 링크와 지도 후보 검색에는 같은 처리 흐름의 로컬 복사본 대신 이 저장소의 Cloud Run 추출기를 사용합니다. 이전 사용자 내보내기 자료나 로컬 데이터베이스는 이 패키지에 포함되지 않습니다.

인증 정보, 브라우저 프로필, 수집한 미디어, 생성된 결과물을 Git에 넣지 않습니다. `.env.example`에는 환경 변수 이름만 있습니다. 테스트에서는 유료 AI 또는 Places API를 호출하지 않습니다.

`npm test`를 실행하면 API와 Python 검색 로직을 검사합니다. Cloud Run의 `GET /health`는 프로세스가 실행 중인지 확인하지만, 인스타그램 접근이나 외부 AI 서비스 이용 가능 여부까지 보장하지는 않습니다.

## 저장된 장소의 사진 대체 방식

`POST /api/content-photo`는 저장된 콘텐츠의 UUID와 장소 인덱스만 받습니다. Supabase 사용자를 검증하고 해당 사용자가 저장한 장소를 읽습니다. 기존 게시물 썸네일을 우선 사용합니다. 썸네일이 없으면 정규화한 장소 이름과 반경 150m 이내 좌표를 기준으로 새 Google Places 사진을 찾습니다. `map_locations`에는 `google_place_id`만 저장하고 Google 사진 이름, URI, 이미지 바이트는 저장하지 않습니다. 화면에 표시하는 각 Google 사진에는 작성자 표시와 Google 지도 원본 링크를 함께 제공합니다.

`GOOGLE_MAPS_SERVER_KEY`는 서버 전용입니다. 토큰으로 보호되는 관리용 `POST /api/photo-backfill`은 기존에 저장된 장소의 누락된 장소 ID를 한 번에 최대 6개씩 채웁니다. 임의의 데이터베이스 변경 요청은 받지 않으며 건수와 커서만 반환합니다. 원본 썸네일, 계정 소유권, 출처 URL, 저장 시각은 그대로 두고, 최초 업데이트 시각을 확인해 그사이 변경된 콘텐츠는 건너뜁니다. 지도 제공자 요청에 실패하면 재시도를 위해 해당 묶음 작업을 멈춥니다. 관리용 토큰은 `PINMAP_EXTRACTOR_TOKEN`이며 브라우저 코드에 들어가서는 안 됩니다.

## 분석 성능

2026-11-26 운영 Cloud Run 단계 로그 표본에서 OCR 중앙값은 24.71초(상위 10% 65.087초), 미디어 수집은 9.28초, 통합 AI는 7.24초였다. 단계별 표본으로, 새 구현의 개선율은 배포 후 같은 유형의 콘텐츠로 다시 측정해야 한다.

`PINMAP_AI_ONLY_ANALYSIS=1`은 OCR과 지도 검색 기반 주소·좌표 조회를 건너뛰고 캡션과 수집된 모든 사진·릴스 프레임을 `PINMAP_AI_CHUNK_SIZE`개씩 AI API에 보낸다. 최대 `PINMAP_AI_CHUNK_WORKERS`개 묶음을 동시에 처리한 뒤 원래 순서대로 합친다. 음성은 선택한 제공자의 기존 전사 경로를 사용한다. AI가 정확한 좌표를 제시하지 못하거나 좌표 범위가 틀리면 지도 핀을 만들지 않는다. AI 좌표는 `coordinate_source=ai_estimate`로 내부에 기록하고 별도의 ‘확인 필요’ 표시는 추가하지 않는다. 일부 구간이나 이미지 전송이 실패하면 성공으로 처리하지 않는다. 이 경로는 모델 호출 수와 이미지 입력 비용이 늘 수 있고, 주소·좌표의 실제 정확도는 지도 검색으로 검증되지 않는다. 기존 경로는 플래그 `0`으로 유지한다.

기존 경로의 Tesseract OCR도 `PINMAP_OCR_BATCH_SIZE`장씩 한 프로세스에서 읽는다. 묶음별 결과 순서를 유지하고 불완전한 묶음만 개별 이미지로 다시 읽는다. `PINMAP_OCR_WORKERS`는 동시 묶음 수이며 운영 1-vCPU에서는 1을 사용한다. 새 AI 경로의 `ai_media_chunk` 로그와 `analysis_metrics`에서 묶음 수·실패 수·소요 시간을 비교한다.

추출기는 OCR 전에 완전히 동일한 정지 이미지를 제거합니다. 표지와 슬라이드가 중복되면 슬라이드의 근거를 우선하며, 동영상의 서로 다른 시점은 유지합니다. 첫 OCR 결과는 빈 결과나 실패 결과를 포함해 장소 사진 매칭에도 재사용하므로 슬라이드 전체에 Tesseract를 다시 실행하지 않습니다. 1-vCPU 이미지에서는 `OMP_THREAD_LIMIT=1`을 설정해 CPU 자원 경쟁을 줄입니다.

하나의 구조화된 모델 응답으로 누락된 장소·행사 후보와 제목·콘텐츠 설명을 받습니다. 설명은 확인된 캡션·화면 글자·음성·사진·영상 프레임을 근거로 3~4문장, 보통 120~220자로 작성하며, 응답을 500자 이내에서 문장 경계에 맞춰 보존합니다. 장소·일정 추출이 필요 없는 경우에도 준비된 이미지가 있으면 설명 생성에 전달합니다. 이미지 전달로 분석 시간과 모델 사용량이 늘 수 있습니다. 기존의 원본 파일 확인, 날짜 근거 확인, 검토 필요 여부 검사 로직은 이전 경로와 공유합니다. 규칙 기반으로 이미 완성된 행사 후보는 유지합니다. 캡션만으로 장소·일정 추출이 완료된 경우에는 기존 빠른 경로가 미디어를 건너뛸 수 있으므로 이때 설명의 근거는 캡션에 한정됩니다. 통합 응답이 유효하지 않거나 불완전하면 이전 분석 함수로 돌아갑니다. 이전 AI 호출 방식을 사용하려면 `PINMAP_UNIFIED_ANALYSIS=0`으로 설정합니다.

AI에 보내는 긴 캡션·OCR·음성 전사에는 글자 수 상한을 적용하고, 잘린 중간 부분에서도 날짜·장소·행사 관련 문구를 우선 남깁니다. 이미 추출한 장소·행사는 요약에 필요한 이름·주소·날짜·근거만 다시 보냅니다. 동일한 모델·요청 본문·인증 키의 **완료된 JSON 응답**은 같은 Cloud Run 인스턴스에서 15분간 최대 32개 재사용하며, 동시에 들어온 동일 요청은 한 번만 호출합니다. 실패하거나 중단된 응답은 저장하지 않습니다. 원문이나 키는 캐시 식별자에 저장하지 않고 해시만 사용하며, 프로세스가 재시작되거나 다른 인스턴스로 요청이 가면 캐시는 공유되지 않습니다. `PINMAP_AI_CACHE_ENABLED=0`으로 끌 수 있습니다. `analysis_metrics`의 `ai_cache_hits`·`ai_cache_misses`로 재사용 여부를 확인할 수 있습니다. 실제 토큰 절감량은 배포 후 모델 사용량을 비교해 측정해야 합니다.

Google·Naver 장소 검색은 최대 4개 요청을 동시에 실행합니다. 게시물 하나에서 동일한 장소 이름·지역·검색어 조합은 한 번만 조회합니다. 후보 순위, 결과 순서, 검토 필요 여부는 동일한 입력에 대해 같은 결과가 나오도록 유지합니다. 공개 지오코딩 대체 경로는 순차적으로 실행하고, 같은 주소가 반복되면 이전 결과를 재사용합니다. `PINMAP_MAP_LOOKUP_WORKERS=1`로 설정하면 장소 검색을 순차 실행으로 되돌립니다.

구조화된 `analysis_timing` 로그와 추출 응답의 `analysis_metrics`에는 수집, 준비, OCR, AI, 지도 검색, 이미지 매칭 시간과 OCR 이미지 수, 선택된 AI 분석 방식이 포함됩니다. OCR 원문은 성능 지표에 중복해서 넣거나 시간 로그에 기록하지 않습니다. Vercel의 저장 콘텐츠 스키마에도 이 진단 정보는 저장되지 않습니다. Cloud Run 이미지는 Vercel과 별도로 배포하고 성능을 측정합니다.

### 팀 테스트 계정 로그인

웹 로그인 화면의 `테스트 계정으로 시작하기`는 `POST /api/auth/test-login`으로 지정된 팀 계정의 실제 Supabase 세션을 발급받습니다. 저장한 콘텐츠는 같은 계정을 사용하는 팀원끼리 공유됩니다. 기존 저장 API의 사용자별 접근 규칙을 적용하며 일일 분석 횟수는 제한하지 않습니다.

서버 환경에 `PINMAP_TEST_LOGIN_ENABLED=true`, `PINMAP_TEST_LOGIN_PASSWORD`를 등록해야 버튼이 표시됩니다. 기존 Supabase URL·공개 키도 필요합니다. 기존 계정으로만 로그인하며 사용자를 생성하거나 비밀번호를 변경하지 않습니다. 비밀번호나 서버 키는 브라우저에 전달하지 않습니다. 테스트 종료 시 플래그를 `false`로 바꿉니다.

## 분석 횟수 제한 해제

공식 추출·저장과 개발자 추출 API는 일일 횟수 제한 없이 동작합니다. 별도 multiuser 서비스의 일일 작업 한도도 제거했습니다. 로그인과 테스트 코드 검증, 요청·미디어 크기 제한, 계정별 저장 수 제한, 동시 대기 작업 제한은 각 기능의 기존 규칙을 따릅니다. 외부 AI·지도 제공업체의 사용 한도와 오류는 그대로 전달됩니다. Vercel API 변경에는 Cloud Run 재배포가 필요하지 않습니다.

## Decisions 분류와 선택적 지도 검증

Cloud Run의 `PINMAP_DECISIONS_ENABLED=1`은 기존 `GEMINI_API_KEY`로
`gemini-decision-1`을 사용합니다. 장소·행사 추출과 제목·요약 생성은 기존 모델에
남겨두고, 캡션·OCR·전사·요약 텍스트의 콘텐츠 유형 및 세부 카테고리를 별도로
분류합니다. `classification`에는 출처·모델·분류값·신뢰도를 저장합니다.
`content_kind`는 데이터베이스의 장소/행사 배열 일관성 규칙을 계속 따르므로,
분류만으로 존재하지 않는 장소나 날짜를 만들지 않습니다.

지도는 유일한 이름·지역·업종 일치 후보를 기존 규칙으로 처리하고, 동명이점,
별칭, 주소 충돌 등 애매한 경우만 Decisions 검증을 거칩니다. 영문 별칭 후보는
지도 제공자가 반환한 최대 10개 후보 안에서만 보존합니다. 게시물당 애매한
장소 최대 40개를 한 요청으로 검증하며 후보가 없으면 호출하지 않습니다.
좌표는 지도 제공자 값만 사용하고 주소 호환성 검사와 검토 필요 표시를 유지합니다.
거절·낮은 신뢰도는 자동 선택하지 않습니다. API 장애·4초 타임아웃에는 기존
규칙을 사용합니다. 초기 수락 기준 0.8은 운영 자료로 보정해야 할 보수적 시작값이며,
실제 위치 정확도 보장이 아닙니다. 로그에는 질문 수와 소요 시간만 남깁니다.

Vercel API 배포 전에 `database/004_content_classification.sql`을 적용해야 합니다.
기존 저장 행은 빈 분류값을 유지하며 자동 재분석하지 않습니다. 웹은 새 저장 결과의
분류값을 사용하고, 분류가 없으면 이전 표시를 유지합니다.
Cloud Run과 Vercel은 각각 배포하며 플래그를 0으로 바꾸면 Decisions 호출을 끕니다.

## 캡션이 충분한 경우 OCR 생략

`PINMAP_CAPTION_FAST_PATH=1`(기본값)은 캡션에서 요청된 장소·행사 정보가
충분히 추출되면 추가 원본 수집, 영상 프레임 생성, OCR, 음성 분석과 장소 이미지
매칭을 생략합니다. 최초 캡션 수집에서 확보한 표지는 유지하며, 장소 사진이 없으면
기존 Google Places 사진 대체 기능을 사용합니다. 사진 게시물의 최초 HTTP 수집은
이미 미디어를 내려받았을 수 있으므로 모든 다운로드가 없어지는 것은 아닙니다.

장소는 이름·주소가 있어야 하고, 행사는 이름·명시된 연월일·기간·장소가 필요합니다.
명시적으로 하루 행사임을 알 수 있는 단일 날짜도 허용하며 연도나 종료일을 추정하지
않습니다. 목록 수나 번호, 추가 장소 표기가 추출 결과와 맞지 않거나 사진·영상 속
정보를 보라는 안내가 있으면 기존 미디어 분석을 유지합니다. 생략 판단에는 추가 AI를
호출하지 않습니다. 제목·요약 생성, Decisions 분류, 지도 검색과 주소 검증은 유지합니다.

`stage=caption_policy` 로그의 `skip_ocr`·`reason`, 응답 `analysis_metrics.counts`의
`caption_fast_path`·`caption_policy_reason`·`ocr_skipped`·`media_skipped_due_caption`과
`timings`에서 생략 여부를 확인합니다. 이미 생략한 OCR을 사진 매칭 단계에서 다시
실행하지 않습니다. `PINMAP_CAPTION_FAST_PATH=0`으로 기존 경로를 복구할 수 있습니다.

## Paddle 샌드박스 월간 이용권

월 5,000원, 결제 주기마다 성공한 콘텐츠 분석 300개를 제공합니다. 실패한 분석은 예약을 반환하고 남은 횟수는 이월하지 않습니다. 무료 계정의 기존 정책은 유지합니다.

`database/005_billing.sql`은 checkout intent, 구독, 웹훅 중복 방지, 사용량 예약과 서비스 역할 전용 RPC를 추가합니다. `/api/billing/account`는 인증된 계정의 checkout transaction, 구독 상태·사용량, 고객 포털을 제공합니다. `/api/billing/webhook`은 원본 바이트의 서명과 Paddle API 결제·구독·checkout binding을 검증하며 브라우저 이벤트만으로 권한을 부여하지 않습니다.

`database/006_free_monthly_analysis.sql`은 무료 계정에 서울 날짜 기준 월 50회의 성공한 콘텐츠 분석 한도를 추가합니다. `005_billing.sql` 뒤에 적용해야 하며, 실패한 분석 예약은 반환됩니다. 계정 조회 API는 무료 사용량과 남은 횟수를 반환합니다.

서버 환경: `PADDLE_BILLING_ENABLED=1`, `PADDLE_ENVIRONMENT=sandbox`, `PADDLE_MONTHLY_PRICE_ID`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`. 키는 Vercel 서버 환경에만 저장합니다. 웹훅 destination은 `https://pinmap-backend.vercel.app/api/billing/webhook`이며 transaction.completed, subscription lifecycle, adjustment 이벤트를 구독합니다. 기존 익명 테스트 결제는 사용자 계정에 자동 귀속하지 않습니다.

SQL 회귀 검증: 임시 경로의 `@electric-sql/pglite`를 사용하여 `PINMAP_PGLITE_MODULE=/tmp/pinmap-billing-sql-check/node_modules/@electric-sql/pglite node scripts/test-billing-sql.cjs`. 301개 중복 예약의 한도, 실패 반환, 갱신·환불·이벤트 순서·접근 권한을 검사합니다.

### 운영 환경 전환

`GET /api/billing/config`는 서버에서 활성화한 환경과 브라우저용 공개 토큰·가격 ID만 반환합니다. `PADDLE_CLIENT_TOKEN`은 샌드박스에서 `test_`, 운영에서 `live_` 토큰을 사용합니다. API 키의 환경도 일치해야 합니다. 로그인 앱의 구독·사용량은 활성 환경으로 필터링하며 기존 샌드박스 구독을 운영 이용권으로 전환하지 않습니다.

운영 계정과 체크아웃 도메인의 승인, 운영 제품·KRW 5000/월/세금 포함 가격, 운영 API 키와 공개 토큰·웹훅 비밀키가 준비된 뒤 서버 설정을 함께 전환해야 합니다. `https://pinmap-prototype.vercel.app/checkout.html`은 서버 활성 환경을 사용하고 `?mode=prototype`은 테스트 환경을 사용합니다. 현재 운영 계정 로그인·승인 여부는 확인 전이며 실제 청구는 수행하지 않았습니다.

### 운영 인증 정보 사전 저장 (2026-11-22)

운영용 `PADDLE_LIVE_API_KEY`, `PADDLE_LIVE_CLIENT_TOKEN`, `PADDLE_LIVE_MONTHLY_PRICE_ID`, `PADDLE_LIVE_WEBHOOK_SECRET`을 서버에 별도로 저장합니다. 활성 환경의 전용 값이 우선되며 기존 일반 키는 샌드박스용으로 유지합니다. `PADDLE_ENVIRONMENT=sandbox`인 동안 운영 키를 저장해도 공개 결제와 분석 이용권 환경은 바뀌지 않습니다.

운영 제품 `pro_01m7zvyj8pzczmz0gbgpdddxbg`, 가격 `pri_01m7zw038c1rh0yd7d84v7vm4b`는 월 KRW 5000/세금 포함/수량 1/체험 기간 없음으로 생성하고 API에서 확인했습니다. 웹훅은 `ntfset_01m7zwbt5yq9cz6wq3jvb5drae`이며 `.../api/billing/webhook?environment=live`로 전달됩니다. 명시적 환경별 비밀키로 서명과 Paddle API 계정을 검증합니다. 쿼리 없는 기존 웹훅은 샌드박스로 처리합니다.

현재 계정 인증 및 도메인 승인이 완료되지 않아 공개 환경은 샌드박스로 유지합니다. 승인을 확인한 후에만 활성 환경을 live로 전환합니다. 실제 청구는 수행하지 않았습니다.

### 2026-11-22 운영 결제 활성화

Paddle 운영 대시보드의 계정 인증 `Complete / You're verified`와 앞서 승인된 체크아웃 도메인을 확인한 뒤 `PADDLE_ENVIRONMENT=live`로 전환했습니다. 운영 기본 결제 링크는 `https://pinmap-prototype.vercel.app/checkout.html`입니다. 활성 환경의 운영용 API 키·공개 토큰·월간 가격·웹훅 비밀키를 사용하며, 기존 샌드박스 키와 구독은 별도 환경으로 보존합니다. 더미 프로토타입은 샌드박스를 유지합니다.

실제 카드 결제 제출은 하지 않습니다. 이 배포 후 공개 설정의 live 환경과 로그인 계정의 KRW 5000 월간 체크아웃을 확인합니다.
