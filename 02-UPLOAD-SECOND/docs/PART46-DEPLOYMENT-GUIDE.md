# 푸릇마켓 Part 46 — Netlify·GitHub·Supabase 상용화 배포 가이드

> 이 문서는 `fruit-market.netlify.app` 프론트, GitHub Private 저장소, Supabase Database/Auth/Storage/Edge Functions 구조를 기준으로 작성했습니다. 화면은 기존 Part 32 푸릇마켓 UI를 보존하며, 민감한 주문·결제·환불·정산 로직은 브라우저가 아닌 Edge Functions와 PostgreSQL RPC에서 처리합니다.

---

## 0. 준비할 값

먼저 메모장에 아래 값을 정리합니다. Secret 값은 GitHub 파일이나 Netlify에 저장하지 않습니다.

```text
SUPABASE_PROJECT_REF=
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_ACCESS_TOKEN=GitHub_Actions_배포용

PUBLIC_SITE_URL=https://fruit-market.netlify.app
ALLOWED_ORIGINS=https://fruit-market.netlify.app

FRUITMARKET_CRON_SECRET=길고_무작위인_문자열
ACCOUNT_ENCRYPTION_KEY_BASE64=32바이트_키_Base64

TOSS_ENVIRONMENT=test
TOSS_CLIENT_KEY=test_ck_...
TOSS_SECRET_KEY=test_sk_...
```

실제 지급대행과 외부 검증을 사용할 때만 아래 값을 추가합니다.

```text
IDENTITY_PROVIDER_START_URL=
IDENTITY_PROVIDER_API_KEY=
BUSINESS_VERIFICATION_ENDPOINT=
BUSINESS_VERIFICATION_API_KEY=
TOSS_PAYOUT_REQUEST_URL=
TOSS_PAYOUT_SECRET_KEY=
TOSS_PAYOUT_WEBHOOK_SECURITY_KEY=
```

---

# 1. Supabase 프로젝트 생성

1. Supabase Dashboard에 로그인합니다.
2. `New project`를 선택합니다.
3. Organization을 선택합니다.
4. Project name을 `fruitmarket-production`으로 입력합니다.
5. 강력한 Database password를 생성해 별도 비밀번호 관리자에 보관합니다.
6. 한국 사용자 중심이면 지연시간을 고려해 가까운 Region을 선택합니다.
7. 프로젝트 생성이 끝나면 `Project Settings → API Keys`에서 Project URL과 Publishable key를 확인합니다.

브라우저에는 Publishable key만 사용합니다. Secret/service role 계열 키는 RLS를 우회할 수 있으므로 Edge Functions 이외에 노출하지 않습니다.

---

# 2. SQL Editor 실행

## 2-1. 실행 방법

1. Supabase Dashboard 왼쪽에서 `SQL Editor`를 선택합니다.
2. `New query`를 누릅니다.
3. `03-SUPABASE-SETUP/sql` 폴더의 파일을 메모장 또는 VS Code로 엽니다.
4. 파일 전체를 복사해 SQL Editor에 붙여넣습니다.
5. 오른쪽 아래 `Run`을 누릅니다.
6. 성공 메시지를 확인한 뒤 다음 파일로 넘어갑니다.

## 2-2. 정확한 실행 순서

```text
01_schema.sql
02_functions_triggers.sql
03_rls_policies.sql
[Storage 버킷 생성]
04_storage_policies.sql
05_seed_public_data.sql
07_commercial_hardening.sql
09_full_marketplace_schema.sql
10_full_marketplace_rpcs.sql
12_full_marketplace_operations.sql
11_full_marketplace_rls.sql
[관리자 Auth 사용자 생성]
06_make_admin_template.sql
08_verification_queries.sql
13_full_verification.sql
14_marketplace_legal_compliance.sql
15_fruit_specialization.sql
16_marketplace_operations_controls.sql
17_part46_verification.sql
08_verification_queries.sql 재실행
13_full_verification.sql 재실행
```

`12 → 11` 순서와 `14 → 15 → 16` 순서를 바꾸지 않습니다.

## 2-3. Part 46 SQL에서 추가되는 핵심

### 오픈마켓 법률·운영

- 판매자 신원·사업자 검증 상태
- 판매자 계약 버전과 수락 증거
- 통신판매중개 고지와 법률검토 상태
- 주문 당시 판매자·정책·반품조건 스냅샷
- 분쟁 접수·진행·처리결과와 3/10영업일 기한
- 법적 보존정책, Legal Hold, 관리자 작업증거
- 정산 보류, 조정, 대사, 세금서류
- 판매자 성과와 제재 이력

