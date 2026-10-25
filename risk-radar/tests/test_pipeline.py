"""Unit tests for the Risk Radar pipeline: parsing, deduplication, matching, update detection, scoring, data validity.

Run with:  python3 -m unittest discover -s risk-radar/tests
"""
import datetime as dt
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "pipeline"))
import ingest  # noqa: E402
import analysis  # noqa: E402

DATA = os.path.join(HERE, "..", "data")

RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Avian influenza A(H5N1) - Cambodia</title><link>https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON1</link>
<pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;A human case of &lt;b&gt;H5N1&lt;/b&gt;&lt;/p&gt;</description></item>
<item><title>Ebola virus disease - DRC</title><link>https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON2?utm_source=x</link></item>
</channel></rss>"""

ATOM = b"""<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title>
<entry><title>Rapid risk assessment: dengue</title><link rel="alternate" href="https://www.ecdc.europa.eu/en/publications-data/rra-dengue"/>
<updated>2026-10-21T08:00:00Z</updated><summary>Dengue in the EU/EEA</summary></entry></feed>"""

PAGE = """<html><body><a href="/en/Publications/GFSR/Issues/2026/10/13/global-financial-stability-report-october-2026">GFSR October 2026</a>
<a href="/en/Publications/GFSR/Issues/2026/04/14/global-financial-stability-report-april-2026">GFSR April 2026</a>
<a href="/en/about">About</a><p>Last updated: 24 October 2026</p></body></html>"""


class Parsing(unittest.TestCase):
    def test_rss(self):
        items = ingest.parse_feed(RSS)
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["published"], "2026-10-20T10:00:00Z")
        self.assertEqual(items[0]["summary"], "A human case of H5N1")
        self.assertIsNone(items[1]["published"])

    def test_atom(self):
        items = ingest.parse_feed(ATOM)
        self.assertEqual(items[0]["url"], "https://www.ecdc.europa.eu/en/publications-data/rra-dengue")
        self.assertEqual(items[0]["published"], "2026-10-21T08:00:00Z")

    def test_page_links(self):
        items = ingest.parse_page(PAGE, "https://www.imf.org/en/Publications/GFSR", r"/Publications/GFSR/Issues/20\d\d/")
        self.assertEqual([i["title"] for i in items], ["GFSR October 2026", "GFSR April 2026"])
        self.assertTrue(items[0]["url"].startswith("https://www.imf.org/en/Publications/GFSR/Issues/2026/10/13/"))

    def test_bad_xml_raises(self):
        with self.assertRaises(Exception):
            ingest.parse_feed(b"<html>not a feed")


class Dedup(unittest.TestCase):
    def test_url_normalisation(self):
        a = ingest.item_id("https://WWW.who.int/x/item/1/?utm_source=feed#top")
        b = ingest.item_id("https://www.who.int/x/item/1")
        self.assertEqual(a, b)

    def test_merge_skips_known_and_baseline_not_announced(self):
        src = {"id": "who-don"}
        items = ingest.parse_feed(RSS)
        signals, state = [], {}
        n = ingest.merge_items(src, items, state, signals, [], "2026-10-25T00:00:00Z", baseline=True)
        self.assertEqual(n, 0)
        self.assertTrue(all(s["baseline"] for s in signals))
        n2 = ingest.merge_items(src, items, state, signals, [], "2026-10-26T00:00:00Z", baseline=False)
        self.assertEqual(n2, 0, "re-reading the same feed must not create new signals")
        self.assertEqual(len(signals), 2)
        extra = [{"title": "New DON", "url": "https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON3", "summary": "", "published": None}]
        self.assertEqual(ingest.merge_items(src, extra, state, signals, [], "2026-10-27T00:00:00Z", baseline=False), 1)


class UpdateDetection(unittest.TestCase):
    def test_page_hash_ignores_cosmetic_changes(self):
        base = "https://www.imf.org/en/Publications/GFSR"
        pat = r"/Publications/GFSR/Issues/20\d\d/"
        h1 = ingest.content_hash(ingest.parse_page(PAGE, base, pat))
        changed = PAGE.replace("24 October 2026", "25 October 2026").replace("GFSR April 2026", "GFSR April 2026 (PDF)")
        h2 = ingest.content_hash(ingest.parse_page(changed, base, pat))
        self.assertEqual(h1, h2)
        added = PAGE.replace("<a href=\"/en/about\">", "<a href=\"/en/Publications/GFSR/Issues/2027/04/14/gfsr-april-2027\">GFSR April 2027</a><a href=\"/en/about\">")
        self.assertNotEqual(h1, ingest.content_hash(ingest.parse_page(added, base, pat)))

    def test_failed_source_keeps_items(self):
        # run_connector raising must be caught by main(); here we check the contract of merge on empty input
        signals = [{"id": "x", "source": "s", "detected": "2026-10-01T00:00:00Z"}]
        state = {"seen": ["x"]}
        ingest.merge_items({"id": "s"}, [], state, signals, [], "2026-10-25T00:00:00Z", baseline=False)
        self.assertEqual(len(signals), 1)


class Matching(unittest.TestCase):
    def setUp(self):
        self.m = ingest.build_matchers([
            {"id": "h5", "match": ["h5n1", "avian influenza"]},
            {"id": "amr", "match": ["amr", "antibiotic resistance"]},
            {"id": "war", "match": ["war"]},
        ])

    def test_matches_terms(self):
        self.assertEqual(ingest.match_risks("Avian influenza A(H5N1) - Cambodia", self.m), ["h5"])

    def test_word_boundaries(self):
        self.assertEqual(ingest.match_risks("Software update for hardware", self.m), [])
        self.assertEqual(ingest.match_risks("Global AMR report", self.m), ["amr"])
        self.assertEqual(ingest.match_risks("Post-war recovery", self.m), [], "hyphenated compounds are not matched")


class Scoring(unittest.TestCase):
    def risk(self, rid, groups, coding=None, dates=None):
        dates = dates or ["2026-06"] * len(groups)
        return {"id": rid, "coding": coding, "assessments": [
            {"independence": g, "method": "perception survey", "date": d, "quant": []} for g, d in zip(groups, dates)]}

    def test_attention_counts_independent_groups(self):
        r = self.risk("a", ["wef", "wef", "imf"])
        att = analysis.attention(r, dt.date(2026, 10, 25))
        self.assertEqual(att["independent"], 2)
        self.assertEqual(att["mentions"], 3)

    def test_attention_window(self):
        r = self.risk("a", ["wef", "imf"], dates=["2026-06", "2020-01"])
        self.assertEqual(analysis.attention(r, dt.date(2026, 10, 25), 730)["independent"], 1)

    def test_convergence_single_source_is_zero(self):
        self.assertEqual(analysis.convergence_index(self.risk("a", ["x"]), dt.date(2026, 10, 25)), 0.0)

    def test_mcda_unranked_when_missing(self):
        rs = [{"id": "a", "coding": {"impact": 3, "likelihood": 3, "confidence": 3, "preparedness": 3}},
              {"id": "b", "coding": {"impact": 1, "likelihood": 1, "confidence": 1, "preparedness": 1}},
              {"id": "c", "coding": {"impact": 3, "likelihood": None, "confidence": 3, "preparedness": 3}},
              {"id": "d", "coding": None}]
        order, scores, unranked = analysis.mcda(rs, {"impact": 1, "likelihood": 1, "confidence": 0, "preparedness": 0})
        self.assertEqual(order, ["a", "b"])
        self.assertEqual(sorted(unranked), ["c", "d"])
        order2, _, unranked2 = analysis.mcda(rs, {"impact": 1, "likelihood": 0, "confidence": 0, "preparedness": 0})
        self.assertIn("c", order2, "a risk is ranked when only criteria it has are weighted")

    def test_weights_change_order(self):
        rs = [{"id": "hi-impact", "coding": {"impact": 3, "likelihood": 1, "confidence": 2, "preparedness": 2}},
              {"id": "hi-likely", "coding": {"impact": 1, "likelihood": 3, "confidence": 2, "preparedness": 2}}]
        self.assertEqual(analysis.mcda(rs, {"impact": 3, "likelihood": 1})[0][0], "hi-impact")
        self.assertEqual(analysis.mcda(rs, {"impact": 1, "likelihood": 3})[0][0], "hi-likely")

    def test_sensitivity_deterministic(self):
        rs = [{"id": str(i), "coding": {"impact": 1 + i % 3, "likelihood": 1 + (i * 2) % 3, "confidence": 2, "preparedness": 2}} for i in range(5)]
        w = {"impact": 1, "likelihood": 1, "confidence": 1, "preparedness": 1}
        self.assertEqual(analysis.sensitivity(rs, w), analysis.sensitivity(rs, w))


class DataValidity(unittest.TestCase):
    def test_dataset_is_valid(self):
        risks = json.load(open(os.path.join(DATA, "risks.json"), encoding="utf-8"))["risks"]
        rel = json.load(open(os.path.join(DATA, "relations.json"), encoding="utf-8"))["relations"]
        src = json.load(open(os.path.join(DATA, "sources.json"), encoding="utf-8"))["sources"]
        self.assertEqual(analysis.validate(risks, rel, src), [])

    def test_validator_catches_problems(self):
        src = [{"id": "s"}]
        bad = [{"id": "x", "title": "t", "summary": "s", "kind": "doom", "domains": ["ai"], "geo": ["global"], "horizon": ["12m"],
                "assessments": [{"source": "nope", "url": "http://x", "date": "2026", "independence": "g", "quant": [{"value": 0, "unit": "", "measure": ""}]}]}]
        errs = analysis.validate(bad, [], src)
        self.assertTrue(any("unknown kind" in e for e in errs))
        self.assertTrue(any("unknown source" in e for e in errs))
        self.assertTrue(any("https" in e for e in errs))
        self.assertTrue(any("incomplete quantity" in e for e in errs))

    def test_no_zero_for_unquantified(self):
        risks = json.load(open(os.path.join(DATA, "risks.json"), encoding="utf-8"))["risks"]
        for r in risks:
            for a in r["assessments"]:
                for q in a["quant"]:
                    self.assertNotIn(q["value"], (0, "0", None))

    def test_curated_signals_reference_known_risks(self):
        risks = {r["id"] for r in json.load(open(os.path.join(DATA, "risks.json"), encoding="utf-8"))["risks"]}
        for s in json.load(open(os.path.join(DATA, "curated-signals.json"), encoding="utf-8"))["items"]:
            for rid in s["riskIds"]:
                self.assertIn(rid, risks, s["id"])


if __name__ == "__main__":
    unittest.main()
