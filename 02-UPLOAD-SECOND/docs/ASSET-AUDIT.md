# 배너·로고·과일 아이콘 감사 결과

## 메인 배너

파일:

- `site/assets/banners/home-hero-01.webp`
- `site/assets/banners/home-hero-02.webp`
- `site/assets/banners/home-hero-03.webp`

수정 사항:

- 배너 API 응답이 비어 있거나 실패하면 위 3장을 자동 사용
- 첫 이미지는 eager/high priority 로딩
- 이미지 로딩 실패 시 해당 순서의 로컬 배너로 교체
- 3초 간격 자동 전환
- 이전/다음 버튼과 점 표시 유지
- 페이지가 숨겨지면 일시 정지하고 다시 보이면 재시작

브라우저 검사:

- 모바일 390px: `1 / 3`에서 `2 / 3`으로 자동 이동
- PC 1365px: `1 / 3`에서 `2 / 3`으로 자동 이동
- `data-hero-autoplay="running"`
- 오류 요청 0건

## 과일 아이콘

고유 파일 21개:

```text
apple, banana, blueberry, cherry, fig, grapefruit, grape, kiwi, lemon,
tangerine, mango, melon, chamoe, peach, pear, persimmon, pineapple,
plum, pomegranate, strawberry, watermelon
```

화면 표시키 23개:

```text
전체, 사과, 바나나, 블루베리, 체리, 무화과, 자몽, 포도, 키위, 레몬,
감귤, 귤, 망고, 멜론, 참외, 복숭아, 배, 감, 파인애플, 자두, 석류, 딸기, 수박
```

- `전체`는 사과 아이콘을 공통 탐색 아이콘으로 사용
- `귤`은 `감귤`과 같은 tangerine 파일 사용
- 따라서 23개 키에 21개 고유 파일이 정상입니다.
- API 카테고리가 비어 있어도 기준 과일 카테고리를 유지하는 `canonical-category-guard.js`를 추가했습니다.

## 기타 이미지

- 브랜드 이미지: 2개
- UI 아이콘: 18개
- 전체 해시: `docs/ASSET-MANIFEST.json`
