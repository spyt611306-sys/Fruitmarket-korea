-- 푸릇마켓 관리자 최초 부트스트랩 안전 스크립트
-- 대상: pdg04036@naver.com / bac71fa7-ea02-46a0-ba8c-fc0b8b31e3e3
-- Supabase SQL Editor에서 Role=postgres 상태로 전체 실행하세요.
-- 중요: 일부 줄만 선택하지 말고 파일 전체를 한 번에 실행하세요.

rollback;
begin;

-- 1) Auth 사용자와 UUID를 먼저 검증합니다.
do $$
declare
  v_admin_email text := 'pdg04036@naver.com';
  v_expected_id uuid := 'bac71fa7-ea02-46a0-ba8c-fc0b8b31e3e3'::uuid;
  v_actual_id uuid;
begin
  select id
    into v_actual_id
  from auth.users
  where lower(email) = lower(v_admin_email)
  limit 1;

  if v_actual_id is null then
    raise exception 'ADMIN_AUTH_USER_NOT_FOUND: %', v_admin_email;
  end if;

  if v_actual_id <> v_expected_id then
    raise exception 'ADMIN_UUID_MISMATCH: expected=%, actual=%', v_expected_id, v_actual_id;
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.profiles'::regclass
      and tgname = 'profiles_privilege_guard'
      and not tgisinternal
  ) then
    raise exception 'PROFILE_GUARD_TRIGGER_NOT_FOUND';
  end if;
end $$;

-- 2) 최초 관리자 1회 등록 동안에만 해당 보호 트리거를 중지합니다.
-- ALTER TABLE은 강한 잠금을 획득하므로 이 트랜잭션 동안 다른 profiles 쓰기를 차단합니다.
alter table public.profiles disable trigger profiles_privilege_guard;

-- 3) Auth 사용자와 public.profiles를 연결하고 관리자 역할을 부여합니다.
insert into public.profiles (
  id,
  role,
  status,
  display_name,
  created_at,
  updated_at
)
values (
  'bac71fa7-ea02-46a0-ba8c-fc0b8b31e3e3'::uuid,
  'admin',
  'active',
  '김민수',
  now(),
  now()
)
on conflict (id) do update
set
  role = 'admin',
  status = 'active',
  display_name = '김민수',
  updated_at = now();

-- 4) 보호 트리거를 즉시 다시 활성화합니다.
alter table public.profiles enable trigger profiles_privilege_guard;

-- 5) 감사로그가 있으면 최초 관리자 지정 기록을 남깁니다.
do $$
begin
  if to_regclass('public.audit_logs') is not null then
    insert into public.audit_logs (
      actor_id,
      action,
      entity_type,
      entity_id,
      reason,
      payload
    )
    values (
      'bac71fa7-ea02-46a0-ba8c-fc0b8b31e3e3'::uuid,
      'ADMIN_BOOTSTRAP',
      'PROFILE',
      'bac71fa7-ea02-46a0-ba8c-fc0b8b31e3e3',
      'Supabase SQL Editor postgres 역할로 최초 관리자 계정 연결',
      jsonb_build_object(
        'email', 'pdg04036@naver.com',
        'trigger_temporarily_disabled', 'profiles_privilege_guard',
        'executed_at', now()
      )
    );
  end if;
end $$;

commit;

-- 6) 최종 확인
select
  u.id as admin_uuid,
  u.email,
  p.display_name,
  p.role,
  p.status,
  p.updated_at
from auth.users u
join public.profiles p on p.id = u.id
where lower(u.email) = lower('pdg04036@naver.com');

select
  t.tgname as trigger_name,
  case t.tgenabled
    when 'O' then 'ENABLED'
    when 'D' then 'DISABLED'
    when 'R' then 'REPLICA'
    when 'A' then 'ALWAYS'
    else t.tgenabled::text
  end as trigger_status
from pg_trigger t
where t.tgrelid = 'public.profiles'::regclass
  and t.tgname = 'profiles_privilege_guard'
  and not t.tgisinternal;
