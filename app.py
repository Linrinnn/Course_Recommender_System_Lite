from __future__ import annotations

import asyncio
import math
import os
import time
from collections import Counter
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from catalog import (
    DETAIL_CONCURRENCY,
    ENRICHED_PATH,
    EVENING_SECTIONS,
    DAYTIME_SECTIONS,
    HT,
    HY,
    LCID,
    OFFICIAL_SECTIONS,
    append_enriched,
    append_failure,
    compact_enriched_file,
    counted_options,
    enrich_course,
    fetch_list_catalog,
    load_enriched_map,
    matches_assessment_style,
    matches_online,
    matches_weighted,
    merge_enriched,
    relation_options,
    search_score,
    weighted_options,
)

CACHE_SECONDS = int(os.environ.get("FJU_CACHE_SECONDS", "600"))
SEMESTER_START = os.environ.get("FJU_SEMESTER_START", "2026-09-14")
SEMESTER_WEEKS = int(os.environ.get("FJU_SEMESTER_WEEKS", "18"))
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="FJU Course Recommender Lite+", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_cache: dict[str, Any] = {"at": 0.0, "courses": [], "enriched_mtime": None}
_cache_lock = asyncio.Lock()
_index_lock = asyncio.Lock()
_index_task: asyncio.Task | None = None
_index_state: dict[str, Any] = {
    "running": False,
    "total": 0,
    "completed": 0,
    "failed": 0,
    "current": "",
    "started_at": None,
    "finished_at": None,
    "last_error": "",
}


def _enriched_mtime() -> float | None:
    try:
        return ENRICHED_PATH.stat().st_mtime
    except FileNotFoundError:
        return None


async def _load_courses(force: bool = False) -> list[dict[str, Any]]:
    now = time.monotonic()
    mtime = _enriched_mtime()
    if not force and _cache["courses"] and now - _cache["at"] < CACHE_SECONDS and _cache["enriched_mtime"] == mtime:
        return _cache["courses"]

    async with _cache_lock:
        now = time.monotonic()
        mtime = _enriched_mtime()
        if not force and _cache["courses"] and now - _cache["at"] < CACHE_SECONDS and _cache["enriched_mtime"] == mtime:
            return _cache["courses"]
        try:
            basic = await fetch_list_catalog()
            courses, _ = merge_enriched(basic)
            _cache.update({"at": time.monotonic(), "courses": courses, "enriched_mtime": _enriched_mtime()})
            return courses
        except Exception as exc:
            if _cache["courses"]:
                return _cache["courses"]
            raise HTTPException(status_code=502, detail=f"無法讀取輔大課程 API：{exc}") from exc


