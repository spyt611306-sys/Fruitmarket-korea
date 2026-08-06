# Netlify · GitHub · Supabase 배포 상세 가이드 — Part 46

## 전체 구조

```text
GitHub Private Repository
 ├─ Netlify가 site를 빌드해 dist 배포
 ├─ GitHub Actions가 코드·SQL·브라우저 검사
 └─ GitHub Actions가 Supabase Edge Functions 배포

Netlify 브라우저
 ├─ Supabase Auth/Database/Storage
 └─ Supabase Edge Functions
      ├─ 주문·재고·결제·환불
      ├─ 관리자·판매자 API
      └─ 정산·웹훅·예약 작업
```

## 1. GitHub 저장소

1. GitHub에서 `New repository`를 선택합니다.
2. 이름을 `fruitmarket-production`으로 입력합니다.
3. `Private`를 선택합니다.
4. README, License, gitignore 자동생성은 해제합니다.
5. `02-fruitmarket-part46-github-repository.zip`을 압축 해제합니다.
6. `fruitmarket-production` 폴더 안의 파일을 저장소 루트에 업로드합니다.

PowerShell 방식:

```powershell
cd "C:\FruitMarket\fruitmarket-production"
.\deployment\GITHUB-UPLOAD.ps1 `
  -RepositoryUrl "https://github.com/본인아이디/fruitmarket-production.git"
