---
name: EXAMPLE-2026-01-01-example
description: EXAMPLE ONLY. Shows the decision file format. memmem-server project add does not copy this file into the actual memory.
---
# (Example) Cache the product list response in Redis

## Decision

Cache `GET /products` responses in Redis with a 60-second TTL. Key format: `products:list:{category}:{page}`.

## Reason

To reduce database read load at peak hours and keep p95 latency under 300ms.

## Alternatives

- In-process application cache: rejected because instances would disagree.
- Database read replica: deferred; small benefit for the cost.

## Source sessions

- member=minji tool=claude-code session=00000000-0000-0000-0000-000000000000 (2026-01-01)

## Status

Status: active
