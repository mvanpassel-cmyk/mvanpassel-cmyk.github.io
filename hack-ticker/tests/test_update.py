import os, sys, unittest
from datetime import datetime, timezone
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pipeline"))
import update  # noqa: E402

RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
<item><title>Hospital hit by ransomware &amp; diverts ambulances</title><link>https://ex.org/a</link>
<description>&lt;p&gt;Systems down&lt;/p&gt;</description><pubDate>Fri, 30 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>"""
ATOM = b"""<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Exchange drained</title>
<link rel="alternate" href="https://ex.org/b"/><summary>x</summary><updated>2026-10-29T08:00:00Z</updated></entry></feed>"""


class T(unittest.TestCase):
    def test_feeds(self):
        a = update.parse_feed(RSS)[0]
        self.assertEqual(a["title"], "Hospital hit by ransomware & diverts ambulances")
        self.assertEqual(a["summary"], "Systems down")
        self.assertEqual(update.parse_feed(ATOM)[0]["url"], "https://ex.org/b")

    def test_scales(self):
        self.assertEqual(update.impact_people(6_200_000), 3)
        self.assertEqual(update.impact_people(150_000_000), 5)
        self.assertEqual(update.impact_usd(6.3e9), 5)
        self.assertEqual(update.impact_usd(2e6), 2)
        self.assertEqual(update.region_of("nl"), "NL")
        self.assertEqual(update.region_of("DE"), "EU")
        self.assertEqual(update.region_of("US"), "World")

    def test_parse(self):
        now = datetime(2026, 10, 31, tzinfo=timezone.utc)
        cands = [{"source": "S", "url": "https://ex.org/a", "date": now, "title": "t", "summary": ""},
                 {"source": "S2", "url": "https://ex.org/c", "date": now, "title": "t2", "summary": ""}]
        txt = ('{"incidents":[{"i":[0],"same_as":null,"date":"2026-10-30","title":"Hospital hit","victim":"H",'
               '"country":"nl","sector":"Health","type":"Ransomware","impact":5,"people":null,"usd":null,'
               '"status":"claimed","summary":"s"},{"i":[1],"same_as":"x1","status":"confirmed","note":"Victim confirms"},{"i":[9]}]}')
        out = update.parse_incidents(txt, cands, {"x1"}, now)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["impact"], 5)  # impact is scored as if true
        self.assertEqual(out[0]["status"], "claimed")  # certainty is kept separately
        self.assertEqual(out[0]["region"], "NL")
        self.assertEqual(out[1]["same_as"], "x1")
        self.assertEqual(out[1]["status"], "confirmed")

    def test_similar(self):
        inc = [{"id": "a", "date": "2026-10-29", "victim": "Binance", "title": "Binance drained", "sources": []}]
        d = datetime(2026, 10, 29, tzinfo=timezone.utc)
        self.assertIsNotNone(update.similar(inc, "Binance CEX", d))
        self.assertIsNone(update.similar(inc, "Fence Finance", d))

    def test_csv(self):
        import csv, tempfile
        d = tempfile.mkdtemp()
        old, update.DATA = update.DATA, d
        try:
            update.write_csv([{"id": "a", "date": "2026-10-29", "impact": 5, "title": "T, with comma", "victim": "V",
                               "status": "confirmed", "sources": [{"name": "S", "url": "https://x"}],
                               "updates": [{"date": "2026-10-30", "kind": "restored", "text": "Back online"}]}])
            rows = list(csv.reader(open(os.path.join(d, "incidents.csv"), encoding="utf-8-sig")))
        finally:
            update.DATA = old
        self.assertEqual(rows[0][0], "id")
        self.assertEqual(rows[1][6], "T, with comma")
        self.assertEqual(rows[1][5], "Severe")

    def test_hack_words(self):
        self.assertTrue(update.HACK_WORDS.search("Groot datalek bij provider"))
        self.assertFalse(update.HACK_WORDS.search("New phone review"))


if __name__ == "__main__":
    unittest.main()
