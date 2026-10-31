import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pipeline"))
import update  # noqa: E402

RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
<item><title>Treaty &amp; ocean</title><link>https://example.org/a?utm=1</link>
<description>&lt;p&gt;Big &lt;b&gt;news&lt;/b&gt;&lt;/p&gt;</description><pubDate>Fri, 30 Oct 2026 10:00:00 GMT</pubDate></item>
</channel></rss>"""
ATOM = b"""<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Moon</title>
<link rel="alternate" href="https://example.org/b"/><summary>Crew back</summary><updated>2026-10-29T08:00:00Z</updated></entry></feed>"""


class T(unittest.TestCase):
    def test_rss(self):
        it = update.parse_feed(RSS)[0]
        self.assertEqual(it["title"], "Treaty & ocean")
        self.assertEqual(it["summary"], "Big news")
        self.assertEqual(it["date"].day, 30)

    def test_atom(self):
        it = update.parse_feed(ATOM)[0]
        self.assertEqual(it["url"], "https://example.org/b")

    def test_key_ignores_query(self):
        self.assertEqual(update.key("https://example.org/a?utm=1"), update.key("https://EXAMPLE.org/a/"))

    def test_picks(self):
        txt = 'ok {"picks":[{"i":0,"score":91,"horizon":"centuries","theme":"Space","headline":"A","why":"B"},' \
              '{"i":0,"score":95,"horizon":"x","theme":"y","headline":"dup","why":"dup"},' \
              '{"i":1,"score":40,"horizon":"decades","theme":"Health","headline":"low","why":"low"},' \
              '{"i":9,"score":99,"horizon":"decades","theme":"Health","headline":"oob","why":"oob"}]}'
        p = update.parse_picks(txt, 3)
        self.assertEqual(len(p), 1)
        self.assertEqual(p[0]["horizon"], "centuries")

    def test_bad_json(self):
        self.assertEqual(update.parse_picks("no json here", 3), [])


if __name__ == "__main__":
    unittest.main()
