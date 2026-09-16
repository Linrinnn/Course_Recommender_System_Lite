from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE_URL = "https://travellerlink.fju.edu.tw/Outline/api"
LIST_ENDPOINT = "OutlineQuery/OutlineStudentQuery"
HY = int(os.environ.get("FJU_HY", "115"))
HT = int(os.environ.get("FJU_HT", "1"))
LCID = int(os.environ.get("FJU_LCID", "1028"))
SCO_TYP = int(os.environ.get("FJU_SCO_TYP", "100"))
CACHE_SECONDS = int(os.environ.get("FJU_CACHE_SECONDS", "600"))
PAGE_SIZE = 100
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="FJU Course Recommender Lite", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_cache: dict[str, Any] = {"at": 0.0, "courses": []}
_cache_lock = asyncio.Lock()


def _fetch_json_sync(endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{BASE_URL}/{endpoint}?{query}",
        headers={
            "User-Agent": "Mozilla/5.0 FJU-Course-Recommender-Lite/1.0",
            "Accept": "application/json,text/plain,*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


async def _fetch_page(page_number: int) -> dict[str, Any]:
    return await asyncio.to_thread(
        _fetch_json_sync,
        LIST_ENDPOINT,
        {
            "scoTyp": SCO_TYP,
            "hy": HY,
            "ht": HT,
            "PageNumber": page_number,
            "PageSize": PAGE_SIZE,
            "lcid": LCID,
        },
    )


def _string(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _first(row: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value
    return None


def _meetings(row: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in row.get("seqList") or []:
        if not isinstance(item, dict):
            continue
        sections = [part.strip() for part in _string(item.get("section")).split(",") if part.strip()]
        result.append(
            {
                "weekday": int(item["couWek"]) if _string(item.get("couWek")).isdigit() else None,
                "sections": sections,
                "section_raw": _string(item.get("section")),
                "room": _string(item.get("romNO")).split("-", 1)[0],
            }
        )
    return result


def _normalize(row: dict[str, Any]) -> dict[str, Any]:
    jon = _first(row, "jonCouSn", "jon_cou_sn")
    return {
        "id": _string(jon),
        "course_code": _string(_first(row, "avaNO", "jAvaNO", "couNo")),
        "name": _string(_first(row, "couCNa", "courseName", "name")),
        "name_en": _string(_first(row, "couENa", "courseNameEn")),
        "teacher": _string(_first(row, "tchCNa", "teacherName", "tchName")),
        "credits": _first(row, "credit", "credits"),
        "required_elective": _string(_first(row, "reqSelCNa", "requiredElective")),
        "department": _string(_first(row, "dptGrdCN", "dptCNa", "departmentName", "unitName")),
        "class_group": _string(_first(row, "clsCNa", "className", "class_group")),
        "meetings": _meetings(row),
        "outline_url": f"https://outline.fju.edu.tw/#/outlineSearch/outlineView/{jon}/{LCID}" if jon else "",
    }


async def _load_courses(force: bool = False) -> list[dict[str, Any]]:
    now = time.monotonic()
    if not force and _cache["courses"] and now - _cache["at"] < CACHE_SECONDS:
        return _cache["courses"]

    async with _cache_lock:
        now = time.monotonic()
        if not force and _cache["courses"] and now - _cache["at"] < CACHE_SECONDS:
            return _cache["courses"]
        try:
            first = await _fetch_page(1)
            result = first.get("result") or {}
            total_pages = int(result.get("totalPages") or 1)
            rows = list(result.get("result") or [])
            for page in range(2, total_pages + 1):
                payload = await _fetch_page(page)
                rows.extend((payload.get("result") or {}).get("result") or [])
            courses = [_normalize(row) for row in rows]
            courses = [course for course in courses if course["id"] and course["name"]]
            _cache.update({"at": time.monotonic(), "courses": courses})
            return courses
        except Exception as exc:
            if _cache["courses"]:
                return _cache["courses"]
            raise HTTPException(status_code=502, detail=f"無法讀取輔大課程 API：{exc}") from exc


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/meta")
async def meta() -> dict[str, Any]:
    return {"academic_year": HY, "semester": HT, "cache_seconds": CACHE_SECONDS}


@app.get("/api/courses")
async def courses(
    q: str = Query("", max_length=100),
    weekday: int | None = Query(None, ge=1, le=7),
    required_elective: str = Query("", max_length=20),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
) -> dict[str, Any]:
    items = await _load_courses()
    needle = q.strip().casefold()
    req = required_elective.strip().casefold()

    def matches(course: dict[str, Any]) -> bool:
        if needle:
            haystack = " ".join(
                [
                    course["name"],
                    course["name_en"],
                    course["teacher"],
                    course["course_code"],
                    course["department"],
                    course["class_group"],
                ]
            ).casefold()
            if needle not in haystack:
                return False
        if weekday and not any(meeting.get("weekday") == weekday for meeting in course["meetings"]):
            return False
        if req and req not in course["required_elective"].casefold():
            return False
        return True

    filtered = [course for course in items if matches(course)]
    start = (page - 1) * page_size
    end = start + page_size
    return {
        "items": filtered[start:end],
        "total": len(filtered),
        "page": page,
        "page_size": page_size,
        "academic_year": HY,
        "semester": HT,
    }


@app.post("/api/refresh")
async def refresh() -> dict[str, Any]:
    items = await _load_courses(force=True)
    return {"ok": True, "course_count": len(items)}
