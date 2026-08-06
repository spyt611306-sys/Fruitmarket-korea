# Supabase Edge Functions — Part 46

## 함수 목록

- `api`: 소비자·생산자·관리자 REST 호환 게이트웨이
- `health`: 공개 상태확인
- `checkout-prepare`: 가격·배송비·쿠폰·포인트·재고를 서버에서 검증하고 주문/결제 시도 생성
- `payment-confirm`: Toss 승인, 0원 주문, DB 최종 반영, 실패 시 보상취소
- `payment-cancel`: 전체/부분취소·클레임 환불·재고복귀
- `payment-webhook`: 결제·지급·판매자 상태 웹훅 멱등 처리와 공급자 조회 대사
- `payout-run`: 이중승인 정산의 지급대행 공급자 요청
- `scheduled-jobs`: 예약만료·자동구매확정·정기 유지보수

## Secret 설정

```bash
supabase secrets set \
  SUPABASE_URL=https://PROJECT_REF.supabase.co \
  SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx \
  SUPABASE_SECRET_KEY=sb_secret_xxx \
  PUBLIC_SITE_URL=https://fruit-market.netlify.app \
  ALLOWED_ORIGINS=https://fruit-market.netlify.app \
  REQUIRE_ADMIN_MFA=true \
  TOSS_ENVIRONMENT=test \
  TOSS_SECRET_KEY=test_sk_xxx \
  FRUITMARKET_CRON_SECRET=긴_무작위값 \
  ACCOUNT_ENCRYPTION_KEY_BASE64=32바이트_Base64
```

선택 공급자:

```text
IDENTITY_PROVIDER_START_URL
IDENTITY_PROVIDER_API_KEY
BUSINESS_VERIFICATION_ENDPOINT
BUSINESS_VERIFICATION_API_KEY
TOSS_PAYOUT_REQUEST_URL
TOSS_PAYOUT_SECRET_KEY
TOSS_PAYOUT_WEBHOOK_SECURITY_KEY
```

`SUPABASE_SECRET_KEY`/service role과 `TOSS_SECRET_KEY`는 브라우저·Netlify·GitHub 소스에 넣지 않습니다.

## 배포

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy api
supabase functions deploy health --no-verify-jwt
supabase functions deploy checkout-prepare
supabase functions deploy payment-confirm
supabase functions deploy payment-cancel
supabase functions deploy payment-webhook --no-verify-jwt
supabase functions deploy payout-run
supabase functions deploy scheduled-jobs --no-verify-jwt
```

GitHub의 `deploy-supabase-functions.yml`로도 배포할 수 있습니다.

## Part 46 운영 주의

- `scheduled-jobs`는 기존 예약만료·자동구매확정 작업과 함께 `run_part46_operational_controls()`를 호출합니다.
- 법률검토 승인, 판매자 계약, 과일 신선정보, 원산지·고시정보가 누락된 상품은 DB 트리거가 최종 판매승인을 거부합니다.
- 웹훅 함수는 공개 호출이 가능하므로 공급자 조회·공유키·멱등키·금액대조를 반드시 유지합니다.
- Secret 변경은 함수 재배포 없이 즉시 반영되지만, 테스트/라이브 키 전환 후 승인·취소·대사를 다시 실행해야 합니다.
