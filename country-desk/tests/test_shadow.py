import json, os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pipeline"))
import shadow as s

WORLD = [
    {"iso3": "GIN", "name": "Guinea", "names": ["Guinea", "Republic of Guinea"]},
    {"iso3": "GNQ", "name": "Equatorial Guinea", "names": ["Equatorial Guinea"]},
    {"iso3": "PNG", "name": "Papua New Guinea", "names": ["Papua New Guinea"]},
    {"iso3": "SDN", "name": "Sudan", "names": ["Sudan"]},
    {"iso3": "SSD", "name": "South Sudan", "names": ["South Sudan"]},
    {"iso3": "NER", "name": "Niger", "names": ["Niger"]},
    {"iso3": "NGA", "name": "Nigeria", "names": ["Nigeria"]},
]


class Matching(unittest.TestCase):
    def setUp(self):
        sup = s.superstrings(WORLD)
        self.t = {c["iso3"]: s.matcher(c, sup[c["iso3"]]) for c in WORLD}

    def test_longer_names_do_not_count(self):
        self.assertFalse(self.t["GIN"]("Marburg virus disease - Equatorial Guinea"))
        self.assertFalse(self.t["GIN"]("Cholera - Papua New Guinea"))
        self.assertTrue(self.t["GIN"]("Lassa fever - Guinea"))
        self.assertTrue(self.t["GIN"]("Ebola - Guinea and Equatorial Guinea"))
        self.assertFalse(self.t["SDN"]("Cholera - South Sudan"))
        self.assertTrue(self.t["SSD"]("Cholera - South Sudan"))

    def test_whole_words(self):
        self.assertFalse(self.t["NER"]("Lassa fever - Nigeria"))
        self.assertTrue(self.t["NGA"]("Lassa fever - Nigeria"))


class Tracss(unittest.TestCase):
    def test_average_level(self):
        data = {"countries": [{"iso": "AAA"}, {"iso": "BBB"}],
                "questions": [{"kind": "rating", "opts": ["A|x", "B|x", "C|x", "D|x", "E|x", "Not applicable"], "a": [0, 4]},
                              {"kind": "rating", "opts": ["A|x", "B|x", "C|x", "D|x", "E|x", "Not applicable"], "a": [5, 2]},
                              {"kind": "choice", "opts": ["Yes", "No"], "a": [0, 0]}],
                "docs": {"BBB": [["National action plan on AMR", "https://example.org/nap"]]}}
        self.assertEqual(s.tracss_slice("AAA", data)["avg"], 1.0)
        b = s.tracss_slice("BBB", data)
        self.assertEqual((b["avg"], b["n"], b["nap"]), (4.0, 2, "https://example.org/nap"))
        self.assertIsNone(s.tracss_slice("CCC", data))


class Sketch(unittest.TestCase):
    def test_only_sourced_statements_survive(self):
        reply = json.dumps({
            "snapshot": {"text": "A mixed public-private system.", "src": ["https://www.who.int/countries/gha/"]},
            "minister": {"name": "A. Minister", "role": "Minister of Health", "src": "https://moh.gov.example/minister"},
            "priorities": [{"title": "Insurance reform", "text": "Expanding coverage.", "src": "https://news.example/a"},
                           {"title": "Invented", "text": "Not in the search.", "src": "https://made-up.example/b"}],
            "netherlands": None})
        urls = {"https://who.int/countries/gha", "https://news.example/a"}
        sk = s.parse_sketch("Here you go:\n" + reply, urls, "2026-11-14")
        self.assertEqual(sk["snapshot"]["src"], ["https://who.int/countries/gha"])
        self.assertNotIn("minister", sk)
        self.assertEqual([p["title"] for p in sk["priorities"]], ["Insurance reform"])
        self.assertNotIn("netherlands", sk)

    def test_bad_json(self):
        self.assertIsNone(s.parse_sketch("no json here", set(), "2026-11-14"))


if __name__ == "__main__":
    unittest.main()
