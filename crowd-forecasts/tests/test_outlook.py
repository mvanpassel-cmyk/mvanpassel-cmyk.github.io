import os, sys, unittest
from datetime import datetime, timezone
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import outlook as o  # noqa: E402

NOW = datetime(2026, 11, 9, 5, 30, tzinfo=timezone.utc)


class T(unittest.TestCase):
    def test_upcoming_window(self):
        ev = [{"start": "2026-11-05", "end": "2026-11-20", "title": "COP31"}, {"start": "2026-11-01", "title": "Past"},
              {"start": "2026-11-18", "title": "APEC"}, {"start": "2027-03-01", "title": "Far"}]
        got = [e["title"] for e in o.upcoming(ev, NOW)]
        self.assertEqual(got, ["COP31", "APEC"])

    def test_prob(self):
        self.assertEqual(o.prob(0.65), 0.65)
        self.assertEqual(o.prob(65), 0.65)
        self.assertEqual(o.prob(1), 0.99)
        self.assertIsNone(o.prob("x"))

    def test_parse(self):
        self.assertEqual(o.parse('Here: ```json\n{"brief": "b", "events": []}\n``` done')["brief"], "b")
        self.assertIsNone(o.parse('{"events": [{"e": "cut off'))       # truncated reply
        self.assertIsNone(o.parse('{"other": 1}'))
        self.assertIsNone(o.parse("no json"))

    def test_settle_from_market_price(self):
        calls = [{"id": "a", "type": "market", "market": "m1", "by": "2026-11-05", "status": "open", "p": .7, "crowd": .6},
                 {"id": "b", "type": "market", "market": "m2", "by": "2026-11-05", "status": "open", "p": .3, "crowd": .4},
                 {"id": "c", "type": "market", "market": "m3", "by": "2026-11-20", "status": "open", "p": .5, "crowd": .5}]
        n = o.settle_from_markets(calls, {"items": [{"id": "m3", "prob": .99}]}, {"m1": [["2026-11-06", .985]], "m2": [["2026-11-06", .6]]}, NOW)
        self.assertEqual(n, 1)
        self.assertEqual([c["status"] for c in calls], ["yes", "open", "open"])   # m2 unclear, m3 not due

    def test_scoreboard(self):
        calls = [{"type": "market", "status": "yes", "p": .8, "crowd": .6}, {"type": "own", "status": "no", "p": .3},
                 {"type": "own", "status": "open", "p": .5, "by": "2026-11-20"}]
        s = o.scoreboard(calls)
        self.assertEqual(s["market"], {"n": 1, "claude": 0.04, "crowd": 0.16, "claude_closer": 1})
        self.assertEqual((s["own"]["n"], s["own"]["right"]), (1, 1))
        self.assertEqual(s["next_due"], "2026-11-20")

    def test_apply_keeps_only_known_ids_and_cited_urls(self):
        events = o.upcoming([{"start": "2026-11-18", "title": "APEC", "cat": "summit"}], NOW)
        mk = [{"id": "pm-1", "kind": "binary", "prob": .4, "resolves": "2026-11-30T00:00:00Z", "title": "Q?", "url": "u", "source": "polymarket"},
              {"id": "pm-2", "kind": "multi", "prob": .5, "resolves": "2026-11-30T00:00:00Z", "title": "M?", "url": "u", "source": "polymarket"}]
        reply = {"brief": "b", "events": [{"e": events[0]["id"], "expect": "x", "calls": [{"q": "Joint statement", "by": "2026-11-20", "p": 0.7},
                 {"q": "Old", "by": "2026-11-01", "p": .5}], "markets": ["pm-1", "nope"], "sources": ["https://a.org", "https://made-up.org"]},
                 {"e": "unknown", "expect": "y"}],
                 "odds": [{"m": "pm-1", "p": 0.55}, {"m": "pm-2", "p": 0.2}, {"m": "zz", "p": .1}]}
        calls = []
        out = o.apply(reply, events, mk, calls, {"https://a.org": "A"}, NOW)
        self.assertEqual(len(out["events"]), 1)
        e = out["events"][0]
        self.assertEqual([c["q"] for c in e["calls"]], ["Joint statement"])
        self.assertEqual(e["markets"], ["pm-1"])
        self.assertEqual(e["sources"], [{"url": "https://a.org", "title": "A"}])
        self.assertEqual(list(out["odds"]), ["pm-1"])                      # only yes/no markets get odds
        self.assertEqual(sorted(c["type"] for c in calls), ["market", "own"])
        o.apply(reply, events, mk, calls, {}, NOW)                            # same week again: no duplicates
        self.assertEqual(len(calls), 2)

    def test_due(self):
        self.assertTrue(o.due({}, NOW))
        self.assertFalse(o.due({"generated": "2026-11-05T05:30:00Z", "events": [1]}, NOW))
        self.assertTrue(o.due({"generated": "2026-11-05T05:30:00Z", "events": []}, NOW))   # an empty outlook is retried
        self.assertTrue(o.due({"generated": "2026-11-02T05:40:00Z", "events": [1]}, NOW))


if __name__ == "__main__":
    unittest.main()
