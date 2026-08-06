# Edge Functions

```powershell
npm install
npx supabase@latest login
npx supabase@latest projects list
npx supabase@latest link --project-ref 본인_PROJECT_REF
npx supabase@latest functions deploy health --project-ref 본인_PROJECT_REF --use-api
npx supabase@latest functions deploy --project-ref 본인_PROJECT_REF --use-api
```

Secret은 Supabase Edge Functions에만 입력합니다. 결제·정산은 실제 공급자 연동 전까지 false를 유지합니다.
