-- 푸릇마켓 Part 45: 확장 테이블 RLS/권한

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'consent_receipts','auth_security_events','identity_verifications','seller_kyc','product_approval_history',
    'inventory_movements','inventory_reservations','inventory_excel_templates','inventory_import_jobs',
    'recent_product_views','seller_favorites','product_questions','form_drafts','coupons','coupon_issues',
    'point_accounts','point_ledger','order_status_history','payments','payment_attempts','payment_webhook_events',
    'refunds','shipments','shipment_events','claim_evidence','claim_history','seller_settlement_accounts',
    'settlement_policies','settlements','settlement_items','payout_requests','marketing_messages','client_errors',
    'admin_approval_actions','operation_readiness'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

-- 사용자 자신의 데이터
drop policy if exists "users read own consents" on public.consent_receipts;
create policy "users read own consents" on public.consent_receipts for select to authenticated using (user_id=(select auth.uid()) or public.is_admin());
drop policy if exists "users insert own consents" on public.consent_receipts;
create policy "users insert own consents" on public.consent_receipts for insert to authenticated with check (user_id=(select auth.uid()));
drop policy if exists "users read own auth security" on public.auth_security_events;
create policy "users read own auth security" on public.auth_security_events for select to authenticated using (user_id=(select auth.uid()) or public.is_admin());
drop policy if exists "users read own identity verification" on public.identity_verifications;
create policy "users read own identity verification" on public.identity_verifications for select to authenticated using (user_id=(select auth.uid()) or public.is_admin());
drop policy if exists "users read own recent views" on public.recent_product_views;
create policy "users read own recent views" on public.recent_product_views for select to authenticated using (user_id=(select auth.uid()));
drop policy if exists "users manage own recent views" on public.recent_product_views;
create policy "users manage own recent views" on public.recent_product_views for all to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
drop policy if exists "users manage seller favorites" on public.seller_favorites;
create policy "users manage seller favorites" on public.seller_favorites for all to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
drop policy if exists "users read own coupon issues" on public.coupon_issues;
create policy "users read own coupon issues" on public.coupon_issues for select to authenticated using (user_id=(select auth.uid()) or public.is_admin());
drop policy if exists "users read own point account" on public.point_accounts;
create policy "users read own point account" on public.point_accounts for select to authenticated using (user_id=(select auth.uid()) or public.is_admin());
drop policy if exists "users read own point ledger" on public.point_ledger;
create policy "users read own point ledger" on public.point_ledger for select to authenticated using (user_id=(select auth.uid()) or public.is_admin());
drop policy if exists "users manage own drafts" on public.form_drafts;
create policy "users manage own drafts" on public.form_drafts for all to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));

-- 상품문의: 공개 질문과 본인/판매자/관리자
drop policy if exists "public reads visible questions" on public.product_questions;
create policy "public reads visible questions" on public.product_questions for select to anon,authenticated using (
  (status<>'HIDDEN' and secret=false)
  or user_id=(select auth.uid())
  or exists(select 1 from public.products p where p.id=product_id and public.owns_seller(p.seller_id))
  or public.is_admin()
);
drop policy if exists "users create own questions" on public.product_questions;
create policy "users create own questions" on public.product_questions for insert to authenticated with check (user_id=(select auth.uid()) and exists(select 1 from public.profiles where id=(select auth.uid()) and status='active'));
drop policy if exists "users update own waiting questions" on public.product_questions;
create policy "users update own waiting questions" on public.product_questions for update to authenticated using (user_id=(select auth.uid()) and status='WAITING') with check (user_id=(select auth.uid()));
drop policy if exists "seller answers own product questions" on public.product_questions;
create policy "seller answers own product questions" on public.product_questions for update to authenticated using (exists(select 1 from public.products p where p.id=product_id and public.owns_seller(p.seller_id))) with check (exists(select 1 from public.products p where p.id=product_id and public.owns_seller(p.seller_id)));

-- 공개/판매자 쿠폰
drop policy if exists "public reads active coupons" on public.coupons;
create policy "public reads active coupons" on public.coupons for select to anon,authenticated using (status='ACTIVE' and now() between starts_at and ends_at or public.is_admin() or (seller_id is not null and public.owns_seller(seller_id)));
drop policy if exists "seller manages own coupons" on public.coupons;
create policy "seller manages own coupons" on public.coupons for all to authenticated using (seller_id is not null and public.owns_seller(seller_id)) with check (seller_id is not null and public.owns_seller(seller_id));

