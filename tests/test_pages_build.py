import unittest

import build_pages


class PagesBuildTests(unittest.TestCase):
    def test_rewrite_index_injects_static_api(self):
        html = '<script src="/static/schedule-modal.js"></script><script type="module" src="/static/app.js"></script>'
        out = build_pages.rewrite_html(html)
        self.assertIn('./static/pages-api.js', out)
        self.assertIn('./static/schedule-modal.js', out)

    def test_rewrite_schedule_injects_static_api(self):
        html = '<script type="module" src="/static/schedule.js"></script>'
        out = build_pages.rewrite_html(html, schedule=True)
        self.assertIn('./static/pages-api.js', out)
        self.assertIn('./static/schedule.js', out)


if __name__ == '__main__':
    unittest.main()
