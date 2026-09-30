import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ws_handler import normalize_key_panel_config


class KeyPanelConfigTests(unittest.TestCase):
    def test_key_panel_normalizes_custom_keys_and_defaults(self):
        cfg = normalize_key_panel_config({
            "shape": "diamond",
            "size": 54,
            "keys": [
                {"key": "W", "color": "#ff00ff"},
                "A|#00ff88|square",
                "Space|#66d9ff|pill|20|12",
            ],
        })

        self.assertEqual(cfg["shape"], "diamond")
        self.assertEqual(cfg["size"], 54)
        self.assertEqual(cfg["keys"][0]["key"], "w")
        self.assertEqual(cfg["keys"][0]["label"], "W")
        self.assertEqual(cfg["keys"][0]["shape"], "round")
        self.assertEqual(cfg["keys"][0]["color"], "#ff00ff")
        self.assertEqual(cfg["keys"][1]["key"], "a")
        self.assertEqual(cfg["keys"][1]["shape"], "square")
        self.assertEqual(cfg["keys"][2]["key"], "space")
        self.assertEqual(cfg["keys"][2]["label"], "SPACE")
        self.assertEqual(cfg["keys"][2]["x"], 20)
        self.assertEqual(cfg["keys"][2]["y"], 12)

    def test_key_panel_normalizes_arrow_and_modifier_aliases(self):
        cfg = normalize_key_panel_config({
            "keys": [
                {"key": "Arrow Up"},
                "left ctrl|#ffffff|round",
                "Enter|#00ff88|pill",
            ],
            "glow": False,
        })

        self.assertEqual(cfg["keys"][0]["key"], "up")
        self.assertEqual(cfg["keys"][0]["label"], "↑")
        self.assertEqual(cfg["keys"][1]["key"], "ctrl")
        self.assertEqual(cfg["keys"][2]["key"], "enter")
        self.assertFalse(cfg["glow"])


if __name__ == "__main__":
    unittest.main()
