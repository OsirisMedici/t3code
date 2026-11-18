import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import socket
import sqlite3
import subprocess
import time
import urllib.request

VERSION = '0.1.4-nightly.20261028.3841001'
STATE = Path.home() / '.local/state/t3-updates/20261029-3841'
HOME_DIR = Path.home() / '.t3'
DB = HOME_DIR / 'userdata/statev2.sqlite'
MAC = platform.system() == 'Darwin'
HOST = 'mac' if MAC else 'vps'
RESULT = STATE / f'install-result-{HOST}.json'
LOCK = open(STATE / f'install-{HOST}.lock', 'a')
fcntl.flock(LOCK, fcntl.LOCK_EX | fcntl.LOCK_NB)
log = open(STATE / f'install-{HOST}.log', 'a', buffering=1)
result = {'version': VERSION, 'host': HOST, 'started_at': time.time()}

def record(phase, **fields):
    result.update(phase=phase, updated_at=time.time(), **fields)
    temp = RESULT.with_suffix('.tmp')
    temp.write_text(json.dumps(result, indent=2) + '\n')
    os.replace(temp, RESULT)
    print(phase, fields, file=log)

def run(args, timeout=180):
    p = subprocess.run(args, stdout=log, stderr=log, timeout=timeout)
    if p.returncode:
        raise RuntimeError(f'{args[0]} failed with {p.returncode}')

def descriptor():
    with urllib.request.urlopen('http://127.0.0.1:3773/.well-known/t3/environment', timeout=3) as r:
        return json.load(r)

def port_open():
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(('127.0.0.1', 3773)) == 0

def database_summary():
    with sqlite3.connect(f'file:{DB}?mode=ro', uri=True, timeout=5) as c:
        names = {r[0] for r in c.execute("select name from sqlite_master where type='table'")}
        counts = {}
        for table in ('orchestration_v2_projection_threads', 'projection_projects', 'projection_threads'):
            if table in names:
                counts[table] = c.execute(f'select count(*) from {table}').fetchone()[0]
        return counts

def active_work(exclude):
    with sqlite3.connect(f'file:{DB}?mode=ro', uri=True, timeout=5) as c:
        rows = c.execute("select thread_id,status from orchestration_v2_projection_runs where status in ('preparing','queued','starting','running','waiting')").fetchall()
        requests = c.execute("select thread_id,status from orchestration_v2_projection_runtime_requests where status not in ('resolved','cancelled')").fetchall()
        return [r for r in rows + requests if r[0] != exclude]

