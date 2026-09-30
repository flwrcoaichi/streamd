import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ws_handler import _resolve_scene_from_status


class StatusSceneResolutionTests(unittest.TestCase):
    def test_status_updates_match_scene(self):
        self.assertEqual(_resolve_scene_from_status("starting soon"), "starting")
        self.assertEqual(_resolve_scene_from_status("be right back"), "brb")
        self.assertEqual(_resolve_scene_from_status("brb – technical"), "brb")
        self.assertEqual(_resolve_scene_from_status("playing: Halo"), "playing")
        self.assertEqual(_resolve_scene_from_status("ending soon"), "ending")
        self.assertEqual(_resolve_scene_from_status("just chatting"), "live")


if __name__ == "__main__":
    unittest.main()
