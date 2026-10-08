"""Regression guards for the redesigned static UI.

The browser scripts rely on stable element IDs; these tests catch accidental
removal or duplication before Pages deploys an unusable page.
"""
from html.parser import HTMLParser
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"


class IdParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.tag_by_id = {}

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        identifier = attr.get("id")
        if identifier:
            self.ids.append(identifier)
            self.tag_by_id[identifier] = tag


class UIWorkspaceTests(unittest.TestCase):
    def test_search_page_preserves_all_operational_controls(self):
        html = (STATIC / "index.html").read_text(encoding="utf-8")
        parsed = IdParser()
        parsed.feed(html)
        self.assertEqual(len(parsed.ids), len(set(parsed.ids)), "Duplicate ID in search page")
        required = {
            "openScheduleBtn", "scheduleCount", "refreshBtn",
            "filterPanel", "filterBackdrop", "mobileFiltersBtn", "closeFiltersBtn",
            "searchInput", "searchBtn", "departmentSelect", "weekdaySelect",
            "sectionSelect", "roomSelect", "creditsSelect", "reqSelect",
            "advancedFilters", "advancedCount", "applyFiltersBtn",
            "resetFiltersBtn", "sectionChips", "activeFilterText",
            "courseList", "courseTemplate", "prevPageBtn", "nextPageBtn",
            "resultCount", "pageText", "status", "detailDialog", "detailTitle",
            "detailContent", "closeDetailBtn", "enrichedCoverageText",
            "favoriteCount", "favoritesTab", "allCoursesTab", "conflictFreeBtn",
            "gradeChips", "weekdayChips", "classSelect", "studyLevelSelect",
            "divisionSelect", "departmentLookup", "departmentSuggestions",
            "roomLookup", "roomSuggestions",
        }
        self.assertFalse(required.difference(parsed.ids))
        self.assertEqual(parsed.tag_by_id["filterPanel"], "aside")
        self.assertEqual(parsed.tag_by_id["resultsPanel"], "section")
        self.assertEqual(parsed.tag_by_id["mobileFiltersBtn"], "button")
        self.assertIn('class="workspace-layout"', html)
        self.assertIn('class="favorite-btn"', html)
        self.assertNotIn('class="compare-btn secondary"', html)
        self.assertNotIn('id="compareDialog"', html)
        self.assertNotIn('id="savedViewsSelect"', html)
        self.assertIn('id="gradeChips"', html)
        self.assertIn('id="weekdayChips"', html)
        self.assertIn('id="roomLookup"', html)

    def test_schedule_preserves_slot_controls(self):
        html = (STATIC / "schedule.html").read_text(encoding="utf-8")
        parsed = IdParser()
        parsed.feed(html)
        self.assertEqual(len(parsed.ids), len(set(parsed.ids)))
        for required in (
            "planSelect", "addPlanBtn", "renamePlanBtn", "deletePlanBtn",
            "clearPlanBtn", "timetableWrap", "slotSearchPanel", "slotResults",
            "slotKeyword", "slotSearchBtn", "backToSearchBtn",
        ):
            self.assertIn(required, parsed.ids)

    def test_mobile_filter_styles_and_handlers_are_present(self):
        css = (STATIC / "styles.css").read_text(encoding="utf-8")
        js = (STATIC / "app.js").read_text(encoding="utf-8")
        self.assertIn(".filters-open .search-panel", css)
        self.assertIn("@media (max-width: 900px)", css)
        self.assertIn("setFilterPanelOpen", js)
        self.assertIn('$("#mobileFiltersBtn").addEventListener', js)
        self.assertIn('$("#filterBackdrop").addEventListener', js)

    def test_pages_hotfix_does_not_overwrite_navigation(self):
        js = (STATIC / "pages-hotfix.js").read_text(encoding="utf-8")
        self.assertNotIn("scheduleButton.innerHTML", js)
        self.assertNotIn("setText(refreshButton", js)


if __name__ == "__main__":
    unittest.main()
