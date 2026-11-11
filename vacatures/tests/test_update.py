import datetime as dt
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import update as u  # noqa: E402

TODAY = dt.date(2026, 11, 11)
CFG = json.loads((ROOT / "data" / "sources.json").read_text(encoding="utf-8"))
RULES = u.compile_rules(CFG)

PAGE = """<html><head><title>Expert curriculum &amp; toetsing (24-40 uur) — SLO — AcademicTransfer</title></head>
<body><h1>Expert curriculum &amp; toetsing (24-40 uur)</h1>
<div>Deadline 25 nov ’26</div><div>9 nov ’26 gepubliceerd</div>
<dl><dt>Aantal uren per week</dt><dd>24—40 uur per week</dd>
<dt>Salarisindicatie</dt><dd>€3562—€5014 per maand</dd>
<dt>Locatie</dt><dd>Stationsplein, 3818 LE, Amersfoort</dd></dl>
<script>var x = "Deadline 1 jan ’99";</script></body></html>"""

SITEMAP = """<urlset>
<url><loc>https://www.academictransfer.com/en/jobs/365423/expert-curriculum-toetsing-24-40-uur/</loc></url>
<url><loc>https://www.academictransfer.com/nl/jobs/365423/expert-curriculum-toetsing-24-40-uur/</loc></url>
<url><loc>https://www.academictransfer.com/en/jobs/365500/pabo-docent-rekenen-wiskunde/</loc></url>
<url><loc>https://www.academictransfer.com/en/jobs/365600/pabo-lerarenopleider-didactiek/</loc></url>
<url><loc>https://www.academictransfer.com/en/jobs/365700/postdoc-hydrogen-aircraft/</loc></url>
</urlset>"""

PAGES = {
    "https://www.academictransfer.com/en/jobs/365500/pabo-docent-rekenen-wiskunde/":
        PAGE.replace("Expert curriculum &amp; toetsing (24-40 uur) — SLO", "Docent rekenen-wiskunde pabo — Basisschool De Regenboog"),
    "https://www.academictransfer.com/nl/jobs/365423/expert-curriculum-toetsing-24-40-uur/": PAGE,
    "https://www.academictransfer.com/en/jobs/365600/pabo-lerarenopleider-didactiek/":
        PAGE.replace("Expert curriculum &amp; toetsing (24-40 uur) — SLO", "Lerarenopleider pabo — Hogeschool X")
            .replace("Amersfoort", "'s-Gravenhage"),
}


def fake_fetch(url, timeout=30):
    if url.endswith("sitemap-vacancies.xml"):
        return SITEMAP
    return PAGES[url]


class DatesAndText(unittest.TestCase):
    def test_dutch_date(self):
        self.assertEqual(u.parse_nl_date("22", "nov", "26"), dt.date(2026, 11, 22))
        self.assertEqual(u.parse_nl_date("5", "mrt", "26"), dt.date(2026, 3, 5))
        self.assertIsNone(u.parse_nl_date("5", "xyz", "26"))

    def test_city_from_address(self):
        self.assertEqual(u.city_from_address("Stationsplein, 3818 LE, Amersfoort"), "Amersfoort")
        self.assertEqual(u.city_from_address("Laan van Nieuw Oost-Indië 300, 2593CE, 's-Gravenhage"), "Den Haag")
        self.assertIsNone(u.city_from_address(None))


class Parsing(unittest.TestCase):
    def test_parse_page(self):
        rec = u.parse_academictransfer(PAGE, "https://x/y", TODAY)
        self.assertEqual(rec["title"], "Expert curriculum & toetsing (24-40 uur)")
        self.assertEqual(rec["employer"], "SLO")
        self.assertEqual(rec["deadline"], "2026-11-25")
        self.assertEqual(rec["published"], "2026-11-09")
        self.assertEqual(rec["hours"], [24.0, 40.0])
        self.assertEqual(rec["salary"], "€ 3.562 – € 5.014 per maand")
        self.assertEqual(rec["city"], "Amersfoort")

    def test_script_content_is_ignored(self):
        rec = u.parse_academictransfer(PAGE, "https://x/y", TODAY)
        self.assertNotEqual(rec["deadline"], "2099-01-01")

    def test_relative_publication(self):
        page = PAGE.replace("9 nov ’26 gepubliceerd", "gisteren gepubliceerd")
        self.assertEqual(u.parse_academictransfer(page, "u", TODAY)["published"], "2026-11-10")

    def test_unknown_page_is_none(self):
        self.assertIsNone(u.parse_academictransfer("<title>Iets anders</title>", "u", TODAY))


