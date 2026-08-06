# Supabase SQL Editor 상세 설정 가이드 — Part 46

## 1. 프로젝트 생성

1. Supabase Dashboard에서 `New project`를 누릅니다.
2. Organization을 선택합니다.
3. Project name에 `fruitmarket-production`을 입력합니다.
4. 강력한 Database password를 생성해 별도 비밀번호 관리자에 보관합니다.
5. 한국 사용자 대상이면 가까운 지원 Region을 선택합니다.
6. 프로젝트 생성이 끝날 때까지 기다립니다.

프로젝트 생성 후 `Project Settings → API` 또는 `Connect` 화면에서 아래 값을 확인합니다.

```text
Project URL       https://PROJECT_REF.supabase.co
Publishable key   sb_publishable_...
Project ref       PROJECT_REF
```

Secret/service role key와 Database password는 Netlify에 입력하지 않습니다.

## 2. SQL 파일 실행

ZIP의 `supabase/sql` 폴더를 엽니다. Dashboard에서 `SQL Editor → New query`를 누르고 각 파일 내용을 통째로 붙여넣은 후 `Run`을 누릅니다.

정확한 순서:

```text
01_schema.sql
02_functions_triggers.sql
03_rls_policies.sql
Storage 버킷 4개 생성
04_storage_policies.sql
05_seed_public_data.sql
07_commercial_hardening.sql
09_full_marketplace_schema.sql
10_full_marketplace_rpcs.sql
12_full_marketplace_operations.sql
11_full_marketplace_rls.sql
관리자 Auth 사용자 생성
06_make_admin_template.sql
08_verification_queries.sql
13_full_verification.sql
```

### 실행 중 오류가 난 경우

- 이미 존재한다는 알림만 발생하면 해당 파일의 `IF NOT EXISTS`, `DROP POLICY IF EXISTS` 여부를 확인합니다.
- 중간 파일이 실패하면 다음 파일로 넘어가지 말고 실패한 SQL의 첫 오류를 해결합니다.
- `12 → 11` 순서를 바꾸면 새 운영 테이블에 RLS가 누락될 수 있습니다.
- `13_full_verification.sql` 결과에서 누락 목록이 나오면 라이브 배포를 중단합니다.

## 3. Storage 버킷 생성

`Storage → New bucket`에서 아래 네 개를 정확한 이름으로 생성합니다.

| 버킷 | Public | 용도 |
|---|---:|---|
| `public-assets` | ON | 배너·공개 콘텐츠 |
| `product-images` | ON | 상품 이미지 |
| `seller-documents` | OFF | 사업자·입점 서류 |
| `claim-evidence` | OFF | 반품·교환 증빙 |

생성 후 `04_storage_policies.sql`을 실행합니다. 비공개 버킷은 공개 URL로 노출하지 않고 사용자·판매자·관리자 정책을 통해 접근합니다.

## 4. 관리자 사용자 생성

1. `Authentication → Users → Add user`로 이동합니다.
2. 관리자 이메일과 임시 비밀번호로 사용자를 생성합니다.
3. 이메일 인증을 완료합니다.
4. `06_make_admin_template.sql`을 열어 `ADMIN_EMAIL@example.com`을 실제 관리자 이메일로 교체합니다.
5. SQL Editor에서 실행합니다.
6. 아래 확인 SQL을 실행합니다.

```sql
select id, email, role, status
from public.profiles
where email = '실제관리자이메일';
```

`role=admin`, `status=active`여야 합니다. 관리자 페이지의 중요 기능은 MFA `aal2` 세션이 없으면 거부됩니다.

## 5. Auth URL 설정

`Authentication → URL Configuration`에 입력합니다.

```text
Site URL
https://fruit-market.netlify.app

Redirect URLs
https://fruit-market.netlify.app/auth-callback.html
https://fruit-market.netlify.app/payment-success.html
https://fruit-market.netlify.app/payment-fail.html
http://localhost:8888/auth-callback.html
```

사용 도메인이 달라지면 실제 Netlify URL로 교체합니다.

## 6. 이메일 인증·비밀번호 재설정

`Authentication → Email Templates`에서 가입 인증과 비밀번호 재설정 메일을 브랜드에 맞게 수정합니다. 메일의 복귀 주소는 `auth-callback.html`이 되도록 URL 설정을 먼저 완료합니다.

운영 발송량이 많아지면 Auth SMTP 설정에 실제 발신 도메인과 SMTP를 연결합니다. 기본 발송 제한만으로 상용 운영하지 않습니다.

## 7. Kakao OAuth

