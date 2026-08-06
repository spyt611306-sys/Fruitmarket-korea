-- 실제 공개 사업자정보와 기본 분류·메인배너를 등록합니다.
-- 고객센터 전화·이메일은 완전한 공개값을 확보한 뒤 Table Editor에서 입력하세요.

insert into public.business_information(
  id,brand_name,legal_name,representative_name,registration_number,
  ecommerce_registration_number,public_business_address,reported_domain,reported_categories
)
values(
  1,'푸릇마켓','맞춤식','김민수','571-31-01733',
  '2025-부산사상구-0467',
  '부산광역시 사상구 엄궁북로 62, 204동 (엄궁동, 엄궁롯데캐슬리버)',
  '쿠팡 마켓플레이스',
  '교육/도서/완구/오락, 의류/패션/잡화/뷰티'
)
on conflict(id) do update set
  brand_name=excluded.brand_name,
  legal_name=excluded.legal_name,
  representative_name=excluded.representative_name,
  registration_number=excluded.registration_number,
  ecommerce_registration_number=excluded.ecommerce_registration_number,
  public_business_address=excluded.public_business_address,
  reported_domain=excluded.reported_domain,
  reported_categories=excluded.reported_categories,
  updated_at=now();

insert into public.categories(name,slug,icon_key,sort_order) values
('사과','apple','apple',10),('바나나','banana','banana',20),('블루베리','blueberry','blueberry',30),('체리','cherry','cherry',40),
('무화과','fig','fig',50),('자몽','grapefruit','grapefruit',60),('포도','grape','grape',70),('키위','kiwi','kiwi',80),
('레몬','lemon','lemon',90),('감귤','tangerine','tangerine',100),('망고','mango','mango',110),('멜론','melon','melon',120),
('참외','chamoe','chamoe',130),('복숭아','peach','peach',140),('배','pear','pear',150),('감','persimmon','persimmon',160),
('파인애플','pineapple','pineapple',170),('자두','plum','plum',180),('석류','pomegranate','pomegranate',190),
('딸기','strawberry','strawberry',200),('수박','watermelon','watermelon',210)
on conflict(name) do update set
  slug=excluded.slug,icon_key=excluded.icon_key,sort_order=excluded.sort_order,active=true,updated_at=now();

-- Netlify에 함께 배포되는 3개 배너 파일을 사용합니다.
insert into public.banners(id,placement,title,image_url,link_url,active,sort_order) values
('11111111-1111-4111-8111-111111111101','HOME_HERO','당도선별 프리미엄 직송','/assets/banners/home-hero-01.webp','#list',true,10),
('11111111-1111-4111-8111-111111111102','HOME_HERO','제철 산지의 신선함','/assets/banners/home-hero-02.webp','#list',true,20),
('11111111-1111-4111-8111-111111111103','HOME_HERO','생산자와 소비자를 가깝게','/assets/banners/home-hero-03.webp','#seller-inquiry',true,30)
on conflict(id) do update set
  title=excluded.title,image_url=excluded.image_url,link_url=excluded.link_url,
  active=excluded.active,sort_order=excluded.sort_order,updated_at=now();

insert into public.search_keywords(keyword,search_count) values
('사과',100),('수박',90),('복숭아',80),('포도',70),('감귤',60)
on conflict(keyword) do update set search_count=greatest(public.search_keywords.search_count,excluded.search_count),updated_at=now();