class Filtering(unittest.TestCase):
    def test_classroom_roles_are_dropped(self):
        for t in ["Leraar basisonderwijs", "Docent Klinische psychologie", "Groepsleerkracht groep 5",
                  "Medewerker onderwijsadministratie", "Docent wiskunde"]:
            self.assertFalse(u.accept_title(t, RULES), t)

    def test_pabo_docent_depends_on_employer(self):
        self.assertTrue(u.accept_title("Docent rekenen-wiskunde pabo", RULES, "Hogeschool Windesheim"))
        self.assertTrue(u.accept_title("Pabo docent", RULES, "Universiteit Utrecht"))
        self.assertFalse(u.accept_title("Pabo docent", RULES, "Stichting Basisonderwijs Noord"))
        self.assertFalse(u.accept_title("(ZZP) Pabo docent", RULES, None))

    def test_relevant_roles_are_kept(self):
        for t in ["Lerarenopleider Pabo", "Universitair docent Onderwijswetenschappen",
                  "Docent-onderzoeker lerarenopleiding", "Onderwijsadviseur", "Opleidingsmanager Pabo"]:
            self.assertTrue(u.accept_title(t, RULES), t)

    def test_slug_filter(self):
        self.assertTrue(RULES["include"].search("pabo-lerarenopleider-didactiek"))
        self.assertFalse(RULES["include"].search("postdoc-hydrogen-aircraft"))

    def test_topics(self):
        self.assertIn("pabo", u.topics_for("Lerarenopleider Pabo"))
        self.assertIn("onderwijsadvies", u.topics_for("Onderwijsadviseur"))
        self.assertEqual(u.topics_for("Iets heel anders"), ["overig"])


class Crawl(unittest.TestCase):
    def test_new_records_and_rejections(self):
        rejected = {}
        new, seen, found = u.crawl_academictransfer(
            CFG["sources"][0], RULES, {}, rejected, TODAY, fetch=fake_fetch, sleep=lambda s: None)
        ids = sorted(r["id"] for r in new)
        self.assertEqual(ids, ["at-365423", "at-365600"])
        self.assertIn("at-365500", rejected)           # docent voor de klas: buiten bereik
        self.assertNotIn("at-365700", seen)            # slug past niet
        self.assertEqual(found, 3)
        city = {r["id"]: r["city"] for r in new}
        self.assertEqual(city["at-365600"], "Den Haag")

    def test_crawl_delay_is_respected(self):
        calls = []
        u.crawl_academictransfer(CFG["sources"][0], RULES, {}, {}, TODAY, fetch=fake_fetch,
                                 sleep=lambda s: calls.append(s))
        self.assertEqual(calls, [10, 10])  # drie pagina's, dus twee pauzes van 10 seconden

    def test_known_ids_are_not_refetched(self):
        existing = {"at-365423": {"id": "at-365423", "source": "AcademicTransfer"}}
        new, _seen, _found = u.crawl_academictransfer(
            CFG["sources"][0], RULES, existing, {}, TODAY, fetch=fake_fetch, sleep=lambda s: None)
        self.assertEqual([r["id"] for r in new], ["at-365600"])


