-- 1) Supabase Authentication > Users에서 관리자 계정을 먼저 생성하세요.
-- 2) 아래 이메일을 실제 관리자 이메일로 바꾼 뒤 실행하세요.
update public.profiles
set role='admin', status='active', updated_at=now()
where id=(select id from auth.users where email='ADMIN_EMAIL@example.com');

select id,role,status,display_name from public.profiles
where id=(select id from auth.users where email='ADMIN_EMAIL@example.com');