### 과일 전문 기능

- 품종, 산지, 등급, 수확일, 포장일, 당도, 산도, 보관온도
- 농산물 로트, 입고수량, 가용수량, 안전재고, 유통기한
- FEFO 방식 출고 예약
- 품질검사와 증빙
- 냉장·상온 유통 이벤트
- 리콜과 구매자 통지
- 지역·요일·기상조건 배송 가능 여부

### 라이브 판매 게이트

다음 조건이 모두 충족되지 않으면 DB가 상품의 최종 판매승인을 거부합니다.

```text
판매자 활성·승인·사업자검증
현재 판매자 계약 수락
법률검토 완료된 중개고지
원산지
상품정보제공고시
반품정책 스냅샷
금지광고표현 검사
과일 신선정보 승인
품질 증빙과 로트 판매가능 상태
```

---

# 3. Storage 버킷 생성

SQL `04_storage_policies.sql` 실행 전에 Dashboard의 `Storage`에서 다음 버킷을 생성합니다.

| 버킷 | Public | 용도 |
|---|---:|---|
| `public-assets` | ON | 로고·배너·공개 콘텐츠 |
| `product-images` | ON | 상품 대표·상세 이미지 |
| `seller-documents` | OFF | 사업자등록증·입점·KYC 서류 |
| `claim-evidence` | OFF | 반품·교환·분쟁 증빙 |

생성 후 `04_storage_policies.sql`을 실행합니다. 비공개 버킷의 URL을 DB 공개 필드에 직접 노출하지 않고, 로그인·역할 검증 후 signed URL을 발급하도록 유지합니다.

---

# 4. 관리자 계정 생성

1. `Authentication → Users`로 이동합니다.
2. `Add user`를 선택합니다.
3. 관리자 이메일과 강력한 초기 비밀번호를 입력합니다.
4. 관리자 이메일 인증 상태를 확인합니다.
5. `06_make_admin_template.sql`을 열어 `ADMIN_EMAIL@example.com`을 방금 만든 이메일로 변경합니다.
6. SQL Editor에서 실행합니다.
7. 다음 쿼리로 확인합니다.

```sql
select id, email, role, status
from public.profiles
where email = '관리자이메일';
```

`role=admin`, `status=active`여야 합니다. 운영 관리자는 MFA를 등록하고, 지급·정산·민감정보 작업에서 재인증을 사용합니다.

---

# 5. Auth URL·이메일·Kakao 설정

## 5-1. URL Configuration

`Authentication → URL Configuration`에서 입력합니다.

```text
Site URL
https://fruit-market.netlify.app

Redirect URLs
https://fruit-market.netlify.app/**
https://fruit-market.netlify.app/auth-callback.html
http://localhost:8888/**
```

## 5-2. 이메일

운영 전 SMTP 공급자를 연결하고 다음 흐름을 실제 메일로 테스트합니다.

```text
회원가입 인증
인증메일 재전송
비밀번호 찾기
비밀번호 재설정
이메일 변경
탈퇴 안내
```

## 5-3. Kakao OAuth

1. Kakao Developers에서 앱을 생성합니다.
2. REST API key와 Client Secret을 준비합니다.
3. Supabase `Authentication → Providers → Kakao`에 입력합니다.
4. Supabase가 안내하는 Callback URL을 Kakao 앱 Redirect URI에 등록합니다.
5. Netlify 운영 도메인에서 실제 로그인·로그아웃·재로그인을 테스트합니다.

---

# 6. Edge Function Secrets 입력

Dashboard의 `Edge Functions → Secrets` 또는 CLI에서 설정합니다.

```bash
supabase secrets set \
  PUBLIC_SITE_URL=https://fruit-market.netlify.app \
  ALLOWED_ORIGINS=https://fruit-market.netlify.app \
  REQUIRE_ADMIN_MFA=true \
  FRUITMARKET_CRON_SECRET='무작위_긴_문자열' \
  ACCOUNT_ENCRYPTION_KEY_BASE64='32바이트_Base64' \
  TOSS_ENVIRONMENT=test \
  TOSS_SECRET_KEY='test_sk_...'
```

호스팅된 Supabase Functions에는 프로젝트 URL과 키가 기본 제공될 수 있지만, 코드가 요구하는 이름과 실제 Dashboard 환경을 확인합니다. `.env` 파일은 `.gitignore`에 포함시키고 commit하지 않습니다.

---

# 7. Edge Functions 배포

## 7-1. CLI 설치와 연결

프로젝트 루트에서 실행합니다.

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

## 7-2. 배포

