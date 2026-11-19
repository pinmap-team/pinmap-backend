# Pinmap 콘텐츠 추출 백엔드

이 저장소는 핀맵의 서버 측 코드를 관리합니다. 공개 웹 UI는 [`pinmap-web-prototype`](https://github.com/pinmap-team/pinmap-web-prototype)에 있으며, 별도의 모바일 앱은 비공개 `pinmap` 저장소에 있습니다.

백엔드 Vercel 프로젝트는 공식 핀맵의 API를 제공합니다. 별도 테스트 웹 화면은 운영하지 않으며, 로그인 계정에서 장소·일정 추출과 저장을 시험할 수 있습니다. Vercel 프로젝트와 `/api/*` 경로는 공식 웹의 로그인·저장·분석 기능에 필요합니다.

## 모듈

| 디렉터리 | 배포 위치 | 역할 |
| --- | --- | --- |
| `api/` | Vercel | 개발자 테스트 경로, 인증이 필요한 콘텐츠 추출과 계정별 저장·목록·삭제 API를 제공하고, 브라우저에 공개해도 되는 지도 및 Supabase 설정을 반환합니다. |
| `extractor/` | Google Cloud Run | 공개 인스타그램 미디어를 가져와 캡션과 이미지 프레임을 분석하고, 장소와 행사 날짜를 각각 추출하며 지도 검색 후보를 찾습니다. |
| `packages/multiuser/` | 별도로 선택해 실행하는 Node 서비스. Vercel 배포에서는 제외 | 이전 로컬 백엔드에서 가져온 계정별 ZIP·미디어 가져오기, 영속 작업, 오디오·시각 분석 기능입니다. 공개 핀맵 UI에는 연결되지 않습니다. |
| `database/` | 공식 Supabase 프로젝트에 적용 | 하루 단위 추출 횟수를 원자적으로 제한하고 계정별 저장 콘텐츠를 관리합니다. 쓰기 작업은 서버에서만 허용합니다. |
| `tests/`, `extractor/tests/` | CI·로컬 | API 경계, 장소 검색, OCR, 행사 일정 파싱을 검사합니다. |

## 요청 흐름

1. 개발자 테스트 API는 인스타그램 게시물·릴스 URL, 테스트 코드, `content_types: ["place", "event"]`를 `POST /api/place-extract`에서 받습니다. 서버에서 공유하는 제한에 따라 서울 날짜 기준 하루 최대 20회의 개발자 분석을 허용합니다. `content_types`를 생략하는 기존 호출은 장소만 분석합니다.
2. 공식 `POST /api/content-save` 경로는 Supabase 사용자 액세스 토큰을 요구합니다. 저장 테이블을 확인한 뒤 Cloud Run에 요청하기 전에 Supabase에서 사용자별 하루 5회 분석 한도 중 1회를 사용합니다. 기본적으로 장소와 행사 두 종류를 모두 분석합니다. `POST /api/content-extract`는 같은 한도를 적용하는 인증된 추출 전용 경로로 유지됩니다.
3. Vercel은 URL을 검증하고 서버 전용 토큰을 사용해 Cloud Run의 `/extract-link`로 요청을 전달합니다. Cloud Run은 지도 핀에 사용할 `places`와 `map_locations`를 반환합니다. 날짜, 시간 문구, 장소, 근거, 검토 필요 여부가 포함된 `events`도 별도로 반환합니다. 연도가 없거나 날짜가 불확실하면 검토할 수 있도록 구조화하지 않은 원문으로 남깁니다.
4. 공식 저장 경로는 서버 전용 비밀 키를 사용해, 허용된 필드와 크기로 제한한 분석 결과를 로그인한 사용자의 Supabase 행에 저장합니다. 브라우저는 분석 필드를 데이터베이스에 직접 쓸 수 없습니다. `GET /api/content-save`는 저장 항목을 불러오고 `DELETE /api/content-save`는 항목을 삭제합니다. 분석에 실패한 링크도 `content_kind: "unknown"`으로 저장할 수 있지만, 같은 링크의 이전 성공 결과를 덮어쓰지는 않습니다. 테스트 코드로 호출하는 개발자 경로는 결과를 영구 저장하지 않습니다. 별도의 다중 사용자 서비스는 자체 저장소와 인증 방식을 사용합니다.

## 인스타그램 수집 방식

Cloud Run 추출기는 먼저 Scrapling HTTP 요청으로 지정된 공개 사진 게시물을 해석하고, 최대 6개의 동시 전송으로 전체 사진을 다운로드합니다. 게시물 ID가 일치하고, 지원하는 이미지 전용 미디어이며, 사진 세트가 완전한 경우만 결과를 받아들입니다. 캡션과 미디어 요청은 같은 임시 요청 디렉터리 안에서 캐시를 공유합니다. 결과와 브라우저 세션은 사용자 간에 공유하지 않습니다.

공개 데이터를 사용할 수 없거나, 로그인 제한·페이지 구조 변경·사진 누락·지원하지 않는 게시물 또는 동영상 게시물·의존성 오류·이미지 다운로드 실패가 발생하면 기존 브라우저 수집기로 자동 전환합니다. 이미지 다운로드는 HTTPS 인스타그램 CDN 호스트만 허용하고 파일 형식을 확인하며, 기존의 이미지별·전체 크기 제한을 유지합니다. 프로필 이미지는 선택 사항이며 짧은 제한 시간을 적용합니다. HTTP 방식의 OCR 대상 이미지는 1080px입니다. OCR, AI, 지도 검색, 콘텐츠 저장 동작은 변경되지 않습니다.

구조화된 Cloud Run 표준 오류 로그에는 `stage=collection`, 수집 방식인 `method=scrapling_http` 또는 `browser_fallback`, 소요 시간, 제한된 범위의 대체 경로 전환 사유가 기록됩니다. 캡션, 토큰, 서명된 이미지 URL은 기록하지 않습니다. Cloud Run에서 `PINMAP_SCRAPLING_ENABLED=0`으로 설정하면 이전 브라우저 방식만 사용합니다. 버전을 고정한 Scrapling 의존성은 컨테이너 이미지의 Python 가상 환경에서 실행됩니다. Vercel만 배포해서는 이 코드가 활성화되지 않으므로 `extractor/`도 Cloud Run에 배포해야 합니다.

## 설정과 배포

1. `SUPABASE_URL`이 가리키는 동일한 Supabase 프로젝트에 [`database/001_content_extraction_quota.sql`](database/001_content_extraction_quota.sql), [`database/002_saved_content.sql`](database/002_saved_content.sql), [`database/003_developer_test_quota.sql`](database/003_developer_test_quota.sql)을 순서대로 적용합니다. 각 변경의 적용 여부를 기록하세요. 이 파일들은 순서대로 한 번씩 실행하도록 작성되었습니다. 필요한 함수와 테이블이 없으면 API는 추출기에 요청하지 않고 `503`을 반환합니다. 저장 콘텐츠는 계정당 100개로 제한됩니다. 분석 결과 행은 백엔드만 쓸 수 있으며, 인증된 사용자는 백엔드를 통해 자신의 행만 읽을 수 있습니다.
2. `extractor/`의 Dockerfile을 사용해 Cloud Run에 배포합니다. `PINMAP_TEST_TOKEN`에는 Vercel의 `PINMAP_EXTRACTOR_TOKEN`과 동일한 서버 전용 값을 설정합니다. AI 키와 지도 제공자 키는 Git이 아닌 Cloud Run에 설정합니다. Cloud Run 배포 버전은 별도로 배포하고 확인해야 합니다. Vercel의 Git 배포는 Cloud Run을 업데이트하지 않습니다.
3. 이 저장소를 Vercel 프로젝트에 연결하고 `.env.example`에 설명된 Vercel 환경 변수들을 설정합니다. `SUPABASE_PUBLISHABLE_KEY`는 설계상 공개 키입니다. 새 API 경로를 배포하기 전에 `SUPABASE_SECRET_KEY`(`sb_secret_…`)를 **서버 전용** Vercel 환경 변수로 설정합니다. 이 값을 브라우저, Git, URL, 채팅에 넣지 마세요. 추출기 토큰은 서버에만 보관합니다. 개발자 테스트 코드는 Vercel에 설정하고 `X-Pinmap-Test-Code` 요청 헤더에만 넣으며, Git이나 공개 링크에는 넣지 않습니다.
4. Cloud Run의 `GET /health`, `GET /api/map-config`, `GET /api/auth/config`, 인증된 개발자의 `POST /api/place-extract`, 그리고 공개 웹의 동일 출처 재작성 경로를 통한 인증된 `POST`·`GET`·`DELETE` 요청을 `/api/content-save`에서 확인합니다. 두 번째 계정이 첫 번째 계정의 행을 읽을 수 없는지, Supabase에 조작한 분석 결과를 직접 쓸 수 없는지, 개발자 테스트 한도가 적용되는지 확인합니다. 날짜가 일부만 있는 행사와 좌표가 모호한 장소도 검사합니다. 어느 쪽에도 근거 없는 날짜나 지도 핀이 추가되어서는 안 됩니다.

공식 추출 API 요청은 `POST /api/content-extract`입니다. `Authorization: Bearer <Supabase user access token>`, `Content-Type: application/json`, 요청 본문 `{"url":"https://www.instagram.com/p/.../","content_types":["place","event"]}`를 사용합니다. 응답은 기존 `results[0].places`와 `results[0].map_locations`를 유지하고 `results[0].events`와 `results[0].content_kind`를 추가합니다. 각 행사에는 `event_type`(`exhibition`, `pop_up`, `other`), `start_date`, `end_date`, `date_text`, `time_text`, `venue_name`, `address`, `evidence`, `needs_review`, `notes`를 사용합니다. 검토가 필요하다고 표시된 지도 좌표와 행사 날짜는 확인된 사실이 아닌 후보로 취급합니다.

공식 저장 API인 `POST /api/content-save`는 동일한 Bearer 토큰과 요청 본문을 사용하며 `{item, analysis_status, analysis_notes, warnings}`를 반환합니다. `GET /api/content-save?limit=2&offset=0`은 `{items, next_offset}`을 반환합니다. 두 매개변수는 선택 사항이며, 포함된 이미지 데이터가 함수 응답 크기 제한을 넘지 않도록 페이지당 최대 2개 항목을 반환합니다. `DELETE /api/content-save`는 `{"url":"https://www.instagram.com/p/.../"}`를 받아 `{deleted}`를 반환합니다. 분석 오류가 발생하더라도 한도 사용이 확정된 뒤라면 분석 1회를 사용하며, 링크는 검토가 필요한 상태로 저장할 수 있습니다. 데이터베이스에는 원본 동영상, 캡션 전문, OCR 결과 전문을 저장하지 않습니다. 프로필·표지·장소 썸네일에는 각각 명시적인 크기 제한이 있고, 생략된 썸네일은 `warnings`에 표시됩니다. 로그인한 브라우저에는 Supabase 공개 키만 전달됩니다. 백엔드는 저장용 비밀 키를 사용하기 전에 액세스 토큰을 별도로 검증합니다.

이 저장소는 `pinmap-team`에서 공개되어 있으며, 기존 `pinmap-backend` Vercel 프로젝트에 직접 연결되어 있습니다. `main`에 푸시하면 Vercel API가 배포되고, 풀 리퀘스트에는 미리보기 배포가 제공됩니다. GitHub의 `Backend tests` 워크플로가 코드를 검사하지만 Vercel의 기본 Git 배포는 이 워크플로가 통과할 때까지 기다리지 않습니다. 미리보기 환경에 서버 전용 테스트 자격 정보가 있으므로 Vercel 프로젝트의 Git Fork Protection을 활성화된 상태로 유지합니다.

Vercel의 Git 배포는 별도의 Cloud Run 추출기를 다시 배포하지 않습니다. `.vercel/`과 로컬 테스트 접근 코드 파일을 Git에 올리지 마세요. 배포에 실패하면 다시 변경하기 전에 Vercel 프로젝트의 배포 로그와 GitHub 테스트 결과를 확인합니다.

이전 로컬 AI 백엔드는 `packages/multiuser/`에 별도 서비스로 보관되어 있습니다. 자체 API, SQLite 저장소, 작업자는 Vercel API 경로나 공식 사이트의 인증 체계를 공유하지 않습니다. `.vercelignore`는 이 소스가 Vercel에 배포되지 않도록 제외하며, CI 워크플로는 해당 서비스의 테스트를 별도로 실행합니다. 실행 방법은 패키지 README를 참고하세요. 공개 인스타그램 링크와 지도 후보 검색에는 같은 처리 흐름의 로컬 복사본 대신 이 저장소의 Cloud Run 추출기를 사용합니다. 이전 사용자 내보내기 자료나 로컬 데이터베이스는 이 패키지에 포함되지 않습니다.

인증 정보, 브라우저 프로필, 수집한 미디어, 생성된 결과물을 Git에 넣지 않습니다. `.env.example`에는 환경 변수 이름만 있습니다. 테스트에서는 유료 AI 또는 Places API를 호출하지 않습니다.

`npm test`를 실행하면 API와 Python 검색 로직을 검사합니다. Cloud Run의 `GET /health`는 프로세스가 실행 중인지 확인하지만, 인스타그램 접근이나 외부 AI 서비스 이용 가능 여부까지 보장하지는 않습니다.

## 저장된 장소의 사진 대체 방식

`POST /api/content-photo`는 저장된 콘텐츠의 UUID와 장소 인덱스만 받습니다. Supabase 사용자를 검증하고 해당 사용자가 저장한 장소를 읽습니다. 기존 게시물 썸네일을 우선 사용합니다. 썸네일이 없으면 정규화한 장소 이름과 반경 150m 이내 좌표를 기준으로 새 Google Places 사진을 찾습니다. `map_locations`에는 `google_place_id`만 저장하고 Google 사진 이름, URI, 이미지 바이트는 저장하지 않습니다. 화면에 표시하는 각 Google 사진에는 작성자 표시와 Google 지도 원본 링크를 함께 제공합니다.

`GOOGLE_MAPS_SERVER_KEY`는 서버 전용입니다. 토큰으로 보호되는 관리용 `POST /api/photo-backfill`은 기존에 저장된 장소의 누락된 장소 ID를 한 번에 최대 6개씩 채웁니다. 임의의 데이터베이스 변경 요청은 받지 않으며 건수와 커서만 반환합니다. 원본 썸네일, 계정 소유권, 출처 URL, 저장 시각은 그대로 두고, 최초 업데이트 시각을 확인해 그사이 변경된 콘텐츠는 건너뜁니다. 지도 제공자 요청에 실패하면 재시도를 위해 해당 묶음 작업을 멈춥니다. 관리용 토큰은 `PINMAP_EXTRACTOR_TOKEN`이며 브라우저 코드에 들어가서는 안 됩니다.

## 분석 성능

추출기는 OCR 전에 완전히 동일한 정지 이미지를 제거합니다. 표지와 슬라이드가 중복되면 슬라이드의 근거를 우선하며, 동영상의 서로 다른 시점은 유지합니다. 첫 OCR 결과는 빈 결과나 실패 결과를 포함해 장소 사진 매칭에도 재사용하므로 슬라이드 전체에 Tesseract를 다시 실행하지 않습니다. 1-vCPU 이미지에서는 `OMP_THREAD_LIMIT=1`을 설정해 CPU 자원 경쟁을 줄입니다.

하나의 구조화된 모델 응답으로 누락된 장소·행사 후보와 제목·요약을 받습니다. 기존의 원본 파일 확인, 날짜 근거 확인, 검토 필요 여부 검사 로직은 이전 경로와 공유합니다. 규칙 기반으로 이미 완성된 행사 후보는 유지하며, 요약만 필요한 요청에는 이미지를 보내지 않습니다. 통합 응답이 유효하지 않거나 불완전하면 이전 분석 함수로 돌아갑니다. 이전 AI 호출 방식을 사용하려면 `PINMAP_UNIFIED_ANALYSIS=0`으로 설정합니다.

AI에 보내는 긴 캡션·OCR·음성 전사에는 글자 수 상한을 적용하고, 잘린 중간 부분에서도 날짜·장소·행사 관련 문구를 우선 남깁니다. 이미 추출한 장소·행사는 요약에 필요한 이름·주소·날짜·근거만 다시 보냅니다. 동일한 모델·요청 본문·인증 키의 **완료된 JSON 응답**은 같은 Cloud Run 인스턴스에서 15분간 최대 32개 재사용하며, 동시에 들어온 동일 요청은 한 번만 호출합니다. 실패하거나 중단된 응답은 저장하지 않습니다. 원문이나 키는 캐시 식별자에 저장하지 않고 해시만 사용하며, 프로세스가 재시작되거나 다른 인스턴스로 요청이 가면 캐시는 공유되지 않습니다. `PINMAP_AI_CACHE_ENABLED=0`으로 끌 수 있습니다. `analysis_metrics`의 `ai_cache_hits`·`ai_cache_misses`로 재사용 여부를 확인할 수 있습니다. 실제 토큰 절감량은 배포 후 모델 사용량을 비교해 측정해야 합니다.

Google·Naver 장소 검색은 최대 4개 요청을 동시에 실행합니다. 게시물 하나에서 동일한 장소 이름·지역·검색어 조합은 한 번만 조회합니다. 후보 순위, 결과 순서, 검토 필요 여부는 동일한 입력에 대해 같은 결과가 나오도록 유지합니다. 공개 지오코딩 대체 경로는 순차적으로 실행하고, 같은 주소가 반복되면 이전 결과를 재사용합니다. `PINMAP_MAP_LOOKUP_WORKERS=1`로 설정하면 장소 검색을 순차 실행으로 되돌립니다.

구조화된 `analysis_timing` 로그와 추출 응답의 `analysis_metrics`에는 수집, 준비, OCR, AI, 지도 검색, 이미지 매칭 시간과 OCR 이미지 수, 선택된 AI 분석 방식이 포함됩니다. OCR 원문은 성능 지표에 중복해서 넣거나 시간 로그에 기록하지 않습니다. Vercel의 저장 콘텐츠 스키마에도 이 진단 정보는 저장되지 않습니다. Cloud Run 이미지는 Vercel과 별도로 배포하고 성능을 측정합니다.

### 팀 테스트 계정 로그인

웹 로그인 화면의 `테스트 계정으로 시작하기`는 `POST /api/auth/test-login`으로 지정된 팀 계정의 실제 Supabase 세션을 발급받습니다. 저장한 콘텐츠는 같은 계정을 사용하는 팀원끼리 공유됩니다. 기존 저장 API의 사용자별 접근 규칙과 추출 제한을 그대로 적용합니다.

서버 환경에 `PINMAP_TEST_LOGIN_ENABLED=true`, `PINMAP_TEST_LOGIN_PASSWORD`를 등록해야 버튼이 표시됩니다. 기존 Supabase URL·공개 키도 필요합니다. 기존 계정으로만 로그인하며 사용자를 생성하거나 비밀번호를 변경하지 않습니다. 비밀번호나 서버 키는 브라우저에 전달하지 않습니다. 테스트 종료 시 플래그를 `false`로 바꿉니다.
