# 파일별 업로드 위치

| 폴더/파일 | 대상 |
|---|---|
| 저장소 전체 | GitHub Private Repository |
| `dist/` | Netlify 빌드 결과(자동) |
| `site/` | Netlify 수동 업로드 원본 |
| `supabase/sql/*.sql` | Supabase SQL Editor |
| `supabase/functions/**` | Supabase Edge Functions |
| `supabase/config.toml` | Supabase CLI 설정 |
| `.github/workflows/verify.yml` | GitHub 자동검사 |
| `.github/workflows/deploy-supabase-functions.yml` | Edge Function 배포 |
| `.github/workflows/run-scheduled-jobs.yml` | 매시간 운영 작업 |

비밀키는 파일에 쓰지 않고 Supabase Secrets 또는 GitHub Repository Secrets에 저장합니다.