def _section_options(courses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counter = Counter(section for course in courses for meeting in course.get("meetings") or [] for section in meeting.get("sections") or [])
    return [{"value": section, "label": section, "count": counter.get(section, 0)} for section in OFFICIAL_SECTIONS]


def _tag_options(courses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counter: Counter[tuple[str, str]] = Counter()
    for course in courses:
        for tag in course.get("course_tags") or []:
            counter[(str(tag.get("code")), str(tag.get("label") or tag.get("code")))] += 1
    return [{"value": code, "label": label, "count": count} for (code, label), count in sorted(counter.items(), key=lambda pair: pair[0][1])]


def _numeric_options(values: list[Any], suffix: str) -> list[dict[str, Any]]:
    counter: Counter[float] = Counter()
    for value in values:
        try:
            if value is not None:
                counter[float(value)] += 1
        except (TypeError, ValueError):
            pass
    return [{"value": f"{value:g}", "label": f"{value:g}{suffix}", "count": counter[value]} for value in sorted(counter)]


def _instructor_options(courses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counter: Counter[tuple[str, str]] = Counter()
    for course in courses:
        for item in course.get("instructors") or []:
            ident = str(item.get("id") or "")
            label = str(item.get("name_zh") or item.get("name_en") or ident)
            if ident:
                counter[(ident, label)] += 1
    return [{"value": ident, "label": label, "count": count} for (ident, label), count in sorted(counter.items(), key=lambda row: row[0][1])]


def _facet_coverage(courses: list[dict[str, Any]], field: str) -> dict[str, int]:
    indexed = [course for course in courses if course.get("detail_indexed")]
    available = sum(1 for course in indexed if course.get(field) not in (None, "", [], {}))
    return {"indexed": len(indexed), "available": available, "total": len(courses)}


def _matches_time_of_day(course: dict[str, Any], mode: str, include_unknown: bool) -> bool:
    meetings = course.get("meetings") or []
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
        return any(meeting.get("weekday") == 6 or bool(set(meeting.get("sections") or []) & EVENING_SECTIONS) for meeting in meetings)
    return True


def _comma_set(value: str, *, upper: bool = False) -> set[str]:
    result = {item.strip() for item in value.split(",") if item.strip()}
    return {item.upper() for item in result} if upper else result


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/schedule")
async def schedule() -> FileResponse:
    return FileResponse(STATIC_DIR / "schedule.html")


@app.get("/api/meta")
async def meta() -> dict[str, Any]:
    courses = await _load_courses()
    indexed = sum(1 for course in courses if course.get("detail_indexed"))
    return {
        "academic_year": HY,
        "semester": HT,
        "lcid": LCID,
        "cache_seconds": CACHE_SECONDS,
        "semester_start": SEMESTER_START,
        "semester_weeks": SEMESTER_WEEKS,
        "sections": OFFICIAL_SECTIONS,
        "course_count": len(courses),
        "detail_indexed": indexed,
        "detail_index_complete": bool(courses) and indexed == len(courses),
        "detail_index_path": str(ENRICHED_PATH),
    }


@app.get("/api/facets")
async def facets() -> dict[str, Any]:
    courses = await _load_courses()
    return {
        "departments": counted_options(course.get("department") for course in courses),
        "grades": _numeric_options([course.get("grade") for course in courses], " 年級"),
        "credits": _numeric_options([course.get("credits_number") for course in courses], " 學分"),
        "classes": counted_options(course.get("class_group") for course in courses),
        "divisions": counted_options(course.get("division") for course in courses),
        "study_levels": counted_options(course.get("study_level") for course in courses),
        "required_elective": counted_options(course.get("required_elective") for course in courses),
        "course_tags": _tag_options(courses),
        "teachers": counted_options(course.get("teacher") for course in courses),
        "instructors": _instructor_options(courses),
        "sections": _section_options(courses),
        "teaching_languages": counted_options(course.get("teaching_language") for course in courses),
        "material_languages": counted_options(course.get("material_language") for course in courses),
        "teaching_methods": weighted_options(courses, "teaching_methods"),
        "assessments": weighted_options(courses, "assessments"),
        "relations": relation_options(courses),
        "coverage": {field: _facet_coverage(courses, field) for field in ("teaching_language", "material_language", "teaching_methods", "assessments", "relations", "online_teaching", "prerequisite", "objective")},
    }


@app.get("/api/courses")
async def courses(
    q: str = Query("", max_length=200),
    department: str = Query("", max_length=120),
    grade: int | None = Query(None, ge=1, le=8),
    division: str = Query("", max_length=80),
    study_level: str = Query("", max_length=30),
    required_elective: str = Query("", max_length=60),
    course_tag: str = Query("", max_length=400),
    teacher: str = Query("", max_length=100),
    instructor: str = Query("", max_length=200),
    class_group: str = Query("", max_length=100),
    weekday: int | None = Query(None, ge=1, le=7),
    section: str = Query("", max_length=20),
    sections: str = Query("", max_length=200),
    time_of_day: str = Query("all", pattern="^(all|daytime|evening|weekday_evening_or_saturday)$"),
    include_unknown_schedule: bool = Query(True),
    min_credits: float | None = Query(None, ge=0, le=30),
    max_credits: float | None = Query(None, ge=0, le=30),
    schedule: str = Query("all", pattern="^(all|known|unknown)$"),
    teaching_language: str = Query("", max_length=100),
    material_language: str = Query("", max_length=100),
    teaching_method: str = Query("", max_length=400),
    teaching_method_criterion: str = Query("dominant", pattern="^(dominant|minimum)$"),
    teaching_method_min: float = Query(20, ge=0, le=100),
    assessment: str = Query("", max_length=400),
    assessment_criterion: str = Query("dominant", pattern="^(dominant|minimum)$"),
    assessment_min: float = Query(20, ge=0, le=100),
    assessment_style: str = Query("all", pattern="^(all|no_exams|exam|writing|presentation|practical|participation)$"),
    online_teaching: str = Query("all", pattern="^(all|physical_only|has_online|sync|async|both)$"),
    relation: str = Query("", max_length=400),
    include_indirect_relations: bool = Query(True),
    prerequisite: str = Query("", max_length=120),
    detail_indexed: str = Query("all", pattern="^(all|yes|no)$"),
    sort: str = Query("relevance", pattern="^(relevance|name|department|grade|teacher|credits|course_code)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
) -> dict[str, Any]:
    items = await _load_courses()
    query = q.strip()
    selected_sections = _comma_set(sections, upper=True)
    selected_tags = _comma_set(course_tag)
    selected_methods = _comma_set(teaching_method)
    selected_assessments = _comma_set(assessment)
    selected_relations = _comma_set(relation)
    selected_instructors = _comma_set(instructor)
    scored: list[tuple[float, dict[str, Any]]] = []

    for course in items:
        score = search_score(course, query) if query else 0.0
        if query and score <= 0:
            continue
        if department and course.get("department", "").casefold() != department.casefold():
            continue
        if grade and course.get("grade") != grade:
            continue
        if division and course.get("division", "").casefold() != division.casefold():
            continue
        if study_level and course.get("study_level") != study_level:
            continue
        if required_elective and course.get("required_elective", "").casefold() != required_elective.casefold():
            continue
        if selected_tags and not selected_tags.intersection(str(tag.get("code")) for tag in course.get("course_tags") or []):
            continue
        if teacher and teacher.casefold() not in course.get("teacher", "").casefold():
            continue
        if selected_instructors and not selected_instructors.intersection(str(item.get("id")) for item in course.get("instructors") or []):
            continue
        if class_group and class_group.casefold() not in course.get("class_group", "").casefold():
            continue
        meetings = course.get("meetings") or []
        if weekday and not any(meeting.get("weekday") == weekday for meeting in meetings):
            continue
        if section and not any(section.upper() in (meeting.get("sections") or []) for meeting in meetings):
            continue
        if selected_sections:
            actual = {part for meeting in meetings for part in meeting.get("sections") or []}
            if not actual.intersection(selected_sections):
                continue
        if not _matches_time_of_day(course, time_of_day, include_unknown_schedule):
            continue
        if schedule == "known" and not meetings:
            continue
        if schedule == "unknown" and meetings:
            continue
        credits = course.get("credits_number")
        if min_credits is not None and (credits is None or credits < min_credits):
            continue
        if max_credits is not None and (credits is None or credits > max_credits):
            continue
        if teaching_language and course.get("teaching_language") != teaching_language:
            continue
        if material_language and course.get("material_language") != material_language:
            continue
        if not matches_weighted(course, "teaching_methods", selected_methods, teaching_method_criterion, teaching_method_min):
            continue
        if not matches_weighted(course, "assessments", selected_assessments, assessment_criterion, assessment_min):
            continue
        if not matches_assessment_style(course, assessment_style):
            continue
        if not matches_online(course, online_teaching):
            continue
        if selected_relations:
            actual_relations = {str(item.get("id")) for item in course.get("relations") or [] if include_indirect_relations or item.get("strength") == "direct"}
            if not selected_relations.intersection(actual_relations):
                continue
        if prerequisite and prerequisite.casefold() not in course.get("prerequisite", "").casefold():
            continue
        if detail_indexed == "yes" and not course.get("detail_indexed"):
            continue
        if detail_indexed == "no" and course.get("detail_indexed"):
            continue
        scored.append((score, course))

    if sort == "relevance" and query:
        scored.sort(key=lambda pair: (-pair[0], pair[1].get("name", "").casefold()))
    else:
        sort_map = {
            "name": lambda course: (course.get("name", "").casefold(), course.get("course_code", "")),
            "department": lambda course: (not bool(course.get("department")), course.get("department", "").casefold(), course.get("name", "").casefold()),
            "grade": lambda course: (course.get("grade") is None, course.get("grade") or 99, course.get("name", "").casefold()),
            "teacher": lambda course: (not bool(course.get("teacher")), course.get("teacher", "").casefold(), course.get("name", "").casefold()),
            "credits": lambda course: (course.get("credits_number") is None, course.get("credits_number") or 0, course.get("name", "").casefold()),
            "course_code": lambda course: (not bool(course.get("course_code")), course.get("course_code", ""), course.get("name", "").casefold()),
            "relevance": lambda course: (course.get("name", "").casefold(),),
        }
        scored.sort(key=lambda pair: sort_map[sort](pair[1]))

    total = len(scored)
    total_pages = max(1, math.ceil(total / page_size))
    page = min(page, total_pages)
    start = (page - 1) * page_size
    page_rows = []
    for score, course in scored[start:start + page_size]:
        item = dict(course)
        item.pop("raw_list", None)
        if query:
            item["search_score"] = round(score, 3)
        page_rows.append(item)
    return {"items": page_rows, "total": total, "page": page, "page_size": page_size, "total_pages": total_pages, "academic_year": HY, "semester": HT}


@app.get("/api/course/{course_id}")
async def course_detail(course_id: str, refresh: bool = False) -> dict[str, Any]:
    items = await _load_courses()
    course = next((item for item in items if item.get("id") == course_id), None)
    if not course:
        raise HTTPException(status_code=404, detail="找不到課程")
    if course.get("detail_indexed") and not refresh:
        result = dict(course)
        result.pop("raw_list", None)
        return result
    try:
        enriched = await enrich_course(course)
        append_enriched(enriched)
        compact_enriched_file()
        await _load_courses(force=True)
        return enriched
    except Exception as exc:
        append_failure(course_id, exc)
        raise HTTPException(status_code=502, detail=f"無法讀取課程詳細資料：{exc}") from exc


async def _run_full_index() -> None:
    global _index_state
    async with _index_lock:
        try:
            basic = await fetch_list_catalog()
            existing = load_enriched_map()
            pending = [course for course in basic if course["id"] not in existing]
            _index_state.update({"running": True, "total": len(basic), "completed": len(existing), "failed": 0, "current": "", "started_at": int(time.time()), "finished_at": None, "last_error": ""})
            semaphore = asyncio.Semaphore(DETAIL_CONCURRENCY)
            write_lock = asyncio.Lock()

            async def worker(course: dict[str, Any]) -> None:
                async with semaphore:
                    _index_state["current"] = course.get("name", "")
                    try:
                        enriched = await enrich_course(course)
                        async with write_lock:
                            append_enriched(enriched)
                            _index_state["completed"] += 1
                    except Exception as exc:
                        async with write_lock:
                            append_failure(course["id"], exc)
                            _index_state["failed"] += 1

            tasks = [asyncio.create_task(worker(course)) for course in pending]
            for task in asyncio.as_completed(tasks):
                await task
            compact_enriched_file()
            await _load_courses(force=True)
        except Exception as exc:
            _index_state["last_error"] = str(exc)
        finally:
            _index_state["running"] = False
            _index_state["current"] = ""
            _index_state["finished_at"] = int(time.time())


@app.get("/api/index/status")
async def index_status() -> dict[str, Any]:
    items = await _load_courses()
    indexed = sum(1 for course in items if course.get("detail_indexed"))
    state = dict(_index_state)
    state["catalog_total"] = len(items)
    state["catalog_indexed"] = indexed
    state["complete"] = bool(items) and indexed == len(items)
    return state


@app.post("/api/index/start")
async def start_index() -> dict[str, Any]:
    global _index_task
    if _index_task and not _index_task.done():
        return {"ok": True, "already_running": True, **_index_state}
    _index_task = asyncio.create_task(_run_full_index())
    await asyncio.sleep(0)
    return {"ok": True, "already_running": False, **_index_state}


@app.post("/api/refresh")
async def refresh() -> dict[str, Any]:
    items = await _load_courses(force=True)
    return {"ok": True, "course_count": len(items), "detail_indexed": sum(1 for item in items if item.get("detail_indexed"))}
