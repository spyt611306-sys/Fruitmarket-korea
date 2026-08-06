-- 공개 스키마 모든 핵심 테이블에 RLS 활성화
alter table public.profiles enable row level security;
alter table public.business_information enable row level security;
alter table public.sellers enable row level security;
alter table public.seller_applications enable row level security;
alter table public.categories enable row level security;
alter table public.banners enable row level security;
alter table public.products enable row level security;
alter table public.product_images enable row level security;
alter table public.product_options enable row level security;
alter table public.home_products enable row level security;
alter table public.addresses enable row level security;
alter table public.favorites enable row level security;
alter table public.carts enable row level security;
alter table public.cart_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.claims enable row level security;
alter table public.reviews enable row level security;
alter table public.policies enable row level security;
alter table public.notifications enable row level security;
alter table public.search_keywords enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "public reads business information" on public.business_information;
create policy "public reads business information" on public.business_information for select using (true);
drop policy if exists "admin manages business information" on public.business_information;
create policy "admin manages business information" on public.business_information for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public reads active categories" on public.categories;
create policy "public reads active categories" on public.categories for select using (active or public.is_admin());
drop policy if exists "admin manages categories" on public.categories;
create policy "admin manages categories" on public.categories for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public reads active banners" on public.banners;
create policy "public reads active banners" on public.banners for select using (active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at >= now()) or public.is_admin());
drop policy if exists "admin manages banners" on public.banners;
create policy "admin manages banners" on public.banners for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "users read own profile" on public.profiles;
create policy "users read own profile" on public.profiles for select using (id=auth.uid() or public.is_admin());
drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles for update using (id=auth.uid()) with check (id=auth.uid());
drop policy if exists "admin manages profiles" on public.profiles;
create policy "admin manages profiles" on public.profiles for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public reads approved sellers" on public.sellers;
create policy "public reads approved sellers" on public.sellers for select using ((approval_status='APPROVED' and status='ACTIVE') or owner_id=auth.uid() or public.is_admin());
drop policy if exists "seller updates own seller" on public.sellers;
create policy "seller updates own seller" on public.sellers for update using (owner_id=auth.uid()) with check (owner_id=auth.uid());
drop policy if exists "admin manages sellers" on public.sellers;
create policy "admin manages sellers" on public.sellers for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "applicant creates application" on public.seller_applications;
create policy "applicant creates application" on public.seller_applications for insert to anon,authenticated with check (user_id is null or user_id=auth.uid());
drop policy if exists "applicant reads own application" on public.seller_applications;
create policy "applicant reads own application" on public.seller_applications for select using (user_id=auth.uid() or public.is_admin());
drop policy if exists "admin manages applications" on public.seller_applications;
create policy "admin manages applications" on public.seller_applications for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public reads approved products" on public.products;
create policy "public reads approved products" on public.products for select using ((active and sale_status='ON_SALE' and approval_status='APPROVED') or public.owns_seller(seller_id) or public.is_admin());
drop policy if exists "seller creates products" on public.products;
create policy "seller creates products" on public.products for insert with check (public.owns_seller(seller_id));
drop policy if exists "seller updates own products" on public.products;
create policy "seller updates own products" on public.products for update using (public.owns_seller(seller_id)) with check (public.owns_seller(seller_id));
drop policy if exists "seller deletes own draft products" on public.products;
create policy "seller deletes own draft products" on public.products for delete using (public.owns_seller(seller_id) and sale_status='DRAFT');
drop policy if exists "admin manages products" on public.products;
create policy "admin manages products" on public.products for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public reads product images" on public.product_images;
create policy "public reads product images" on public.product_images for select using (exists(select 1 from public.products p where p.id=product_id and (p.active and p.sale_status='ON_SALE' and p.approval_status='APPROVED' or public.owns_seller(p.seller_id) or public.is_admin())));
drop policy if exists "seller manages product images" on public.product_images;
create policy "seller manages product images" on public.product_images for all using (exists(select 1 from public.products p where p.id=product_id and public.owns_seller(p.seller_id))) with check (exists(select 1 from public.products p where p.id=product_id and public.owns_seller(p.seller_id)));
drop policy if exists "admin manages product images" on public.product_images;
create policy "admin manages product images" on public.product_images for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public reads active options" on public.product_options;
create policy "public reads active options" on public.product_options for select using (active and exists(select 1 from public.products p where p.id=product_id and p.active and p.sale_status='ON_SALE' and p.approval_status='APPROVED') or exists(select 1 from public.products p where p.id=product_id and (public.owns_seller(p.seller_id) or public.is_admin())));
drop policy if exists "seller manages options" on public.product_options;
create policy "seller manages options" on public.product_options for all using (exists(select 1 from public.products p where p.id=product_id and public.owns_seller(p.seller_id))) with check (exists(select 1 from public.products p where p.id=product_id and public.owns_seller(p.seller_id)));
drop policy if exists "admin manages options" on public.product_options;
create policy "admin manages options" on public.product_options for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public reads home products" on public.home_products;
create policy "public reads home products" on public.home_products for select using (active or public.is_admin());
drop policy if exists "admin manages home products" on public.home_products;
create policy "admin manages home products" on public.home_products for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "users manage own addresses" on public.addresses;
create policy "users manage own addresses" on public.addresses for all using (user_id=auth.uid()) with check (user_id=auth.uid());
drop policy if exists "admin reads addresses" on public.addresses;
create policy "admin reads addresses" on public.addresses for select using (public.is_admin());
drop policy if exists "users manage own favorites" on public.favorites;
create policy "users manage own favorites" on public.favorites for all using (user_id=auth.uid()) with check (user_id=auth.uid());
drop policy if exists "users manage own cart" on public.carts;
create policy "users manage own cart" on public.carts for all using (user_id=auth.uid()) with check (user_id=auth.uid());
drop policy if exists "users manage own cart items" on public.cart_items;
create policy "users manage own cart items" on public.cart_items for all using (exists(select 1 from public.carts c where c.id=cart_id and c.user_id=auth.uid())) with check (exists(select 1 from public.carts c where c.id=cart_id and c.user_id=auth.uid()));

