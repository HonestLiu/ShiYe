#!/usr/bin/env python3
"""Exercise real HTTP handlers with a >64 MiB UTF-8 payload, no browser required."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

parser=argparse.ArgumentParser()
parser.add_argument('--server-dir',type=Path,default=Path(__file__).resolve().parent)
args=parser.parse_args()
sys.path.insert(0,str(args.server_dir))
temporary=tempfile.TemporaryDirectory(prefix='pdf-transfer-check-')
os.environ['LOCAL_EXPORT_DATA_DIR']=temporary.name
import server
original_pool=server.POOL
recorded=[]
class Recorder:
    def submit(self,*args):recorded.append(args)
server.POOL=Recorder()

class Socket:
    def __init__(self,data):self.input=io.BytesIO(data);self.output=io.BytesIO()
    def makefile(self,*args):return self.input
    def sendall(self,data):self.output.write(data)
class Handler(server.Handler):
    def log_message(self,*args):pass
def request(path,body,origin='chrome-extension://fixture'):
    data=json.dumps(body).encode()
    headers=f'Host: 127.0.0.1:8765\r\nOrigin: {origin}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\n'
    socket=Socket(f'POST {path} HTTP/1.0\r\n{headers}\r\n'.encode()+data)
    Handler(socket,('127.0.0.1',1),SimpleNamespace(server_port=8765))
    head,body=socket.output.getvalue().split(b'\r\n\r\n',1)
    return int(head.split(b' ')[1]),json.loads(body)
try:
    assert request('/api/pdf/uploads',{'size':1},'https://evil.example')[0]==403
    assert request('/api/pdf/uploads',{'size':300*1048576})[0]==400
    small=request('/api/pdf/uploads',{'size':5})[1]['uploadId']
    assert request('/api/pdf/uploads/'+small+'/commit',{})[0]==400
    assert request('/api/pdf/uploads/'+small+'/chunk',{'index':1,'data':base64.b64encode(b'hello').decode()})[0]==400
    assert request('/api/pdf/uploads/'+small+'/cancel',{})[0]==200
    assert request('/api/pdf/uploads/'+small+'/commit',{})[0]==400
    prefix=b'{"engine":"chromium","webDocument":{"html":"<h1>Large transfer</h1>","width":760},"bulk":"'+ '起点汉字'.encode()
    suffix='终点"}'.encode()
    bulk=prefix+b'x'*(70*1048576)+suffix
    assert len(bulk)>server.MAX_BODY
    upload=request('/api/pdf/uploads',{'size':len(bulk)})[1]['uploadId']
    for index,offset in enumerate(range(0,len(bulk),524288)):
        chunk={'index':index,'data':base64.b64encode(bulk[offset:offset+524288]).decode()}
        status,result=request('/api/pdf/uploads/'+upload+'/chunk',chunk)
        assert status==200,(status,result)
        if index==0:assert request('/api/pdf/uploads/'+upload+'/chunk',chunk)[0]==400
    status,result=request('/api/pdf/uploads/'+upload+'/commit',{})
    assert status==200 and result['jobId'],result
    payload=recorded[0][2]
    assert payload['bulk'].startswith('起点汉字') and payload['bulk'].endswith('终点')
    assert payload['bulk'].count('x')==70*1048576
    assert not list((Path(temporary.name)/'uploads').iterdir())
    print('PASS real HTTP chunk upload: 70 MiB + UTF-8 payload reassembled exactly; IPC-sized chunks; origin/size/order/duplicate/incomplete/cancel checks; staging removed on commit')
finally:
    original_pool.shutdown(wait=True)
    temporary.cleanup()
