from __future__ import annotations
import json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
html=(ROOT/'site/index.html').read_text('utf-8')
adapter=(ROOT/'site/assets/js/supabase-adapter.js').read_text('utf-8')
api=(ROOT/'supabase/functions/api/index.ts').read_text('utf-8')

# Extract route-like strings from canonical single HTML. Some template literals contain
# nested expressions; for coverage purposes the stable path family is retained.
raw=sorted(set(m.group(1) for m in re.finditer(r'(/api/[^"\'`\s<]*)',html)))

def norm(v:str)->str:
    v=v.replace('&amp;','&')
    v=re.sub(r'\$\{[^}]*\}',':dynamic',v)
    if '${' in v: v=v.split('${',1)[0]+':dynamic'
    v=re.sub(r'\{[^}]+\}',':dynamic',v)
    v=v.split('?',1)[0]
    v=re.sub(r'/+$','',v) or '/api'
    return v

# Rule: name, path pattern, source file, mandatory code token.
R=[]
def add(name,pattern,source,token): R.append((name,re.compile(pattern),source,token))
# Frontend adapter/auth/function routes
add('generic-api-root',r'^/api$','adapter','async function route')
add('auth',r'^/api/(?:auth|members)(?:/.*)?$','adapter','signInWithPassword')
add('register',r'^/api/public/auth/register$','adapter','signUp')
add('dev-login-block',r'^/api/public/dev-login$','adapter','DEV_LOGIN_DISABLED')
add('files',r'^/api/files$','adapter','uploadFile')
add('checkout',r'^/api/orders/checkout/(?:cart|direct)$','adapter','checkout-prepare')
add('payment-approve',r'^/api/orders/payments/[^/]+/approve$','adapter','payment-confirm')
add('payment-fail',r'^/api/orders/payments/[^/]+/fail$','api','paymentFail')
add('payment-cancel',r'^/api/orders/payments/[^/]+/(?:cancel|refund)$','adapter','payment-cancel')
# Public
for name,pat,token in [
 ('health',r'^/api/(?:health|public/health)$','/api/public/health'),
 ('categories-public',r'^/api/public/categories$','/api/public/categories'),
 ('home-products-public',r'^/api/public/home-products$','/api/public/home-products'),
 ('products-public',r'^/api/public/products(?:/[^/]+(?:/(?:reviews|questions))?)?$','productMatch'),
 ('banners-public',r'^/api/public/promotions/banners$','/api/public/promotions/banners'),
 ('reviews-public',r'^/api/public/reviews$','/api/public/reviews'),
 ('policies-public',r'^/api/policies/public/current$','/api/policies/public/current'),
 ('search-public',r'^/api/public/search/(?:popular|suggestions|guide|click)$','/api/public/search/'),
 ('statistics-public',r'^/api/public/statistics/impressions$','/api/public/statistics/impressions'),
 ('identity-public',r'^/api/public/identity/pass(?:/[^/]+)?$','/api/public/identity/pass'),
 ('seller-application-public',r'^/api/public/seller-applications(?:/verify-business|/[^/]+/status)?$','/api/public/seller-applications'),
]: add(name,pat,'api',token)
# Consumer
for name,pat,token in [
 ('profile',r'^/api/mypage/profile$','/api/mypage/profile'),
 ('addresses',r'^/api/mypage/addresses(?:/[^/]+(?:/default)?)?$','const address = path.match'),
 ('cart',r'^/api/cart(?:/items(?:/[^/]+(?:/quantity)?)?)?$','cartItem'),
 ('favorites-product',r'^/api/mypage/favorites(?:/[^/]+)?$','const favorite = path.match'),
 ('favorites-seller',r'^/api/favorites/sellers(?:/[^/]+(?:/status)?)?$','sellerFavorite'),
 ('recent',r'^/api/mypage/(?:recent-products|recent-viewed(?:/[^/]+)?)$','const recentRecord = path.match'),
 ('coupon-mine',r'^/api/coupons/mine$','/api/coupons/mine'),
 ('points',r'^/api/points/balance$','/api/points/balance'),
 ('orders',r'^/api/orders(?:/my|/[^/]+(?:/(?:cancel|confirm))?)?$','orderMatch'),
 ('claims',r'^/api/claims(?:/me|/[^/]+(?:/(?:withdraw|return-tracking))?)?$','claimAction'),
 ('questions',r'^/api/questions/products/[^/]+$','const qCreate = path.match'),
 ('reviews-me',r'^/api/(?:reviews|mypage/reviews)$','/api/mypage/reviews'),
 ('form-drafts',r'^/api/form-drafts$','/api/form-drafts'),
 ('client-errors',r'^/api/client-errors$','/api/client-errors'),
]: add(name,pat,'api',token)
# Seller
for name,pat,token in [
 ('seller-stats',r'^/api/seller/statistics$','/api/seller/statistics'),
 ('seller-products',r'^/api/seller/products(?:/[^/]+(?:/(?:submit|discontinue))?)?$','sellerProduct'),
 ('seller-orders',r'^/api/seller/orders$','/api/seller/orders'),
 ('seller-shipments-list',r'^/api/seller/shipments$','/api/seller/shipments'),
 ('seller-shipments-action',r'^/api/seller/shipments/[^/]+/(?:prepare|dispatch|in-transit|delivered|label|:dynamic)$','const shipmentAction = path.match'),
 ('seller-shipments-batch',r'^/api/seller/shipments/batch/(?:prepare|dispatch)$','const shipmentBatch = path.match'),
 ('seller-carrier-csv',r'^/api/seller/shipments/carrier-request\.csv$','carrier-request.csv'),
 ('seller-claims',r'^/api/seller/claims(?:/[^/]+(?:/(?:approve|reject|received|complete-return|replacement|:dynamic))?)?$','sellerClaimAction'),
 ('seller-questions',r'^/api/seller/questions(?:/[^/]+/answer)?$','const answerQuestion = path.match'),
 ('seller-coupons',r'^/api/seller/coupons(?:/[^/]+(?:/(?:issues|status))?)?$','const couponIssue = path.match'),
 ('seller-inventory',r'^/api/seller/inventory/bulk(?:/(?:preview|template|template/info))?$','/api/seller/inventory/bulk'),
 ('seller-marketing',r'^/api/seller/marketing/messages$','/api/seller/marketing/messages'),
 ('seller-checklist',r'^/api/seller/operations/(?:checklist|readiness)$','/api/seller/operations/'),
 ('seller-settlement-account',r'^/api/seller/settlement-account$','/api/seller/settlement-account'),
 ('seller-settlements',r'^/api/seller/settlements$','/api/seller/settlements'),
 ('seller-alerts',r'^/api/seller/alerts/realtime$','/api/seller/alerts/realtime'),
]: add(name,pat,'api',token)
# Admin
for name,pat,token in [
 ('admin-stats',r'^/api/admin/statistics$','/api/admin/statistics'),
 ('admin-sellers',r'^/api/admin/sellers(?:/settlement-accounts|/[^/]+(?:/status)?)?$','adminSellerDetail'),
 ('admin-applications',r'^/api/admin/seller-applications(?:/[^/]+(?:/(?:approve|reject|:dynamic))?)?$','const adminApp = path.match'),
 ('admin-products',r'^/api/admin/products(?:/[^/]+(?:/(?:status|commercial-approval))?)?$','adminProduct'),
 ('admin-categories',r'^/api/admin/categories(?:/[^/]+(?:/active)?)?$','adminCategory'),
 ('admin-home-products',r'^/api/admin/home-products(?:/[^/]+)?$','const homeProduct = path.match'),
 ('admin-banners',r'^/api/admin/promotions/banners(?:/[^/]+(?:/status)?)?$','bannerStatus'),
 ('admin-orders',r'^/api/admin/orders(?:/[^/]+)?$','adminOrder'),
 ('admin-claims',r'^/api/admin/claims(?:/[^/]+/(?:approve|reject|:dynamic))?$','adminClaim'),
 ('admin-consumers',r'^/api/admin/consumers(?:/[^/]+(?:/(?:suspend|activate|grade(?:/recalculate)?))?)?$','consumerAction'),
 ('admin-shipments',r'^/api/admin/shipments(?:/[^/]+/(?:in-transit|delivered|:dynamic))?$','adminShipment'),
 ('admin-settlements',r'^/api/admin/settlements(?:/lock-policy|/[^/]+/(?:approve|hold|release-hold|complete|payout))?$','settlementAction'),
 ('admin-settlement-policy',r'^/api/admin/settlement-policy$','/api/admin/settlement-policy'),
 ('admin-templates',r'^/api/admin/inventory-excel-templates(?:/[^/]+(?:/(?:activate|download))?)?$','adminTemplate'),
 ('admin-operations',r'^/api/admin/operations/(?:normalize|readiness|unanswered-questions)$','/api/admin/operations/'),
 ('admin-privacy',r'^/api/admin/privacy/mask-expired$','/api/admin/privacy/mask-expired'),
 ('admin-alerts',r'^/api/admin/alerts/realtime$','/api/admin/alerts/realtime'),
]: add(name,pat,'api',token)

source={'api':api,'adapter':adapter}
missing_tokens=[]
for name,_,src,token in R:
    if token not in source[src]: missing_tokens.append({'rule':name,'source':src,'token':token})
rows=[];uncovered=[]
for route in raw:
    n=norm(route)
    matched=[name for name,rx,_,_ in R if rx.match(n)]
    row={'raw':route,'normalized':n,'handlers':matched}
    rows.append(row)
    if not matched: uncovered.append(row)
result={
  'checkedAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
  'uiRouteStringCount':len(raw),'normalizedRouteCount':len(set(x['normalized'] for x in rows)),
  'coveredCount':len(rows)-len(uncovered),'uncovered':uncovered,'missingHandlerTokens':missing_tokens,
  'passed':not uncovered and not missing_tokens,'routes':rows,
}
(ROOT/'tests/route-coverage-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
print(json.dumps({k:v for k,v in result.items() if k!='routes'},ensure_ascii=False,indent=2))
raise SystemExit(0 if result['passed'] else 1)
