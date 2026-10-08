"""Server search regression: exclusion must happen before pagination."""
import unittest
from unittest.mock import AsyncMock, patch

from httpx import ASGITransport, AsyncClient

from app import app


def sample(course_id, day=None, sections=None):
    return {
        "id": course_id, "name": "課程 " + course_id,
        "name_en": "", "department": "資訊工程學系",
        "course_code": "D12" + course_id, "teacher": "甲",
        "credits_number": 3, "required_elective": "選修",
        "meetings": [{"weekday": day, "sections": sections or []}] if day else [],
        "course_tags": [], "relations": [], "teaching_methods": [], "assessments": [],
        "online_teaching": None, "detail_indexed": False,
    }


class ConflictFilterTests(unittest.IsolatedAsyncioTestCase):
    async def test_exclude_before_counting_and_pagination(self):
        items = [
            sample("1", 1, ["D1", "D2"]),
            sample("2", 2, ["D1"]),
            sample("3", 1, ["D3"]),
            sample("4"),
        ]
        with patch("app._load_courses", new=AsyncMock(return_value=items)):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get(
                    "/api/courses", params={"exclude_slots": "1:D1,1:D2", "page_size": 2}
                )
                self.assertEqual(response.status_code, 200)
                data = response.json()
                self.assertEqual(data["total"], 3)
                self.assertEqual(data["total_pages"], 2)
                self.assertEqual({item["id"] for item in data["items"]}, {"2", "3"})

    async def test_bad_exclusion_ignored_and_other_weekday_untouched(self):
        items = [sample("1", 1, ["D1"]), sample("2", 2, ["D1"])]
        with patch("app._load_courses", new=AsyncMock(return_value=items)):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get(
                    "/api/courses", params={"exclude_slots": "invalid,2:D1"}
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual([c["id"] for c in response.json()["items"]], ["1"])


if __name__ == "__main__":
    unittest.main()