```bash
supabase functions deploy api
supabase functions deploy health --no-verify-jwt
supabase functions deploy checkout-prepare
supabase functions deploy payment-confirm
supabase functions deploy payment-cancel
supabase functions deploy payment-webhook --no-verify-jwt
supabase functions deploy payout-run
supabase functions deploy scheduled-jobs --no-verify-jwt
```

배포 후 공개 상태확인을 테스트합니다.

```text
https://PROJECT_REF.supabase.co/functions/v1/health
```

결제 웹훅과 scheduled-jobs는 JWT 대신 공급자 검증 또는 별도 Cron Secret을 사용하므로 공개 함수처럼 보이더라도 내부 검증을 제거하지 않습니다.

---

# 8. GitHub 업로드

## 8-1. 저장소 만들기

1. GitHub에서 `New repository`를 선택합니다.
2. 이름을 `fruitmarket-production`으로 입력합니다.
3. `Private`를 선택합니다.
4. README, .gitignore, License 자동 생성을 해제하고 생성합니다.

## 8-2. 업로드

`02-GITHUB-REPOSITORY/fruitmarket-production` 폴더 안에서 PowerShell을 엽니다.

```powershell
git init -b main
git add .
git status
git commit -m "Fruitmarket Part 46 marketplace hardening"
git remote add origin https://github.com/본인아이디/fruitmarket-production.git
git push -u origin main
```

## 8-3. GitHub Actions Secrets

`Settings → Secrets and variables → Actions`에서 다음 Repository secret을 생성합니다.

```text
SUPABASE_ACCESS_TOKEN
SUPABASE_PROJECT_ID
SUPABASE_FUNCTIONS_URL=https://PROJECT_REF.supabase.co/functions/v1
FRUITMARKET_CRON_SECRET
```

Production Environment를 만들고 Edge Function 배포 작업에 required reviewer를 설정하면 실수로 main push만으로 민감한 운영 배포가 진행되는 위험을 줄일 수 있습니다.

## 8-4. 검증 확인

`Actions → Verify Fruitmarket Part 46`에서 모두 녹색인지 확인합니다.

```text
정적검사
인라인 JS
SQL/RLS
API 경로
Edge Function TypeScript
프로세스 시뮬레이션
모바일·PC 브라우저 감사
Netlify PRE-PG 빌드
Secret 노출 검사
```

---

# 9. Netlify 배포

## 9-1. GitHub 연결 방식

1. Netlify → `Add new project`
2. `Import an existing project`
3. GitHub 연결
4. `fruitmarket-production` 선택
5. 설정 확인

```text
Base directory: 비움
Build command: npm run build
Publish directory: dist
```

## 9-2. Netlify 환경변수

`Site configuration → Environment variables`에서 설정합니다.

```text
FRUITMARKET_SITE_URL=https://fruit-market.netlify.app
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
TOSS_CLIENT_KEY=
FRUITMARKET_PAYMENTS_ENABLED=false
FRUITMARKET_SETTLEMENTS_ENABLED=false
```

결제 테스트가 끝나기 전까지 두 기능 플래그는 false를 유지합니다. Netlify에 `TOSS_SECRET_KEY`, Supabase secret/service role key, DB password를 입력하지 않습니다.

## 9-3. 수동 업로드 방식

`01-NETLIFY-DRAG-DROP` 폴더의 `config/supabase-config.js`를 실제 공개 값으로 수정한 뒤, ZIP이 아니라 압축 해제한 폴더 전체를 `Deploy manually` 화면에 드래그합니다.

수동 업로드는 화면 확인용으로만 사용하고, 운영은 GitHub 연결 배포를 권장합니다. Git 연동이 있어야 수정 이력과 자동검사를 함께 관리할 수 있습니다.

---

# 10. Toss 테스트와 라이브 전환

## 10-1. 테스트해야 할 결제 흐름

```text
정상 승인
같은 주문 중복클릭
금액 위변조
재고부족
결제창 이탈
승인 성공 후 DB 실패 보상취소
전체취소
부분취소
반품 입고 후 환불
쿠폰 복원
포인트 복원
웹훅 중복 수신
웹훅 순서 역전
결제 승인과 웹훅 대사
```

## 10-2. 활성화 순서

1. Supabase Secret에 Toss test secret key 입력
2. Netlify에 test client key 입력
3. `FRUITMARKET_PAYMENTS_ENABLED=true`
4. 테스트 승인·취소·웹훅을 완료
5. PG 심사와 운영정책 검토 완료
6. 라이브 client/secret key로 교체
7. 같은 E2E 테스트를 소액으로 다시 수행
8. 결제와 정산 기능 플래그를 단계적으로 활성화

