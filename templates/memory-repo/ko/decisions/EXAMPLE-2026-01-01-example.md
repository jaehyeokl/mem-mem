---
name: EXAMPLE-2026-01-01-example
description: EXAMPLE ONLY. 결정 파일 형식 예시. memmem-server project add는 이 파일을 실제 메모리에 복사하지 않는다.
---
# (예시) 상품 목록 응답을 Redis로 캐시한다

## 결정

`GET /products` 응답을 Redis에 60초 TTL로 캐시한다. 키 형식은 `products:list:{category}:{page}`.

## 이유

피크 시간 DB 읽기 부하를 줄이고 p95 지연을 300ms 아래로 유지하기 위해.

## 대안

- 애플리케이션 메모리 캐시: 인스턴스 간 불일치로 기각.
- DB 읽기 복제본: 비용 대비 효과가 작아 보류.

## 근거 세션

- member=minji tool=claude-code session=00000000-0000-0000-0000-000000000000 (2026-01-01)

## 상태

상태: active
