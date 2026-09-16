from __future__ import annotations

import asyncio
import json
import shutil
import urllib.request
from collections import Counter
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
DEPARTMENT_REFERENCE_URL = (
    "https://raw.githubusercontent.com/hyslchs/Course_Recommender_System/"
    "main/data/reference/departments_115.json"
)


def clean_course(course: dict) -> dict:
    result = dict(course)
    result.pop("raw_list", None)
    return result


def load_department_reference() -> tuple[dict[tuple[str, str], str], dict[str, str]]:
    """Load the 115 academic-year department catalog generated from FJU's official APIs."""
    request = urllib.request.Request(
        DEPARTMENT_REFERENCE_URL,
        headers={"User-Agent": "FJU-Course-Recommender-LitePlus-Pages/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        print(f"Warning: department reference unavailable: {exc}")
        return {}, {}

    departments: dict[tuple[str, str], str] = {}
    divisions: dict[str, str] = {}
    for division in payload.get("divisions") or []:
        division_code = str(division.get("code") or "").strip().upper()
        if not division_code:
            continue
        division_name = str(division.get("name_zh") or division.get("label") or "").strip()
        if division_name:
            divisions[division_code] = division_name
        for department in division.get("departments") or []:
            department_code = str(department.get("code") or "").strip().upper()
            department_name = str(
                department.get("name_zh") or department.get("label") or department_code
            ).strip()
            if department_code:
                departments[(division_code, department_code)] = department_name
    return departments, divisions


def apply_department_reference(courses: list[dict]) -> None:
    departments, divisions = load_department_reference()

    # The current FJU list API exposes compact course codes such as C010001466
    # and DAT0200009A. Their stable prefix is: 1 char division + 2 char unit.
    # The list API itself does not currently include department name/code fields.
    for course in courses:
        course_code = str(course.get("course_code") or "").strip().upper()
        division_code = str(course.get("division_code") or "").strip().upper()
        department_code = str(course.get("department_code") or "").strip().upper()

        if len(course_code) >= 3:
            if not division_code:
                division_code = course_code[0]
            if not department_code:
                department_code = course_code[1:3]

        if division_code:
            course["division_code"] = division_code
            if divisions.get(division_code):
                course["division"] = divisions[division_code]
        if department_code:
            course["department_code"] = department_code

        name = departments.get((division_code, department_code))
        if name:
            course["department"] = name
            if not course.get("raw_department"):
                course["raw_department"] = name


def department_options(courses: list[dict]) -> list[dict]:
    counts: Counter[str] = Counter()
    names: dict[str, Counter[str]] = {}
    uncoded: Counter[str] = Counter()

    for course in courses:
        code = str(course.get("department_code") or "").strip().upper()
        name = str(course.get("department") or "").strip()
        if code:
            counts[code] += 1
            if name:
                names.setdefault(code, Counter())[name] += 1
        elif name:
            uncoded[name] += 1

    result: list[dict] = []
    for code in sorted(counts, key=lambda value: (not value.isdigit(), value)):
        name_counter = names.get(code, Counter())
        name = name_counter.most_common(1)[0][0] if name_counter else ""
        label = f"{code}｜{name}" if name else code
        result.append({"value": code, "label": label, "count": counts[code]})

    for name, count in sorted(uncoded.items(), key=lambda item: item[0]):
        result.append({"value": name, "label": name, "count": count})
    return result


def build_facets(courses: list[dict]) -> dict:
    return {
        "departments": department_options(courses),
        "grades": _numeric_options([course.get("grade") for course in courses], " 年級"),
        "credits": _numeric_options([course.get("credits_number") for course in courses], " 學分"),
        "classes": counted_options(course.get("class_group") for course in courses),
        "divisions": counted_options(course.get("division") for course in courses),
        "study_levels": [
            item
            for item in counted_options(course.get("study_level") for course in courses)
            if item.get("value") not in {"", "unknown"}
        ],
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
        '<script src="./static/pages-api.js"></script>\n'
        '  <script src="./static/pages-hotfix.js"></script>'
    )
    marker = (
        '<script type="module" src="./static/schedule.js"></script>'
        if schedule
        else '<script src="./static/schedule-modal.js"></script>'
    )
    if '<script src="./static/pages-hotfix.js"></script>' not in value:
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
    apply_department_reference(courses)
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
        "pages_mode": True,
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
    print(
        f"Pages build: {len(courses)} courses, {indexed} enriched, "
        f"{len(payload['facets']['departments'])} department options -> {DIST}"
    )


if __name__ == "__main__":
    asyncio.run(main())
