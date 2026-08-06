create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  if tg_table_name = 'products' then new.version = coalesce(old.version,0) + 1; end if;
  return new;
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, display_name)
  values(new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)))
  on conflict(id) do nothing;
  insert into public.carts(user_id) values(new.id) on conflict(user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin' and status = 'active');
$$;

create or replace function public.owns_seller(target_seller uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.sellers where id = target_seller and owner_id = auth.uid() and status <> 'CLOSED');
$$;

create or replace function public.make_default_address(target_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from public.addresses where id=target_id and user_id=auth.uid()) then raise exception 'ADDRESS_NOT_FOUND'; end if;
  update public.addresses set is_default=false where user_id=auth.uid();
  update public.addresses set is_default=true where id=target_id and user_id=auth.uid();
end $$;

create or replace function public.increment_search_keyword(input_keyword text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if length(trim(input_keyword)) between 1 and 100 then
    insert into public.search_keywords(keyword,search_count) values(trim(input_keyword),1)
    on conflict(keyword) do update set search_count=public.search_keywords.search_count+1, updated_at=now();
  end if;
end $$;

create or replace function public.prevent_reserved_stock_overflow() returns trigger language plpgsql as $$
begin
  if new.reserved_stock < 0 or new.reserved_stock > new.stock_quantity then raise exception 'INVALID_RESERVED_STOCK'; end if;
  return new;
end $$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles for each row execute procedure public.set_updated_at();
drop trigger if exists sellers_updated_at on public.sellers;
create trigger sellers_updated_at before update on public.sellers for each row execute procedure public.set_updated_at();
drop trigger if exists categories_updated_at on public.categories;
create trigger categories_updated_at before update on public.categories for each row execute procedure public.set_updated_at();
drop trigger if exists banners_updated_at on public.banners;
create trigger banners_updated_at before update on public.banners for each row execute procedure public.set_updated_at();
drop trigger if exists products_updated_at on public.products;
create trigger products_updated_at before update on public.products for each row execute procedure public.set_updated_at();
drop trigger if exists product_options_updated_at on public.product_options;
create trigger product_options_updated_at before update on public.product_options for each row execute procedure public.set_updated_at();
drop trigger if exists addresses_updated_at on public.addresses;
create trigger addresses_updated_at before update on public.addresses for each row execute procedure public.set_updated_at();
drop trigger if exists carts_updated_at on public.carts;
create trigger carts_updated_at before update on public.carts for each row execute procedure public.set_updated_at();
drop trigger if exists cart_items_updated_at on public.cart_items;
create trigger cart_items_updated_at before update on public.cart_items for each row execute procedure public.set_updated_at();
drop trigger if exists orders_updated_at on public.orders;
create trigger orders_updated_at before update on public.orders for each row execute procedure public.set_updated_at();
drop trigger if exists claims_updated_at on public.claims;
create trigger claims_updated_at before update on public.claims for each row execute procedure public.set_updated_at();
drop trigger if exists reviews_updated_at on public.reviews;
create trigger reviews_updated_at before update on public.reviews for each row execute procedure public.set_updated_at();
drop trigger if exists products_reserved_stock_guard on public.products;
create trigger products_reserved_stock_guard before insert or update on public.products for each row execute procedure public.prevent_reserved_stock_overflow();
