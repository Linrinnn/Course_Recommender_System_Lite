from __future__ import annotations

import asyncio
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

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
FETCH_CONCURRENCY = max(1, min(int(os.environ.get("FJU_FETCH_CONCURRENCY", "4")), 8))
SEMESTER_START = os.environ.get("FJU_SEMESTER_START", "2026-09-14")
SEMESTER_WEEKS = int(os.environ.get("FJU_SEMESTER_WEEKS", "18"))
PAGE_SIZE = 100
STATIC_DIR = Path(__file__).parent / "static"
OFFICIAL_SECTIONS = ["D0", "D1", "D2", "D3", "D4", "DN", "D5", "D6", "D7", "D8", "E0", "E1", "E2", "E3", "E4"]
DAYTIME_SECTIONS = set(OFFICIAL_SECTIONS[:10])
EVENING_SECTIONS = set(OFFICIAL_SECTIONS[10:])

app = FastAPI(title="FJU Course Recommender Lite+", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_cache: dict[str, Any] = {"at": 0.0, "courses": []}
_cache_lock = asyncio.Lock()


def _fetch_json_sync(endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{BASE_URL}/{endpoint}?{query}",
        headers={
            "User-Agent": "Mozilla/5.0 FJU-Course-Recommender-LitePlus/2.0",
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


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _infer_grade(row: dict[str, Any]) -> int | None:
    direct = _first(row, "grade", "grd", "dptGrd", "stuGrade")
    parsed = _int(direct)
    if parsed and 1 <= parsed <= 8:
        return parsed
    label = _string(_first(row, "dptGrdCN", "clsCNa", "className"))
    match = re.search(r"([一二三四五六七八1-8])年", label)
    if not match:
        return None
    token = match.group(1)
    zh = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8}
    return zh.get(token, _int(token))


def _course_tags(row: dict[str, Any]) -> list[dict[str, str]]:
    tags: list[dict[str, str]] = []
    for item in row.get("couClassifyList") or []:
        if not isinstance(item, dict):
            continue
        code = _first(item, "couClassifyNo", "code", "id")
        label = _first(item, "couClassifyCna", "label", "name")
        if code in (None, "") or not label:
            continue
        tags.append({"code": _string(code), "label": _string(label)})
    return tags


def _meetings(row: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in row.get("seqList") or []:
        if not isinstance(item, dict):
            continue
        sections = [part.strip().upper() for part in _string(item.get("section")).split(",") if part.strip()]
        result.append(
            {
                "weekday": _int(item.get("couWek")),
                "sections": sections,
                "section_raw": _string(item.get("section")),
                "room": _string(item.get("romNO")).split("-", 1)[0],
                "week_pattern": _string(item.get("sda")),
            }
        )
    return result


def _normalize(row: dict[str, Any]) -> dict[str, Any]:
    jon = _first(row, "jonCouSn", "jon_cou_sn")
    credits = _first(row, "credit", "credits")
    department = _string(_first(row, "dptGrdCN", "dptCNa", "departmentName", "unitName", "dptName"))
    division = _string(_first(row, "dayCNa", "division", "divisionName", "dayNgt"))
    return {
        "id": _string(jon),
        "course_code": _string(_first(row, "avaNO", "jAvaNO", "couNo")),
        "name": _string(_first(row, "couCNa", "courseName", "name")),
        "name_en": _string(_first(row, "couENa", "courseNameEn")),
        "teacher": _string(_first(row, "tchCNa", "teacherName", "tchName")),
        "teacher_en": _string(_first(row, "tchENa", "teacherNameEn")),
        "credits": credits,
        "credits_number": _number(credits),
        "required_elective": _string(_first(row, "reqSelCNa", "requiredElective")),
        "required_elective_code": _string(_first(row, "reqSel", "requiredElectiveCode")),
        "department": department,
        "division": division,
        "grade": _infer_grade(row),
        "class_group": _string(_first(row, "clsCNa", "className", "class_group")),
        "course_tags": _course_tags(row),
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

            for start in range(2, total_pages + 1, FETCH_CONCURRENCY):
                pages = range(start, min(start + FETCH_CONCURRENCY, total_pages + 1))
                payloads = await asyncio.gather(*(_fetch_page(page) for page in pages))
                for payload in payloads:
                    rows.extend((payload.get("result") or {}).get("result") or [])

            courses = [_normalize(row) for row in rows]
            courses = [course for course in courses if course["id"] and course["name"]]
            _cache.update({"at": time.monotonic(), "courses": courses})
            return courses
        except Exception as exc:
            if _cache["courses"]:
                return _cache["courses"]
            raise HTTPException(status_code=502, detail=f"無法讀取輔大課程 API：{exc}") from exc


def _counted_options(values: Iterable[Any]) -> list[dict[str, Any]]:
    counter = Counter(_string(value) for value in values if _string(value))
    return [
        {"value": value, "label": value, "count": count}
        for value, count in sorted(counter.items(), key=lambda pair: pair[0].casefold())
    ]


def _numeric_options(values: Iterable[Any], suffix: str) -> list[dict[str, Any]]:
    counter: Counter[float] = Counter()
    for value in values:
        number = _number(value)
        if number is not None:
            counter[number] += 1
    return [
        {"value": f"{value:g}", "label": f"{value:g}{suffix}", "count": counter[value]}
        for value in sorted(counter)
    ]


def _section_options(courses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counter = Counter(
        section
        for course in courses
        for meeting in course["meetings"]
        for section in meeting.get("sections") or []
    )
    return [
        {"value": section, "label": section, "count": counter.get(section, 0)}
        for section in OFFICIAL_SECTIONS
    ]


def _tag_options(courses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counter: Counter[tuple[str, str]] = Counter()
    for course in courses:
        for tag in course.get("course_tags") or []:
            counter[(tag["code"], tag["label"])] += 1
    return [
        {"value": code, "label": label, "count": count}
        for (code, label), count in sorted(counter.items(), key=lambda pair: pair[0][1])
    ]


def _search_text(course: dict[str, Any]) -> str:
    return " ".join(
        [
            course["name"], course["name_en"], course["course_code"], course["teacher"], course["teacher_en"],
            course["department"], course["division"], course["class_group"],
            " ".join(tag["label"] for tag in course.get("course_tags") or []),
        ]
    ).casefold()


def _matches_time_of_day(course: dict[str, Any], mode: str, include_unknown: bool) -> bool:
    meetings = course["meetings"]
    if not meetings:
        return include_unknown
    if mode == "all":
        return True
    sections = {section for meeting in meetings for section in meeting.get("sections") or []}
    if mode == "daytime":
        return bool(sections & DAYTIME_SECTIONS)
    if mode == "evening":
        return bool(sections & EVENING_SECTIONS)
    if mode == "weekday_evening_or_saturday":
        return any(
            meeting.get("weekday") == 6 or bool(set(meeting.get("sections") or []) & EVENING_SECTIONS)
            for meeting in meetings
        )
    return True


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/schedule")
async def schedule() -> FileResponse:
    return FileResponse(STATIC_DIR / "schedule.html")


@app.get("/api/meta")
async def meta() -> dict[str, Any]:
    return {
        "academic_year": HY,
        "semester": HT,
        "cache_seconds": CACHE_SECONDS,
        "semester_start": SEMESTER_START,
        "semester_weeks": SEMESTER_WEEKS,
        "sections": OFFICIAL_SECTIONS,
    }


@app.get("/api/facets")
async def facets() -> dict[str, Any]:
    courses = await _load_courses()
    return {
        "departments": _counted_options(course["department"] for course in courses),
        "grades": _numeric_options((course["grade"] for course in courses), " 年級"),
        "credits": _numeric_options((course["credits_number"] for course in courses), " 學分"),
        "classes": _counted_options(course["class_group"] for course in courses),
        "divisions": _counted_options(course["division"] for course in courses),
        "required_elective": _counted_options(course["required_elective"] for course in courses),
        "course_tags": _tag_options(courses),
        "teachers": _counted_options(course["teacher"] for course in courses),
        "sections": _section_options(courses),
    }


@app.get("/api/courses")
async def courses(
    q: str = Query("", max_length=120),
    department: str = Query("", max_length=100),
    grade: int | None = Query(None, ge=1, le=8),
    division: str = Query("", max_length=50),
    required_elective: str = Query("", max_length=30),
    course_tag: str = Query("", max_length=200),
    teacher: str = Query("", max_length=80),
    class_group: str = Query("", max_length=80),
    weekday: int | None = Query(None, ge=1, le=7),
    section: str = Query("", max_length=20),
    sections: str = Query("", max_length=200),
    time_of_day: str = Query("all", pattern="^(all|daytime|evening|weekday_evening_or_saturday)$"),
    include_unknown_schedule: bool = Query(True),
    min_credits: float | None = Query(None, ge=0, le=30),
    max_credits: float | None = Query(None, ge=0, le=30),
    schedule: str = Query("all", pattern="^(all|known|unknown)$"),
    sort: str = Query("name", pattern="^(name|department|grade|teacher|credits|course_code)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
) -> dict[str, Any]:
    items = await _load_courses()
    query = q.strip().casefold()
    department_q = department.strip().casefold()
    division_q = division.strip().casefold()
    req_q = required_elective.strip().casefold()
    teacher_q = teacher.strip().casefold()
    class_q = class_group.strip().casefold()
    section_q = section.strip().upper()
    selected_sections = {item.strip().upper() for item in sections.split(",") if item.strip()}
    selected_tags = {item.strip() for item in course_tag.split(",") if item.strip()}

    def matches(course: dict[str, Any]) -> bool:
        if query and query not in _search_text(course):
            return False
        if department_q and department_q != course["department"].casefold():
            return False
        if grade and course.get("grade") != grade:
            return False
        if division_q and division_q != course["division"].casefold():
            return False
        if req_q and req_q != course["required_elective"].casefold():
            return False
        if selected_tags and not selected_tags.intersection(tag["code"] for tag in course.get("course_tags") or []):
            return False
        if teacher_q and teacher_q not in course["teacher"].casefold():
            return False
        if class_q and class_q not in course["class_group"].casefold():
            return False
        if weekday and not any(meeting.get("weekday") == weekday for meeting in course["meetings"]):
            return False
        if section_q and not any(section_q in (meeting.get("sections") or []) for meeting in course["meetings"]):
            return False
        if selected_sections:
            actual = {part for meeting in course["meetings"] for part in meeting.get("sections") or []}
            if not actual.intersection(selected_sections):
                return False
        if not _matches_time_of_day(course, time_of_day, include_unknown_schedule):
            return False
        if schedule == "known" and not course["meetings"]:
            return False
        if schedule == "unknown" and course["meetings"]:
            return False
        credits = course.get("credits_number")
        if min_credits is not None and (credits is None or credits < min_credits):
            return False
        if max_credits is not None and (credits is None or credits > max_credits):
            return False
        return True

    filtered = [course for course in items if matches(course)]
    sort_map = {
        "name": lambda course: (course["name"].casefold(), course["course_code"]),
        "department": lambda course: (not bool(course["department"]), course["department"].casefold(), course["name"].casefold()),
        "grade": lambda course: (course["grade"] is None, course["grade"] or 99, course["name"].casefold()),
        "teacher": lambda course: (not bool(course["teacher"]), course["teacher"].casefold(), course["name"].casefold()),
        "credits": lambda course: (course["credits_number"] is None, course["credits_number"] or 0, course["name"].casefold()),
        "course_code": lambda course: (not bool(course["course_code"]), course["course_code"], course["name"].casefold()),
    }
    filtered.sort(key=sort_map[sort])

    total = len(filtered)
    total_pages = max(1, math.ceil(total / page_size))
    page = min(page, total_pages)
    start = (page - 1) * page_size
    return {
        "items": filtered[start : start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "academic_year": HY,
        "semester": HT,
    }


@app.post("/api/refresh")
async def refresh() -> dict[str, Any]:
    items = await _load_courses(force=True)
    return {"ok": True, "course_count": len(items)}
