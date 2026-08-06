# 푸릇마켓 Part 48 배포·활성화 순서

## 1. Supabase

1. `supabase/sql/00_RUN_ORDER.md` 순서대로 SQL 실행
2. `20_part48_verification.sql` 결과에서 테이블·RLS·정책해시 확인
3. `part48_mutual_protection_readiness.release_ready=false`가 초기 정상값인지 확인
4. Edge Function Secrets에 공개키가 아닌 서버 비밀키 저장
5. `api`, `checkout-prepare`, `payment-confirm`, `payment-cancel`, `payment-webhook`, `payout-run`, `scheduled-jobs`, `health` 배포

## 2. Netlify

공개 환경변수만 설정합니다.

- `FRUITMARKET_SITE_URL`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `FRUITMARKET_PAYMENTS_ENABLED=false`
- `FRUITMARKET_SETTLEMENTS_ENABLED=false`

`service_role`, Toss Secret, 지급대행 키는 Netlify에 입력하지 않습니다.

## 3. 운영 준비

- 분쟁 담당자와 대체 담당자 지정
- 최종 계정제재를 승인할 관리자 2명 이상 지정
- 택배사 배송증거와 반품검수 절차 연결
- 허위신고·오탐 월간 샘플검토
- 3영업일 진행안내, 10영업일 결과안내 운영
- 이의제기 접수와 재검토 담당 분리
- 변호사·개인정보 전문가 검토 완료

## 4. 결제·정산 활성화

실제 Toss 테스트 승인·취소·부분취소·웹훅·차지백 대사와 판매자 지급대행 테스트가 통과한 뒤에만 결제·정산 플래그를 활성화합니다.
