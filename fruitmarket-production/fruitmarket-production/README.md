# fruitmarket-production

GitHub·Netlify·Supabase 연결을 이어가기 위한 푸릇마켓 저장소입니다.

루트에 `package.json`, `netlify.toml`, `site`, `supabase`, `scripts`, `.github`가 바로 보여야 합니다.

```powershell
npm install
npm run check
npm run build
npx supabase@latest login
npx supabase@latest link --project-ref 본인_PROJECT_REF
npx supabase@latest functions deploy health --project-ref 본인_PROJECT_REF --use-api
```

- 결제와 정산은 기본 비활성화 상태입니다.
- Secret/service-role/Toss Secret/DB 비밀번호를 GitHub에 올리지 마세요.
- `supabase/sql`은 이미 Part 48 기본 DB가 설치된 현재 프로젝트의 후속 보정용입니다.
- 이 저장소는 현재 실행환경에서 확인 가능한 기준 HTML과 최신 관리자 SQL로 재구성한 작업 연속용입니다. 과거 Part 48 전체 ZIP과 바이트 단위 동일본은 아닙니다.