운영자가 구매대금을 직접 보관하거나 독자적인 지급대행을 구현하지 말고, 계약된 PG·에스크로·지급대행 공급자의 구조와 책임범위를 사용합니다.

---

# 11. 판매자·상품 최초 운영

## 판매자

```text
입점 신청
사업자번호·대표자·연락처·주소 검증
본인확인 및 서류 검토
현재 판매자 계약 수락
반품지·정산계좌·KYC 확인
관리자 승인
```

## 과일 상품

```text
카테고리·상품명·품종
원산지와 생산자
상품정보제공고시
대표·상세 이미지
옵션·SKU·포장단위·중량
판매가·배송비·제주/도서산간 정책
반품·환불 조건
수확일·포장일·보관온도·당도·등급
품질증빙
재고 로트와 유통기한
관리자 신선정보 심사
상품 최종 승인
```

과장된 효능, 질병 예방·치료 표현, 근거 없는 최고·최상급 비교표현은 등록단계에서 차단하고 증빙이 있는 객관적 품질정보만 노출합니다.

---

# 12. 운영 준비 게이트

`operation_readiness`와 Part 46 검증 SQL에서 다음 항목을 완료합니다.

```text
중개고지 법률검토
구매자 약관·개인정보 정책
판매자 계약
PG·결제보호 계약
지급대행·KYC 계약
판매자 신원 검증
과일 로트 추적
리콜 모의훈련
분쟁 담당자와 SLA
개인정보 내부관리계획
백업·복구 훈련
모바일·PC UX 감사
```

증거 URL, 승인자, 승인일, 만료일을 기록합니다. 체크박스만 임의로 true로 바꾸지 않습니다.

---

# 13. 오픈 전 E2E 체크리스트

## 소비자

- 신규가입 → 이메일 인증 → 로그인
- 주소검색 → 상세주소 → 기본배송지
- 검색 → 옵션 → 장바구니 → 쿠폰/포인트 → 결제
- 주문내역 → 배송 → 구매확정 → 리뷰
- 취소·반품·교환 → 증빙 → 환불
- 문의·분쟁 → 진행안내 → 처리결과
- 비밀번호 재설정·탈퇴

## 생산자

- 입점신청 → 계약수락 → 승인
- 상품 1건·옵션 2개·이미지 3개 등록
- 로트 2개 등록 후 FEFO 확인
- 판매승인 실패 사유와 정상 승인 확인
- 주문 알림 → 상품준비 → 송장 → 출고
- 문의 답변·클레임 대응
- 정산 예정·보류·조정 확인

## 관리자

- 판매자 승인·반려·정지
- 상품 원산지·신선정보·광고표현 심사
- 배너·카테고리·추천상품
- 분쟁 3/10영업일 기한
- 리콜 로트 판매차단·구매자 통지
- 환불·부분환불·웹훅 대사
- 정산 이중승인·지급대사
- 개인정보 요청·파기·감사로그

---

# 14. 장애 시 우선 확인

| 증상 | 확인 위치 |
|---|---|
| 버튼 눌러도 반응 없음 | 브라우저 Console, `FruitMarketSafeAction`, API 함수 로그 |
| 로그인 후 다시 로그아웃됨 | Auth URL, 세션, RLS, profile status |
| 상품 승인 실패 | 판매자 계약·검증, 법률고지, 원산지, 신선정보, 품질증빙 |
| 배너가 안 넘어감 | 배너 3개 파일, browser audit, API 배너 응답 |
| 이미지 403 | Storage public/private, RLS, signed URL |
| 결제 401/403 | JWT, Edge Function verify_jwt, Auth 세션 |
| 결제 금액 오류 | 서버 재계산, 쿠폰·포인트, 배송비, option SKU |
| 중복 주문 | idempotency key, checkout_requests, payment_attempts |
| 정산금액 불일치 | refunds, settlement_adjustments, reconciliations |
| 모바일 화면 잘림 | 390px browser audit, 긴 텍스트, 표 스크롤 컨테이너 |

---

# 15. 최종 판단

Part 46은 오픈마켓과 과일 전문 플랫폼에 필요한 기능을 코드와 DB 구조로 최대한 연결하고, 잘못된 판매·결제·정산·리콜 상태를 DB와 서버에서 차단하도록 보완한 후보본입니다. 실제 상용화 승인은 실계정·실계약·실데이터·법률검토·부하·복구 테스트가 모두 끝난 뒤 운영자가 결정해야 합니다.
