# 맞춤식 과외 v28.3-complete-supabase-ready

## GitHub 구조
- `.github/workflows/deploy-supabase-api.yml`
- `matchsik-platform/frontend/source`
- `matchsik-platform/frontend/dist`
- `matchsik-platform/supabase/functions/api`
- `matchsik-platform/supabase/migrations`

## Netlify 설정
- Base directory: `matchsik-platform`
- Build command: `node scripts/build-frontend.mjs`
- Publish directory: `frontend/dist`
- Environment: `API_BASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `CUSTOMER_CENTER_EMAIL`

## Supabase SQL 순서
1. `20260806_v28_3_complete_schema.sql`
2. `20260806_v28_1_teacher_catalog_repair.sql`

## 비밀값
service role, secret key, DB 비밀번호, 관리자·강사 비밀번호는 파일에 넣지 않습니다.
