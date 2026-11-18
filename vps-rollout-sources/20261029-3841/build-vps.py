import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

home = Path.home()
root = home / 'projects/t3code-update-3841'
state = home / '.local/state/t3-updates/20261029-3841'
version = '0.1.4-nightly.20261028.3841001'
env = dict(os.environ)
env['PATH'] = str(state / 'bin') + ':' + str(state / 'node-v26.12.1-linux-x64/bin') + ':' + str(home / '.local/share/vite-plus/bin') + ':' + env['PATH']
for line in (root / '.env.example').read_text().splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        if key in ('T3CODE_CLERK_PUBLISHABLE_KEY', 'T3CODE_CLERK_JWT_TEMPLATE', 'T3CODE_CLERK_CLI_OAUTH_CLIENT_ID', 'T3CODE_RELAY_URL'):
            env[key] = value
subprocess.run(['git', 'diff', '--quiet', '7c3b3b3605efa695e9948051b569937fc1482c0f', '9e09926d97824179d97311d1a810c6b5bb60d2d1', '--', 'native/resource-monitor'], cwd=root, check=True)
native_source = home / '.t3/runtime/versions/0.1.4-nightly.20261027.3770+osiris.browser.1/resource-monitor'
native_cache = state / 'resource-monitor'
shutil.copytree(native_source, native_cache, dirs_exist_ok=True)
manifest = {'candidate_sha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(), 'version': version, 'native_cache': {'unchanged_source': True, 'source_runtime': str(native_source), 'sha256': hashlib.sha256((native_cache / 'linux-x64/t3-resource-monitor').read_bytes()).hexdigest()}, 'steps': {}}
if (state / 'build-manifest-vps.json').exists():
    prior = json.loads((state / 'build-manifest-vps.json').read_text())
    assert prior['candidate_sha'] == manifest['candidate_sha'] and prior['version'] == version
    manifest['steps'] = prior['steps']
originals = {p: (root / p).read_bytes() for p in ('apps/server/package.json', 'apps/desktop/package.json', 'apps/web/package.json', 'packages/contracts/package.json')}
archive = state / 'artifacts' / ('t3-' + version + '-linux-x64.tar.gz')
steps = [
    ('align-versions-vps', ['node', 'scripts/update-release-package-versions.ts', version]),
    ('build-web-vps', ['bun', 'run', 'vp', 'run', '--filter', '@t3tools/web', 'build']),
    ('build-server-vps', ['node', 'apps/server/scripts/cli.ts', 'build', '--verbose']),
    ('build-executable-vps', ['node', 'apps/server/scripts/cli.ts', 'build-exe', '--verbose']),
    ('package-cli-vps', ['node', 'scripts/build-cli-archive.ts', '--platform', 'linux', '--arch', 'x64', '--version', version, '--output-dir', str(state / 'artifacts'), '--resource-monitor-dir', str(native_cache)]),
    ('smoke-cli-vps', ['node', 'scripts/smoke-cli-archive.ts', '--archive', str(archive), '--expect-version', version]),
]
try:
    for name, command in steps:
        if name != 'align-versions-vps' and manifest['steps'].get(name, {}).get('exit_code') == 0:
            print('Verified existing result', name, flush=True)
            continue
        print('Starting', name, flush=True)
        with (state / (name + '.log')).open('w') as log:
            result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        manifest['steps'][name] = {'exit_code': result.returncode, 'log': str(state / (name + '.log'))}
        (state / 'build-manifest-vps.json').write_text(json.dumps(manifest, indent=2) + '\n')
        print(name, 'exit', result.returncode, flush=True)
        if result.returncode:
            raise SystemExit(result.returncode)
    manifest['artifact_sha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
    (state / 'build-manifest-vps.json').write_text(json.dumps(manifest, indent=2) + '\n')
finally:
    for relative, contents in originals.items():
        (root / relative).write_bytes(contents)
