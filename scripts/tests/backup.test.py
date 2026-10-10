import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('opshelper', Path(__file__).resolve().parents[1] / 'opshelper.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)

class BackupValidation(unittest.TestCase):
    def archive(self, entries):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as archive:
            for name, target in entries:
                item = tarfile.TarInfo(name)
                if target:
                    item.type = tarfile.SYMTYPE
                    item.linkname = target
                archive.addfile(item)
        data.seek(0)
        return tarfile.open(fileobj=data)

    def test_normal_files_are_accepted(self):
        with self.archive([('users/u/workspace/a.txt', None)]) as archive:
            self.assertEqual(len(ops.validated_members(archive)), 1)

    def test_traversal_absolute_and_escaped_links_are_rejected(self):
        for entries in [[('../outside', None)], [('/users/a', None)], [('config/../../outside', None)], [('users/link', '/etc/passwd')], [('users/link', '../../outside')], [('users/link', 'x')], [('users/a', None), ('users/a', None)], [('users/u/a', None), ('users/u/./a', None)]]:
            with self.subTest(entries=entries), self.archive(entries) as archive:
                with self.assertRaises(ValueError): ops.validated_members(archive)

    def test_overlap_and_symlink_targets_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'link').symlink_to(root)
            with self.assertRaises(ValueError): ops.canonical(root / 'link' / 'new')
            with self.assertRaises(ValueError): ops.independent(root, root / 'backup')

    def test_hash_fallback_reads_the_entire_stream(self):
        content = b'opshelper-backup' * 1000
        expected = __import__('hashlib').sha256(content).hexdigest()
        self.assertEqual(ops.hash_stream(io.BytesIO(content)), expected)

    def test_restore_accepts_only_the_empty_init_skeleton(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['postgres', 'agents', 'config/opencode', 'users', 'backups']:
                (root / name).mkdir(parents=True, exist_ok=True)
            self.assertTrue(ops.is_empty_prepared_root(root))
            (root / 'users/u').mkdir()
            self.assertFalse(ops.is_empty_prepared_root(root))
            (root / 'users/u').rmdir()
            (root / 'config/opencode/provider.json').write_text('{}')
            self.assertFalse(ops.is_empty_prepared_root(root))

class DeploymentCommands(unittest.TestCase):
    def deployment(self):
        deployment = object.__new__(ops.Deployment)
        deployment.verify_bind = lambda: None
        return deployment

    def test_backup_image_identity_ignores_maintenance_service_names(self):
        services = {name: {'image': name + ':release'} for name in ['postgres', 'api', 'worker', 'web', 'nginx']}
        services['api']['environment'] = {'OPENCODE_DOCKER_IMAGE': 'runtime:release'}
        services['bootstrap'] = {'image': services['api']['image']}
        images = ops.deployment_images({'services': services})
        self.assertEqual(set(images), {'postgres', 'api', 'worker', 'web', 'nginx', 'runtime'})

    def test_up_never_initializes_business_data(self):
        deployment = self.deployment()
        with patch.object(deployment, 'dc') as dc:
            deployment.up()
        commands = [call.args for call in dc.call_args_list]
        self.assertIn(('run', '--rm', '--no-deps', 'migrate'), commands)
        self.assertFalse(any('bootstrap' in command or 'seed' in command for command in commands))

    def test_bootstrap_is_explicit_and_follows_migrations(self):
        deployment = self.deployment()
        with patch.object(deployment, 'dc') as dc:
            deployment.bootstrap()
        commands = [call.args for call in dc.call_args_list]
        self.assertEqual(commands[-2:], [('run', '--rm', '--no-deps', 'migrate'), ('run', '--rm', '--no-deps', 'bootstrap')])

    def test_mac_runtime_lookup_handles_path_case_without_crossing_deployments(self):
        deployment = self.deployment()
        deployment.root = Path('/srv/opshelper/data')
        containers = [
            {'Id': 'own', 'Mounts': [{'Source': '/srv/OPSHELPER/data/users/u/workspace'}]},
            {'Id': 'other', 'Mounts': [{'Source': '/srv/opshelper/data-other/users/u/workspace'}]},
        ]
        with patch.object(ops.sys, 'platform', 'darwin'), patch.object(ops, 'run', side_effect=[b'own other', ops.json.dumps(containers).encode()]):
            self.assertEqual([row['Id'] for row in deployment.runtimes()], ['own'])

if __name__ == '__main__': unittest.main()
