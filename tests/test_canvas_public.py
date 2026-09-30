import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from state import state
from canvas import place_public_pixel


class CanvasPublicPixelTests(unittest.TestCase):
    def setUp(self):
        state.data["canvas"] = {
            "size": 10,
            "visible": False,
            "pixels": {},
            "owners": {},
        }
        state.canvas_credits = {}

    def test_place_public_pixel_tracks_owner(self):
        ok, msg = place_public_pixel("Alice", 1, 2, "#ff0000")
        self.assertTrue(ok)
        self.assertEqual(state.data["canvas"]["pixels"]["1,2"], "#ff0000")
        self.assertEqual(state.data["canvas"]["owners"]["1,2"], "alice")
        self.assertIn("placed pixel", msg)


if __name__ == "__main__":
    unittest.main()
