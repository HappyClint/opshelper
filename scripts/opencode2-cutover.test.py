"""Exercise destructive cutover gates without accessing Docker or user data."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('cutover', Path(__file__).with_name('opencode2-cutover.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CutoverTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'config').mkdir()
        self.deployment = Mock(root=self.root, project='fixture')
        self.deployment.config = {'services': {'api': {'environment': {'OPENCODE_DOCKER_IMAGE': 'fixture:v2'}}}}
        self.deployment.sql.side_effect = ['{"conversations":6}', '0', '']
        self.deployment.runtimes.return_value = [{'Id': 'owned-container', 'State': {'Running': True}}]
        self.factory = patch.object(module, 'Deployment', return_value=self.deployment)
        self.command = patch.object(module, 'run', return_value=b'opencode v2.0.27\n')
        self.factory.start()
        self.run = self.command.start()
        self.addCleanup(self.factory.stop)
        self.addCleanup(self.command.stop)

    def execute(self, discard=True):
        module.cutover(SimpleNamespace(discard_history=discard))

    def test_preview_does_not_stop_or_delete_anything(self):
        self.execute(False)
        self.run.assert_not_called()
        self.deployment.dc.assert_not_called()
        self.assertEqual(self.deployment.sql.call_count, 1)

    def test_wrong_version_never_stops_services(self):
        self.run.return_value = b'opencode v1.18.34\n'
        with self.assertRaisesRegex(ValueError, '2.0.27'):
            self.execute()
        self.deployment.dc.assert_not_called()

    def test_pending_execution_prevents_history_deletion(self):
        self.deployment.sql.side_effect = ['{}', '1']
        with self.assertRaisesRegex(ValueError, '未完成任务'):
            self.execute()
        self.deployment.runtimes.assert_not_called()
        self.assertFalse((self.root / 'config/.opencode2-cutover.json').exists())

    def test_success_clears_history_once_and_preserves_backup_marker(self):
        self.execute()
        self.assertEqual(self.deployment.sql.call_args.args[0], module.RESET_SQL)
        self.assertTrue((self.root / 'config/.opencode2-cutover.json').exists())
        calls = self.deployment.sql.call_count
        self.execute()
        self.assertEqual(self.deployment.sql.call_count, calls)
        self.run.assert_any_call(['docker', 'rm', 'owned-container'])


if __name__ == '__main__':
    unittest.main()
