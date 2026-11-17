#!/usr/bin/env python3
"""Unit tests for the manifest write in scripts/lingbot_map_worker.py.

Run with plain stdlib, no torch and no lingbot_map:

    python3 -m unittest tests/unit/python/test_lingbot_manifest_worker.py

Under -I a bare file path cannot be imported (-I keeps the working directory off
sys.path), so the isolated run goes through discover:

    python3 -I -B -m unittest discover -s tests/unit/python -p test_lingbot_manifest_worker.py

The worker is loaded by path. Its module-level imports are standard library only:
torch and lingbot_map are imported inside run(), which these tests never call.

What is pinned is the verdict rule in _write_manifest. A skip or an error keeps an
earlier degenerate verdict (its quality and remediation) beside its own status and
reason. An ok payload drops the verdict. A prior manifest that cannot be read, is not
a JSON object, or has no degenerate verdict gives a plain write.
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

WORKER = Path(__file__).resolve().parents[3] / "scripts" / "lingbot_map_worker.py"
MANIFEST = "lingbot-map.manifest.json"


def load_worker():
    spec = importlib.util.spec_from_file_location("lingbot_map_worker", WORKER)
    module = importlib.util.module_from_spec(spec)
    # Registered before it runs: the worker's dataclass has string annotations, and
    # dataclasses looks the module up in sys.modules while it builds the class.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


worker = load_worker()

# Shaped the way server/lingbot-map/lingbot_map.ts writes a degenerate verdict.
DEGENERATE_QUALITY = {
    "degenerate": True,
    "status": "needs-rescan",
    "reasons": ["collapsed-extent"],
    "extentRatio": 0.04,
}
DEGENERATE_REMEDIATION = "The walk was too short for the room. Walk it again, end to end."
DEGENERATE_PRIOR = {
    "status": "error",
    "error": "The 3D reconstruction collapsed: its points span only a few centimetres.",
    "quality": DEGENERATE_QUALITY,
    "remediation": DEGENERATE_REMEDIATION,
}
INSTALL_HINT = "Install torch + lingbot-map (see README)."


class ManifestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.session = Path(self._tmp.name)
        self.path = self.session / MANIFEST

    def tearDown(self):
        self._tmp.cleanup()

    def write_prior(self, text):
        self.path.write_text(text, encoding="utf-8")

    def write_prior_json(self, obj):
        self.write_prior(json.dumps(obj))

    def written(self):
        return json.loads(self.path.read_text(encoding="utf-8"))


class SkipAndErrorKeepTheVerdict(ManifestCase):
    def test_skip_keeps_quality_and_remediation_with_its_own_status_and_reason(self):
        self.write_prior_json(DEGENERATE_PRIOR)
        worker._write_manifest(self.session, {
            "status": "skipped",
            "skippedReason": "torch import failed: No module named 'torch'",
            "remediation": INSTALL_HINT,
        })
        m = self.written()
        self.assertEqual(m["status"], "skipped")
        self.assertEqual(m["skippedReason"], "torch import failed: No module named 'torch'")
        self.assertEqual(m["quality"], DEGENERATE_QUALITY)
        # The verdict's remediation is the fix for the cloud, so it replaces the install hint.
        self.assertEqual(m["remediation"], DEGENERATE_REMEDIATION)

    def test_error_keeps_quality_and_remediation_with_its_own_status_and_reason(self):
        self.write_prior_json(DEGENERATE_PRIOR)
        worker._write_manifest(self.session, {
            "status": "error",
            "error": "RuntimeError: CUDA out of memory",
            "traceback": "Traceback (most recent call last): ...",
        })
        m = self.written()
        self.assertEqual(m["status"], "error")
        self.assertEqual(m["error"], "RuntimeError: CUDA out of memory")
        self.assertEqual(m["quality"], DEGENERATE_QUALITY)
        self.assertEqual(m["remediation"], DEGENERATE_REMEDIATION)

    def test_skip_with_no_degenerate_verdict_keeps_its_own_remediation(self):
        self.write_prior_json({"status": "ok", "pointCount": 900, "quality": {"degenerate": False}})
        payload = {"status": "skipped", "skippedReason": "model checkpoint not found", "remediation": INSTALL_HINT}
        worker._write_manifest(self.session, payload)
        self.assertEqual(self.written(), payload)


class OkDropsTheVerdict(ManifestCase):
    def test_ok_payload_drops_quality_and_remediation(self):
        self.write_prior_json(DEGENERATE_PRIOR)
        ok = {
            "status": "ok",
            "pointCount": 900,
            "artifacts": {"pointCloud": "lingbot-map.point-cloud.ply", "poses": "lingbot-map.poses.json"},
        }
        worker._write_manifest(self.session, ok)
        m = self.written()
        self.assertEqual(m, ok)
        self.assertNotIn("quality", m)
        self.assertNotIn("remediation", m)


class UnreadablePriorGivesAPlainWrite(ManifestCase):
    def assert_plain_write(self):
        payload = {"status": "skipped", "skippedReason": "model checkpoint not found", "remediation": INSTALL_HINT}
        worker._write_manifest(self.session, payload)
        self.assertEqual(self.written(), payload)

    def test_no_prior_manifest(self):
        self.assert_plain_write()

    def test_prior_is_not_json(self):
        self.write_prior("{not json")
        self.assert_plain_write()

    def test_prior_is_not_utf8(self):
        self.path.write_bytes(b"\xff\xfe\x00 garbage")
        self.assert_plain_write()

    def test_prior_is_a_json_list(self):
        self.write_prior_json([DEGENERATE_PRIOR])
        self.assert_plain_write()

    def test_prior_is_a_json_scalar(self):
        self.write_prior("42")
        self.assert_plain_write()

    def test_prior_whose_quality_is_not_an_object(self):
        self.write_prior_json({"status": "error", "quality": "degenerate", "remediation": DEGENERATE_REMEDIATION})
        self.assert_plain_write()


if __name__ == "__main__":
    unittest.main(verbosity=2)
