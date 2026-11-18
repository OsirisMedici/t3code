import os,json,subprocess,shutil,hashlib
from pathlib import Path
repo=Path('/home/t3worker/projects/t3code-live-browser')
root=Path('/home/t3worker/.local/state/t3-live-rollouts/20261028-browser')
version='0.1.4-nightly.20261027.3770+osiris.browser.1'
manifest=repo/'apps/server/package.json';original=manifest.read_bytes()
env=os.environ.copy();env.update(json.loads((root/'build-config.json').read_text()))
try:
 data=json.loads(original);data['version']=version;manifest.write_text(json.dumps(data,indent=2)+'\n')
 subprocess.run(['bun','run','--cwd','apps/server','build:exe'],cwd=repo,env=env,check=True)
finally:manifest.write_bytes(original)
stage=root/'candidate-runtime'
assert not stage.exists()
stage.mkdir(mode=0o700)
old=Path('/home/t3worker/.t3/runtime/versions/0.1.4-nightly.20261027.3770')
for name in ['client','node_modules','resource-monitor']:
 subprocess.run(['cp','-a','--reflink=auto',str(old/name),str(stage/name)],check=True)
shutil.copy2(repo/'apps/server/dist-exe/t3',stage/'t3')
(stage/'.install-complete').write_text(version+'\n')
subprocess.run([str(stage/'t3'),'--version'],check=True)
assert b'T3CODE_SERVER_BROWSER_EXECUTABLE' in (stage/'t3').read_bytes()
sha=hashlib.sha256((stage/'t3').read_bytes()).hexdigest()
(root/'candidate-manifest.json').write_text(json.dumps({'version':version,'releaseBase':'7c3b3b3605efa695e9948051b569937fc1482c0f','binarySha256':sha,'runtime':str(stage)},indent=2))
print('CANDIDATE READY',version,sha)
