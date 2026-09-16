import unittest
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
