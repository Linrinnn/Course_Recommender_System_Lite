from __future__ import annotations

import argparse
import asyncio

from catalog import DETAIL_CONCURRENCY, DETAIL_SCHEMA_VERSION, append_enriched, append_failure, compact_enriched_file, enrich_course, get_list_catalog, load_enriched_map


async def build(limit: int | None, concurrency: int, refresh_list: bool = False) -> None:
    courses, list_meta = await get_list_catalog(refresh=refresh_list)
    print(f"課程清單來源：{list_meta.get('source', 'unknown')}；更新時間：{list_meta.get('updated_at', 'unknown')}")
    existing = load_enriched_map()
    pending = [
        course
        for course in courses
        if course["id"] not in existing
        or int(existing[course["id"]].get("detail_schema_version") or 0) < DETAIL_SCHEMA_VERSION
    ]
    if limit is not None:
        pending = pending[:limit]
    total = len(courses)
    current_existing = sum(
        1 for item in existing.values()
        if int(item.get("detail_schema_version") or 0) >= DETAIL_SCHEMA_VERSION
    )
    print(f"課綱 API 範圍 {total} 門；目前有效完整索引 {current_existing} 門；本次待處理 {len(pending)} 門。")
    semaphore = asyncio.Semaphore(max(1, min(concurrency, 8)))
    lock = asyncio.Lock()
    completed = 0
    failed = 0

    async def worker(course):
        nonlocal completed, failed
        async with semaphore:
            try:
                enriched = await enrich_course(course)
                async with lock:
                    append_enriched(enriched)
                    completed += 1
                    print(f"[{current_existing + completed}/{total}] {course['name']}")
            except Exception as exc:
                async with lock:
                    append_failure(course["id"], exc)
                    failed += 1
                    print(f"[失敗] {course['name']}: {exc}")

    tasks = [asyncio.create_task(worker(course)) for course in pending]
    for task in asyncio.as_completed(tasks):
        await task
    count = compact_enriched_file()
    print(f"完成：索引 {count}/{total} 門，本次失敗 {failed} 門。重新執行會自動續跑未完成項目。")


def main() -> None:
    parser = argparse.ArgumentParser(description="建立 Lite+ 完整課程搜尋索引")
    parser.add_argument("--limit", type=int, default=None, help="僅測試前 N 門課；省略則跑全部")
    parser.add_argument("--concurrency", type=int, default=DETAIL_CONCURRENCY, help="同時處理課程數，預設 4，最高 8")
    parser.add_argument("--refresh-list", action="store_true", help="先向輔大 API 更新課程清單；失敗時自動退回最近成功快照")
    args = parser.parse_args()
    asyncio.run(build(args.limit, args.concurrency, args.refresh_list))


if __name__ == "__main__":
    main()
