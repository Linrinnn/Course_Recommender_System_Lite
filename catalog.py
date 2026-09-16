from __future__ import annotations

import asyncio
import json
import os
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

BASE_URL = "https://travellerlink.fju.edu.tw/Outline/api"
LIST_ENDPOINT = "OutlineQuery/OutlineStudentQuery"
DETAIL_ENDPOINTS = {
    "course_details": "OutlineMaintain/CourseDetailsData",
    "relations": "OutlineMaintain/CourseRelations",
    "info_and_book": "OutlineMaintain/CourseInfoAndBook",
    "course_progress": "OutlineMaintain/CourseCP",
    "methods": "OutlineMaintain/CourseMethods",
}

HY = int(os.environ.get("FJU_HY", "115"))
HT = int(os.environ.get("FJU_HT", "1"))
LCID = int(os.environ.get("FJU_LCID", "1028"))
SCO_TYP = int(os.environ.get("FJU_SCO_TYP", "100"))
PAGE_SIZE = int(os.environ.get("FJU_PAGE_SIZE", "100"))
FETCH_CONCURRENCY = max(1, min(int(os.environ.get("FJU_FETCH_CONCURRENCY", "4")), 8))
DETAIL_CONCURRENCY = max(1, min(int(os.environ.get("FJU_DETAIL_CONCURRENCY", "4")), 8))
DATA_DIR = Path(os.environ.get("FJU_DATA_DIR", "data_runtime"))
ENRICHED_PATH = DATA_DIR / f"enriched_{HY}_{HT}.jsonl"
FAILED_PATH = DATA_DIR / f"enriched_{HY}_{HT}_failures.jsonl"

OFFICIAL_SECTIONS = ["D0", "D1", "D2", "D3", "D4", "DN", "D5", "D6", "D7", "D8", "E0", "E1", "E2", "E3", "E4"]
DAYTIME_SECTIONS = set(OFFICIAL_SECTIONS[:10])
EVENING_SECTIONS = set(OFFICIAL_SECTIONS[10:])
GRADE_RE = re.compile(r"^(.+?)([一二三四五六七八])([甲乙丙丁戊己庚辛壬癸愛智仁勇忠孝信義和平]*)$")
GRADE_MAP = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8}
ASSESSMENT_FAMILIES = {
    "exam": {"1", "6", "7", "8", "9", "14"},
    "writing": {"2", "3", "10", "12", "18"},
    "presentation": {"4", "13", "15"},
    "practical": {"5", "16", "17"},
    "participation": {"11"},
}