1. Kakao Developers에서 애플리케이션을 만듭니다.
2. Kakao 로그인 기능과 동의항목을 설정합니다.
3. Supabase `Authentication → Providers → Kakao`에서 Client ID/Secret을 입력합니다.
4. Supabase가 표시하는 callback URL을 Kakao 앱의 Redirect URI에 그대로 등록합니다.
5. Netlify 도메인의 `auth-callback.html`로 돌아오는지 테스트합니다.

프론트는 `signInWithOAuth({ provider: "kakao" })` 방식으로 연결돼 있습니다. Kakao 앱 설정이 없으면 버튼이 성공할 수 없습니다.

## 8. Edge Function Secrets

로컬 Supabase CLI 또는 Dashboard의 Function Secrets에 아래 값을 넣습니다.

필수 공통:

```text
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_... 또는 service role key
PUBLIC_SITE_URL=https://fruit-market.netlify.app
ALLOWED_ORIGINS=https://fruit-market.netlify.app
REQUIRE_ADMIN_MFA=true
FRUITMARKET_CRON_SECRET=32자 이상 무작위 문자열
ACCOUNT_ENCRYPTION_KEY_BASE64=32바이트 Base64
```

Toss 테스트 등록 후:

```text
TOSS_ENVIRONMENT=test
TOSS_SECRET_KEY=test_sk_...
```

지급대행 계약 후:

```text
TOSS_PAYOUT_REQUEST_URL=공급자 요청 URL
TOSS_PAYOUT_SECRET_KEY=지급대행 Secret
TOSS_PAYOUT_WEBHOOK_SECURITY_KEY=웹훅 검증키
```

본인·사업자 확인 공급자 연결 시:

```text
IDENTITY_PROVIDER_START_URL
IDENTITY_PROVIDER_API_KEY
BUSINESS_VERIFICATION_ENDPOINT
BUSINESS_VERIFICATION_API_KEY
```

테스트용 신원확인 성공값을 운영에서 활성화하지 않습니다.

## 9. Edge Functions 배포

Supabase CLI:

```bash
supabase login
supabase link --project-ref PROJECT_REF
supabase functions deploy api
supabase functions deploy health --no-verify-jwt
supabase functions deploy checkout-prepare
supabase functions deploy payment-confirm
supabase functions deploy payment-cancel
supabase functions deploy payment-webhook --no-verify-jwt
supabase functions deploy payout-run
supabase functions deploy scheduled-jobs --no-verify-jwt
```

GitHub 배포 시 Repository Secrets에 다음 두 값을 넣습니다.

```text
SUPABASE_ACCESS_TOKEN
SUPABASE_PROJECT_ID
```

이후 Actions의 `Deploy Supabase Edge Functions`를 실행합니다.

## 10. GitHub 정기 작업 Secret

`Run Fruitmarket Scheduled Jobs` 워크플로에 사용합니다.

```text
SUPABASE_FUNCTIONS_URL=https://PROJECT_REF.supabase.co/functions/v1
FRUITMARKET_CRON_SECRET=Edge Function과 동일한 값
```

워크플로는 매시간 15분에 예약·자동확정·운영 유지보수를 호출합니다. 동일 시간대의 중복 실행은 DB run key로 멱등 처리합니다.

## 11. 설치 검증

SQL Editor에서 실행:

```sql
select count(*) as public_table_count
from pg_tables
where schemaname = 'public';

select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;

select * from public.banners order by sort_order;
select public.run_marketplace_scheduled_jobs();
```

프로젝트의 `13_full_verification.sql` 결과가 모두 정상이고, 모든 public 테이블의 `rowsecurity=true`인지 확인합니다.

## 12. 절대 하지 말아야 할 것

- service role/secret key를 HTML, GitHub, Netlify에 넣기
- RLS를 끄고 오류를 해결하기
- 결제금액을 브라우저 값으로 확정하기
- 상품 재고를 브라우저에서 직접 차감하기
- 관리자 MFA를 운영에서 끄기
- 실지급 성공을 수동 DB 업데이트로 위조하기

## Part 48 상호 피해보호 추가

기존 SQL을 모두 실행한 다음 다음 두 파일을 순서대로 실행합니다.

1. `19_mutual_fraud_and_abuse_protection.sql`
2. `20_part48_verification.sql`

검증 결과의 `part48_mutual_protection_readiness.release_ready`는 실제 담당인력, 증거수집, 배송증거 연동, 정산계좌 재검증, 오탐 점검, 이의제기 절차가 모두 운영에서 확인되기 전에는 `false`가 정상입니다. SQL 설치 성공과 운영준비 완료는 서로 다른 상태입니다.