class State(unittest.TestCase):
    def test_closed_early_flag(self):
        items = [
            {"id": "at-1", "source": "AcademicTransfer", "deadline": "2026-11-30", "in_sitemap": True, "closed_early": False},
            {"id": "at-2", "source": "AcademicTransfer", "deadline": "2026-10-01", "in_sitemap": True, "closed_early": False},
            {"id": "at-3", "source": "AcademicTransfer", "deadline": "2026-11-30", "in_sitemap": True, "closed_early": False},
            {"id": "eur-1", "source": "Erasmus Universiteit", "deadline": "2026-11-30", "in_sitemap": None, "closed_early": False},
        ]
        u.apply_closed_state(items, {"at-3"}, TODAY)
        self.assertTrue(items[0]["closed_early"])      # weg vóór sluitdatum
        self.assertFalse(items[1]["closed_early"])     # gewoon verlopen
        self.assertFalse(items[2]["closed_early"])     # nog in de sitemap
        self.assertFalse(items[3]["closed_early"])     # andere bron blijft ongemoeid

    def test_archive_requests_are_limited_and_recorded(self):
        items = [{"id": f"x{i}", "url": f"https://x/{i}", "deadline": f"2026-0{i % 9 + 1}-01"} for i in range(15)]
        n = u.archive_pending(items, TODAY, requester=lambda url: True, sleep=lambda s: None)
        self.assertEqual(n, u.MAX_ARCHIVE_PER_RUN)
        done = [i for i in items if i.get("archive_requested")]
        self.assertEqual(len(done), u.MAX_ARCHIVE_PER_RUN)
        self.assertTrue(done[0]["archive_url"].startswith("https://web.archive.org/web/"))

    def test_failed_archive_is_retried_next_time(self):
        items = [{"id": "a", "url": "https://x/a", "deadline": "2026-11-01"}]
        u.archive_pending(items, TODAY, requester=lambda url: False, sleep=lambda s: None)
        self.assertFalse(items[0].get("archive_requested"))


class Rss(unittest.TestCase):
    FEED = """<rss><channel>
    <item><title>Lerarenopleider Pabo</title><link>https://h.nl/1</link><pubDate>Mon, 09 Nov 2026 08:00:00 GMT</pubDate></item>
    <item><title>Leraar groep 3</title><link>https://h.nl/2</link></item>
    <item><title>Kok</title><link>https://h.nl/3</link></item></channel></rss>"""

    def test_rss_filtering(self):
        cfg = {"name": "Test", "url": "u", "title_filter": "pabo|leraar", "employer": "Hogeschool X", "city": "Zwolle"}
        rejected = {}
        new, _seen, found = u.crawl_rss(cfg, RULES, {}, rejected, TODAY, fetch=lambda url: self.FEED)
        self.assertEqual([r["title"] for r in new], ["Lerarenopleider Pabo"])
        self.assertEqual(found, 3)
        self.assertEqual(len(rejected), 2)


class Dataset(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = json.loads((ROOT / "data" / "vacancies.json").read_text(encoding="utf-8"))
        cls.employers = json.loads((ROOT / "data" / "employers.json").read_text(encoding="utf-8"))["employers"]

    def test_unique_ids_and_required_fields(self):
        ids = [i["id"] for i in self.doc["items"]]
        self.assertEqual(len(ids), len(set(ids)))
        for it in self.doc["items"]:
            for key in ("id", "source", "url", "title", "employer", "topics"):
                self.assertTrue(it.get(key), f"{it.get('id')}: {key} ontbreekt")
            self.assertTrue(it["url"].startswith("https://"))
            for d in ("published", "deadline"):
                if it.get(d):
                    dt.date.fromisoformat(it[d])

    def test_every_vacancy_has_coordinates_when_city_known(self):
        for it in self.doc["items"]:
            if u.coords_for(it.get("city")):
                self.assertIn("lat", it, it["id"])

    def test_employer_keys_exist(self):
        for it in self.doc["items"]:
            key = it.get("employer_key")
            if key:
                self.assertIn(key, self.employers)

    def test_employer_profiles_have_sources(self):
        for key, prof in self.employers.items():
            for r in prof.get("ratings", []):
                self.assertTrue(r["url"].startswith("https://"), key)
                self.assertTrue(r["source"], key)
            for n in prof.get("news", []):
                self.assertTrue(n["url"].startswith("https://"), key)

    def test_employer_matching(self):
        self.assertEqual(u.employer_key("Radboud Universiteit (Faculteit der Sociale Wetenschappen)", self.employers), "radboud")
        self.assertEqual(u.employer_key("Radboudumc", self.employers), "radboudumc")
        self.assertEqual(u.employer_key("SLO", self.employers), "slo")
        self.assertIsNone(u.employer_key("Slovenië Instituut", self.employers))


if __name__ == "__main__":
    unittest.main()
