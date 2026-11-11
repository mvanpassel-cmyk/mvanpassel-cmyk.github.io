import os, sys, unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pipeline"))
import talk  # noqa: E402


class TestTalk(unittest.TestCase):
    def test_extract_text_keeps_paragraphs_and_skips_nav(self):
        page = ("<html><nav><p>Home News About Contact and more navigation text here please</p></nav>"
                "<article><p>" + "The WHO said financing fell sharply this year. " * 3 + "</p>"
                "<p>Subscribe to our newsletter</p><script>var x='<p>no</p>'</script></article></html>")
        t = talk.extract_text(page)
        self.assertIn("financing fell", t)
        self.assertNotIn("navigation", t)
        self.assertNotIn("newsletter", t)

    def test_clean_message(self):
        self.assertEqual(talk.clean_message("B: I'm not convinced. [END]"), ("I'm not convinced.", True))
        self.assertEqual(talk.clean_message("**Fair** point."), ("Fair point.", False))

    def test_parse_pick(self):
        self.assertEqual(talk.parse_pick('Sure: {"i": 2, "why": "Because."}', 5), (2, "Because."))
        with self.assertRaises(RuntimeError):
            talk.parse_pick('{"i": 9}', 5)

    def test_candidates_filters(self):
        now = datetime(2026, 11, 11, tzinfo=timezone.utc)
        feed = {"items": [
            {"title": "WHO budget cut", "url": "https://a/1", "date": "2026-11-10T00:00:00+00:00", "score": 5},
            {"title": "Public Health Officer (P4) vacancy", "url": "https://a/2", "date": "2026-11-10T00:00:00+00:00", "score": 9},
            {"title": "Old story", "url": "https://a/3", "date": "2026-10-01T00:00:00+00:00", "score": 9},
            {"title": "Used story", "url": "https://a/4", "date": "2026-11-10T00:00:00+00:00", "score": 9},
            {"title": "Google item", "url": "https://news.google.com/x", "gnews": 1, "date": "2026-11-10T00:00:00+00:00", "score": 7},
        ]}
        c = talk.candidates(feed, {"https://news.google.com/x": {"url": "https://real/x"}}, {"https://a/4"}, now)
        self.assertEqual([x["url"] for x in c], ["https://real/x", "https://a/1"])

    def test_conversation_turns_are_separate_and_end(self):
        story = {"title": "T", "publisher": "P", "date": "2026-11-10", "url": "u", "text_source": "summary", "text": "s"}
        prompts = []

        def fake(system, user):
            prompts.append(user)
            n = len(prompts)
            return f"message {n}" + (" [END]" if n == 7 else "")

        msgs, ended = talk.run_conversation(story, talk.Usage(), call=fake)
        self.assertEqual(len(msgs), 7)
        self.assertEqual(ended, "A")
        self.assertEqual([m["speaker"] for m in msgs[:3]], ["A", "B", "A"])
        self.assertIn("You are B", prompts[1])
        self.assertIn("A: message 1", prompts[1])
        self.assertNotIn("message 2", prompts[1])

    def test_early_end_is_ignored_and_cap_holds(self):
        story = {"title": "T", "publisher": "P", "date": "", "url": "u", "text_source": "summary", "text": ""}
        msgs, ended = talk.run_conversation(story, talk.Usage(), call=lambda s, u: "ok [END]" if "B;" in u else "ok")
        # A always continues; B ends only once MIN_MESSAGES is reached
        self.assertEqual(len(msgs), talk.MIN_MESSAGES)
        self.assertEqual(ended, "B")


class TestPublisher(unittest.TestCase):
    def test_feed_label_replaced(self):
        it = {"title": "US poised to lose measles status - CIDRAP", "src": "Global Health"}
        self.assertEqual(talk.publisher_and_title(it, "https://www.cidrap.umn.edu/x"), ("CIDRAP", "US poised to lose measles status"))
        it = {"title": "Wider use of Ervebo urged", "src": "WHO Alert"}
        self.assertEqual(talk.publisher_and_title(it, "https://www.cidrap.umn.edu/x")[0], "CIDRAP")
        it = {"title": "A - B test", "src": "Devex Global Health"}
        self.assertEqual(talk.publisher_and_title(it, "https://devex.com/x"), ("Devex Global Health", "A - B test"))


class TestSuggestions(unittest.TestCase):
    def test_topic(self):
        st = talk.suggested_story("", "  Should   WHO charge member states for emergency response? ")
        self.assertEqual(st["title"], "Should WHO charge member states for emergency response?")
        self.assertEqual(st["text_source"], "topic")
        self.assertIn("no article", talk.story_block(st).lower())

    def test_url(self):
        page = ('<html><head><title>X | Site</title><meta property="og:title" content="Big AMR deal - Example News">'
                '<meta property="og:site_name" content="Example News">'
                '<meta property="article:published_time" content="2026-11-09T10:00:00Z"></head><body>'
                + "<p>" + "Countries agreed on a new antibiotic pull incentive today. " * 20 + "</p></body></html>")
        orig = talk.http_get
        talk.http_get = lambda u, timeout=25: (page, "https://www.example.com/a")
        try:
            st = talk.suggested_story("https://example.com/a", "")
        finally:
            talk.http_get = orig
        self.assertEqual((st["title"], st["publisher"], st["date"]), ("Big AMR deal", "Example News", "2026-11-09"))
        self.assertTrue(st["suggested"])

    def test_unreadable_url_stops(self):
        orig = talk.http_get
        talk.http_get = lambda u, timeout=25: ("<html><p>Paywall</p></html>", u)
        try:
            with self.assertRaises(RuntimeError):
                talk.suggested_story("https://x/y", "")
        finally:
            talk.http_get = orig


if __name__ == "__main__":
    unittest.main()
