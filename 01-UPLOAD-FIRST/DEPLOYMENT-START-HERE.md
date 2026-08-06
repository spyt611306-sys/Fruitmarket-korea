# 푸릇마켓 Part 48 배포 시작

1. Supabase 프로젝트를 만들고 `supabase/sql/00_RUN_ORDER.md` 순서대로 SQL을 실행합니다.
2. Part 47까지 설치된 프로젝트라면 `18_policy_evidence_and_legal_holds.sql` 실행 여부를 확인한 뒤 `19_mutual_fraud_and_abuse_protection.sql`, `20_part48_verification.sql`을 실행합니다.
3. `20_part48_verification.sql` 결과와 `part48_mutual_protection_readiness`를 확인합니다.
4. Supabase Edge Functions 8개를 배포하고 Function Secrets를 입력합니다.
5. GitHub에 전체 프로젝트를 올리고 `Verify Fruitmarket Part 48`이 녹색인지 확인합니다.
6. Netlify를 GitHub 저장소에 연결하고 환경변수를 입력합니다.
7. 실제 담당인력·증거절차·이의제기·정산계좌 재검증 절차가 검증되기 전에는 결제와 정산을 비활성 상태로 유지합니다.

상세 내용은 `docs/NETLIFY-GITHUB-SUPABASE-GUIDE.md`, `docs/PART48-MUTUAL-PROTECTION.md`를 확인합니다.