```

정상 루트:

```text
package.json
netlify.toml
site/
supabase/
scripts/
tests/
.github/
```

저장소 안에 같은 이름의 폴더가 한 단계 더 들어가면 Netlify가 `package.json`을 찾지 못합니다.

## 2. GitHub Actions 확인

`Actions → Verify Fruitmarket Part 46`를 열어 녹색 완료를 확인합니다.

검사 내용:

- 정적 보안검사
- 인라인 JavaScript 44개 문법
- SQL/RLS/함수 검증
- UI API 경로 171개 연결 범위
- Edge Function TypeScript 검사
- PC·모바일 브라우저 검사
- Netlify pre-PG 빌드
- 공개 결과물에 Secret이 없는지 검사

`main` 브랜치에는 Ruleset을 적용해 해당 Action 통과 전 병합을 막는 편이 안전합니다.

## 3. GitHub Secrets

`Settings → Secrets and variables → Actions`에 입력합니다.

Edge Function 배포:

```text
SUPABASE_ACCESS_TOKEN
SUPABASE_PROJECT_ID
```

정기 작업:

```text
SUPABASE_FUNCTIONS_URL=https://PROJECT_REF.supabase.co/functions/v1
FRUITMARKET_CRON_SECRET=Supabase Secret과 동일한 값
```

Toss secret/service role key는 GitHub Action에 둘 필요가 없으며 Supabase Function Secrets에서 관리합니다.

## 4. Netlify Git 연결

1. Netlify에서 `Add new project → Import an existing project`를 선택합니다.
2. GitHub를 연결합니다.
3. `fruitmarket-production` 저장소를 선택합니다.
4. 다음 설정을 확인합니다.

```text
Base directory       비움
Build command        npm run build
Publish directory    dist
Production branch    main
```

`netlify.toml`에도 동일 설정이 들어 있습니다.

## 5. Netlify 공개 환경변수

`Project configuration → Environment variables`에서 입력합니다.

PG 등록 전:

```text
FRUITMARKET_SITE_URL=https://fruit-market.netlify.app
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
FRUITMARKET_PAYMENTS_ENABLED=false
FRUITMARKET_SETTLEMENTS_ENABLED=false
TOSS_CLIENT_KEY=
```

Toss 테스트 연결 후:

```text
TOSS_CLIENT_KEY=test_ck_...
FRUITMARKET_PAYMENTS_ENABLED=true
```

지급대행 연동·검증 후:

```text
FRUITMARKET_SETTLEMENTS_ENABLED=true
```

Netlify에 입력 금지:

```text
SUPABASE_SECRET_KEY
SUPABASE_SERVICE_ROLE_KEY
TOSS_SECRET_KEY
TOSS_PAYOUT_SECRET_KEY
DATABASE_PASSWORD
```

## 6. Netlify 사이트 이름

`Project configuration → General → Project details`에서 사이트 이름을 `fruit-market`으로 지정하면 기본 주소는 다음 형태입니다.

```text
https://fruit-market.netlify.app
```

다른 이름을 사용하면 Supabase Auth URL, Kakao Redirect URL, Function `PUBLIC_SITE_URL`, Toss 성공/실패 URL을 모두 새 주소로 바꿉니다.

## 7. Netlify 수동 업로드

GitHub 연결 전에 화면을 확인할 때만 사용합니다.

1. `01-fruitmarket-part46-netlify-drag-drop.zip`을 압축 해제합니다.
2. `config/supabase-config.js`를 엽니다.
3. 실제 Project URL과 publishable key를 입력합니다.
4. Netlify `Deploy manually` 화면에 **압축을 푼 폴더 전체**를 드래그합니다.

`index.html`만 올리면 배너, 과일 아이콘, Supabase 어댑터, 결제 콜백 페이지가 누락됩니다.

## 8. Supabase Function 배포

GitHub Actions의 `Deploy Supabase Edge Functions`를 수동 실행하거나 CLI를 사용합니다. 배포 후 확인:

```text
https://PROJECT_REF.supabase.co/functions/v1/health
```

`api` 함수의 공개 상품·배너 조회, 로그인 상태 API, 관리자 MFA 거부가 예상대로 동작하는지 확인합니다.

## 9. Toss 테스트 연결

1. Toss 테스트 client key를 Netlify에 입력합니다.
2. Toss 테스트 secret key를 Supabase Function Secret에 입력합니다.
3. `TOSS_ENVIRONMENT=test`를 입력합니다.
4. 성공 URL을 `/payment-success.html`, 실패 URL을 `/payment-fail.html`로 사용합니다.
5. 웹훅 URL을 다음으로 등록합니다.

```text
https://PROJECT_REF.supabase.co/functions/v1/payment-webhook
```

6. 테스트 결제, 중복 승인, 전체취소, 부분취소, 웹훅 재전송을 검증합니다.
7. live 계약 후 test key를 live key로 교체하고 다시 E2E 테스트합니다.

## 10. 배포 후 점검 주소

```text
https://fruit-market.netlify.app/
https://fruit-market.netlify.app/auth-callback.html
https://fruit-market.netlify.app/payment-success.html
https://fruit-market.netlify.app/payment-fail.html
https://fruit-market.netlify.app/build-manifest.json
https://PROJECT_REF.supabase.co/functions/v1/health
```

`build-manifest.json`에서 다음을 확인합니다.

```text
version = 45.0.0
backend = Supabase
containsServerSecret = false
paymentsEnabled = 실제 설정값
```

## 11. 상용 오픈 전 E2E 체크

- 소비자 가입·메일인증·로그인·Kakao 로그인
- 비밀번호 재설정·세션 복원·정지계정 차단
- 주소·장바구니·찜·쿠폰·포인트
- 옵션별 재고·동시 주문 충돌
- 0원 주문·테스트 결제·실패·중복콜백
- 전체취소·부분취소·반품환불·재고복귀
- 생산자 입점·상품·엑셀·주문·송장·클레임
- 관리자 MFA·입점/상품 승인·환불·정산 이중승인
- 웹훅 재전송·예약 만료·자동구매확정
- PC·모바일 실제 기기 점검

외부 키가 없는 로컬 정적검사는 이 단계의 실서비스 검증을 대체하지 않습니다.

## Part 48 추가 배포 확인

- GitHub Actions 이름: `Verify Fruitmarket Part 48`
- SQL 추가: `19_mutual_fraud_and_abuse_protection.sql`, `20_part48_verification.sql`
- 프론트 추가: `site/assets/js/mutual-protection-ui.js`
- 공개 정책: `/policies/trust-safety.html`
- 외부 운영준비 검증 전 결제·정산 비활성 유지
