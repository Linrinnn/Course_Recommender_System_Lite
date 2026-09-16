from __future__ import annotations

import asyncio
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from app import (
    CACHE_SECONDS,
    SEMESTER_START,
    SEMESTER_WEEKS,
    _facet_coverage,
    _instructor_options,
    _numeric_options,
    _section_options,
    _tag_options,
)
from catalog import (
    HT,
    HY,
    LCID,
    OFFICIAL_SECTIONS,
    counted_options,
    fetch_list_catalog,
    merge_enriched,
    relation_options,
    weighted_options,
)

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
STATIC = ROOT / "static"


def clean_course(course: dict) -> dict:
    result = dict(course)
    result.pop("raw_list", None)
    return result


def build_facets(courses: list[dict]) -> dict:
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
        "coverage": {
            field: _facet_coverage(courses, field)
            for field in (
                "teaching_language",
                "material_language",
                "teaching_methods",
                "assessments",
                "relations",
                "online_teaching",
                "prerequisite",
                "objective",
            )
        },
    }


def rewrite_html(source: str, *, schedule: bool = False) -> str:
    value = source.replace('href="/static/', 'href="./static/').replace('src="/static/', 'src="./static/')
    loaders = (
        '<script src="./static/department-fix.js"></script>\n'
        '  <script src="./static/pages-api.js"></script>'
    )
    marker = (
        '<script type="module" src="./static/schedule.js"></script>'
        if schedule
        else '<script src="./static/schedule-modal.js"></script>'
    )
    if '<script src="./static/department-fix.js"></script>' not in value:
        value = value.replace(marker, f'{loaders}\n  {marker}')
    return value


def patch_static_js() -> None:
    modal_path = DIST / "static" / "schedule-modal.js"
    modal = modal_path.read_text(encoding="utf-8").replace(
        "frame.src = '/schedule?embed=1'",
        "frame.src = './schedule.html?embed=1'",
    )
    modal_path.write_text(modal, encoding="utf-8")

    schedule_path = DIST / "static" / "schedule.js"
    schedule = schedule_path.read_text(encoding="utf-8")
    schedule = schedule.replace("const url = `/?weekday=", "const url = `./?weekday=")
    schedule = schedule.replace('location.href = "/";', 'location.href = "./";')
    schedule_path.write_text(schedule, encoding="utf-8")


async def main() -> None:
    basic = await fetch_list_catalog()
    courses, _ = merge_enriched(basic)
    indexed = sum(1 for course in courses if course.get("detail_indexed"))

    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "data").mkdir(parents=True)
    shutil.copytree(STATIC, DIST / "static")

    (DIST / "index.html").write_text(
        rewrite_html((STATIC / "index.html").read_text(encoding="utf-8")),
        encoding="utf-8",
    )
    (DIST / "schedule.html").write_text(
        rewrite_html((STATIC / "schedule.html").read_text(encoding="utf-8"), schedule=True),
        encoding="utf-8",
    )
    (DIST / ".nojekyll").write_text("", encoding="utf-8")
    patch_static_js()

    meta = {
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
        "pages_generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    payload = {
        "meta": meta,
        "facets": build_facets(courses),
        "courses": [clean_course(course) for course in courses],
    }
    (DIST / "data" / "catalog.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Pages build: {len(courses)} courses, {indexed} enriched -> {DIST}")


if __name__ == "__main__":
    asyncio.run(main())