-- 판매자 소유 데이터
drop policy if exists "seller reads own kyc" on public.seller_kyc;
create policy "seller reads own kyc" on public.seller_kyc for select to authenticated using (public.owns_seller(seller_id) or public.is_admin());
drop policy if exists "seller reads own inventory movements" on public.inventory_movements;
create policy "seller reads own inventory movements" on public.inventory_movements for select to authenticated using (public.owns_seller(seller_id) or public.is_admin());
drop policy if exists "seller reads own imports" on public.inventory_import_jobs;
create policy "seller reads own imports" on public.inventory_import_jobs for select to authenticated using (public.owns_seller(seller_id) or public.is_admin());
drop policy if exists "seller creates own imports" on public.inventory_import_jobs;
create policy "seller creates own imports" on public.inventory_import_jobs for insert to authenticated with check (public.owns_seller(seller_id) and requested_by=(select auth.uid()));
drop policy if exists "seller reads own shipments" on public.shipments;
create policy "seller reads own shipments" on public.shipments for select to authenticated using (public.owns_seller(seller_id) or exists(select 1 from public.orders o where o.id=order_id and o.buyer_id=(select auth.uid())) or public.is_admin());
drop policy if exists "seller reads own shipment events" on public.shipment_events;
create policy "seller reads own shipment events" on public.shipment_events for select to authenticated using (exists(select 1 from public.shipments s where s.id=shipment_id and (public.owns_seller(s.seller_id) or exists(select 1 from public.orders o where o.id=s.order_id and o.buyer_id=(select auth.uid())) or public.is_admin())));
drop policy if exists "seller reads own settlement account" on public.seller_settlement_accounts;
create policy "seller reads own settlement account" on public.seller_settlement_accounts for select to authenticated using (public.owns_seller(seller_id) or public.is_admin());
drop policy if exists "seller reads own settlements" on public.settlements;
create policy "seller reads own settlements" on public.settlements for select to authenticated using (public.owns_seller(seller_id) or public.is_admin());
drop policy if exists "seller reads own settlement items" on public.settlement_items;
create policy "seller reads own settlement items" on public.settlement_items for select to authenticated using (exists(select 1 from public.settlements s where s.id=settlement_id and (public.owns_seller(s.seller_id) or public.is_admin())));
drop policy if exists "seller reads own payouts" on public.payout_requests;
create policy "seller reads own payouts" on public.payout_requests for select to authenticated using (public.owns_seller(seller_id) or public.is_admin());
drop policy if exists "seller reads own marketing messages" on public.marketing_messages;
create policy "seller reads own marketing messages" on public.marketing_messages for select to authenticated using (public.owns_seller(seller_id) or public.is_admin());
drop policy if exists "seller creates own marketing messages" on public.marketing_messages;
create policy "seller creates own marketing messages" on public.marketing_messages for insert to authenticated with check (public.owns_seller(seller_id) and requested_by=(select auth.uid()));

-- 주문/결제/클레임
drop policy if exists "buyer reads own payments" on public.payments;
create policy "buyer reads own payments" on public.payments for select to authenticated using (exists(select 1 from public.orders o where o.id=order_id and o.buyer_id=(select auth.uid())) or public.is_admin() or exists(select 1 from public.order_items oi where oi.order_id=order_id and public.owns_seller(oi.seller_id)));
drop policy if exists "buyer reads own payment attempts" on public.payment_attempts;
create policy "buyer reads own payment attempts" on public.payment_attempts for select to authenticated using (exists(select 1 from public.payments p join public.orders o on o.id=p.order_id where p.id=payment_id and o.buyer_id=(select auth.uid())) or public.is_admin());
drop policy if exists "buyer reads own refunds" on public.refunds;
create policy "buyer reads own refunds" on public.refunds for select to authenticated using (exists(select 1 from public.orders o where o.id=order_id and o.buyer_id=(select auth.uid())) or public.is_admin() or exists(select 1 from public.order_items oi where oi.order_id=order_id and public.owns_seller(oi.seller_id)));
drop policy if exists "order participants read status history" on public.order_status_history;
create policy "order participants read status history" on public.order_status_history for select to authenticated using (exists(select 1 from public.orders o where o.id=order_id and o.buyer_id=(select auth.uid())) or public.is_admin() or exists(select 1 from public.order_items oi where oi.order_id=order_id and public.owns_seller(oi.seller_id)));
drop policy if exists "claim participants read evidence" on public.claim_evidence;
create policy "claim participants read evidence" on public.claim_evidence for select to authenticated using (exists(select 1 from public.claims c join public.order_items oi on oi.id=c.order_item_id where c.id=claim_id and (c.requester_id=(select auth.uid()) or public.owns_seller(oi.seller_id) or public.is_admin())));
drop policy if exists "claim participants read history" on public.claim_history;
create policy "claim participants read history" on public.claim_history for select to authenticated using (exists(select 1 from public.claims c join public.order_items oi on oi.id=c.order_item_id where c.id=claim_id and (c.requester_id=(select auth.uid()) or public.owns_seller(oi.seller_id) or public.is_admin())));