drop policy if exists "buyers read own orders" on public.orders;
create policy "buyers read own orders" on public.orders for select using (buyer_id=auth.uid() or public.is_admin());
drop policy if exists "buyers create pending orders" on public.orders;
create policy "buyers create pending orders" on public.orders for insert with check (buyer_id=auth.uid() and status='PENDING_PAYMENT');
drop policy if exists "admin manages orders" on public.orders;
create policy "admin manages orders" on public.orders for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "buyers and sellers read order items" on public.order_items;
create policy "buyers and sellers read order items" on public.order_items for select using (exists(select 1 from public.orders o where o.id=order_id and o.buyer_id=auth.uid()) or public.owns_seller(seller_id) or public.is_admin());
drop policy if exists "admin manages order items" on public.order_items;
create policy "admin manages order items" on public.order_items for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "users read own claims" on public.claims;
create policy "users read own claims" on public.claims for select using (requester_id=auth.uid() or exists(select 1 from public.order_items oi where oi.id=order_item_id and public.owns_seller(oi.seller_id)) or public.is_admin());
drop policy if exists "users create own claims" on public.claims;
create policy "users create own claims" on public.claims for insert with check (requester_id=auth.uid());
drop policy if exists "seller or admin updates claims" on public.claims;
create policy "seller or admin updates claims" on public.claims for update using (exists(select 1 from public.order_items oi where oi.id=order_item_id and public.owns_seller(oi.seller_id)) or public.is_admin());

drop policy if exists "public reads published reviews" on public.reviews;
create policy "public reads published reviews" on public.reviews for select using (status='PUBLISHED' or user_id=auth.uid() or public.is_admin());
drop policy if exists "users create own reviews" on public.reviews;
create policy "users create own reviews" on public.reviews for insert with check (user_id=auth.uid());
drop policy if exists "users update own pending reviews" on public.reviews;
create policy "users update own pending reviews" on public.reviews for update using (user_id=auth.uid() and status='PENDING') with check (user_id=auth.uid());
drop policy if exists "admin moderates reviews" on public.reviews;
create policy "admin moderates reviews" on public.reviews for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public reads published policies" on public.policies;
create policy "public reads published policies" on public.policies for select using (published or public.is_admin());
drop policy if exists "admin manages policies" on public.policies;
create policy "admin manages policies" on public.policies for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "users read own notifications" on public.notifications;
create policy "users read own notifications" on public.notifications for select using (user_id=auth.uid());
drop policy if exists "users update own notifications" on public.notifications;
create policy "users update own notifications" on public.notifications for update using (user_id=auth.uid()) with check (user_id=auth.uid());
drop policy if exists "admin creates notifications" on public.notifications;
create policy "admin creates notifications" on public.notifications for insert with check (public.is_admin());
drop policy if exists "public reads popular keywords" on public.search_keywords;
create policy "public reads popular keywords" on public.search_keywords for select using (true);
drop policy if exists "admin manages keywords" on public.search_keywords;
create policy "admin manages keywords" on public.search_keywords for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin reads audit logs" on public.audit_logs;
create policy "admin reads audit logs" on public.audit_logs for select using (public.is_admin());
drop policy if exists "authenticated writes own audit events" on public.audit_logs;
create policy "authenticated writes own audit events" on public.audit_logs for insert with check (actor_id=auth.uid());

-- 최소 권한 부여
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.business_information, public.categories, public.banners, public.products, public.product_images, public.product_options, public.home_products, public.reviews, public.policies, public.search_keywords to anon, authenticated;
grant select,insert,update on public.profiles, public.sellers, public.seller_applications, public.addresses, public.favorites, public.carts, public.cart_items, public.orders, public.order_items, public.claims, public.notifications to authenticated;
grant delete on public.addresses, public.favorites, public.cart_items to authenticated;
grant insert,update,delete on public.products, public.product_images, public.product_options to authenticated;
grant execute on function public.make_default_address(uuid), public.increment_search_keyword(text) to authenticated;