def _string(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _first(row: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value
    return None


def _number(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def split_department_grade(value: str) -> tuple[str, int | None, str]:
    value = value.strip()
    match = GRADE_RE.match(value)
    if not match:
        return value, None, ""
    base, grade_text, class_text = match.groups()
    return base, GRADE_MAP.get(grade_text), f"{class_text}班" if class_text else ""


def infer_study_level(raw_department: str, division: str) -> str:
    text = f"{raw_department} {division}"
    if any(token in text for token in ("博士", "博班")):
        return "doctoral"
    if any(token in text for token in ("碩士", "碩班", "研究所")):
        return "master"
    if any(token in text for token in ("學系", "學士", "進修", "二年制", "四年制", "大學部")):
        return "undergraduate"
    return "unknown"


def _course_tags(row: dict[str, Any]) -> list[dict[str, Any]]:
    tags: list[dict[str, Any]] = []
    for item in row.get("couClassifyList") or []:
        if not isinstance(item, dict):
            continue
        code = item.get("couClassifyNo")
        label = item.get("couClassifyCna")
        if code is None or not label:
            continue
        tags.append({
            "code": str(code),
            "label": str(label),
            "label_en": _string(item.get("couClassifyEna")),
            "note": _string(item.get("couClassifyNoteCna")),
        })
    return tags


def _meetings(row: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in row.get("seqList") or []:
        if not isinstance(item, dict):
            continue
        sections = [part.strip().upper() for part in _string(item.get("section")).split(",") if part.strip()]
        result.append({
            "weekday": _int(item.get("couWek")),
            "sections": sections,
            "section_raw": _string(item.get("section")),
            "room": _string(item.get("romNO")).split("-", 1)[0],
            "week_pattern": _string(item.get("sda")),
        })
    return result


def normalize_list_row(row: dict[str, Any]) -> dict[str, Any]:
    jon = _first(row, "jonCouSn", "jon_cou_sn")
    raw_department = _string(_first(row, "dptGrdCN", "dptCNa", "departmentName", "unitName", "dptName"))
    department, grade_from_label, class_from_label = split_department_grade(raw_department)
    division = _string(_first(row, "dayCNa", "division", "divisionName", "dayNgt"))
    credits = _number(_first(row, "credit", "credits"))
    return {
        "id": _string(jon),
        "course_code": _string(_first(row, "avaNO", "jAvaNO", "couNo")),
        "name": _string(_first(row, "couCNa", "courseName", "name")),
        "name_en": _string(_first(row, "couENa", "courseNameEn")),
        "teacher": _string(_first(row, "tchCNa", "teacherName", "tchName")),
        "teacher_en": _string(_first(row, "tchENa", "teacherNameEn")),
        "credits": credits,
        "credits_number": credits,
        "required_elective": _string(_first(row, "reqSelCNa", "requiredElective")),
        "required_elective_code": _string(_first(row, "reqSel", "requiredElectiveCode")),
        "department": department or raw_department,
        "raw_department": raw_department,
        "department_code": _string(_first(row, "dptNo", "departmentCode")),
        "division": division,
        "division_code": _string(_first(row, "dayNgt", "divisionCode")),
        "grade": grade_from_label,
        "class_group": _string(_first(row, "clsCNa", "className", "class_group")) or class_from_label,
        "study_level": infer_study_level(raw_department, division),
        "course_tags": _course_tags(row),
        "meetings": _meetings(row),
        "outline_url": f"https://outline.fju.edu.tw/#/outlineSearch/outlineView/{jon}/{LCID}" if jon else "",
        "teaching_language": None,
        "material_language": None,
        "instructors": [],
        "relations": [],
        "teaching_methods": [],
        "assessments": [],
        "online_teaching": None,
        "prerequisite": "",
        "objective": "",
        "weekly_progress": "",
        "materials_text": "",
        "enrollment_note": "",
        "detail_indexed": False,
        "raw_list": row,
    }


def _fetch_json_sync(endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    request = urllib.request.Request(
        f"{BASE_URL}/{endpoint}?{query}",
        headers={
            "User-Agent": "Mozilla/5.0 FJU-Course-Recommender-LitePlus/3.0",
            "Accept": "application/json,text/plain,*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


async def fetch_json(endpoint: str, **params: Any) -> dict[str, Any]:
    return await asyncio.to_thread(_fetch_json_sync, endpoint, params)


async def fetch_list_page(page_number: int) -> dict[str, Any]:
    return await fetch_json(
        LIST_ENDPOINT,
        scoTyp=SCO_TYP,
        hy=HY,
        ht=HT,
        PageNumber=page_number,
        PageSize=PAGE_SIZE,
        lcid=LCID,
    )


async def fetch_list_catalog(concurrency: int = FETCH_CONCURRENCY) -> list[dict[str, Any]]:
    first = await fetch_list_page(1)
    result = first.get("result") or {}
    total_pages = int(result.get("totalPages") or 1)
    rows = list(result.get("result") or [])
    semaphore = asyncio.Semaphore(concurrency)

    async def one(page: int) -> dict[str, Any]:
        async with semaphore:
            return await fetch_list_page(page)

    for start in range(2, total_pages + 1, concurrency):
        payloads = await asyncio.gather(*(one(page) for page in range(start, min(total_pages + 1, start + concurrency))))
        for payload in payloads:
            rows.extend((payload.get("result") or {}).get("result") or [])
    courses = [normalize_list_row(row) for row in rows]
    return [course for course in courses if course["id"] and course["name"]]


def _result(payload: Any, default: Any) -> Any:
    if not isinstance(payload, dict):
        return default
    value = payload.get("result", default)
    return default if value is None else value


def _normalize_methods(groups: list[dict[str, Any]], method_type: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for group in groups or []:
        if not isinstance(group, dict) or group.get("mType") != method_type:
            continue
        for item in group.get("methodsDetails") or []:
            if not isinstance(item, dict):
                continue
            sn = item.get("methodSN")
            percent = _number(item.get("percent"))
            if sn is None or not percent or percent <= 0:
                continue
            rows.append({
                "id": str(sn),
                "label": _string(item.get("methodName")),
                "label_en": _string(item.get("methodEName")),
                "percent": percent,
            })
    return rows


def _normalize_relations(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    group_map = {1: "literacy", 5: "special_issues", 6: "core_knowledge", 8: "core_skills_attitudes", 10: "sdgs", 11: "innovation_features"}
    for item in rows or []:
        if not isinstance(item, dict) or item.get("relation") not in {1, 3}:
            continue
        core_no, item_no = item.get("coreNo"), item.get("itemNo")
        if core_no is None or item_no is None:
            continue
        result.append({
            "id": f"{core_no}:{item_no}",
            "group": group_map.get(core_no, "core_competencies"),
            "label": _string(item.get("itemName")),
            "strength": "direct" if item.get("relation") == 3 else "indirect",
        })
    return result


def _weekly_progress(progress: dict[str, Any]) -> tuple[str, dict[str, bool]]:
    rows = progress.get("weeklyCP") or []
    parts: list[str] = []
    sync = False
    async_mode = False
    for item in rows:
        if not isinstance(item, dict):
            continue
        parts.append(" ".join(_string(item.get(key)) for key in ("theme", "unit", "other") if _string(item.get(key))))
        sync = sync or (_number(item.get("syncOnlineClassHr")) or 0) > 0
        async_mode = async_mode or (_number(item.get("asyncOnlineClassHr")) or 0) > 0
    return "\n".join(part for part in parts if part), {"sync": sync, "async": async_mode}


def _materials_text(info: dict[str, Any], progress: dict[str, Any]) -> str:
    parts = [_string(info.get(key)) for key in ("cm", "book", "refBook", "tchUrl") if _string(info.get(key))]
    for item in progress.get("courseTeaMater") or []:
        if isinstance(item, dict):
            parts.append(" ".join(_string(v) for v in item.values() if isinstance(v, (str, int, float))))
        else:
            parts.append(_string(item))
    return "\n".join(part for part in parts if part)


async def enrich_course(course: dict[str, Any]) -> dict[str, Any]:
    jon = course["id"]
    details_payload = await fetch_json(DETAIL_ENDPOINTS["course_details"], jonCouSn=jon, lcid=LCID, fromStu="true")
    details = _result(details_payload, {})
    tch_no = details.get("tchNo") or (course.get("raw_list") or {}).get("tchNo")
    common = {"jonCouSn": jon, "tchNo": tch_no, "lcid": LCID}

    async def safe(endpoint: str, **params: Any) -> dict[str, Any]:
        try:
            return await fetch_json(endpoint, **params)
        except Exception:
            return {"result": None}

    relations_payload, info_payload, progress_payload, methods_payload = await asyncio.gather(
        safe(DETAIL_ENDPOINTS["relations"], **common),
        safe(DETAIL_ENDPOINTS["info_and_book"], **common),
        safe(DETAIL_ENDPOINTS["course_progress"], **common),
        safe(DETAIL_ENDPOINTS["methods"], **common),
    )
    relations = _result(relations_payload, [])
    info = _result(info_payload, {})
    progress = _result(progress_payload, {})
    methods = _result(methods_payload, [])
    weekly, online = _weekly_progress(progress)

    raw_department = _string(details.get("dptGrdCN")) or course.get("raw_department", "")
    department, grade, class_group = split_department_grade(raw_department)
    division = _string(details.get("dayCNa")) or course.get("division", "")
    teacher = _string(details.get("tchCNa")) or course.get("teacher", "")
    teacher_en = _string(details.get("tchENa")) or course.get("teacher_en", "")
    instructors: list[dict[str, str]] = []
    primary_id = _string(details.get("tchNo")) or f"name:{teacher or teacher_en}"
    if teacher or teacher_en:
        instructors.append({"id": primary_id, "name_zh": teacher, "name_en": teacher_en})
    for extra in details.get("tchList") or []:
        if not isinstance(extra, dict):
            continue
        name_zh, name_en = _string(extra.get("tchCNa")), _string(extra.get("tchENa"))
        ident = _string(extra.get("tchNo")) or f"name:{name_zh or name_en}"
        if ident and not any(item["id"] == ident for item in instructors):
            instructors.append({"id": ident, "name_zh": name_zh, "name_en": name_en})

    result = dict(course)
    result.update({
        "course_code": _string(details.get("avaNO")) or course.get("course_code", ""),
        "name": _string(details.get("couCNa")) or course.get("name", ""),
        "name_en": _string(details.get("couENa")) or course.get("name_en", ""),
        "credits": _number(details.get("credit")) if details.get("credit") not in (None, "") else course.get("credits"),
        "credits_number": _number(details.get("credit")) if details.get("credit") not in (None, "") else course.get("credits_number"),
        "required_elective": _string(details.get("reqSelCNa")) or course.get("required_elective", ""),
        "raw_department": raw_department,
        "department": department or course.get("department", ""),
        "department_code": _string(details.get("dptNo")) or course.get("department_code", ""),
        "division": division,
        "division_code": _string(details.get("dayNgt")) or course.get("division_code", ""),
        "grade": grade if grade is not None else course.get("grade"),
        "class_group": class_group or course.get("class_group", ""),
        "study_level": infer_study_level(raw_department, division),
        "teacher": teacher,
        "teacher_en": teacher_en,
        "instructors": instructors,
        "teaching_language": _string(details.get("teaLangCNa")) or None,
        "material_language": _string(details.get("teaMaterCNa")) or None,
        "relations": _normalize_relations(relations),
        "teaching_methods": _normalize_methods(methods, 1),
        "assessments": _normalize_methods(methods, 2),
        "online_teaching": online,
        "prerequisite": _string(info.get("preCourse")),
        "objective": _string(info.get("obj")),
        "weekly_progress": weekly,
        "materials_text": _materials_text(info, progress),
        "enrollment_note": _string(details.get("avaNote")),
        "detail_indexed": True,
        "detail_indexed_at": int(time.time()),
    })
    result.pop("raw_list", None)
    return result


def load_enriched_map() -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    if not ENRICHED_PATH.exists():
        return result
    for line in ENRICHED_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if item.get("id"):
            result[str(item["id"])] = item
    return result


def merge_enriched(courses: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    enriched = load_enriched_map()
    merged: list[dict[str, Any]] = []
    count = 0
    for course in courses:
        detail = enriched.get(course["id"])
        if detail:
            base = dict(course)
            base.update(detail)
            base["detail_indexed"] = True
            merged.append(base)
            count += 1
        else:
            merged.append(course)
    return merged, count


def append_enriched(course: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with ENRICHED_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(course, ensure_ascii=False, separators=(",", ":")) + "\n")


def append_failure(course_id: str, error: Exception) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with FAILED_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"id": course_id, "error": str(error), "at": int(time.time())}, ensure_ascii=False) + "\n")


def compact_enriched_file() -> int:
    data = load_enriched_map()
    if not data:
        return 0
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = ENRICHED_PATH.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        for course_id in sorted(data):
            handle.write(json.dumps(data[course_id], ensure_ascii=False, separators=(",", ":")) + "\n")
    tmp.replace(ENRICHED_PATH)
    return len(data)


def normalize_text(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).casefold()


def tokenize(value: Any) -> list[str]:
    text = normalize_text(value)
    latin = re.findall(r"[a-z0-9]+(?:[+#.-][a-z0-9]+)*", text)
    han_runs = re.findall(r"[\u3400-\u9fff]+", text)
    tokens = list(latin)
    for run in han_runs:
        tokens.extend(run)
        tokens.extend(run[i:i+2] for i in range(len(run) - 1))
    return list(dict.fromkeys(token for token in tokens if token.strip()))


def search_score(course: dict[str, Any], query: str) -> float:
    terms = tokenize(query)
    if not terms:
        return 0.0
    fields = [
        (5.0, f"{course.get('name','')} {course.get('name_en','')}"),
        (4.0, f"{course.get('course_code','')} {course.get('teacher','')} {course.get('teacher_en','')}"),
        (2.2, course.get("objective", "")),
        (1.6, course.get("weekly_progress", "")),
        (1.4, course.get("prerequisite", "")),
        (1.2, course.get("materials_text", "")),
        (1.1, " ".join(item.get("label", "") for item in course.get("relations") or [])),
        (1.0, " ".join(item.get("label", "") for item in course.get("teaching_methods") or [])),
        (1.0, " ".join(item.get("label", "") for item in course.get("assessments") or [])),
        (1.0, f"{course.get('department','')} {course.get('division','')} {course.get('class_group','')}"),
        (0.8, " ".join(item.get("label", "") for item in course.get("course_tags") or [])),
    ]
    score = 0.0
    for weight, field in fields:
        normalized = normalize_text(field)
        for term in terms:
            if term in normalized:
                score += weight
    full = normalize_text(" ".join(str(field) for _, field in fields))
    return score if all(term in full for term in terms) else 0.0


def counted_options(values: Iterable[Any]) -> list[dict[str, Any]]:
    counter = Counter(_string(value) for value in values if _string(value))
    return [{"value": value, "label": value, "count": count} for value, count in sorted(counter.items(), key=lambda pair: pair[0].casefold())]


def weighted_options(courses: list[dict[str, Any]], field: str) -> list[dict[str, Any]]:
    counter: Counter[tuple[str, str]] = Counter()
    for course in courses:
        for item in course.get(field) or []:
            if item.get("id"):
                counter[(str(item["id"]), _string(item.get("label")) or str(item["id"]))] += 1
    return [{"value": key, "label": label, "count": count} for (key, label), count in sorted(counter.items(), key=lambda row: row[0][1])]


def relation_options(courses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counter: Counter[tuple[str, str, str]] = Counter()
    for course in courses:
        for item in course.get("relations") or []:
            if item.get("id"):
                counter[(str(item["id"]), _string(item.get("label")) or str(item["id"]), _string(item.get("group")))] += 1
    return [{"value": key, "label": label, "group": group, "count": count} for (key, label, group), count in sorted(counter.items(), key=lambda row: row[0][1])]


def matches_weighted(course: dict[str, Any], field: str, selected: set[str], criterion: str, minimum: float) -> bool:
    if not selected:
        return True
    rows = course.get(field) or []
    if not rows:
        return False
    if criterion == "minimum":
        return any(str(item.get("id")) in selected and (_number(item.get("percent")) or 0) >= minimum for item in rows)
    maximum = max((_number(item.get("percent")) or 0) for item in rows)
    return any(str(item.get("id")) in selected and (_number(item.get("percent")) or 0) == maximum for item in rows)


def matches_assessment_style(course: dict[str, Any], style: str) -> bool:
    if style == "all":
        return True
    if not course.get("detail_indexed"):
        return False
    values = {str(item.get("id")): (_number(item.get("percent")) or 0) for item in course.get("assessments") or []}
    if style == "no_exams":
        return sum(values.get(item, 0) for item in ASSESSMENT_FAMILIES["exam"]) == 0
    totals = {family: sum(values.get(item, 0) for item in ids) for family, ids in ASSESSMENT_FAMILIES.items()}
    maximum = max(totals.values(), default=0)
    return maximum > 0 and totals.get(style, 0) == maximum


def matches_online(course: dict[str, Any], mode: str) -> bool:
    if mode == "all":
        return True
    value = course.get("online_teaching")
    if value is None:
        return False
    sync, async_mode = bool(value.get("sync")), bool(value.get("async"))
    if mode == "physical_only":
        return not sync and not async_mode
    if mode == "has_online":
        return sync or async_mode
    if mode == "sync":
        return sync
    if mode == "async":
        return async_mode
    if mode == "both":
        return sync and async_mode
    return True
