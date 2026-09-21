import unittest
from unittest.mock import AsyncMock, patch

import catalog


class CatalogTests(unittest.TestCase):
    def test_list_row_normalization(self):
        row = {"jonCouSn": 123, "avaNO": "CS101", "couCNa": "程式設計", "couENa": "Programming", "tchCNa": "王老師", "credit": "3", "reqSelCNa": "選修", "dptGrdCN": "資訊工程學系二甲", "dayCNa": "日間部", "seqList": [{"couWek": 3, "section": "D5,D6", "romNO": "SF123-教室"}]}
        course = catalog.normalize_list_row(row)
        self.assertEqual(course["id"], "123")
        self.assertEqual(course["department"], "資訊工程學系")
        self.assertEqual(course["grade"], 2)
        self.assertEqual(course["class_group"], "甲班")
        self.assertEqual(course["meetings"][0]["sections"], ["D5", "D6"])
        self.assertEqual(course["meetings"][0]["room"], "SF123")
        self.assertEqual(course["credits_number"], 3.0)

    def test_search_score_requires_all_query_terms(self):
        course = catalog.normalize_list_row({"jonCouSn": 1, "couCNa": "人工智慧導論", "tchCNa": "陳老師", "dptGrdCN": "資訊工程學系"})
        self.assertGreater(catalog.search_score(course, "人工智慧"), 0)
        self.assertGreater(catalog.search_score(course, "人工 陳老師"), 0)
        self.assertEqual(catalog.search_score(course, "人工 法律"), 0)

    def test_weighted_filter(self):
        course = {"teaching_methods": [{"id": "1", "percent": 60}, {"id": "2", "percent": 40}]}
        self.assertTrue(catalog.matches_weighted(course, "teaching_methods", {"1"}, "dominant", 20))
        self.assertFalse(catalog.matches_weighted(course, "teaching_methods", {"2"}, "dominant", 20))
        self.assertTrue(catalog.matches_weighted(course, "teaching_methods", {"2"}, "minimum", 30))

    def test_online_filter(self):
        course = {"online_teaching": {"sync": True, "async": False}}
        self.assertTrue(catalog.matches_online(course, "has_online"))
        self.assertTrue(catalog.matches_online(course, "sync"))
        self.assertFalse(catalog.matches_online(course, "physical_only"))


class EnrichmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_enrichment_maps_original_fields(self):
        base = catalog.normalize_list_row({"jonCouSn": 99, "couCNa": "測試課", "tchCNa": "老師", "dptGrdCN": "資訊工程學系二甲"})
        responses = {
            catalog.DETAIL_ENDPOINTS["course_details"]: {"result": {"jonCouSn": 99, "couCNa": "測試課", "tchCNa": "老師", "tchNo": "T1", "teaLangCNa": "英語", "teaMaterCNa": "英文"}},
            catalog.DETAIL_ENDPOINTS["relations"]: {"result": [{"coreNo": 10, "itemNo": 1, "itemName": "SDG", "relation": 3}]},
            catalog.DETAIL_ENDPOINTS["info_and_book"]: {"result": {"obj": "學會測試", "preCourse": "程式設計", "book": "教材"}},
            catalog.DETAIL_ENDPOINTS["course_progress"]: {"result": {"weeklyCP": [{"theme": "單元一", "syncOnlineClassHr": 1, "asyncOnlineClassHr": 0}]}},
            catalog.DETAIL_ENDPOINTS["methods"]: {"result": [{"mType": 1, "methodsDetails": [{"methodSN": 2, "methodName": "討論", "percent": 60}]}, {"mType": 2, "methodsDetails": [{"methodSN": 4, "methodName": "報告", "percent": 100}]}]},
            catalog.DETAIL_ENDPOINTS["tch_leaves"]: {"result": [{"cweek": 3, "note": "補課"}]},
        }

        async def fake_fetch(endpoint, **params):
            return responses[endpoint]

        with patch("catalog.fetch_json", new=AsyncMock(side_effect=fake_fetch)):
            detail = await catalog.enrich_course(base)
        self.assertEqual(detail["teaching_language"], "英語")
        self.assertEqual(detail["material_language"], "英文")
        self.assertEqual(detail["prerequisite"], "程式設計")
        self.assertTrue(detail["online_teaching"]["sync"])
        self.assertEqual(detail["teaching_methods"][0]["label"], "討論")
        self.assertEqual(detail["assessments"][0]["label"], "報告")
        self.assertEqual(detail["relations"][0]["group"], "sdgs")
        self.assertEqual(detail["makeup_classes"][0]["note"], "補課")
        self.assertEqual(detail["materials"]["textbook"], "教材")


if __name__ == "__main__":
    unittest.main()
