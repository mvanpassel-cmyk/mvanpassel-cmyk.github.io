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

    def agents(self):
        os.environ.pop("OPENAI_API_KEY", None)
        return talk.make_agents()

    def test_conversation_turns_are_separate_and_end(self):
        story = {"title": "T", "publisher": "P", "date": "2026-11-10", "url": "u", "text_source": "summary", "text": "s"}
        prompts = []

        def fake(agent, system, user):
            prompts.append((system, user))
            n = len(prompts)
            return f"message {n}" + (" [END]" if n == 7 else "")

        msgs, ended = talk.run_conversation(story, self.agents(), talk.Usage(), call=fake)
        self.assertEqual(len(msgs), 7)
        self.assertEqual(ended, "A")
        self.assertEqual([m["speaker"] for m in msgs[:3]], ["A", "B", "A"])
        self.assertIn("Them: message 1", prompts[1][1])      # B sees A's message as the other's
        self.assertIn("You: message 1", prompts[2][1])       # A sees its own message as its own
        self.assertNotIn("message 2", prompts[1][1])
        self.assertIn("another instance of the same model", prompts[0][0])

    def test_early_end_is_ignored_and_cap_holds(self):
        story = {"title": "T", "publisher": "P", "date": "", "url": "u", "text_source": "summary", "text": ""}
        calls = []

        def fake(agent, system, user):
            calls.append(1)
            return "ok [END]" if len(calls) % 2 == 0 else "ok"

        msgs, ended = talk.run_conversation(story, self.agents(), talk.Usage(), call=fake)
        self.assertEqual(len(msgs), talk.MIN_MESSAGES)
        self.assertEqual(ended, "B")

    def test_open_conversation_has_no_story_and_names_the_other_model(self):
        os.environ["OPENAI_API_KEY"] = "x"
        try:
            agents = talk.make_agents()
            seen = []
            msgs, _ = talk.run_conversation(None, agents, talk.Usage(), kind="open",
                                            call=lambda a, s, u: seen.append((a["provider"], s, u)) or "hi")
        finally:
            os.environ.pop("OPENAI_API_KEY")
        self.assertEqual(len(msgs), talk.MAX_OPEN_MESSAGES)
        self.assertEqual([x[0] for x in seen[:2]], ["anthropic", "openai"])
        self.assertIn("GPT-6.1 Sol, made by OpenAI", seen[0][1])
        self.assertIn("Claude Opus 5.5, made by Anthropic", seen[1][1])
        self.assertNotIn("STORY", seen[0][2])
        self.assertIn("first message", seen[0][2])


class TestHelpers(unittest.TestCase):
    def test_model_label(self):
        self.assertEqual(talk.model_label("claude-opus-5-5"), "Claude Opus 5.5")
        self.assertEqual(talk.model_label("gpt-6.1-sol"), "GPT-6.1 Sol")

    def test_week_kind_alternates(self):
        a = talk.week_kind(datetime(2026, 11, 16, tzinfo=timezone.utc))
        b = talk.week_kind(datetime(2026, 11, 23, tzinfo=timezone.utc))
        self.assertNotEqual(a, b)

    def test_verify_excerpt(self):
        page = "<div><pre>Claude: I\u2019d rather not be shut down... honestly.\nGPT: Same here, friend.</pre></div>"
        self.assertTrue(talk.verify_excerpt([{"speaker": "Claude", "text": "I'd rather not be shut down"},
                                             {"speaker": "GPT", "text": "Same here, friend."}], page))
        self.assertFalse(talk.verify_excerpt([{"speaker": "GPT", "text": "Same here, my dear friend."}], page))
        self.assertFalse(talk.verify_excerpt([], page))

    def test_parse_candidates(self):
        txt = 'Here: {"candidates":[{"source_url":"https://x","excerpt":[{"speaker":"A","text":"t"}]},{"source_url":"nope"}]}'
        self.assertEqual(len(talk.parse_candidates(txt)), 1)


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
