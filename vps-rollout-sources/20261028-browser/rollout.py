#!/usr/bin/env python3
import os,sys,json,subprocess,sqlite3,hashlib,time,urllib.request,shutil
from pathlib import Path
ROOT=Path('/home/t3worker/.local/state/t3-live-rollouts/20261028-browser')
HOME=Path('/home/t3worker/.t3')
OLD='0.1.4-nightly.20261027.3770'
NEW=OLD+'+osiris.browser.1'
DROP=Path('/home/t3worker/.config/systemd/user/t3code.service.d/90-osiris-server-browser.conf')
def command(*a):subprocess.run(a,check=True)
def atomic(path,data):
 tmp=path.with_name(path.name+'.osiris-tmp');tmp.write_bytes(data);tmp.chmod(0o600);os.replace(tmp,path)
def database():return sqlite3.connect('file:'+str(HOME/'userdata/statev2.sqlite')+'?mode=ro',uri=True)
def fingerprint():
 with database() as c:
  assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
  return {'threads':dict(c.execute('SELECT thread_id,title FROM orchestration_v2_projection_threads')),'messages':{k:hashlib.sha256(v.encode()).hexdigest() for k,v in c.execute('SELECT message_id,payload_json FROM orchestration_v2_projection_messages')},'schema':hashlib.sha256(repr(c.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()).encode()).hexdigest()}
def health(version):
 for _ in range(45):
  try:
   with urllib.request.urlopen('http://127.0.0.1:3773/.well-known/t3/environment',timeout=2) as r:assert r.status==200
   result=subprocess.check_output(['ss','-H','-ltnp']).decode()
   import re
   line=next(x for x in result.splitlines() if '127.0.0.1:3773 ' in x)
   pid=re.search(r'pid=(\d+)',line).group(1)
   assert Path('/proc/'+pid+'/exe').resolve()==HOME/'runtime/versions'/version/'t3'
   print('HEALTHY',version,'PID',pid);return
  except Exception:time.sleep(1)
 raise RuntimeError('live readiness did not pass')
def rollback(dry=False):
 backup=ROOT/'cold-backup'
 assert (backup/'complete.json').exists(),'No complete cold backup'
 saved=json.loads((backup/'complete.json').read_text())
 assert hashlib.sha256((backup/'t3-core.tar').read_bytes()).hexdigest()==saved['archiveSha256'],'Backup archive checksum mismatch'
 original=ROOT/'rollback-original/runtime/versions'/OLD
 assert (original/'t3').exists()
 expected='t3 v'+OLD
 assert subprocess.check_output([str(original/'t3'),'--version']).decode().strip()==expected
 if dry:print('ROLLBACK DRY RUN PASS: archive, original runtime and saved configuration available');return
 current=json.loads((HOME/'runtime/service-state.json').read_text())['activeVersion']
 assert current in [NEW,OLD],'Refusing rollback of a different later version'
 command('systemctl','--user','stop','t3code.service')
 for version in [OLD,'0.1.2-nightly.20261022.3512']:
  source=ROOT/'rollback-original/runtime/versions'/version;target=HOME/'runtime/versions'/version
  if not target.exists():command('cp','-a','--reflink=auto',str(source),str(target))
 # Runtime rollback preserves all current chats and profile files.
 atomic(HOME/'runtime/service-state.json',(backup/'service-state.json').read_bytes())
 DROP.unlink(missing_ok=True)
 command('systemctl','--user','daemon-reload');command('systemctl','--user','start','t3code.service');health(OLD)
 print('ROLLED BACK RUNTIME ONLY; current userdata and browser profile preserved')
def deploy():
 assert not DROP.exists(),'Task drop-in already exists'
 state=json.loads((HOME/'runtime/service-state.json').read_text());assert state['activeVersion']==OLD
 with database() as c:
  active=c.execute("SELECT count(*) FROM orchestration_v2_projection_runs WHERE status NOT IN ('completed','cancelled','failed','interrupted')").fetchone()[0]
  assert active==0,'Active/queued runs detected; refusing restart'
 assert Path('/proc/2471299/exe').resolve()==HOME/'runtime/versions'/OLD/'t3'
 candidate=ROOT/'candidate-runtime';manifest=json.loads((ROOT/'candidate-manifest.json').read_text())
 assert hashlib.sha256((candidate/'t3').read_bytes()).hexdigest()==manifest['binarySha256']
 target=HOME/'runtime/versions'/NEW;assert not target.exists()
 command('cp','-a','--reflink=auto',str(candidate),str(target))
 backup=ROOT/'cold-backup';backup.mkdir(mode=0o700)
 try:
  command('systemctl','--user','stop','t3code.service')
  for pid in ['2471299','2655938']:
   p=Path('/proc')/pid/'stat'
   assert not p.exists() or p.read_text().split()[2]=='Z','Old process still alive: '+pid
  baseline=fingerprint();(backup/'chat-baseline.json').write_text(json.dumps(baseline))
  shutil.copy2(HOME/'runtime/service-state.json',backup/'service-state.json')
  shutil.copy2('/home/t3worker/.config/systemd/user/t3code.service',backup/'t3code.service')
  names=['userdata','runtime/service-state.json','service.env','runtime/versions/0.1.2-nightly.20261022.3512','runtime/versions/'+OLD,'tools/chrome-headless-shell/linux64/156.0.8078.70']
  command('tar','-C',str(HOME),'-cpf',str(backup/'t3-core.tar'),*names)
  archiveSha=hashlib.sha256((backup/'t3-core.tar').read_bytes()).hexdigest()
  (backup/'complete.json').write_text(json.dumps({'archiveSha256':archiveSha,'originalVersion':OLD,'candidateVersion':NEW,'threadCount':len(baseline['threads']),'messageCount':len(baseline['messages'])},indent=2))
  for p in backup.iterdir():p.chmod(0o600)
  rollback(True)
  DROP.parent.mkdir(parents=True,exist_ok=True)
  DROP.write_text('[Service]\nEnvironment=T3CODE_SERVER_BROWSER_EXECUTABLE=/opt/google/chrome/chrome\n')
  state['activeVersion']=NEW;state.pop('update',None);atomic(HOME/'runtime/service-state.json',(json.dumps(state,indent=2)+'\n').encode())
  command('systemctl','--user','daemon-reload');command('systemctl','--user','start','t3code.service');health(NEW)
  after=fingerprint();assert after['schema']==baseline['schema'],'Database schema changed'
  assert all(after['threads'].get(k)==v for k,v in baseline['threads'].items()),'Thread missing or title changed'
  assert all(after['messages'].get(k)==v for k,v in baseline['messages'].items()),'Existing message missing or changed'
  print('PRESERVED',len(baseline['threads']),'threads and',len(baseline['messages']),'messages; schema unchanged')
  (ROOT/'deployment-success.json').write_text(json.dumps({'version':NEW,'preservedThreads':len(baseline['threads']),'preservedMessages':len(baseline['messages']),'archiveSha256':archiveSha},indent=2))
 except BaseException:
  if (backup/'complete.json').exists():rollback()
  else:command('systemctl','--user','start','t3code.service')
  raise
if __name__=='__main__':
 os.umask(0o077)
 if '--rollback' in sys.argv:rollback('--dry-run' in sys.argv)
 elif '--deploy' in sys.argv:deploy()
 else:raise SystemExit('Use --deploy, --rollback, or --rollback --dry-run')
