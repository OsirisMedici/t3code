from http.server import BaseHTTPRequestHandler,HTTPServer
import json
state={"viewport":None,"clicks":[]}
html=b'''<!doctype html><meta charset=utf-8><title>Viewport test</title><style>html,body{margin:0;width:100%;height:100%;background:#dbeafe;font:20px system-ui}#r{position:fixed;inset:40% 0;text-align:center}button{position:fixed;width:90px;height:54px;background:#1e40af;color:white;border:0}.tl{top:0;left:0}.tr{top:0;right:0}.bl{bottom:0;left:0}.br{bottom:0;right:0}</style><div id=r></div><button class=tl>TL</button><button class=tr>TR</button><button class=bl>BL</button><button class=br>BR</button><script>let clicks=[];function update(){document.querySelector('#r').textContent=innerWidth+' x '+innerHeight+' | '+clicks.join(', ');navigator.sendBeacon('/state',JSON.stringify({viewport:{width:innerWidth,height:innerHeight},clicks}))}onresize=update;document.querySelectorAll('button').forEach(b=>b.onclick=()=>{clicks.push(b.textContent);update()});update()</script>'''
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','application/json' if self.path=='/state' else 'text/html');self.end_headers();self.wfile.write(json.dumps(state).encode() if self.path=='/state' else html)
 def do_POST(self):
  state.update(json.loads(self.rfile.read(int(self.headers['Content-Length']))));self.send_response(204);self.end_headers()
 def log_message(self,*args): pass
print('fixture 23974',flush=True)
HTTPServer(('127.0.0.1',23974),H).serve_forever()
