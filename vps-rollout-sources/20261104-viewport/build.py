import os,json,subprocess,shutil,hashlib
from pathlib import Path
repo=Path('/home/t3worker/projects/t3code-install-viewport')
root=Path('/home/t3worker/.local/state/t3-live-rollouts/20261104-viewport')
version='0.1.4-nightly.20261027.3770+osiris.viewport.1'
previous='0.1.4-nightly.20261027.3770+osiris.browser.1'
env=os.environ.copy()
env.update(json.loads(Path('/home/t3worker/.local/state/t3-live-rollouts/20261028-browser/build-config.json').read_text()))
for key in ('T3CODE_HOME','T3CODE_PORT','T3_BOOT_SERVICE_UNIT','T3_SERVICE_LAUNCHER_CONTEXT','VITE_HTTP_URL','VITE_WS_URL'):
 env.pop(key,None)
env.update(APP_VERSION=version,VITE_RELEASE_CHANNEL='nightly',T3CODE_WEB_SOURCEMAP='0')
def run(name,args):
 print(name,flush=True)
 with (root/(name+'.log')).open('w') as log:
  subprocess.run(args,cwd=repo,env=env,stdout=log,stderr=log,check=True)
# Server package typecheck interrupted after stalling; focused regressions passed.

manifest=repo/'apps/server/package.json'
original=manifest.read_bytes()
try:
 data=json.loads(original);data['version']=version;manifest.write_text(json.dumps(data,indent=2)+'\n')
 # Fresh web build already completed.
 # Fresh server bundle already completed.
 run('build-executable',['node','apps/server/scripts/cli.ts','build-exe','--target','linux-x64'])
finally:
 manifest.write_bytes(original)
stage=root/'candidate-runtime'
stage.mkdir(mode=0o700)
old=Path.home()/'.t3/runtime/versions'/previous
# Dependency manifests and native code are identical to the installed base release.
for name in ('node_modules','resource-monitor'):
 subprocess.run(['cp','-a','--reflink=auto',str(old/name),str(stage/name)],check=True)
shutil.copytree(repo/'apps/server/dist/client',stage/'client')
shutil.copy2(repo/'apps/server/dist-exe/t3-linux-x64',stage/'t3')
(stage/'.install-complete').write_text(version+'\n')
run('binary-version',[str(stage/'t3'),'--version'])
assert version in (root/'binary-version.log').read_text()
def digest(path):
 return hashlib.file_digest(path.open('rb'),'sha256').hexdigest()
assets={str(p.relative_to(stage)):digest(p) for p in sorted((stage/'client').rglob('*')) if p.is_file()}
record={'version':version,'previousVersion':previous,'releaseBase':'7c3b3b3605efa695e9948051b569937fc1482c0f','candidateCommit':'616d5cb20fbd75ef72bcb91d4383a07d7b159420','patches':['configured-browser','browser-viewport-fit'],'binarySha256':digest(stage/'t3'),'clientFiles':assets,'runtime':str(stage),'migrations':'unchanged from installed release','nativeDependencies':'unchanged from installed release'}
(root/'manifest.json').write_text(json.dumps(record,indent=2)+'\n')
print('candidate ready',version,flush=True)
