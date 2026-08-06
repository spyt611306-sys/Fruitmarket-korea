-- 푸릇마켓 Part 45: 원자적 비즈니스 로직 RPC

create or replace function public.current_app_role()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select role from public.profiles where id = auth.uid() and status = 'active'),'anonymous');
$$;

create or replace function public.current_seller_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.sellers where owner_id = auth.uid() and approval_status='APPROVED' and status='ACTIVE' limit 1;
$$;

create or replace function public.assert_active_user()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception using errcode='28000', message='AUTH_REQUIRED'; end if;
  if not exists(select 1 from public.profiles where id=uid and status='active') then
    raise exception using errcode='42501', message='ACCOUNT_NOT_ACTIVE';
  end if;
  return uid;
end $$;

create or replace function public.assert_role(required_roles text[])
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := public.assert_active_user(); r text;
begin
  select role into r from public.profiles where id=uid;
  if not (r = any(required_roles)) then raise exception using errcode='42501', message='ROLE_FORBIDDEN'; end if;
  return uid;
end $$;

create or replace function public.audit_event(p_action text, p_entity_type text default null, p_entity_id text default null, p_reason text default null, p_payload jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,reason,payload)
  values(auth.uid(),p_action,p_entity_type,p_entity_id,p_reason,coalesce(p_payload,'{}'::jsonb));
end $$;

create or replace function public.register_consent_receipts(p_receipts jsonb, p_email text default null, p_ip_hash text default null, p_user_agent_hash text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare item jsonb; inserted_count integer := 0; uid uuid := auth.uid();
begin
  if jsonb_typeof(p_receipts) <> 'array' then return 0; end if;
  for item in select value from jsonb_array_elements(p_receipts) loop
    insert into public.consent_receipts(user_id,email,scope,policy_code,policy_version,content_hash,consented,ip_hash,user_agent_hash,client_submission_id,consented_at)
    values(uid,coalesce(p_email,item->>'email'),coalesce(item->>'scope','REGISTRATION'),item->>'policyCode',coalesce(item->>'policyVersion','CURRENT'),coalesce(item->>'contentHash','UNAVAILABLE'),coalesce((item->>'consented')::boolean,true),p_ip_hash,p_user_agent_hash,item->>'clientSubmissionId',coalesce((item->>'consentedAt')::timestamptz,now()))
    on conflict(user_id,policy_code,policy_version,client_submission_id) do nothing;
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end $$;

create or replace function public.set_default_address(target_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_active_user();
begin
  if not exists(select 1 from public.addresses where id=target_id and user_id=uid) then raise exception 'ADDRESS_NOT_FOUND'; end if;
  update public.addresses set is_default=false where user_id=uid and is_default=true;
  update public.addresses set is_default=true where id=target_id and user_id=uid;
end $$;

create or replace function public.cart_snapshot()
returns jsonb language sql stable security definer set search_path = '' as $$
with me as (select public.assert_active_user() uid), c as (
  select id from public.carts where user_id=(select uid from me)
), rows as (
  select ci.id,ci.product_id,ci.option_id,ci.quantity,ci.selected,
         p.name product_name,p.primary_image_url,p.sale_price,p.list_price,p.stock_quantity,p.reserved_stock,
         po.option_name,po.additional_price,po.stock_quantity option_stock,po.reserved_stock option_reserved,
         s.store_name seller_name,p.seller_id
  from public.cart_items ci join c on c.id=ci.cart_id
  join public.products p on p.id=ci.product_id
  left join public.product_options po on po.id=ci.option_id
  join public.sellers s on s.id=p.seller_id
)
select jsonb_build_object(
  'items',coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'cartItemId',id,'productId',product_id,'optionId',option_id,'quantity',quantity,'selected',selected,
    'productName',product_name,'imageUrl',primary_image_url,'salePrice',sale_price,'listPrice',list_price,
    'optionName',option_name,'additionalPrice',coalesce(additional_price,0),'sellerName',seller_name,'sellerId',seller_id,
    'availableStock',greatest(0,case when option_id is null then stock_quantity-reserved_stock else option_stock-option_reserved end),
    'lineAmount',(sale_price+coalesce(additional_price,0))*quantity
  ) order by id),'[]'::jsonb),
  'totalAmount',coalesce(sum((sale_price+coalesce(additional_price,0))*quantity) filter(where selected),0),
  'selectedCount',coalesce(sum(quantity) filter(where selected),0)
) from rows;
$$;

