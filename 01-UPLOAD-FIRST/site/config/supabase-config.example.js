/*
 * Netlify 수동 업로드용 공개 설정입니다.
 * 브라우저에 넣어도 되는 값: Supabase URL, publishable/anon key, Toss client key.
 * 넣으면 안 되는 값: Supabase secret/service_role, DB 비밀번호, Toss secret key.
 */
window.FRUITMARKET_SUPABASE = Object.freeze({
  enabled: true,
  url: "https://YOUR_PROJECT_REF.supabase.co",
  publishableKey: "sb_publishable_REPLACE_ME",
  tossClientKey: "",
  features: Object.freeze({
    paymentsEnabled: false,
    settlementsEnabled: false
  }),
  storage: Object.freeze({
    publicAssetsBucket: "public-assets",
    productImagesBucket: "product-images",
    sellerDocumentsBucket: "seller-documents",
    claimEvidenceBucket: "claim-evidence"
  })
});
window.FRUITMARKET_RUNTIME = "SUPABASE";
