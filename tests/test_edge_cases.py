import unittest

import catalog
import app


class AdvancedFilterEdgeCaseTests(unittest.TestCase):
    def test_room_options_count_each_course_once(self):
        courses = [
            {"meetings": [{"room": "SF123"}, {"room": "SF123"}]},
            {"meetings": [{"room": "SF123"}, {"room": "LM020"}]},
            {"meetings": [{"room": ""}]},
        ]
        options = {item["value"]: item["count"] for item in app._room_options(courses)}
        self.assertEqual(options, {"LM020": 1, "SF123": 2})

    def test_unindexed_course_is_not_treated_as_no_exam(self):
        course = {"detail_indexed": False, "assessments": []}
        self.assertFalse(catalog.matches_assessment_style(course, "no_exams"))

    def test_indexed_course_without_exam_methods_matches_no_exam(self):
        course = {"detail_indexed": True, "assessments": [{"id": "4", "percent": 100}]}
        self.assertTrue(catalog.matches_assessment_style(course, "no_exams"))


if __name__ == "__main__":
    unittest.main()
