-- 푸릇마켓 Part 45: 일괄재고·환불·정산·스케줄 운영 트랜잭션
-- 실행순서: 01~11 이후 실행

alter table public.refunds add column if not exists idempotency_key text;
create unique index if not exists refunds_idempotency_key_uq on public.refunds(idempotency_key) where idempotency_key is not null;
alter table public.order_items add column if not exists refunded_quantity integer not null default 0;
alter table public.order_items add column if not exists return_restocked_quantity integer not null default 0;

create table if not exists public.refund_items (
  id bigint generated always as identity primary key,
  refund_id uuid not null references public.refunds(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  amount bigint not null check (amount >= 0),
  restock boolean not null default false,
  created_at timestamptz not null default now(),
  unique(refund_id, order_item_id)
);

create table if not exists public.payout_attempts (
  id uuid primary key default gen_random_uuid(),
  payout_request_id uuid not null references public.payout_requests(id) on delete cascade,
  idempotency_key text not null unique,
  status text not null default 'STARTED' check (status in ('STARTED','SUCCEEDED','FAILED')),
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.scheduled_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  run_key text not null unique,
  status text not null default 'STARTED' check (status in ('STARTED','SUCCEEDED','FAILED')),
  result jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create or replace function public.apply_inventory_bulk(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.assert_active_user();
  sid uuid := public.current_seller_id();
  row_data jsonb;
  product_row public.products%rowtype;
  option_row public.product_options%rowtype;
  product_id uuid;
  option_id uuid;
  new_stock integer;
  reason text;
  before_stock integer;
  applied integer := 0;
  results jsonb := '[]'::jsonb;
begin
  if sid is null then raise exception 'SELLER_NOT_FOUND_OR_NOT_ACTIVE'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'ROWS_REQUIRED'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'ROW_LIMIT_EXCEEDED'; end if;

  for row_data in select value from jsonb_array_elements(p_rows) loop
    begin
      product_id := nullif(row_data->>'productId','')::uuid;
      option_id := nullif(row_data->>'optionId','')::uuid;
      new_stock := (row_data->>'newStock')::integer;
      reason := left(coalesce(nullif(row_data->>'reason',''),'SELLER_BULK_IMPORT'),500);
      if product_id is null or new_stock < 0 or new_stock > 100000000 then raise exception 'INVALID_INVENTORY_ROW'; end if;

      select * into product_row from public.products where id=product_id and seller_id=sid for update;
      if not found then raise exception 'PRODUCT_NOT_OWNED'; end if;

      if option_id is not null then
        select * into option_row from public.product_options where id=option_id and product_id=product_id for update;
        if not found then raise exception 'OPTION_NOT_OWNED'; end if;
        if new_stock < option_row.reserved_stock then raise exception 'NEW_STOCK_BELOW_RESERVED'; end if;
        before_stock := option_row.stock_quantity;
        update public.product_options set stock_quantity=new_stock,updated_at=now() where id=option_id;
      else
        if new_stock < product_row.reserved_stock then raise exception 'NEW_STOCK_BELOW_RESERVED'; end if;
        before_stock := product_row.stock_quantity;
        update public.products set stock_quantity=new_stock,updated_at=now(),version=version+1 where id=product_id;
      end if;

      insert into public.inventory_movements(seller_id,product_id,option_id,movement_type,quantity,reference_type,reference_id,before_quantity,after_quantity,actor_id)
      values(sid,product_id,option_id,'BULK_ADJUST',new_stock-before_stock,'EXCEL_IMPORT',reason,before_stock,new_stock,uid);
      applied := applied + 1;
      results := results || jsonb_build_array(jsonb_build_object('productId',product_id,'optionId',option_id,'newStock',new_stock,'valid',true,'applied',true));
    exception when others then
      results := results || jsonb_build_array(jsonb_build_object('productId',row_data->>'productId','optionId',row_data->>'optionId','newStock',row_data->>'newStock','valid',false,'applied',false,'error',sqlerrm));
    end;
  end loop;

  perform public.audit_event('INVENTORY_BULK_APPLY','SELLER',sid::text,null,jsonb_build_object('rowCount',jsonb_array_length(p_rows),'applied',applied));
  return jsonb_build_object('rows',results,'valid',not jsonb_path_exists(results,'$[*] ? (@.valid == false)'),'applied',applied);
end $$;

create or replace function public.preview_inventory_bulk(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  sid uuid := public.current_seller_id();
  row_data jsonb;
  product_id uuid;
  option_id uuid;
  new_stock integer;
  current_stock integer;
  reserved integer;
  results jsonb := '[]'::jsonb;
begin
  perform public.assert_active_user();
  if sid is null then raise exception 'SELLER_NOT_FOUND_OR_NOT_ACTIVE'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'ROWS_REQUIRED'; end if;
  if jsonb_array_length(p_rows)>5000 then raise exception 'ROW_LIMIT_EXCEEDED'; end if;
  for row_data in select value from jsonb_array_elements(p_rows) loop
    begin
      product_id:=nullif(row_data->>'productId','')::uuid;
      option_id:=nullif(row_data->>'optionId','')::uuid;
      new_stock:=(row_data->>'newStock')::integer;
      if product_id is null or new_stock<0 or new_stock>100000000 then raise exception 'INVALID_INVENTORY_ROW'; end if;
      if option_id is null then
        select p.stock_quantity,p.reserved_stock into current_stock,reserved from public.products p where p.id=product_id and p.seller_id=sid;
      else
        select o.stock_quantity,o.reserved_stock into current_stock,reserved from public.product_options o join public.products p on p.id=o.product_id where o.id=option_id and p.id=product_id and p.seller_id=sid;
      end if;
      if not found then raise exception 'PRODUCT_OR_OPTION_NOT_OWNED'; end if;
      if new_stock<reserved then raise exception 'NEW_STOCK_BELOW_RESERVED'; end if;
      results:=results||jsonb_build_array(jsonb_build_object('productId',product_id,'optionId',option_id,'currentStock',current_stock,'reservedStock',reserved,'newStock',new_stock,'valid',true));
    exception when others then
      results:=results||jsonb_build_array(jsonb_build_object('productId',row_data->>'productId','optionId',row_data->>'optionId','newStock',row_data->>'newStock','valid',false,'error',sqlerrm));
    end;
  end loop;
  return jsonb_build_object('rows',results,'valid',not jsonb_path_exists(results,'$[*] ? (@.valid == false)'),'applied',0);
end $$;

create or replace function public.apply_payment_refund(
  p_payment_id uuid,
  p_amount bigint,
  p_reason text,
  p_idempotency_key text,
  p_provider_response jsonb,
  p_claim_id uuid default null,
  p_items jsonb default '[]'::jsonb,
  p_restock boolean default false
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.assert_active_user();
  actor_role text;
  pay public.payments%rowtype;
  ord public.orders%rowtype;
  refund_id uuid;
  item_data jsonb;
  oi public.order_items%rowtype;
  qty integer;
  amount bigint;
  new_balance bigint;
  allowed boolean:=false;
begin
  select role into actor_role from public.profiles where id=uid;
  select * into pay from public.payments where id=p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  select * into ord from public.orders where id=pay.order_id for update;
  allowed := actor_role='admin' or ord.buyer_id=uid or (actor_role='seller' and exists(select 1 from public.order_items x where x.order_id=ord.id and public.owns_seller(x.seller_id)));
  if not allowed then raise exception 'REFUND_FORBIDDEN'; end if;
  if p_amount<=0 or p_amount>pay.balance_amount then raise exception 'REFUND_AMOUNT_INVALID'; end if;

  select id into refund_id from public.refunds where idempotency_key=p_idempotency_key;
  if refund_id is not null then return jsonb_build_object('refundId',refund_id,'idempotentReplay',true); end if;

  insert into public.refunds(order_id,payment_id,claim_id,refund_amount,reason,status,provider_transaction_key,raw_response,requested_by,completed_at,idempotency_key)
  values(ord.id,pay.id,p_claim_id,p_amount,left(coalesce(p_reason,'환불'),500),'DONE',p_provider_response->>'transactionKey',coalesce(p_provider_response,'{}'::jsonb),uid,now(),p_idempotency_key)
  returning id into refund_id;

  if jsonb_typeof(p_items)='array' and jsonb_array_length(p_items)>0 then
    for item_data in select value from jsonb_array_elements(p_items) loop
      select * into oi from public.order_items where id=(item_data->>'orderItemId')::uuid and order_id=ord.id for update;
      if not found then raise exception 'REFUND_ITEM_NOT_FOUND'; end if;
      qty:=greatest(1,coalesce((item_data->>'quantity')::integer,1));
      if qty+oi.refunded_quantity>oi.quantity then raise exception 'REFUND_QUANTITY_INVALID'; end if;
      amount:=least((oi.unit_price*qty),coalesce((item_data->>'amount')::bigint,oi.unit_price*qty));
      insert into public.refund_items(refund_id,order_item_id,quantity,amount,restock) values(refund_id,oi.id,qty,amount,p_restock);
      update public.order_items set refunded_quantity=refunded_quantity+qty,status=case when refunded_quantity+qty>=quantity then 'REFUNDED' else 'PARTIAL_REFUNDED' end where id=oi.id;
      if p_restock then
        if oi.option_id is null then
          update public.products set stock_quantity=stock_quantity+qty,updated_at=now(),version=version+1 where id=oi.product_id;
        else
          update public.product_options set stock_quantity=stock_quantity+qty,updated_at=now() where id=oi.option_id;
        end if;
        update public.order_items set return_restocked_quantity=return_restocked_quantity+qty where id=oi.id;
        insert into public.inventory_movements(seller_id,product_id,option_id,movement_type,quantity,reference_type,reference_id,actor_id)
        values(oi.seller_id,oi.product_id,oi.option_id,'RETURN_RESTOCK',qty,'REFUND',refund_id::text,uid);
      end if;
    end loop;
  end if;

  new_balance:=pay.balance_amount-p_amount;
  update public.payments set balance_amount=new_balance,status=case when new_balance=0 then 'CANCELED' else 'PARTIAL_CANCELED' end,raw_response=coalesce(p_provider_response,'{}'::jsonb),updated_at=now() where id=pay.id;
  update public.orders set status=case when new_balance=0 then 'REFUNDED' else 'PARTIAL_REFUNDED' end,updated_at=now() where id=ord.id;
  insert into public.order_status_history(order_id,from_status,to_status,actor_id,reason,metadata) values(ord.id,ord.status,case when new_balance=0 then 'REFUNDED' else 'PARTIAL_REFUNDED' end,uid,p_reason,jsonb_build_object('refundId',refund_id,'amount',p_amount));
  if p_claim_id is not null then update public.claims set status='COMPLETED',completed_at=now() where id=p_claim_id; end if;
  perform public.audit_event('PAYMENT_REFUND','PAYMENT',pay.id::text,p_reason,jsonb_build_object('refundId',refund_id,'amount',p_amount,'balance',new_balance));
  return jsonb_build_object('refundId',refund_id,'orderId',ord.id,'paymentId',pay.id,'refundAmount',p_amount,'balanceAmount',new_balance,'paymentStatus',case when new_balance=0 then 'CANCELED' else 'PARTIAL_CANCELED' end);
end $$;

create or replace function public.request_settlement_payout(p_settlement_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid:=public.assert_active_user(); v_role text; st public.settlements%rowtype; payout_id uuid;
begin
  select p.role into v_role from public.profiles p where p.id=uid;
  if v_role<>'admin' then raise exception 'ADMIN_REQUIRED'; end if;
  select * into st from public.settlements where id=p_settlement_id for update;
  if not found then raise exception 'SETTLEMENT_NOT_FOUND'; end if;
  if st.status<>'APPROVED' or st.first_approved_by is null or st.second_approved_by is null or st.first_approved_by=st.second_approved_by then raise exception 'SETTLEMENT_NOT_DUAL_APPROVED'; end if;
  if st.net_amount<=0 then raise exception 'PAYOUT_AMOUNT_INVALID'; end if;
  if not exists(select 1 from public.seller_kyc where seller_id=st.seller_id and status='APPROVED') then raise exception 'SELLER_KYC_NOT_APPROVED'; end if;
  if not exists(select 1 from public.seller_settlement_accounts where seller_id=st.seller_id and verification_status='VERIFIED') then raise exception 'SETTLEMENT_ACCOUNT_NOT_VERIFIED'; end if;
  insert into public.payout_requests(settlement_id,seller_id,idempotency_key,amount,status)
  values(st.id,st.seller_id,p_idempotency_key,st.net_amount,'REQUESTED')
  on conflict(idempotency_key) do update set idempotency_key=excluded.idempotency_key returning id into payout_id;
  update public.settlements set status='PAYOUT_REQUESTED',updated_at=now() where id=st.id;
  perform public.audit_event('PAYOUT_REQUEST','SETTLEMENT',st.id::text,null,jsonb_build_object('payoutRequestId',payout_id,'amount',st.net_amount));
  return jsonb_build_object('payoutRequestId',payout_id,'settlementId',st.id,'amount',st.net_amount,'status','REQUESTED');
end $$;

create or replace function public.complete_payout(p_payout_request_id uuid,p_provider_payout_id text,p_provider_response jsonb,p_success boolean,p_error text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare pr public.payout_requests%rowtype;
begin
  select * into pr from public.payout_requests where id=p_payout_request_id for update;
  if not found then raise exception 'PAYOUT_REQUEST_NOT_FOUND'; end if;
  update public.payout_requests set provider_payout_id=coalesce(nullif(p_provider_payout_id,''),provider_payout_id),status=case when p_success then 'COMPLETED' else 'FAILED' end,raw_response=coalesce(p_provider_response,'{}'::jsonb),completed_at=case when p_success then now() else completed_at end,updated_at=now() where id=pr.id;
  update public.settlements set status=case when p_success then 'COMPLETED' else 'FAILED' end,updated_at=now() where id=pr.settlement_id;
  return jsonb_build_object('payoutRequestId',pr.id,'status',case when p_success then 'COMPLETED' else 'FAILED' end,'error',p_error);
end $$;

create or replace function public.run_marketplace_scheduled_jobs()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare expired integer:=0; confirmed integer:=0; masked integer:=0;
begin
  select public.expire_stale_reservations() into expired;
  with eligible as (
    select o.id from public.orders o
    where o.status='DELIVERED' and o.confirmed_at is null
      and exists(select 1 from public.shipments s where s.order_id=o.id and s.status='DELIVERED' and s.delivered_at<=now()-interval '7 days')
      and not exists(select 1 from public.claims c join public.order_items oi on oi.id=c.order_item_id where oi.order_id=o.id and c.status not in ('REJECTED','WITHDRAWN','COMPLETED'))
    for update
  ), upd as (
    update public.orders o set status='CONFIRMED',confirmed_at=now(),updated_at=now() from eligible e where o.id=e.id returning o.id
  ) select count(*) into confirmed from upd;
  update public.order_items set status='CONFIRMED' where order_id in(select id from public.orders where status='CONFIRMED') and status='DELIVERED';
  with old as (
    select id from public.profiles where status='withdrawn' and withdrawal_requested_at<now()-interval '30 days' and (email is not null or phone is not null) for update
  ), upd as (
    update public.profiles p set email=null,phone=null,display_name='탈퇴회원',updated_at=now() from old where p.id=old.id returning p.id
  ) select count(*) into masked from upd;
  delete from public.client_errors where created_at<now()-interval '90 days';
  delete from public.auth_security_events where created_at<now()-interval '365 days';
  return jsonb_build_object('expiredReservations',expired,'autoConfirmedOrders',confirmed,'maskedWithdrawnProfiles',masked,'completedAt',now());
end $$;

create or replace function public.reconcile_provider_payment(
  p_payment_id uuid, p_status text, p_balance_amount bigint, p_provider_payload jsonb, p_event_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare pay public.payments%rowtype; ord public.orders%rowtype; refund_amount bigint; refund_id uuid; can_restock boolean:=false; row_data record;
begin
  select * into pay from public.payments where id=p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  select * into ord from public.orders where id=pay.order_id for update;
  p_status:=upper(coalesce(p_status,''));
  if p_balance_amount<0 or p_balance_amount>pay.amount then raise exception 'PROVIDER_BALANCE_INVALID'; end if;
  if p_status not in ('CANCELED','PARTIAL_CANCELED','ABORTED','EXPIRED') then raise exception 'PROVIDER_STATUS_UNSUPPORTED'; end if;
  if p_status in ('ABORTED','EXPIRED') then
    update public.payments set status=p_status,raw_response=coalesce(p_provider_payload,'{}'::jsonb),updated_at=now() where id=pay.id;
    perform public.release_checkout(ord.id,'WEBHOOK_'||p_status);
    return jsonb_build_object('paymentId',pay.id,'status',p_status,'released',true);
  end if;
  refund_amount:=greatest(0,pay.balance_amount-p_balance_amount);
  if refund_amount>0 then
    insert into public.refunds(order_id,payment_id,refund_amount,reason,status,raw_response,completed_at,idempotency_key)
    values(ord.id,pay.id,refund_amount,'결제사 웹훅 대사','DONE',coalesce(p_provider_payload,'{}'::jsonb),now(),left('WEBHOOK:'||p_event_key,300))
    on conflict(idempotency_key) do update set raw_response=excluded.raw_response returning id into refund_id;
  end if;
  can_restock:=p_status='CANCELED' and ord.status in ('PAID','PREPARING') and not exists(select 1 from public.shipments where order_id=ord.id and status in ('SHIPPED','IN_TRANSIT','DELIVERED'));
  if p_status='CANCELED' and ord.status in ('PENDING_PAYMENT','WAITING_FOR_DEPOSIT','PAYMENT_FAILED') then
    perform public.release_checkout(ord.id,'PROVIDER_CANCELED_BEFORE_COMMIT');
    update public.order_items set status='CANCELED' where order_id=ord.id and status='PENDING_PAYMENT';
  end if;
  if can_restock and refund_amount>0 then
    for row_data in select * from public.order_items where order_id=ord.id and refunded_quantity<quantity for update loop
      update public.order_items set refunded_quantity=quantity,status='REFUNDED',return_restocked_quantity=return_restocked_quantity+(quantity-refunded_quantity) where id=row_data.id;
      if row_data.option_id is null then update public.products set stock_quantity=stock_quantity+(row_data.quantity-row_data.refunded_quantity),updated_at=now(),version=version+1 where id=row_data.product_id;
      else update public.product_options set stock_quantity=stock_quantity+(row_data.quantity-row_data.refunded_quantity),updated_at=now() where id=row_data.option_id; end if;
      insert into public.inventory_movements(seller_id,product_id,option_id,movement_type,quantity,reference_type,reference_id)
      values(row_data.seller_id,row_data.product_id,row_data.option_id,'WEBHOOK_CANCEL_RESTOCK',row_data.quantity-row_data.refunded_quantity,'PAYMENT_WEBHOOK',p_event_key);
    end loop;
  end if;
  update public.payments set status=p_status,balance_amount=p_balance_amount,raw_response=coalesce(p_provider_payload,'{}'::jsonb),updated_at=now() where id=pay.id;
  update public.orders set status=case when p_status='CANCELED' then 'REFUNDED' else 'PARTIAL_REFUNDED' end,updated_at=now() where id=ord.id;
  insert into public.order_status_history(order_id,from_status,to_status,reason,metadata) values(ord.id,ord.status,case when p_status='CANCELED' then 'REFUNDED' else 'PARTIAL_REFUNDED' end,'PAYMENT_WEBHOOK_RECONCILIATION',jsonb_build_object('eventKey',p_event_key,'refundAmount',refund_amount));
  if p_status='PARTIAL_CANCELED' then
    insert into public.notifications(user_id,type,title,message) select id,'PAYMENT_RECONCILIATION_REQUIRED','부분취소 항목 확인 필요',ord.order_number||' 주문의 부분취소 상품 배분을 확인하세요.' from public.profiles where role='admin' and status='active';
  end if;
  perform public.audit_event('PAYMENT_WEBHOOK_RECONCILE','PAYMENT',pay.id::text,p_status,jsonb_build_object('eventKey',p_event_key,'refundAmount',refund_amount,'restocked',can_restock));
  return jsonb_build_object('paymentId',pay.id,'orderId',ord.id,'status',p_status,'refundAmount',refund_amount,'refundId',refund_id,'restocked',can_restock);
end $$;

revoke execute on function public.reconcile_provider_payment(uuid,text,bigint,jsonb,text) from public,anon,authenticated;

revoke execute on function public.apply_inventory_bulk(jsonb), public.preview_inventory_bulk(jsonb), public.apply_payment_refund(uuid,bigint,text,text,jsonb,uuid,jsonb,boolean), public.request_settlement_payout(uuid,text), public.complete_payout(uuid,text,jsonb,boolean,text), public.run_marketplace_scheduled_jobs() from public,anon;
grant execute on function public.apply_inventory_bulk(jsonb), public.preview_inventory_bulk(jsonb), public.request_settlement_payout(uuid,text) to authenticated;
revoke execute on function public.apply_payment_refund(uuid,bigint,text,text,jsonb,uuid,jsonb,boolean), public.complete_payout(uuid,text,jsonb,boolean,text), public.run_marketplace_scheduled_jobs() from authenticated;
