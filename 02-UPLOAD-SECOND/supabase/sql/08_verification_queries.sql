-- 모든 설치가 끝난 뒤 마지막으로 실행하는 읽기 전용 검증 쿼리입니다.

-- 1. 핵심 테이블 존재 확인
select table_name
from information_schema.tables
where table_schema='public'
  and table_name in (
    'profiles','business_information','sellers','seller_applications','categories','banners',
    'products','product_images','product_options','home_products','addresses','favorites',
    'carts','cart_items','orders','order_items','claims','reviews','policies','notifications',
    'search_keywords','audit_logs'
  )
order by table_name;

-- 2. public 테이블 RLS 활성화 확인: rowsecurity가 모두 true여야 합니다.
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname='public'
order by tablename;

-- 3. 공개 기본 데이터 확인
select id, brand_name, legal_name, representative_name, registration_number,
       ecommerce_registration_number, public_business_address
from public.business_information;
select count(*) as active_category_count from public.categories where active=true;
select count(*) as active_home_banner_count from public.banners where active=true and placement='HOME_HERO';

-- 4. 역할·승인 보호 트리거 확인
select event_object_table, trigger_name, action_timing, event_manipulation
from information_schema.triggers
where trigger_schema='public'
  and trigger_name in ('profiles_privilege_guard','sellers_approval_guard','products_approval_guard')
order by event_object_table, trigger_name;

-- 5. 주문 직접쓰기 권한이 없어야 합니다.
select
  has_table_privilege('authenticated','public.orders','INSERT') as authenticated_can_insert_orders,
  has_table_privilege('authenticated','public.orders','UPDATE') as authenticated_can_update_orders,
  has_table_privilege('authenticated','public.order_items','INSERT') as authenticated_can_insert_order_items;

-- 6. Storage 버킷은 Dashboard에서 만든 뒤 확인합니다.
select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id in ('public-assets','product-images','seller-documents','claim-evidence')
order by id;
