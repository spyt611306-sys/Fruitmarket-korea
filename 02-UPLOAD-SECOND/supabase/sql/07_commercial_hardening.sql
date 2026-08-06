-- 푸릇마켓 상용화 안전장치
-- 브라우저 publishable key로 역할·승인·결제금액을 임의 변경하지 못하도록 보호합니다.

create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    if new.id is distinct from old.id
       or new.role is distinct from old.role
       or new.status is distinct from old.status then
      raise exception 'PROFILE_PRIVILEGE_CHANGE_FORBIDDEN';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_privilege_guard on public.profiles;
create trigger profiles_privilege_guard
before update on public.profiles
for each row execute function public.guard_profile_privileges();

create or replace function public.guard_seller_approval_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    if new.owner_id is distinct from old.owner_id
       or new.approval_status is distinct from old.approval_status
       or new.status is distinct from old.status then
      raise exception 'SELLER_APPROVAL_CHANGE_FORBIDDEN';
    end if;
    if row(new.store_name, new.representative_name, new.business_number, new.business_address,
           new.customer_service_phone, new.customer_service_email)
       is distinct from
       row(old.store_name, old.representative_name, old.business_number, old.business_address,
           old.customer_service_phone, old.customer_service_email) then
      new.approval_status := 'PENDING';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sellers_approval_guard on public.sellers;
create trigger sellers_approval_guard
before update on public.sellers
for each row execute function public.guard_seller_approval_fields();

create or replace function public.guard_product_approval_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.approval_status := 'PENDING';
    if new.sale_status <> 'DRAFT' then
      new.sale_status := 'PENDING_APPROVAL';
    end if;
    return new;
  end if;

  if new.seller_id is distinct from old.seller_id then
    raise exception 'PRODUCT_SELLER_CHANGE_FORBIDDEN';
  end if;

  -- 가격·표시·상품정보가 바뀌면 재승인을 요구합니다. 재고수량만 바꾼 경우는 제외합니다.
  if row(new.name, new.short_description, new.description, new.sale_price, new.list_price,
         new.origin, new.brix, new.free_shipping, new.today_shipping, new.primary_image_url,
         new.category_id)
     is distinct from
     row(old.name, old.short_description, old.description, old.sale_price, old.list_price,
         old.origin, old.brix, old.free_shipping, old.today_shipping, old.primary_image_url,
         old.category_id) then
    new.approval_status := 'PENDING';
    if new.sale_status = 'ON_SALE' then
      new.sale_status := 'PENDING_APPROVAL';
    end if;
  else
    new.approval_status := old.approval_status;
  end if;
  return new;
end;
$$;

drop trigger if exists products_approval_guard on public.products;
create trigger products_approval_guard
before insert or update on public.products
for each row execute function public.guard_product_approval_fields();


-- 공개 상품은 상품 승인뿐 아니라 판매자 승인·활성 상태도 모두 충족해야 합니다.
drop policy if exists "public reads approved products" on public.products;
create policy "public reads approved products" on public.products
for select using (
  (
    active
    and sale_status='ON_SALE'
    and approval_status='APPROVED'
    and exists (
      select 1 from public.sellers s
      where s.id=seller_id and s.approval_status='APPROVED' and s.status='ACTIVE'
    )
  )
  or public.owns_seller(seller_id)
  or public.is_admin()
);

-- 관리자도 authenticated 역할로 접속하므로 RLS를 전제로 관리 테이블 권한을 부여합니다.
grant select, insert, update, delete on
  public.business_information,
  public.categories,
  public.banners,
  public.home_products,
  public.policies,
  public.search_keywords,
  public.reviews,
  public.notifications,
  public.sellers,
  public.seller_applications,
  public.profiles,
  public.products,
  public.product_images,
  public.product_options,
  public.claims
  to authenticated;

grant usage, select on all sequences in schema public to authenticated;

-- 주문·결제금액·주문상품은 브라우저에서 직접 쓰지 못하게 합니다.
-- 향후 Supabase Edge Function 또는 신뢰할 수 있는 서버가 service_role로 트랜잭션을 처리해야 합니다.
drop policy if exists "buyers create pending orders" on public.orders;
revoke insert, update, delete on public.orders from authenticated;
revoke insert, update, delete on public.order_items from authenticated;

-- 보안용 트리거 함수는 직접 호출할 필요가 없습니다.
revoke all on function public.guard_profile_privileges() from public, anon, authenticated;
revoke all on function public.guard_seller_approval_fields() from public, anon, authenticated;
revoke all on function public.guard_product_approval_fields() from public, anon, authenticated;
