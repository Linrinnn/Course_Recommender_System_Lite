import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import build_pages


class PagesBuildTests(unittest.TestCase):
    def test_rewrite_index_injects_static_api(self):
        html = '<script src="/static/schedule-modal.js"></script><script type="module" src="/static/app.js"></script>'
        out = build_pages.rewrite_html(html)
        self.assertIn('./static/pages-api.js', out)
        self.assertIn('./static/pages-hotfix.js', out)
        self.assertIn('./static/schedule-modal.js', out)
        self.assertNotIn('./static/department-fix.js', out)

    def test_rewrite_schedule_injects_static_api(self):
        html = '<script type="module" src="/static/schedule.js"></script>'
        out = build_pages.rewrite_html(html, schedule=True)
        self.assertIn('./static/pages-api.js', out)
        self.assertIn('./static/schedule.js', out)

    def test_rewrite_html_cache_busts_static_assets(self):
        html = (
            '<link href="/static/styles.css" rel="stylesheet">'
            '<link href="/static/guided-ui.css" rel="stylesheet">'
            '<link href="/static/brand-mark.svg" rel="icon">'
            '<img src="/static/brand-mark.svg">'
            '<script src="/static/schedule-modal.js"></script>'
            '<script type="module" src="/static/app.js"></script>'
        )
        with patch.dict("os.environ", {"GITHUB_SHA": "fedcba9876543210"}):
            out = build_pages.rewrite_html(html)
        self.assertIn('styles.css?v=fedcba987654', out)
        self.assertIn('guided-ui.css?v=fedcba987654', out)
        self.assertIn('brand-mark.svg?v=fedcba987654', out)
        self.assertIn('app.js?v=fedcba987654', out)
        self.assertIn('pages-api.js?v=fedcba987654', out)
        self.assertIn('pages-hotfix.js?v=fedcba987654', out)

    def test_nested_schedule_module_import_has_deployment_version(self):
        with TemporaryDirectory() as folder:
            static = Path(folder) / "static"
            static.mkdir()
            (static / "schedule-modal.js").write_text(
                "frame.src = '/schedule?embed=1'", encoding="utf-8"
            )
            (static / "schedule.js").write_text(
                'import { a } from "./schedule-core.mjs"; location.href = "/";',
                encoding="utf-8",
            )
            (static / "app.js").write_text(
                'import { f } from "./filter-ui.mjs";',
                encoding="utf-8",
            )
            with patch.object(build_pages, "DIST", Path(folder)):
                with patch.dict("os.environ", {"GITHUB_SHA": "abc1234567890"}):
                    build_pages.patch_static_js()
            result = (static / "schedule.js").read_text(encoding="utf-8")
            self.assertIn('from "./schedule-core.mjs?v=abc123456789"', result)
            self.assertIn('location.href = "./";', result)
            app_js = (static / "app.js").read_text(encoding="utf-8")
            self.assertIn('from "./filter-ui.mjs?v=abc123456789"', app_js)

    @patch(
        'build_pages.load_department_reference',
        return_value=(
            {
                ('C', '01'): '中國文學系',
                ('D', '01'): '中國文學系',
                ('D', 'AT'): '體育室',
            },
            {'C': '進修部', 'D': '日間部'},
        ),
    )
    def test_department_prefix_is_normalized_from_compact_course_code(self, _reference):
        courses = [
            {'course_code': 'C010001466', 'department': '', 'department_code': '', 'division': '', 'division_code': ''},
            {'course_code': 'D010001234', 'department': '', 'department_code': '', 'division': '', 'division_code': ''},
            {'course_code': 'DAT0200009A', 'department': '', 'department_code': '', 'division': '', 'division_code': ''},
        ]
        build_pages.apply_department_reference(courses)

        self.assertEqual(courses[0]['division_code'], 'C')
        self.assertEqual(courses[0]['department_code'], '01')
        self.assertEqual(courses[0]['department'], '中國文學系')
        self.assertEqual(courses[0]['division'], '進修部')
        self.assertEqual(courses[2]['department_code'], 'AT')
        self.assertEqual(courses[2]['department'], '體育室')

        options = build_pages.department_options(courses)
        by_value = {item['value']: item for item in options}
        self.assertEqual(by_value['01']['label'], '01｜中國文學系')
        self.assertEqual(by_value['01']['count'], 2)
        self.assertEqual(by_value['AT']['label'], 'AT｜體育室')


if __name__ == '__main__':
    unittest.main()