create or replace function public.cart_add(p_product_id uuid, p_option_id uuid, p_quantity integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_active_user(); cart_id uuid; available integer; minq integer; maxq integer;
begin
  if p_quantity is null or p_quantity < 1 then raise exception 'INVALID_QUANTITY'; end if;
  select min_order_quantity,max_order_quantity,
    case when p_option_id is null then stock_quantity-reserved_stock
         else (select stock_quantity-reserved_stock from public.product_options where id=p_option_id and product_id=p_product_id and active)
    end
  into minq,maxq,available
  from public.products where id=p_product_id and active and sale_status='ON_SALE' and approval_status='APPROVED';
  if not found then raise exception 'PRODUCT_NOT_AVAILABLE'; end if;
  if p_quantity < minq or p_quantity > maxq or p_quantity > coalesce(available,0) then raise exception 'QUANTITY_OR_STOCK_INVALID'; end if;
  insert into public.carts(user_id) values(uid) on conflict(user_id) do update set updated_at=now() returning id into cart_id;
  insert into public.cart_items(cart_id,product_id,option_id,quantity,selected)
  values(cart_id,p_product_id,p_option_id,p_quantity,true)
  on conflict(cart_id,product_id,option_id) do update set quantity=least(excluded.quantity+public.cart_items.quantity,maxq),selected=true,updated_at=now();
  return public.cart_snapshot();
end $$;

create or replace function public.cart_update_quantity(p_item_id uuid, p_quantity integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_active_user(); product_id uuid; option_id uuid; maxq integer; available integer;
begin
  select ci.product_id,ci.option_id,p.max_order_quantity,
    case when ci.option_id is null then p.stock_quantity-p.reserved_stock else po.stock_quantity-po.reserved_stock end
  into product_id,option_id,maxq,available
  from public.cart_items ci join public.carts c on c.id=ci.cart_id and c.user_id=uid
  join public.products p on p.id=ci.product_id left join public.product_options po on po.id=ci.option_id
  where ci.id=p_item_id;
  if not found then raise exception 'CART_ITEM_NOT_FOUND'; end if;
  if p_quantity < 1 or p_quantity > maxq or p_quantity > available then raise exception 'QUANTITY_OR_STOCK_INVALID'; end if;
  update public.cart_items set quantity=p_quantity,updated_at=now() where id=p_item_id;
  return public.cart_snapshot();
end $$;

create or replace function public.cart_remove(p_item_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_active_user();
begin
  delete from public.cart_items ci using public.carts c where ci.id=p_item_id and c.id=ci.cart_id and c.user_id=uid;
  return public.cart_snapshot();
end $$;

create or replace function public.cart_clear()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_active_user();
begin
  delete from public.cart_items ci using public.carts c where c.id=ci.cart_id and c.user_id=uid;
  return public.cart_snapshot();
end $$;

create or replace function public.toggle_product_favorite(p_product_id uuid, p_enabled boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_active_user();
begin
  if p_enabled then insert into public.favorites(user_id,product_id) values(uid,p_product_id) on conflict do nothing;
  else delete from public.favorites where user_id=uid and product_id=p_product_id; end if;
  return p_enabled;
end $$;

create or replace function public.toggle_seller_favorite(p_seller_id uuid, p_enabled boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_active_user();
begin
  if p_enabled then insert into public.seller_favorites(user_id,seller_id) values(uid,p_seller_id) on conflict do nothing;
  else delete from public.seller_favorites where user_id=uid and seller_id=p_seller_id; end if;
  return p_enabled;
end $$;

create or replace function public.record_recent_view(p_product_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_active_user();
begin
  insert into public.recent_product_views(user_id,product_id,viewed_at) values(uid,p_product_id,now())
  on conflict(user_id,product_id) do update set viewed_at=excluded.viewed_at;
  delete from public.recent_product_views where user_id=uid and product_id in (
    select product_id from public.recent_product_views where user_id=uid order by viewed_at desc offset 100
  );
end $$;

create or replace function public.release_checkout(p_order_id uuid, p_reason text default 'RELEASED')
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select * from public.inventory_reservations where order_id=p_order_id and status='RESERVED' for update loop
    update public.products set reserved_stock=greatest(0,reserved_stock-r.quantity) where id=r.product_id;
    if r.option_id is not null then update public.product_options set reserved_stock=greatest(0,reserved_stock-r.quantity) where id=r.option_id; end if;
    update public.inventory_reservations set status='RELEASED',updated_at=now() where id=r.id;
  end loop;
  update public.coupon_issues set status='AVAILABLE',reserved_order_id=null where reserved_order_id=p_order_id and status='RESERVED';
  update public.point_accounts pa set available_balance=available_balance+o.points_used,reserved_balance=greatest(0,reserved_balance-o.points_used),updated_at=now()
  from public.orders o where o.id=p_order_id and pa.user_id=o.buyer_id and o.points_used>0;
  update public.orders set status=case when status='PAID' then status else 'PAYMENT_FAILED' end,updated_at=now() where id=p_order_id;
  perform public.audit_event('CHECKOUT_RELEASE','ORDER',p_order_id::text,p_reason);
end $$;

create or replace function public.prepare_checkout(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.assert_active_user();
  v_mode text := upper(coalesce(p_payload->>'checkoutMode','DIRECT'));
  v_idem text := coalesce(p_payload->>'idempotencyKey',p_payload->>'requestKey');
  v_address jsonb := coalesce(p_payload->'address','{}'::jsonb);
  v_items jsonb := coalesce(p_payload->'items','[]'::jsonb);
  v_cart_id uuid;
  v_order_id uuid;
  v_order_number text;
  v_payment_id uuid;
  v_product_total bigint := 0;
  v_shipping_total bigint := 0;
  v_discount_total bigint := 0;
  v_points bigint := greatest(0,coalesce(nullif(p_payload->>'pointsToUse','')::bigint,0));
  v_coupon_issue uuid := nullif(p_payload->>'couponIssueId','')::uuid;
  v_item jsonb;
  v_product public.products%rowtype;
  v_option_id uuid;
  v_option_name text;
  v_option_additional bigint;
  v_option_available integer;
  v_qty integer;
  v_unit_price bigint;
  v_line_total bigint;
  v_order_item_id uuid;
  v_sellers_shipping jsonb := '{}'::jsonb;
  v_coupon record;
  v_discount bigint := 0;
  v_point_balance bigint;
  v_order_name text;
begin
  if v_idem is null or length(v_idem)<8 then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  select o.id,o.order_number,o.payment_id into v_order_id,v_order_number,v_payment_id
  from public.orders o where o.idempotency_key=v_idem and o.buyer_id=v_uid;
  if found then
    return jsonb_build_object('orderId',v_order_id,'orderNumber',v_order_number,'paymentId',v_payment_id,'idempotentReplay',true);
  end if;
  if nullif(v_address->>'recipientName','') is null or nullif(v_address->>'recipientPhone','') is null or nullif(v_address->>'postalCode','') is null or nullif(v_address->>'roadAddress','') is null then
    raise exception 'DELIVERY_ADDRESS_REQUIRED';
  end if;
  if v_mode='CART' and jsonb_array_length(v_items)=0 then
    select c.id into v_cart_id from public.carts c where c.user_id=v_uid;
    select coalesce(jsonb_agg(jsonb_build_object('productId',ci.product_id,'optionId',ci.option_id,'quantity',ci.quantity)), '[]'::jsonb)
      into v_items from public.cart_items ci where ci.cart_id=v_cart_id and ci.selected;
  end if;
  if jsonb_typeof(v_items)<>'array' or jsonb_array_length(v_items)=0 then raise exception 'CHECKOUT_ITEMS_REQUIRED'; end if;

  insert into public.orders(buyer_id,status,recipient_name,recipient_phone,postal_code,road_address,detail_address,delivery_memo,idempotency_key,checkout_key,expires_at)
  values(v_uid,'PENDING_PAYMENT',v_address->>'recipientName',v_address->>'recipientPhone',v_address->>'postalCode',v_address->>'roadAddress',coalesce(v_address->>'detailAddress',''),v_address->>'deliveryMemo',v_idem,encode(gen_random_bytes(24),'hex'),now()+interval '15 minutes')
  returning id,order_number into v_order_id,v_order_number;

  for v_item in select value from jsonb_array_elements(v_items) loop
    v_qty := greatest(1,coalesce(nullif(v_item->>'quantity','')::integer,1));
    select p.* into v_product from public.products p
    where p.id=(v_item->>'productId')::uuid and p.active and p.sale_status='ON_SALE' and p.approval_status='APPROVED' for update;
    if not found then raise exception 'PRODUCT_NOT_AVAILABLE'; end if;
    if v_qty < v_product.min_order_quantity or v_qty > v_product.max_order_quantity then raise exception 'ORDER_QUANTITY_OUT_OF_RANGE'; end if;
    v_option_id := null;
    v_option_name := null;
    v_option_additional := 0;
    v_option_available := null;
    if nullif(v_item->>'optionId','') is not null then
      select po.id,po.option_name,po.additional_price,po.stock_quantity-po.reserved_stock
      into v_option_id,v_option_name,v_option_additional,v_option_available
      from public.product_options po where po.id=(v_item->>'optionId')::uuid and po.product_id=v_product.id and po.active for update;
      if not found or v_option_available < v_qty then raise exception 'OPTION_STOCK_SHORTAGE'; end if;
      update public.product_options set reserved_stock=reserved_stock+v_qty where id=v_option_id;
    else
      if v_product.stock_quantity-v_product.reserved_stock < v_qty then raise exception 'PRODUCT_STOCK_SHORTAGE'; end if;
    end if;
    update public.products set reserved_stock=reserved_stock+v_qty where id=v_product.id;
    v_unit_price := v_product.sale_price + coalesce(v_option_additional,0);
    v_line_total := v_unit_price*v_qty;
    v_product_total := v_product_total+v_line_total;
    if not v_product.free_shipping and not (v_sellers_shipping ? v_product.seller_id::text) then
      v_shipping_total := v_shipping_total+v_product.shipping_fee;
      v_sellers_shipping := v_sellers_shipping || jsonb_build_object(v_product.seller_id::text,true);
    end if;
    insert into public.order_items(order_id,product_id,seller_id,product_name,option_name,option_id,unit_price,quantity,status,reward_points)
    values(v_order_id,v_product.id,v_product.seller_id,v_product.name,v_option_name,v_option_id,v_unit_price,v_qty,'PENDING_PAYMENT',least(v_product.reward_max,round(v_line_total*v_product.reward_rate/100.0)::bigint))
    returning id into v_order_item_id;
    insert into public.inventory_reservations(order_id,order_item_id,product_id,option_id,quantity,expires_at)
    values(v_order_id,v_order_item_id,v_product.id,v_option_id,v_qty,now()+interval '15 minutes');
  end loop;

  if v_coupon_issue is not null then
    select ci.id issue_id,ci.user_id,ci.status issue_status,ci.expires_at issue_expires,
           c.discount_type,c.discount_value,c.minimum_order_amount,c.maximum_discount_amount,c.status coupon_status,c.starts_at,c.ends_at
    into v_coupon from public.coupon_issues ci join public.coupons c on c.id=ci.coupon_id
    where ci.id=v_coupon_issue and ci.user_id=v_uid and ci.status='AVAILABLE' and ci.expires_at>now() and c.status='ACTIVE' and now() between c.starts_at and c.ends_at for update;
    if not found then raise exception 'COUPON_NOT_AVAILABLE'; end if;
    if v_product_total < v_coupon.minimum_order_amount then raise exception 'COUPON_MINIMUM_NOT_MET'; end if;
    v_discount := case when v_coupon.discount_type='FIXED' then v_coupon.discount_value else floor(v_product_total*v_coupon.discount_value/100.0)::bigint end;
    if v_coupon.maximum_discount_amount is not null then v_discount:=least(v_discount,v_coupon.maximum_discount_amount); end if;
    v_discount:=least(v_discount,v_product_total+v_shipping_total);
    v_discount_total:=v_discount_total+v_discount;
    update public.coupon_issues set status='RESERVED',reserved_order_id=v_order_id where id=v_coupon_issue;
  end if;

  select pa.available_balance into v_point_balance from public.point_accounts pa where pa.user_id=v_uid for update;
  if v_points > coalesce(v_point_balance,0) then raise exception 'POINT_BALANCE_SHORTAGE'; end if;
  v_points:=least(v_points,greatest(0,v_product_total+v_shipping_total-v_discount_total));
  if v_points>0 then
    update public.point_accounts set available_balance=available_balance-v_points,reserved_balance=reserved_balance+v_points,updated_at=now() where user_id=v_uid;
    insert into public.point_ledger(user_id,order_id,entry_type,amount,balance_after,reason,idempotency_key)
    values(v_uid,v_order_id,'RESERVE',-v_points,v_point_balance-v_points,'주문 결제 포인트 예약',v_idem||':POINT_RESERVE');
  end if;

  update public.orders o set product_total=v_product_total,shipping_total=v_shipping_total,discount_total=v_discount_total+v_points,
    paid_total=greatest(0,v_product_total+v_shipping_total-v_discount_total-v_points),coupon_issue_id=v_coupon_issue,points_used=v_points
  where o.id=v_order_id;
  insert into public.payments(order_id,provider_order_id,amount,balance_amount,status)
  values(v_order_id,v_order_number,greatest(0,v_product_total+v_shipping_total-v_discount_total-v_points),greatest(0,v_product_total+v_shipping_total-v_discount_total-v_points),'READY')
  returning id into v_payment_id;
  update public.orders set payment_id=v_payment_id where id=v_order_id;
  insert into public.order_status_history(order_id,to_status,actor_id,reason) values(v_order_id,'PENDING_PAYMENT',v_uid,'CHECKOUT_PREPARED');
  select case when count(*)=1 then max(oi.product_name) else max(oi.product_name)||' 외 '||(count(*)-1)::text||'건' end into v_order_name
  from public.order_items oi where oi.order_id=v_order_id;
  perform public.audit_event('CHECKOUT_PREPARED','ORDER',v_order_id::text,null,jsonb_build_object('amount',greatest(0,v_product_total+v_shipping_total-v_discount_total-v_points)));

  return jsonb_build_object(
    'orderId',v_order_id,'orderNumber',v_order_number,'paymentId',v_payment_id,'orderName',v_order_name,
    'productTotal',v_product_total,'shippingTotal',v_shipping_total,'couponDiscount',v_discount_total,'pointsUsed',v_points,
    'totalPaymentAmount',greatest(0,v_product_total+v_shipping_total-v_discount_total-v_points),
    'expiresAt',(select o.expires_at from public.orders o where o.id=v_order_id),
    'successUrl',coalesce(p_payload->>'successUrl','/payment-success.html'),
    'failUrl',coalesce(p_payload->>'failUrl','/payment-fail.html')
  );
exception when others then
  if v_order_id is not null then perform public.release_checkout(v_order_id,sqlerrm); end if;
  raise;
end $$;

create or replace function public.finalize_payment(p_payment_id uuid, p_payment_key text, p_order_id text, p_amount bigint, p_provider_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare pay public.payments%rowtype; ord public.orders%rowtype; r record; total_reward bigint;
begin
  select * into pay from public.payments where id=p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  select * into ord from public.orders where id=pay.order_id for update;
  if pay.status='DONE' then return jsonb_build_object('orderId',ord.id,'orderNumber',ord.order_number,'paymentId',pay.id,'status','DONE','idempotentReplay',true); end if;
  if pay.provider_order_id<>p_order_id or pay.amount<>p_amount or ord.paid_total<>p_amount then raise exception 'PAYMENT_AMOUNT_OR_ORDER_MISMATCH'; end if;
  if ord.expires_at<now() and coalesce(p_provider_payload->>'status','DONE')<>'WAITING_FOR_DEPOSIT' then perform public.release_checkout(ord.id,'PAYMENT_EXPIRED'); raise exception 'PAYMENT_EXPIRED'; end if;
  if coalesce(p_provider_payload->>'status','DONE')='WAITING_FOR_DEPOSIT' then
    update public.payments set provider_payment_key=p_payment_key,status='WAITING_FOR_DEPOSIT',method=p_provider_payload->>'method',balance_amount=p_amount,raw_response=p_provider_payload,updated_at=now() where id=pay.id;
    update public.orders set status='WAITING_FOR_DEPOSIT',payment_key=p_payment_key,payment_provider='TOSS',expires_at=greatest(expires_at,coalesce((p_provider_payload->>'dueDate')::timestamptz,now()+interval '24 hours')),updated_at=now() where id=ord.id;
    update public.inventory_reservations set expires_at=(select expires_at from public.orders where id=ord.id),updated_at=now() where order_id=ord.id and status='RESERVED';
    insert into public.order_status_history(order_id,from_status,to_status,actor_id,reason) values(ord.id,ord.status,'WAITING_FOR_DEPOSIT',ord.buyer_id,'VIRTUAL_ACCOUNT_WAITING');
    return jsonb_build_object('orderId',ord.id,'orderNumber',ord.order_number,'paymentId',pay.id,'status','WAITING_FOR_DEPOSIT','amount',p_amount);
  end if;
  for r in select * from public.inventory_reservations where order_id=ord.id and status='RESERVED' for update loop
    update public.products set stock_quantity=stock_quantity-r.quantity,reserved_stock=greatest(0,reserved_stock-r.quantity) where id=r.product_id and stock_quantity>=r.quantity;
    if r.option_id is not null then update public.product_options set stock_quantity=stock_quantity-r.quantity,reserved_stock=greatest(0,reserved_stock-r.quantity) where id=r.option_id and stock_quantity>=r.quantity; end if;
    update public.inventory_reservations set status='COMMITTED',updated_at=now() where id=r.id;
    insert into public.inventory_movements(seller_id,product_id,option_id,movement_type,quantity,reference_type,reference_id,actor_id)
      select p.seller_id,r.product_id,r.option_id,'SALE',-r.quantity,'ORDER',ord.id::text,ord.buyer_id from public.products p where p.id=r.product_id;
  end loop;
  update public.payments set provider_payment_key=p_payment_key,status=coalesce(p_provider_payload->>'status','DONE'),method=p_provider_payload->>'method',balance_amount=coalesce((p_provider_payload->>'balanceAmount')::bigint,p_amount),raw_response=p_provider_payload,approved_at=coalesce((p_provider_payload->>'approvedAt')::timestamptz,now()),updated_at=now() where id=pay.id;
  update public.orders set status=case when coalesce(p_provider_payload->>'status','DONE')='WAITING_FOR_DEPOSIT' then 'WAITING_FOR_DEPOSIT' else 'PAID' end,payment_key=p_payment_key,payment_provider='TOSS',updated_at=now() where id=ord.id;
  update public.order_items set status='PAID' where order_id=ord.id;
  update public.coupon_issues set status='USED',used_at=now() where id=ord.coupon_issue_id and status='RESERVED';
  if ord.points_used>0 then
    update public.point_accounts set reserved_balance=greatest(0,reserved_balance-ord.points_used),updated_at=now() where user_id=ord.buyer_id;
    insert into public.point_ledger(user_id,order_id,entry_type,amount,balance_after,reason,idempotency_key)
      select ord.buyer_id,ord.id,'USE',-ord.points_used,available_balance,'주문 결제 포인트 사용',ord.idempotency_key||':POINT_USE' from public.point_accounts where user_id=ord.buyer_id on conflict do nothing;
  end if;
  insert into public.shipments(order_id,seller_id)
    select ord.id,seller_id from public.order_items where order_id=ord.id group by seller_id on conflict(order_id,seller_id) do nothing;
  insert into public.order_status_history(order_id,from_status,to_status,actor_id,reason) values(ord.id,'PENDING_PAYMENT','PAID',ord.buyer_id,'PAYMENT_CONFIRMED');
  insert into public.notifications(user_id,type,title,message)
  values(ord.buyer_id,'ORDER_PAID','결제가 완료되었습니다',ord.order_number||' 주문의 결제가 완료되었습니다.');
  insert into public.notifications(user_id,type,title,message)
    select s.owner_id,'NEW_ORDER','새 주문이 들어왔습니다',ord.order_number||' 주문을 확인해 주세요.' from public.shipments sh join public.sellers s on s.id=sh.seller_id where sh.order_id=ord.id;
  perform public.audit_event('PAYMENT_CONFIRMED','PAYMENT',pay.id::text,null,jsonb_build_object('orderId',ord.id,'amount',p_amount));
  return jsonb_build_object('orderId',ord.id,'orderNumber',ord.order_number,'paymentId',pay.id,'status',(select status from public.payments where id=pay.id),'amount',p_amount);
end $$;

create or replace function public.fail_payment(p_payment_id uuid, p_code text, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
declare oid uuid;
begin
  update public.payments set status='FAILED',raw_response=jsonb_build_object('code',p_code,'message',p_message),updated_at=now() where id=p_payment_id returning order_id into oid;
  if oid is not null then perform public.release_checkout(oid,coalesce(p_code,'PAYMENT_FAILED')); end if;
end $$;

create or replace function public.cancel_order(p_order_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_active_user(); ord public.orders%rowtype;
begin
  select * into ord from public.orders where (id=p_order_id or order_number=p_order_id::text) and buyer_id=uid for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if ord.status in ('PENDING_PAYMENT','PAYMENT_FAILED') then
    perform public.release_checkout(ord.id,p_reason);
    update public.orders set status='CANCELED',canceled_at=now(),updated_at=now() where id=ord.id;
  elsif ord.status in ('PAID','PREPARING') then
    raise exception 'PAID_ORDER_REQUIRES_PAYMENT_CANCEL';
  else raise exception 'ORDER_CANNOT_BE_CANCELED'; end if;
  insert into public.order_status_history(order_id,from_status,to_status,actor_id,reason) values(ord.id,ord.status,'CANCELED',uid,p_reason);
  return jsonb_build_object('orderId',ord.id,'status','CANCELED');
end $$;

create or replace function public.confirm_order(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_active_user(); ord public.orders%rowtype; reward bigint;
begin
  select * into ord from public.orders where id=p_order_id and buyer_id=uid for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if ord.status<>'DELIVERED' then raise exception 'ORDER_NOT_CONFIRMABLE'; end if;
  update public.orders set status='CONFIRMED',confirmed_at=now(),updated_at=now() where id=ord.id;
  update public.order_items set status='CONFIRMED' where order_id=ord.id;
  select coalesce(sum(reward_points),0) into reward from public.order_items where order_id=ord.id;
  if reward>0 then
    update public.point_accounts set available_balance=available_balance+reward,updated_at=now() where user_id=uid;
    insert into public.point_ledger(user_id,order_id,entry_type,amount,balance_after,reason,idempotency_key,expires_at)
      select uid,ord.id,'EARN',reward,available_balance,'구매확정 적립',ord.idempotency_key||':REWARD',now()+interval '1 year' from public.point_accounts where user_id=uid on conflict do nothing;
  end if;
  insert into public.order_status_history(order_id,from_status,to_status,actor_id,reason) values(ord.id,ord.status,'CONFIRMED',uid,'BUYER_CONFIRM');
  return jsonb_build_object('orderId',ord.id,'status','CONFIRMED','rewardPoints',reward);
end $$;

create or replace function public.approve_seller_application(p_application_id uuid, p_memo text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare admin_id uuid := public.assert_role(array['admin']); app public.seller_applications%rowtype; seller_id uuid;
begin
  select * into app from public.seller_applications where id=p_application_id for update;
  if not found then raise exception 'APPLICATION_NOT_FOUND'; end if;
  if app.status='APPROVED' then select id into seller_id from public.sellers where business_number=app.business_number; return jsonb_build_object('sellerId',seller_id,'status','APPROVED','idempotentReplay',true); end if;
  if app.business_verification_status<>'VERIFIED' then raise exception 'BUSINESS_NOT_VERIFIED'; end if;
  if app.user_id is null then raise exception 'APPLICATION_USER_REQUIRED'; end if;
  insert into public.sellers(owner_id,store_name,representative_name,business_number,business_address,customer_service_phone,customer_service_email,approval_status,status)
  values(app.user_id,app.store_name,coalesce(app.representative_name,app.applicant_name),app.business_number,coalesce(app.road_address,app.business_address)||case when coalesce(app.detail_address,'')='' then '' else ' '||app.detail_address end,app.phone,app.applicant_email,'APPROVED','ACTIVE')
  on conflict(business_number) do update set approval_status='APPROVED',status='ACTIVE',updated_at=now() returning id into seller_id;
  update public.profiles set role='seller' where id=app.user_id and status='active';
  update public.seller_applications set status='APPROVED',reviewed_at=now(),reviewed_by=admin_id,rejection_reason=null,updated_at=now() where id=app.id;
  insert into public.seller_kyc(seller_id) values(seller_id) on conflict(seller_id) do nothing;
  insert into public.notifications(user_id,type,title,message) values(app.user_id,'SELLER_APPROVED','입점이 승인되었습니다',app.store_name||' 판매자 계정이 활성화되었습니다.');
  perform public.audit_event('SELLER_APPLICATION_APPROVE','SELLER_APPLICATION',app.id::text,p_memo,jsonb_build_object('sellerId',seller_id));
  return jsonb_build_object('sellerId',seller_id,'status','APPROVED');
end $$;

create or replace function public.reject_seller_application(p_application_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare admin_id uuid := public.assert_role(array['admin']); app public.seller_applications%rowtype;
begin
  if length(trim(coalesce(p_reason,'')))<2 then raise exception 'REJECTION_REASON_REQUIRED'; end if;
  update public.seller_applications set status='REJECTED',rejection_reason=p_reason,reviewed_at=now(),reviewed_by=admin_id,updated_at=now() where id=p_application_id returning * into app;
  if not found then raise exception 'APPLICATION_NOT_FOUND'; end if;
  if app.user_id is not null then insert into public.notifications(user_id,type,title,message) values(app.user_id,'SELLER_REJECTED','입점 신청 보완이 필요합니다',p_reason); end if;
  perform public.audit_event('SELLER_APPLICATION_REJECT','SELLER_APPLICATION',app.id::text,p_reason);
  return jsonb_build_object('applicationId',app.id,'status','REJECTED');
end $$;

create or replace function public.submit_product_for_approval(p_product_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_role(array['seller','admin']); p public.products%rowtype;
begin
  select * into p from public.products where id=p_product_id and (public.owns_seller(seller_id) or public.is_admin()) for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if trim(p.name)='' or p.sale_price<=0 or p.stock_quantity<0 or p.category_id is null or p.primary_image_url is null or trim(p.origin)='' then raise exception 'PRODUCT_REQUIRED_FIELDS_MISSING'; end if;
  if not exists(select 1 from public.product_images where product_id=p.id) then raise exception 'PRODUCT_IMAGES_REQUIRED'; end if;
  update public.products set sale_status='PENDING_APPROVAL',approval_status='PENDING',approval_reason=null where id=p.id;
  insert into public.product_approval_history(product_id,actor_id,from_status,to_status) values(p.id,uid,p.approval_status,'PENDING');
  return jsonb_build_object('productId',p.id,'approvalStatus','PENDING','saleStatus','PENDING_APPROVAL');
end $$;

create or replace function public.review_product(p_product_id uuid, p_approve boolean, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_role(array['admin']); p public.products%rowtype; target text;
begin
  select * into p from public.products where id=p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  target:=case when p_approve then 'APPROVED' else 'REJECTED' end;
  if not p_approve and length(trim(coalesce(p_reason,'')))<2 then raise exception 'REJECTION_REASON_REQUIRED'; end if;
  update public.products set approval_status=target,sale_status=case when p_approve then case when stock_quantity>0 then 'ON_SALE' else 'SOLD_OUT' end else 'DRAFT' end,approval_reason=p_reason where id=p.id;
  insert into public.product_approval_history(product_id,actor_id,from_status,to_status,reason,snapshot) values(p.id,uid,p.approval_status,target,p_reason,to_jsonb(p));
  insert into public.notifications(user_id,type,title,message)
    select s.owner_id,'PRODUCT_REVIEW',case when p_approve then '상품 판매가 승인되었습니다' else '상품 보완이 필요합니다' end,coalesce(p_reason,p.name) from public.sellers s where s.id=p.seller_id;
  perform public.audit_event('PRODUCT_REVIEW','PRODUCT',p.id::text,p_reason,jsonb_build_object('approved',p_approve));
  return jsonb_build_object('productId',p.id,'approvalStatus',target);
end $$;

create or replace function public.transition_shipment(p_shipment_id uuid, p_target text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := public.assert_active_user(); sh public.shipments%rowtype; v_role text; allowed boolean:=false;
begin
  select p.role into v_role from public.profiles p where p.id=uid;
  select * into sh from public.shipments where id=p_shipment_id for update;
  if not found then raise exception 'SHIPMENT_NOT_FOUND'; end if;
  allowed := v_role='admin' or exists(select 1 from public.sellers where id=sh.seller_id and owner_id=uid);
  if not allowed then raise exception 'SHIPMENT_FORBIDDEN'; end if;
  p_target:=upper(p_target);
  if p_target='PREPARING' and sh.status='READY' then
    update public.shipments set status='PREPARING',prepared_at=now() where id=sh.id;
  elsif p_target='SHIPPED' and sh.status in ('READY','PREPARING') then
    if nullif(p_payload->>'trackingNumber','') is null then raise exception 'TRACKING_NUMBER_REQUIRED'; end if;
    update public.shipments set status='SHIPPED',carrier_code=p_payload->>'carrierCode',carrier_name=p_payload->>'carrierName',tracking_number=p_payload->>'trackingNumber',dispatched_at=now() where id=sh.id;
  elsif p_target='IN_TRANSIT' and sh.status='SHIPPED' then update public.shipments set status='IN_TRANSIT' where id=sh.id;
  elsif p_target='DELIVERED' and sh.status in ('SHIPPED','IN_TRANSIT') then update public.shipments set status='DELIVERED',delivered_at=now() where id=sh.id;
  else raise exception 'INVALID_SHIPMENT_TRANSITION'; end if;
  insert into public.shipment_events(shipment_id,status,description) values(sh.id,p_target,coalesce(p_payload->>'description','상태 변경'));
  update public.order_items set status=p_target where order_id=sh.order_id and seller_id=sh.seller_id;
  if not exists(select 1 from public.shipments where order_id=sh.order_id and status<>'DELIVERED') then update public.orders set status='DELIVERED' where id=sh.order_id; end if;
  perform public.audit_event('SHIPMENT_TRANSITION','SHIPMENT',sh.id::text,p_target,p_payload);
  return (select to_jsonb(x) from public.shipments x where x.id=sh.id);
end $$;

create or replace function public.create_claim(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid:=public.assert_active_user(); oi public.order_items%rowtype; ord public.orders%rowtype; claim_id uuid; q integer:=greatest(1,coalesce((p_payload->>'quantity')::integer,1)); ev text;
begin
  select * into oi from public.order_items where id=(p_payload->>'orderItemId')::uuid;
  if not found then raise exception 'ORDER_ITEM_NOT_FOUND'; end if;
  select * into ord from public.orders where id=oi.order_id and buyer_id=uid;
  if not found then raise exception 'ORDER_ITEM_FORBIDDEN'; end if;
  if q>oi.quantity then raise exception 'CLAIM_QUANTITY_INVALID'; end if;
  insert into public.claims(order_item_id,requester_id,claim_type,reason_code,reason_detail,quantity,status,return_method,exchange_option_id,request_key)
  values(oi.id,uid,upper(p_payload->>'type'),coalesce(p_payload->>'reason','OTHER'),p_payload->>'reasonDetail',q,'REQUESTED',p_payload->>'returnMethod',nullif(p_payload->>'exchangeOptionId','')::uuid,p_payload->>'requestKey')
  returning id into claim_id;
  if jsonb_typeof(p_payload->'evidenceUrls')='array' then
    for ev in select jsonb_array_elements_text(p_payload->'evidenceUrls') loop insert into public.claim_evidence(claim_id,object_path) values(claim_id,ev); end loop;
  end if;
  insert into public.claim_history(claim_id,actor_id,to_status,memo) values(claim_id,uid,'REQUESTED',p_payload->>'reasonDetail');
  insert into public.notifications(user_id,type,title,message)
    select s.owner_id,'NEW_CLAIM','취소·반품·교환 요청이 접수되었습니다',ord.order_number from public.sellers s where s.id=oi.seller_id;
  return jsonb_build_object('claimId',claim_id,'status','REQUESTED');
end $$;

create or replace function public.transition_claim(p_claim_id uuid, p_action text, p_memo text default null, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid:=public.assert_active_user(); v_role text; c public.claims%rowtype; oi public.order_items%rowtype; target text;
begin
  select p.role into v_role from public.profiles p where p.id=uid;
  select * into c from public.claims where id=p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  select * into oi from public.order_items where id=c.order_item_id;
  if v_role='consumer' and c.requester_id<>uid then raise exception 'CLAIM_FORBIDDEN'; end if;
  if v_role='seller' and not public.owns_seller(oi.seller_id) then raise exception 'CLAIM_FORBIDDEN'; end if;
  p_action:=lower(p_action);
  target:=case p_action when 'withdraw' then 'WITHDRAWN' when 'approve' then 'APPROVED' when 'reject' then 'REJECTED' when 'received' then 'RETURN_RECEIVED' when 'complete-return' then 'COMPLETED' when 'replacement' then 'REPLACEMENT_SHIPPED' else null end;
  if target is null then raise exception 'CLAIM_ACTION_INVALID'; end if;
  if p_action='withdraw' and (v_role<>'consumer' or c.status<>'REQUESTED') then raise exception 'CLAIM_WITHDRAW_INVALID'; end if;
  if p_action in ('approve','reject') and v_role not in ('seller','admin') then raise exception 'CLAIM_REVIEW_FORBIDDEN'; end if;
  update public.claims set status=target,seller_memo=case when v_role='seller' then p_memo else seller_memo end,admin_memo=case when v_role='admin' then p_memo else admin_memo end,approved_at=case when target='APPROVED' then now() else approved_at end,completed_at=case when target='COMPLETED' then now() else completed_at end where id=c.id;
  insert into public.claim_history(claim_id,actor_id,from_status,to_status,memo) values(c.id,uid,c.status,target,p_memo);
  insert into public.notifications(user_id,type,title,message) values(c.requester_id,'CLAIM_STATUS','클레임 상태가 변경되었습니다',target);
  perform public.audit_event('CLAIM_TRANSITION','CLAIM',c.id::text,p_memo,jsonb_build_object('from',c.status,'to',target));
  return jsonb_build_object('claimId',c.id,'status',target,'requiresRefund',target='APPROVED' and c.claim_type in ('CANCEL','RETURN'));
end $$;

create or replace function public.withdraw_member(p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid:=public.assert_active_user();
begin
  if exists(select 1 from public.orders where buyer_id=uid and status in ('PAID','PREPARING','SHIPPED','IN_TRANSIT','DELIVERED')) then raise exception 'ACTIVE_ORDER_EXISTS'; end if;
  update public.profiles set status='withdrawn',display_name='탈퇴회원',phone=null,withdrawal_requested_at=now(),updated_at=now() where id=uid;
  delete from public.addresses where user_id=uid;
  delete from public.favorites where user_id=uid;
  delete from public.seller_favorites where user_id=uid;
  delete from public.cart_items where cart_id in(select id from public.carts where user_id=uid);
  perform public.audit_event('MEMBER_WITHDRAW','PROFILE',uid::text,p_reason);
end $$;

create or replace function public.expire_stale_reservations()
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; n integer:=0;
begin
  for r in select distinct order_id from public.inventory_reservations where status='RESERVED' and expires_at<now() loop
    perform public.release_checkout(r.order_id,'RESERVATION_EXPIRED'); n:=n+1;
  end loop;
  update public.coupon_issues set status='EXPIRED' where status='AVAILABLE' and expires_at<now();
  return n;
end $$;

-- 함수 실행권한 최소화
revoke execute on function public.assert_active_user() from public,anon;
revoke execute on function public.assert_role(text[]) from public,anon;
revoke execute on function public.prepare_checkout(jsonb) from public,anon;
revoke execute on function public.finalize_payment(uuid,text,text,bigint,jsonb) from public,anon,authenticated;
revoke execute on function public.fail_payment(uuid,text,text) from public,anon,authenticated;
revoke execute on function public.release_checkout(uuid,text) from public,anon,authenticated;
revoke execute on function public.approve_seller_application(uuid,text) from public,anon;
revoke execute on function public.reject_seller_application(uuid,text) from public,anon;
revoke execute on function public.review_product(uuid,boolean,text) from public,anon;
revoke execute on function public.expire_stale_reservations() from public,anon,authenticated;

grant execute on function public.current_app_role(), public.current_seller_id(), public.cart_snapshot(), public.cart_add(uuid,uuid,integer), public.cart_update_quantity(uuid,integer), public.cart_remove(uuid), public.cart_clear(), public.toggle_product_favorite(uuid,boolean), public.toggle_seller_favorite(uuid,boolean), public.record_recent_view(uuid), public.set_default_address(uuid), public.register_consent_receipts(jsonb,text,text,text), public.cancel_order(uuid,text), public.confirm_order(uuid), public.submit_product_for_approval(uuid), public.transition_shipment(uuid,text,jsonb), public.create_claim(jsonb), public.transition_claim(uuid,text,text,jsonb), public.withdraw_member(text) to authenticated;
grant execute on function public.prepare_checkout(jsonb) to authenticated;
grant execute on function public.approve_seller_application(uuid,text), public.reject_seller_application(uuid,text), public.review_product(uuid,boolean,text) to authenticated;