-- 관리자 전용
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'auth_security_events','identity_verifications','seller_kyc','product_approval_history','inventory_movements',
    'inventory_reservations','inventory_excel_templates','inventory_import_jobs','coupons','coupon_issues','point_accounts',
    'point_ledger','order_status_history','payments','payment_attempts','payment_webhook_events','refunds','shipments',
    'shipment_events','claim_evidence','claim_history','seller_settlement_accounts','settlement_policies','settlements',
    'settlement_items','payout_requests','marketing_messages','client_errors','admin_approval_actions','operation_readiness'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'admin manages '||t, t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())', 'admin manages '||t, t);
  END LOOP;
END $$;

-- 최소 권한. 민감 테이블은 Edge Function(service role) 또는 허용 RPC를 통해서만 변경합니다.
revoke all on public.consent_receipts,public.auth_security_events,public.identity_verifications,public.seller_kyc,
public.product_approval_history,public.inventory_movements,public.inventory_reservations,public.inventory_excel_templates,
public.inventory_import_jobs,public.recent_product_views,public.seller_favorites,public.product_questions,public.form_drafts,
public.coupons,public.coupon_issues,public.point_accounts,public.point_ledger,public.order_status_history,public.payments,
public.payment_attempts,public.payment_webhook_events,public.refunds,public.shipments,public.shipment_events,public.claim_evidence,
public.claim_history,public.seller_settlement_accounts,public.settlement_policies,public.settlements,public.settlement_items,
public.payout_requests,public.marketing_messages,public.client_errors,public.admin_approval_actions,public.operation_readiness from anon,authenticated;

grant select on public.coupons,public.product_questions to anon,authenticated;
grant select on public.consent_receipts,public.auth_security_events,public.identity_verifications,public.seller_kyc,
public.product_approval_history,public.inventory_movements,public.inventory_excel_templates,public.inventory_import_jobs,
public.recent_product_views,public.seller_favorites,public.coupon_issues,public.point_accounts,public.point_ledger,
public.order_status_history,public.payments,public.payment_attempts,public.refunds,public.shipments,public.shipment_events,
public.claim_evidence,public.claim_history,public.seller_settlement_accounts,public.settlement_policies,public.settlements,
public.settlement_items,public.payout_requests,public.marketing_messages,public.operation_readiness to authenticated;
grant insert on public.consent_receipts,public.product_questions,public.form_drafts,public.recent_product_views,public.seller_favorites,public.marketing_messages to authenticated;
grant update,delete on public.product_questions,public.form_drafts,public.recent_product_views,public.seller_favorites to authenticated;

-- Part 45 operations tables
alter table public.refund_items enable row level security;
alter table public.payout_attempts enable row level security;
alter table public.scheduled_job_runs enable row level security;

drop policy if exists "refund items participant read" on public.refund_items;
create policy "refund items participant read" on public.refund_items for select to authenticated using (
  exists(select 1 from public.refunds r join public.orders o on o.id=r.order_id where r.id=refund_id and (o.buyer_id=auth.uid() or public.current_app_role()='admin' or exists(select 1 from public.order_items oi where oi.id=order_item_id and public.owns_seller(oi.seller_id))))
);
drop policy if exists "payout attempts admin read" on public.payout_attempts;
create policy "payout attempts admin read" on public.payout_attempts for select to authenticated using (public.current_app_role()='admin');
drop policy if exists "scheduled jobs admin read" on public.scheduled_job_runs;
create policy "scheduled jobs admin read" on public.scheduled_job_runs for select to authenticated using (public.current_app_role()='admin');

grant select on public.refund_items to authenticated;
grant select on public.payout_attempts,public.scheduled_job_runs to authenticated;
