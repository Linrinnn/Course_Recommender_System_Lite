"""Headless visual and interaction regression for the approved course mockup.

Serves the actual static files, intercepts only the application API with
representative course data, and checks desktop/mobile layout in Chromium.
"""
import json
import os
import subprocess
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "visual-qa"
OUTPUT.mkdir(exist_ok=True)

COURSES = [
    {
        "id": "test-102", "name": "資料結構", "name_en": "Data Structures", "course_code": "CS102",
        "teacher": "陳老師", "department": "資訊工程學系", "department_code": "D12",
        "division": "日間部", "grade": 2, "class_group": "乙班",
        "credits": 3, "credits_number": 3, "required_elective": "選修",
        "study_level": "undergraduate", "detail_indexed": True,
        "meetings": [{"weekday": 2, "sections": ["D3", "D4"], "room": "ES101"}],
        "outline_url": "https://www.fju.edu.tw/", "course_tags": [],
    },
    {
        "id": "test-203", "name": "演算法", "course_code": "CS203", "teacher": "林老師",
        "department": "資訊工程學系", "department_code": "D12", "division": "日間部",
        "grade": 3, "class_group": "甲班", "credits": 3, "credits_number": 3,
        "required_elective": "必修", "study_level": "undergraduate", "detail_indexed": True,
        "meetings": [{"weekday": 3, "sections": ["D5", "D6"], "room": "ES302"}],
        "outline_url": "https://www.fju.edu.tw/", "course_tags": [],
    },
]
def opt(value, label=None, count=2):
    return {"value": value, "label": label or value, "count": count}

FACETS = {
    "departments": [opt("D12", "D12｜資訊工程學系")],
    "rooms": [opt("ES101"), opt("ES302")],
    "grades": [opt("2", "2 年級"), opt("3", "3 年級")],
    "classes": [opt("乙班"), opt("甲班")],
    "divisions": [opt("日間部")],
    "study_levels": [opt("undergraduate")],
    "sections": [opt("D3"), opt("D4"), opt("D5"), opt("D6")],
    "credits": [opt("3")], "required_elective": [opt("必修"), opt("選修")],
}
for key in ("course_tags","teaching_languages","material_languages","teaching_methods",
            "assessments","relations","teachers","course_relations"):
    FACETS[key] = []

META = {"academic_year": 115, "semester": 1, "course_count": 4854,
        "course_scope": "官方課綱查詢", "pages_mode": True, "detail_indexed": 4854}
OPTIONS = {"grades": FACETS["grades"], "classes": FACETS["classes"]}


def respond(route):
    url = route.request.url
    if "/api/meta" in url: body = META
    elif "/api/filter-options" in url: body = OPTIONS
    elif "/api/facets" in url: body = FACETS
    elif "/api/courses" in url:
        body = {"items": COURSES, "total": 2, "page": 1, "page_size": 25, "total_pages": 1}
    else:
        route.continue_()
        return
    route.fulfill(status=200, content_type="application/json; charset=utf-8", body=json.dumps(body,ensure_ascii=False))


def bounds(page, selector):
    return page.locator(selector).bounding_box(timeout=10000)


def run():
    from playwright.sync_api import sync_playwright
    server = subprocess.Popen(
        ["python", "-m", "http.server", "8765", "--bind", "127.0.0.1", "--directory", str(ROOT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
            desktop = browser.new_page(viewport={"width":1672,"height":941},device_scale_factor=1)
            errors=[]
            desktop.on("pageerror", lambda error: errors.append(str(error)))
            desktop.route("**/api/**", respond)
            desktop.goto("http://127.0.0.1:8765/static/index.html",wait_until="domcontentloaded")
            desktop.locator(".course-card").first.wait_for(timeout=20000)
            assert desktop.locator(".course-card").count() == 2
            nav,hero,guide = (bounds(desktop,s) for s in [".app-rail",".hero",".journey-intro"])
            left,results,right = (bounds(desktop,s) for s in ["#filterPanel","#resultsPanel",".planning-sidebar"])
            print("DESKTOP_LAYOUT", json.dumps({"nav":nav,"hero":hero,"steps":guide,"left":left,
                  "results":results,"right":right},ensure_ascii=False))
            assert nav["y"] <= 1 and 50 <= nav["height"] <= 70
            assert hero["y"] >= nav["height"]-3 and 170 <= hero["height"] <= 280
            assert guide["y"] >= hero["y"]+hero["height"]-2
            assert left["x"] < results["x"] < right["x"]
            assert 280 <= left["width"] <= 400
            assert 230 <= right["width"] <= 335
            assert not errors, "Browser runtime errors: "+str(errors)
            desktop.screenshot(path=str(OUTPUT/"course-desktop-1672.png"),full_page=True)
            desktop.locator("#navHelpBtn").click()
            assert desktop.locator("#siteHelpDialog").evaluate("(el) => el.open")
            desktop.locator("#closeSiteHelpBtn").click()
            desktop.locator("#sortSelect").select_option("name")
            desktop.locator("#favoritesTab").click()
            assert desktop.locator("#resultsHeading").inner_text() == "我的收藏"
            desktop.locator("#allCoursesTab").click()
            desktop.locator(".course-card").first.locator(".add-btn").click()
            assert desktop.locator("#scheduleCount").inner_text() == "1"
            mobile = browser.new_page(viewport={"width":390,"height":844},device_scale_factor=1,
                                      is_mobile=True,has_touch=True)
            mobile_errors=[]
            mobile.on("pageerror", lambda error: mobile_errors.append(str(error)))
            mobile.route("**/api/**", respond)
            mobile.goto("http://127.0.0.1:8765/static/index.html",wait_until="domcontentloaded")
            mobile.locator(".course-card").first.wait_for(timeout=20000)
            assert mobile.locator("#allCoursesTab").is_visible(), "Mobile must retain way back from favorites"
            assert mobile.locator("#mobileFiltersBtn").is_visible(), "Mobile filter trigger must be visible"
            mobile.locator("#mobileFiltersBtn").click()
            assert mobile.locator("body").evaluate("(el) => el.classList.contains('filters-open')")
            mobile.locator("#closeFiltersBtn").click()
            assert not mobile.locator("body").evaluate("(el) => el.classList.contains('filters-open')")
            assert not mobile_errors, "Mobile runtime errors: "+str(mobile_errors)
            mobile.screenshot(path=str(OUTPUT/"course-mobile-390.png"),full_page=True)
            print("VISUAL_QA_PASS desktop 1672x941 and mobile 390x844; interactions passed")
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)


if __name__ == "__main__":
    run()
