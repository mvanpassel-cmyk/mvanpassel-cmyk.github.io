import os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pipeline"))
import check as c

CAM = {"yt": "OLD", "ch": "CH1", "src": "Dublin Bay Live: Watch Ships Enter and Exit Dublin Port"}


class Judge(unittest.TestCase):
    def test_same_video_in_live_results_is_live(self):
        self.assertEqual(c.judge(CAM, "ok", [("OLD", "Dublin Bay Live", "CH1")]), ("live", None))

    def test_same_channel_new_id_is_repaired(self):
        res = [("X", "Something else", "CH9"), ("NEW", "Dublin Bay Live: Watch Ships Enter and Exit Dublin Port (4K)", "CH1")]
        self.assertEqual(c.judge(CAM, "ok", res), ("repaired", "NEW"))

    def test_other_channel_never_repairs(self):
        res = [("NEW", "Dublin Bay Live: Watch Ships Enter and Exit Dublin Port", "CH9")]
        self.assertEqual(c.judge(CAM, "ok", res), ("missing", None))

    def test_unrelated_stream_of_same_channel_does_not_repair(self):
        self.assertEqual(c.judge(CAM, "ok", [("NEW", "Cork Harbour sunrise", "CH1")]), ("missing", None))

    def test_blocked_search_is_inconclusive_not_dead(self):
        self.assertEqual(c.judge(CAM, "ok", None), ("unknown", None))
        self.assertEqual(c.judge(CAM, "unknown", []), ("unknown", None))

    def test_removed_video_is_gone_unless_channel_restarted_it(self):
        self.assertEqual(c.judge(CAM, "gone", []), ("gone", None))
        res = [("NEW", "Dublin Bay Live: Watch Ships Enter and Exit Dublin Port", "CH1")]
        self.assertEqual(c.judge(CAM, "gone", res), ("repaired", "NEW"))
        self.assertEqual(c.judge(CAM, "no-embed", None), ("no-embed", None))


class Parsing(unittest.TestCase):
    def test_only_live_videos_are_read(self):
        def vid(i, live):
            return {"videoRenderer": {"videoId": i, "title": {"runs": [{"text": "Cam " + i}]},
                                      "ownerText": {"runs": [{"text": "Ch", "navigationEndpoint": {"browseEndpoint": {"browseId": "CH" + i}}}]},
                                      "badges": [{"metadataBadgeRenderer": {"label": "LIVE"}}] if live else []}}
        import json
        html = "<script>var ytInitialData = " + json.dumps({"contents": [vid("A", True), {"x": [vid("B", False)]}]}) + ";</script>"
        self.assertEqual(c.parse_live_results(html), [("A", "Cam A", "CHA")])
        self.assertIsNone(c.parse_live_results("<html>consent wall</html>"))


if __name__ == "__main__":
    unittest.main()
