-- Part 46: 과일 전문 플랫폼 특화 구조
-- 로트/수확/포장/숙도/당도근거/콜드체인/리콜/기상 출고제한/FEFO 재고
begin;

create table if not exists public.product_fresh_profiles (
  product_id uuid primary key references public.products(id) on delete cascade,
  fruit_type text not null,
  variety text not null,
  cultivar text,
  farm_name text not null,
  producer_name text not null,
  production_region text not null,
  origin_country text not null default '대한민국',
  grade text,
  size_spec text,
  count_spec text,
  net_weight_grams integer check (net_weight_grams is null or net_weight_grams > 0),
  weight_tolerance_percent numeric(5,2) not null default 3 check (weight_tolerance_percent between 0 and 20),
  harvest_date date,
  packing_date date,
  recommended_consume_by date,
  ripeness_stage text check (ripeness_stage is null or ripeness_stage in ('FIRM','READY_SOON','READY_TO_EAT','SOFT')),
  ripening_guide text,
  storage_method text not null,
  storage_min_c numeric(5,2),
  storage_max_c numeric(5,2),
  wash_before_eating boolean not null default true,
  seed_notice text,
  defect_tolerance text,
  sweetness_claim_type text not null default 'NONE' check (sweetness_claim_type in ('NONE','SAMPLE','LOT_MEASURED','GUARANTEED_MINIMUM')),
  brix_min numeric(5,2),
  brix_max numeric(5,2),
  brix_measurement_method text,
  brix_evidence_required boolean not null default false,
  gap_certified boolean not null default false,
  organic_certified boolean not null default false,
  pesticide_test_status text not null default 'NOT_SUBMITTED' check (pesticide_test_status in ('NOT_SUBMITTED','PENDING','PASSED','FAILED','EXPIRED')),
  quarantine_document_required boolean not null default false,
  traceability_code text,
  country_of_origin_evidence_path text,
  compliance_status text not null default 'INCOMPLETE' check (compliance_status in ('INCOMPLETE','REVIEW_REQUIRED','APPROVED','REJECTED','EXPIRED')),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_quality_evidence (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  seller_id uuid not null references public.sellers(id) on delete cascade,
  evidence_type text not null check (evidence_type in ('BRIX','ORIGIN','GAP','ORGANIC','PESTICIDE','QUARANTINE','GRADE','WEIGHT','FARM','OTHER')),
  file_path text not null,
  document_number text,
  issued_by text,
  issued_at date,
  expires_at date,
  status text not null default 'PENDING' check (status in ('PENDING','VERIFIED','REJECTED','EXPIRED')),
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  rejection_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists product_quality_evidence_product_idx on public.product_quality_evidence(product_id,status,evidence_type);

create table if not exists public.inventory_lots (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.sellers(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  option_id uuid references public.product_options(id) on delete restrict,
  lot_code text not null,
  harvest_date date,
  packing_date date,
  recommended_consume_by date,
  received_at timestamptz not null default now(),
  warehouse_code text,
  storage_zone text,
  storage_min_c numeric(5,2),
  storage_max_c numeric(5,2),
  initial_quantity integer not null check (initial_quantity >= 0),
  available_quantity integer not null check (available_quantity >= 0),
  reserved_quantity integer not null default 0 check (reserved_quantity >= 0),
  damaged_quantity integer not null default 0 check (damaged_quantity >= 0),
  disposed_quantity integer not null default 0 check (disposed_quantity >= 0),
  qc_status text not null default 'PENDING' check (qc_status in ('PENDING','PASSED','CONDITIONAL','FAILED','BLOCKED')),
  recall_status text not null default 'NORMAL' check (recall_status in ('NORMAL','BLOCKED','RECALLING','RECALLED','RELEASED')),
  brix_sample numeric(5,2),
  firmness_sample text,
  origin_trace_code text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(seller_id, lot_code),
  check (reserved_quantity <= available_quantity),
  check (initial_quantity >= available_quantity + damaged_quantity + disposed_quantity)
);
create index if not exists inventory_lots_fefo_idx on public.inventory_lots(product_id,option_id,qc_status,recall_status,recommended_consume_by,received_at);

create table if not exists public.order_item_lot_allocations (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  lot_id uuid not null references public.inventory_lots(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  status text not null default 'RESERVED' check (status in ('RESERVED','PICKED','SHIPPED','RELEASED','RETURNED','DISPOSED')),
  allocated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(order_item_id, lot_id)
);

create table if not exists public.quality_inspections (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.inventory_lots(id) on delete cascade,
  inspection_type text not null check (inspection_type in ('INBOUND','PRE_SHIPMENT','RETURN','RANDOM','COMPLAINT')),
  sampled_quantity integer not null default 1 check (sampled_quantity > 0),
  brix_value numeric(5,2),
  weight_value_grams integer,
  appearance_status text,
  firmness_status text,
  mold_status text,
  damage_rate_percent numeric(5,2),
  temperature_c numeric(5,2),
  result text not null check (result in ('PASS','CONDITIONAL','FAIL','BLOCK')),
  notes text,
  evidence jsonb not null default '[]'::jsonb,
  inspected_by uuid references public.profiles(id),
  inspected_at timestamptz not null default now()
);

create table if not exists public.cold_chain_events (
  id bigint generated always as identity primary key,
  shipment_id uuid references public.shipments(id) on delete cascade,
  lot_id uuid references public.inventory_lots(id) on delete set null,
  event_type text not null check (event_type in ('PICKUP','WAREHOUSE_IN','WAREHOUSE_OUT','HUB','DELIVERY','EXCURSION','MANUAL_CHECK')),
  temperature_c numeric(5,2),
  humidity_percent numeric(5,2),
  location text,
  device_id text,
  threshold_breached boolean not null default false,
  raw_payload jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now()
);
create index if not exists cold_chain_events_shipment_idx on public.cold_chain_events(shipment_id,recorded_at);

create table if not exists public.recall_cases (
  id uuid primary key default gen_random_uuid(),
  recall_number text not null unique default ('RCL-' || to_char(now(),'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
  title text not null,
  reason text not null,
  severity text not null check (severity in ('NOTICE','VOLUNTARY','URGENT','CRITICAL')),
  status text not null default 'OPEN' check (status in ('OPEN','NOTIFYING','COLLECTING','CLOSED','CANCELED')),
  authority_reference text,
  seller_id uuid references public.sellers(id),
  initiated_by uuid not null references public.profiles(id),
  initiated_at timestamptz not null default now(),
  closed_at timestamptz,
  buyer_notice_template text,
  seller_instruction text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.recall_lots (
  recall_id uuid not null references public.recall_cases(id) on delete cascade,
  lot_id uuid not null references public.inventory_lots(id) on delete restrict,
  affected_quantity integer,
  recovered_quantity integer not null default 0,
  disposed_quantity integer not null default 0,
  primary key(recall_id,lot_id)
);

create table if not exists public.recall_notifications (
  id uuid primary key default gen_random_uuid(),
  recall_id uuid not null references public.recall_cases(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  channel text not null check (channel in ('IN_APP','EMAIL','SMS','PHONE')),
  status text not null default 'QUEUED' check (status in ('QUEUED','SENT','FAILED','ACKNOWLEDGED')),
  sent_at timestamptz,
  acknowledged_at timestamptz,
  unique(recall_id,user_id,order_id,channel)
);

create table if not exists public.delivery_calendars (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid references public.sellers(id) on delete cascade,
  region_code text not null,
  delivery_mode text not null check (delivery_mode in ('PARCEL','COLD_PARCEL','DAWN','SAME_DAY','PICKUP')),
  weekday smallint not null check (weekday between 0 and 6),
  order_cutoff time not null,
  expected_ship_days integer not null default 0 check (expected_ship_days between 0 and 30),
  expected_delivery_days integer not null default 1 check (expected_delivery_days between 0 and 30),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(seller_id,region_code,delivery_mode,weekday)
);

create table if not exists public.weather_shipping_holds (
  id uuid primary key default gen_random_uuid(),
  region_code text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null,
  hold_type text not null check (hold_type in ('HEAT','FREEZE','STORM','FLOOD','CARRIER','OTHER')),
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.fruit_quality_standards (
  id uuid primary key default gen_random_uuid(),
  fruit_type text not null,
  variety text,
  version text not null,
  min_brix numeric(5,2),
  weight_tolerance_percent numeric(5,2),
  max_defect_rate_percent numeric(5,2),
  required_evidence text[] not null default '{}'::text[],
  storage_guidance text,
  claim_window_hours integer not null default 24 check (claim_window_hours between 1 and 720),
  active boolean not null default true,
  legal_review_status text not null default 'REVIEW_REQUIRED',
  created_at timestamptz not null default now()
);
create unique index if not exists fruit_quality_standards_version_uidx on public.fruit_quality_standards(fruit_type,coalesce(variety,''),version);

create or replace function public.evaluate_fresh_product_compliance(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_product public.products;
  v_profile public.product_fresh_profiles;
  v_flags text[] := '{}';
  v_verified_count integer := 0;
  v_status text;
begin
  select * into v_product from public.products where id=p_product_id;
  select * into v_profile from public.product_fresh_profiles where product_id=p_product_id;
  if v_product.id is null then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if v_profile.product_id is null then v_flags := array_append(v_flags,'FRESH_PROFILE_REQUIRED'); end if;
  if coalesce(v_product.origin,'')='' then v_flags := array_append(v_flags,'ORIGIN_REQUIRED'); end if;
  if v_profile.product_id is not null then
    if coalesce(v_profile.farm_name,'')='' then v_flags := array_append(v_flags,'FARM_REQUIRED'); end if;
    if coalesce(v_profile.variety,'')='' then v_flags := array_append(v_flags,'VARIETY_REQUIRED'); end if;
    if coalesce(v_profile.storage_method,'')='' then v_flags := array_append(v_flags,'STORAGE_REQUIRED'); end if;
    if v_profile.sweetness_claim_type <> 'NONE' and v_profile.brix_evidence_required then
      select count(*) into v_verified_count from public.product_quality_evidence where product_id=p_product_id and evidence_type='BRIX' and status='VERIFIED' and (expires_at is null or expires_at >= current_date);
      if v_verified_count=0 then v_flags := array_append(v_flags,'BRIX_EVIDENCE_REQUIRED'); end if;
    end if;
    if v_profile.pesticide_test_status='FAILED' then v_flags := array_append(v_flags,'PESTICIDE_TEST_FAILED'); end if;
    if v_profile.pesticide_test_status='EXPIRED' then v_flags := array_append(v_flags,'PESTICIDE_TEST_EXPIRED'); end if;
  end if;
  v_status := case when array_length(v_flags,1) is null then 'READY' else 'INCOMPLETE' end;
  update public.products set compliance_status=v_status, compliance_flags=to_jsonb(v_flags), updated_at=now() where id=p_product_id;
  return jsonb_build_object('status',v_status,'flags',v_flags);
end;
$$;

create or replace function public.reserve_inventory_lots_fefo(p_order_item_id uuid, p_quantity integer)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_item public.order_items;
  v_remaining integer := p_quantity;
  v_take integer;
  v_lot record;
  v_alloc jsonb := '[]'::jsonb;
begin
  if p_quantity <= 0 then raise exception 'INVALID_QUANTITY'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if v_item.id is null then raise exception 'ORDER_ITEM_NOT_FOUND'; end if;
  for v_lot in
    select * from public.inventory_lots
    where product_id=v_item.product_id and (option_id is not distinct from v_item.option_id)
      and active=true and qc_status in ('PASSED','CONDITIONAL') and recall_status='NORMAL'
      and available_quantity-reserved_quantity > 0
      and (recommended_consume_by is null or recommended_consume_by >= current_date)
    order by recommended_consume_by nulls last, harvest_date nulls last, received_at
    for update skip locked
  loop
    exit when v_remaining<=0;
    v_take := least(v_remaining, v_lot.available_quantity-v_lot.reserved_quantity);
    update public.inventory_lots set reserved_quantity=reserved_quantity+v_take,updated_at=now() where id=v_lot.id;
    insert into public.order_item_lot_allocations(order_item_id,lot_id,quantity)
    values(p_order_item_id,v_lot.id,v_take)
    on conflict(order_item_id,lot_id) do update set quantity=public.order_item_lot_allocations.quantity+excluded.quantity,updated_at=now();
    v_alloc := v_alloc || jsonb_build_array(jsonb_build_object('lotId',v_lot.id,'lotCode',v_lot.lot_code,'quantity',v_take));
    v_remaining := v_remaining-v_take;
  end loop;
  if v_remaining>0 then raise exception 'INSUFFICIENT_COMPLIANT_LOT_STOCK'; end if;
  return jsonb_build_object('allocated',v_alloc,'quantity',p_quantity);
end;
$$;

create or replace function public.block_recalled_lot()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  update public.inventory_lots set recall_status='RECALLING',qc_status='BLOCKED',active=false,updated_at=now() where id=new.lot_id;
  update public.products p set sale_status='STOPPED',compliance_status='RECALL_HOLD',updated_at=now()
  where exists(select 1 from public.inventory_lots l where l.id=new.lot_id and l.product_id=p.id);
  return new;
end;
$$;
drop trigger if exists trg_block_recalled_lot on public.recall_lots;
create trigger trg_block_recalled_lot after insert on public.recall_lots for each row execute function public.block_recalled_lot();

-- RLS
alter table public.product_fresh_profiles enable row level security;
alter table public.product_quality_evidence enable row level security;
alter table public.inventory_lots enable row level security;
alter table public.order_item_lot_allocations enable row level security;
alter table public.quality_inspections enable row level security;
alter table public.cold_chain_events enable row level security;
alter table public.recall_cases enable row level security;
alter table public.recall_lots enable row level security;
alter table public.recall_notifications enable row level security;
alter table public.delivery_calendars enable row level security;
alter table public.weather_shipping_holds enable row level security;
alter table public.fruit_quality_standards enable row level security;

drop policy if exists fresh_profiles_public_read on public.product_fresh_profiles;
create policy fresh_profiles_public_read on public.product_fresh_profiles for select using (compliance_status='APPROVED' or public.is_admin() or exists(select 1 from public.products p join public.sellers s on s.id=p.seller_id where p.id=product_id and s.owner_id=auth.uid()));

drop policy if exists quality_evidence_owner_read on public.product_quality_evidence;
create policy quality_evidence_owner_read on public.product_quality_evidence for select using (public.is_admin() or exists(select 1 from public.sellers s where s.id=seller_id and s.owner_id=auth.uid()));

drop policy if exists inventory_lots_owner_read on public.inventory_lots;
create policy inventory_lots_owner_read on public.inventory_lots for select using (public.is_admin() or exists(select 1 from public.sellers s where s.id=seller_id and s.owner_id=auth.uid()));

drop policy if exists lot_allocations_participant_read on public.order_item_lot_allocations;
create policy lot_allocations_participant_read on public.order_item_lot_allocations for select using (public.is_admin() or exists(select 1 from public.order_items oi join public.orders o on o.id=oi.order_id join public.sellers s on s.id=oi.seller_id where oi.id=order_item_id and (o.buyer_id=auth.uid() or s.owner_id=auth.uid())));

drop policy if exists recall_cases_public_read on public.recall_cases;
create policy recall_cases_public_read on public.recall_cases for select using (status in ('OPEN','NOTIFYING','COLLECTING') or public.is_admin() or exists(select 1 from public.sellers s where s.id=seller_id and s.owner_id=auth.uid()));

drop policy if exists delivery_calendars_public_read on public.delivery_calendars;
create policy delivery_calendars_public_read on public.delivery_calendars for select using (active);
drop policy if exists weather_holds_public_read on public.weather_shipping_holds;
create policy weather_holds_public_read on public.weather_shipping_holds for select using (active and now() between starts_at and ends_at);
drop policy if exists fruit_quality_standards_public_read on public.fruit_quality_standards;
create policy fruit_quality_standards_public_read on public.fruit_quality_standards for select using (active);

revoke all on public.product_quality_evidence,public.inventory_lots,public.order_item_lot_allocations,public.quality_inspections,public.cold_chain_events,public.recall_lots,public.recall_notifications from anon,authenticated;
grant select on public.product_fresh_profiles,public.recall_cases,public.delivery_calendars,public.weather_shipping_holds,public.fruit_quality_standards to anon,authenticated;
grant execute on function public.evaluate_fresh_product_compliance(uuid) to authenticated;
grant execute on function public.reserve_inventory_lots_fefo(uuid,integer) to authenticated;

commit;
