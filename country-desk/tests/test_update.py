import os, sys, unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pipeline"))
import update as u

KENYA = {"slug": "kenya", "name": "Kenya", "names": ["Kenya", "Kenyan", "Nairobi"], "terms": ["Duale", "SHA"]}


class Relevance(unittest.TestCase):
    def test_needs_health_and_country(self):
        self.assertTrue(u.relevant("Kenya reports three weeks without new Ebola cases", KENYA))
        self.assertTrue(u.relevant("Duale unveils plan for national health data centre", KENYA))
        self.assertFalse(u.relevant("Kenya wins rugby sevens title", KENYA))
        self.assertFalse(u.relevant("Bangladesh health minister accepts blame for measles outbreak", KENYA))

    def test_names_are_whole_words(self):
        self.assertFalse(u.relevant("Shanghai hospital opens new wing", KENYA))


class Dates(unittest.TestCase):
    def test_stale_by_url(self):
        self.assertTrue(u.stale_by_url("https://x.org/news/2026/05/22/ebola-cases", "2026-11-09"))
        self.assertFalse(u.stale_by_url("https://x.org/news/2026/11/05/ebola-cases", "2026-11-09"))
        self.assertFalse(u.stale_by_url("https://x.org/news/ebola-cases-5664656", "2026-11-09"))

    def test_wb_date(self):
        self.assertEqual(u.wb_date("3/31/2027 12:00:00 AM"), "2027-03-31")
        self.assertEqual(u.wb_date("2027-03-31T00:00:00Z"), "2027-03-31")
        self.assertEqual(u.wb_date(None), "")

    def test_digest_runs_every_other_day(self):
        d = datetime(2026, 11, 13, 6, tzinfo=timezone.utc)
        self.assertTrue(u.digest_due({}, d))
        self.assertFalse(u.digest_due({"digest_date": "2026-11-13"}, d))
        self.assertFalse(u.digest_due({"digest_date": "2026-11-12"}, d))
        self.assertTrue(u.digest_due({"digest_date": "2026-11-11"}, d))
        self.assertTrue(u.digest_due({"digest_date": "2026-11-12"}, d, force=True))


class Digest(unittest.TestCase):
    ITEMS = [{"title": "A", "url": "https://a.example/1", "src": "A News", "date": "2026-11-09"},
             {"title": "B", "url": "https://b.example/2", "src": "B News", "date": "2026-11-10"}]

    def test_every_statement_needs_a_real_headline(self):
        text = ('Here you go: {"highlights":[{"i":[0,9],"headline":"Real","why":"Because."},'
                '{"i":[7],"headline":"Invented","why":"No source."}],'
                '"moves":[{"i":1,"what":"Ministry did a thing."},{"i":5,"what":"Made up."}],"watch":"Next week."}')
        d = u.parse_digest(text, self.ITEMS, "2026-11-10")
        self.assertEqual([h["headline"] for h in d["highlights"]], ["Real"])
        self.assertEqual(d["highlights"][0]["sources"][0]["url"], "https://a.example/1")
        self.assertEqual([m["url"] for m in d["moves"]], ["https://b.example/2"])

    def test_bad_reply_is_rejected(self):
        self.assertIsNone(u.parse_digest("Sorry, I cannot.", self.ITEMS, "2026-11-10"))

    def test_moves_roll_off_and_do_not_repeat(self):
        now = datetime(2026, 11, 10, tzinfo=timezone.utc)
        old = [{"date": "2026-06-01", "what": "old", "url": "u1", "src": ""}, {"date": "2026-11-01", "what": "kept", "url": "u2", "src": ""}]
        new = [{"date": "2026-11-09", "what": "new", "url": "u3", "src": ""}, {"date": "2026-11-01", "what": "dup", "url": "u2", "src": ""}]
        self.assertEqual([m["url"] for m in u.merge_moves(old, new, now)], ["u3", "u2"])


class Slices(unittest.TestCase):
    def test_title_key_ignores_publisher(self):
        self.assertEqual(u.title_key("Kenya nears Ebola-free status - The Standard"), u.title_key("Kenya nears Ebola-free status | KBC"))

    def test_jee_groups_by_area_letter(self):
        a = {"evaluations": [{"country": "Kenya", "year": 2024, "edition": 3, "libraryUrl": "x",
                              "scores": {"P1.1": [1, 3], "P2.1": [3, 4], "D1.1": [4, 9], "PoE3": [2, 8]}}]}
        j = u.jee_slice(KENYA, a)
        self.assertEqual(j["areas"], {"D": 4.0, "P": 2.0, "PoE": 2.0})
        self.assertEqual(j["lowest"], ["P1.1", "PoE3"])

    def test_alt_names_match_in_nphi_and_jee(self):
        c = {"name": "DR Congo", "alt_names": ["Dem. Rep. Congo"]}
        rows = u.nphi_slice(c, [{"title": "t", "partners": ["Dem. Rep. Congo"], "actorCountry": "Netherlands", "start": 2024}])
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["nl"])
        a = {"evaluations": [{"country": "Dem. Rep. Congo", "year": 2023, "edition": 2, "libraryUrl": "x", "scores": {"P1.1": [2, 3]}}]}
        self.assertIsNotNone(u.jee_slice(c, a))


if __name__ == "__main__":
    unittest.main()