def snapshot(rollback):
    staging = rollback / 'database.staging'
    final = rollback / 'database'
    if final.exists():
        raise RuntimeError('Refusing to overwrite existing database snapshot')
    staging.mkdir(mode=0o700)
    for suffix in ('', '-wal', '-shm'):
        source = Path(str(DB) + suffix)
        if source.exists():
            dest = staging / ('statev2.sqlite' + suffix)
            run((['/bin/cp', '-c'] if MAC else ['/bin/cp', '--reflink=auto']) + [str(source), str(dest)])
            with open(dest, 'rb') as f:
                os.fsync(f.fileno())
    os.rename(staging, final)
    record('database-snapshot-created', database_backup=str(final))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--exclude-thread')
    parser.add_argument('--wait-seconds', type=int, default=1800)
    args = parser.parse_args()
    os.umask(0o077)
    rollback = STATE / 'rollback'
    rollback.mkdir(exist_ok=True, mode=0o700)
    before = descriptor()
    if before['serverVersion'] == VERSION:
        raise RuntimeError('Target is already running; verify instead of reinstalling')
    record('waiting-for-idle', before=before, rollback=str(rollback))
    deadline = time.monotonic() + args.wait_seconds
    while True:
        active = active_work(args.exclude_thread)
        if not active:
            time.sleep(2)
            if not active_work(args.exclude_thread):
                break
        if time.monotonic() >= deadline:
            record('idle-window-expired', active_count=len(active))
            return
        record('waiting-for-idle', active_count=len(active))
        time.sleep(15)
    result['database_before'] = database_summary()
    if MAC:
        stage = Path('/Applications/.T3-Code-next-3841.app')
        original = Path('/Applications/T3 Code (Nightly).app')
        old = rollback / 'live-original-3770.app'
        if old.exists():
            raise RuntimeError('Original rollback destination already exists')
        run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(stage)])
        info = plistlib.load(open(stage / 'Contents/Info.plist', 'rb'))
        if info['CFBundleShortVersionString'] != VERSION:
            raise RuntimeError('Staged app version mismatch')
        digest = hashlib.file_digest(open(stage / 'Contents/Resources/app.asar', 'rb'), 'sha256').hexdigest()
        if digest != 'c55ecadd2e83fb5b4b84fc0733719a21881a50fa31cbe8f7f2c4323b66a46bfe':
            raise RuntimeError('Staged app hash mismatch')
        if active_work(args.exclude_thread):
            raise RuntimeError('New unrelated work appeared before stop')
        record('stopping-mac-app')
        run(['/usr/bin/osascript', '-e', 'tell application "/Applications/T3 Code (Nightly).app" to quit'], 90)
    else:
        runtime = HOME_DIR / 'runtime/versions' / VERSION / 't3'
        if not runtime.exists():
            raise RuntimeError('Verified runtime not staged')
        run([str(runtime), '--version'])
        shutil.copy2(HOME_DIR / 'runtime/service-state.json', rollback / 'service-state-before.json')
        shutil.copy2(Path.home() / '.config/systemd/user/t3code.service', rollback / 't3code.service.before')
        if active_work(None):
            raise RuntimeError('New unrelated work appeared before stop')
        record('stopping-vps-service')
        run(['systemctl', '--user', 'stop', 't3code.service'], 120)
    deadline = time.monotonic() + 90
    while port_open():
        if time.monotonic() >= deadline:
            raise RuntimeError('Live port did not stop; no database copy or replacement attempted')
        time.sleep(1)
    record('live-service-stopped')
    snapshot(rollback)
    if MAC:
        os.rename(original, old)
        try:
            os.rename(stage, original)
        except Exception:
            os.rename(old, original)
            raise
        record('installed', installed_app=str(original), original_app=str(old))
        env = dict(os.environ)
        for key in ('ELECTRON_RUN_AS_NODE', 'T3CODE_HOME', 'T3CODE_DESKTOP_DEV_SERVER_URL', 'VITE_HTTP_URL', 'VITE_WS_URL'):
            env.pop(key, None)
        p = subprocess.run(['/usr/bin/open', '-a', str(original)], env=env, stdout=log, stderr=log, timeout=30)
        if p.returncode:
            raise RuntimeError('Failed to launch installed app')
    else:
        record('installing-service')
        run([str(runtime), 'service', 'install', '--base-dir', str(HOME_DIR)], 180)
    record('waiting-for-readiness')
    deadline = time.monotonic() + 180
    while True:
        try:
            after = descriptor()
            if after['serverVersion'] != VERSION:
                raise RuntimeError('Unexpected running version')
            if after['environmentId'] != before['environmentId'] or after['orchestrationProtocolVersion'] != 2:
                raise RuntimeError('Environment identity or protocol changed')
            break
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(2)
    counts = database_summary()
    if any(counts.get(k, 0) < v for k, v in result['database_before'].items()):
        raise RuntimeError('Existing project/thread count declined')
    record('running-verified', after=after, database_after=counts,
           browser_acceptance='Post-install native/client acceptance remains to be performed',
           rollback_note='Database snapshot and original app/runtime retained. Do not restore over newer work.')

try:
    main()
except Exception as e:
    record('failed', error=str(e), recovery='Stop promotion. Inspect snapshot and current data before rollback; do not overwrite newer work.')
    raise
