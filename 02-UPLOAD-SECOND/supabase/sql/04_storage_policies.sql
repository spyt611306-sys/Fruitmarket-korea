-- 먼저 Supabase Dashboard > Storage에서 아래 4개 버킷을 직접 만드세요.
-- public-assets: Public ON, 10MB, image/jpeg,image/png,image/webp,image/svg+xml
-- product-images: Public ON, 10MB, image/jpeg,image/png,image/webp
-- seller-documents: Public OFF, 15MB, application/pdf,image/jpeg,image/png
-- claim-evidence: Public OFF, 10MB, image/jpeg,image/png,image/webp

drop policy if exists "public reads public assets" on storage.objects;
create policy "public reads public assets" on storage.objects for select using (bucket_id in ('public-assets','product-images'));
drop policy if exists "admin uploads public assets" on storage.objects;
create policy "admin uploads public assets" on storage.objects for insert to authenticated with check (bucket_id='public-assets' and public.is_admin());
drop policy if exists "admin updates public assets" on storage.objects;
create policy "admin updates public assets" on storage.objects for update to authenticated using (bucket_id='public-assets' and public.is_admin()) with check (bucket_id='public-assets' and public.is_admin());
drop policy if exists "admin deletes public assets" on storage.objects;
create policy "admin deletes public assets" on storage.objects for delete to authenticated using (bucket_id='public-assets' and public.is_admin());

drop policy if exists "seller uploads own product images" on storage.objects;
create policy "seller uploads own product images" on storage.objects for insert to authenticated with check (bucket_id='product-images' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "seller updates own product images" on storage.objects;
create policy "seller updates own product images" on storage.objects for update to authenticated using (bucket_id='product-images' and owner_id=auth.uid()::text) with check (bucket_id='product-images' and owner_id=auth.uid()::text);
drop policy if exists "seller deletes own product images" on storage.objects;
create policy "seller deletes own product images" on storage.objects for delete to authenticated using (bucket_id='product-images' and owner_id=auth.uid()::text);
drop policy if exists "admin manages all product images" on storage.objects;
create policy "admin manages all product images" on storage.objects for all to authenticated using (bucket_id='product-images' and public.is_admin()) with check (bucket_id='product-images' and public.is_admin());

drop policy if exists "owner uploads seller documents" on storage.objects;
create policy "owner uploads seller documents" on storage.objects for insert to authenticated with check (bucket_id='seller-documents' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "owner reads seller documents" on storage.objects;
create policy "owner reads seller documents" on storage.objects for select to authenticated using (bucket_id='seller-documents' and (owner_id=auth.uid()::text or public.is_admin()));
drop policy if exists "owner deletes seller documents" on storage.objects;
create policy "owner deletes seller documents" on storage.objects for delete to authenticated using (bucket_id='seller-documents' and (owner_id=auth.uid()::text or public.is_admin()));

drop policy if exists "owner uploads claim evidence" on storage.objects;
create policy "owner uploads claim evidence" on storage.objects for insert to authenticated with check (bucket_id='claim-evidence' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "owner reads claim evidence" on storage.objects;
create policy "owner reads claim evidence" on storage.objects for select to authenticated using (bucket_id='claim-evidence' and (owner_id=auth.uid()::text or public.is_admin()));
drop policy if exists "owner deletes claim evidence" on storage.objects;
create policy "owner deletes claim evidence" on storage.objects for delete to authenticated using (bucket_id='claim-evidence' and (owner_id=auth.uid()::text or public.is_admin()));
