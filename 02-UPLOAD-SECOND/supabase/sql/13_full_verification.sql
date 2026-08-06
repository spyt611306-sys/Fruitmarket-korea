-- Part 45 설치 검증: 모든 행이 PASS여야 합니다.
with required_tables(name) as (values
 ('profiles'),('sellers'),('seller_applications'),('products'),('product_options'),('inventory_movements'),('inventory_reservations'),
 ('carts'),('cart_items'),('orders'),('order_items'),('payments'),('payment_attempts'),('payment_webhook_events'),('refunds'),('refund_items'),
 ('shipments'),('shipment_events'),('claims'),('claim_history'),('coupons'),('coupon_issues'),('point_accounts'),('point_ledger'),
 ('settlements'),('settlement_items'),('payout_requests'),('payout_attempts'),('consent_receipts'),('scheduled_job_runs')
), table_check as (
 select name, to_regclass('public.'||name) is not null as ok from required_tables
), required_functions(name, signature) as (values
 ('prepare_checkout','prepare_checkout(jsonb)'),
 ('finalize_payment','finalize_payment(uuid,text,text,bigint,jsonb)'),
 ('apply_inventory_bulk','apply_inventory_bulk(jsonb)'),
 ('preview_inventory_bulk','preview_inventory_bulk(jsonb)'),
 ('apply_payment_refund','apply_payment_refund(uuid,bigint,text,text,jsonb,uuid,jsonb,boolean)'),
 ('run_marketplace_scheduled_jobs','run_marketplace_scheduled_jobs()')
), function_check as (
 select name, to_regprocedure('public.'||signature) is not null as ok from required_functions
), rls_check as (
 select c.relname as name, c.relrowsecurity as ok
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in (select name from required_tables)
)
select 'TABLE' as check_type,name,case when ok then 'PASS' else 'FAIL' end as result from table_check
union all
select 'FUNCTION',name,case when ok then 'PASS' else 'FAIL' end from function_check
union all
select 'RLS',name,case when ok then 'PASS' else 'FAIL' end from rls_check
order by check_type,name;

-- 브라우저 역할에 주문/결제/정산 직접쓰기 권한이 없어야 합니다.
select table_name, privilege_type
from information_schema.role_table_grants
where grantee in ('anon','authenticated')
  and table_schema='public'
  and table_name in ('orders','order_items','payments','payment_attempts','refunds','refund_items','settlements','settlement_items','payout_requests','payout_attempts')
  and privilege_type in ('INSERT','UPDATE','DELETE')
order by table_name,privilege_type;
-- 정상 결과: 0행
