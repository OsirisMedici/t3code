import os,json,subprocess,shutil,hashlib,sqlite3,time,urllib.request,fcntl
from pathlib import Path
root=Path('/home/t3worker/.local/state/t3-live-rollouts/20261104-viewport')
home=Path('/home/t3worker/.t3')
os.umask(0o077)
lock=(root/'install.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
log=(root/'install.log').open('a',buffering=1)
manifest=json.loads((root/'manifest.json').read_text());version=manifest['version']
statefile=home/'runtime/service-state.json';oldstate=statefile.read_bytes()
result={'version':version,'phase':'preflight','typecheck':'server package typecheck interrupted; 51 focused tests passed','visualAcceptance':'not performed; no browser automation requested'}
def record(phase,**fields):
 result.update(phase=phase,**fields)
 temp=root/'result.tmp';temp.write_text(json.dumps(result,indent=2)+'\n');temp.replace(root/'result.json')
 print(phase,file=log,flush=True)
def run(args,timeout=120):
 subprocess.run(args,stdout=log,stderr=log,check=True,timeout=timeout)
def get(url):
 with urllib.request.urlopen(url,timeout=8) as r:return r.read()
def descriptor():return json.loads(get('http://127.0.0.1:3773/.well-known/t3/environment'))
def digest(p):return hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
def dbsummary():
 with sqlite3.connect(f'file:{home}/userdata/statev2.sqlite?mode=ro',uri=True) as c:
  return {table:c.execute('select count(*) from '+table).fetchone()[0] for table in ('orchestration_v2_projection_threads','orchestration_v2_projection_projects') if c.execute('select 1 from sqlite_master where name=?',(table,)).fetchone()}
def others():
 with sqlite3.connect(f'file:{home}/userdata/statev2.sqlite?mode=ro',uri=True) as c:
  rows=c.execute("select thread_id from orchestration_v2_projection_runs where status in ('preparing','queued','starting','running','waiting')").fetchall()
  requests=c.execute("select thread_id from orchestration_v2_projection_runtime_requests where status not in ('resolved','cancelled')").fetchall()
  return [r for r in rows+requests if r[0]!='4d68a880-c228-465d-b039-8f022b731b3a']
def write_state(data):
 temp=statefile.with_suffix('.viewport-tmp')
 with temp.open('wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
 temp.replace(statefile)
before=descriptor();result['beforeVersion']=before['serverVersion'];result['databaseBefore']=dbsummary()
assert before['serverVersion']==manifest['previousVersion']
assert json.loads(oldstate)=={'protocol':3,'activeVersion':manifest['previousVersion']}
stage=Path(manifest['runtime']);assert digest(stage/'t3')==manifest['binarySha256']
for name,expected in manifest['clientFiles'].items():assert digest(stage/name)==expected
rollback=root/'rollback';rollback.mkdir(mode=0o700)
(rollback/'service-state-before.json').write_bytes(oldstate)
shutil.copy2(Path.home()/'.config/systemd/user/t3code.service',rollback/'t3code.service.before')
result['rollbackRuntime']=str(home/'runtime/versions'/manifest['previousVersion'])
result['rollbackState']=str(rollback/'service-state-before.json')
dest=home/'runtime/versions'/version
assert not dest.exists()
partial=dest.with_name(version+'.staging');shutil.copytree(stage,partial);partial.rename(dest)
record('runtime-staged')
assert not others(),'Unrelated work is active; runtime staged without restarting'
assert statefile.read_bytes()==oldstate,'Service state changed during staging'
write_state(json.dumps({'protocol':3,'activeVersion':version},indent=2).encode()+b'\n')
record('restarting')
try:
 run(['systemctl','--user','restart','t3code.service'])
 deadline=time.monotonic()+120
 while True:
  try:
   after=descriptor()
   assert after['serverVersion']==version
   assert after['environmentId']==before['environmentId']
   assert after['orchestrationProtocolVersion']==before['orchestrationProtocolVersion']
   assert hashlib.sha256(get('http://127.0.0.1:3773/')).hexdigest()==manifest['clientFiles']['client/index.html']
   asset=next(p for p in manifest['clientFiles'] if p.startswith('client/assets/') and p.endswith('.js'))
   assert hashlib.sha256(get('http://127.0.0.1:3773/'+asset.removeprefix('client/'))).hexdigest()==manifest['clientFiles'][asset]
   break
  except Exception:
   if time.monotonic()>=deadline:raise
   time.sleep(2)
 counts=dbsummary();assert all(counts.get(k,0)>=v for k,v in result['databaseBefore'].items())
 record('running-verified',runningVersion=after['serverVersion'],environmentPreserved=True,protocolPreserved=True,webAssetsVerified=True,databaseAfter=counts)
except Exception as e:
 record('rolling-back',error=str(e))
 write_state(oldstate);run(['systemctl','--user','restart','t3code.service'])
 record('rolled-back')
 raise
