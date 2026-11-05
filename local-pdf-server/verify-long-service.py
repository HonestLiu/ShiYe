"""A captured transcript -> chunk API -> real server -> Chromium -> text checks."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import verify as fixture

payload=json.loads(Path(sys.argv[1]).read_text())
try:
    body=json.dumps(payload,ensure_ascii=False).encode()
    status,response=fixture.request('POST','/api/pdf/uploads',{'size':len(body)})
    assert status==200,response
    identifier=json.loads(response)['uploadId']
    for index,offset in enumerate(range(0,len(body),524288)):
        status,response=fixture.request('POST',f'/api/pdf/uploads/{identifier}/chunk',{'index':index,'data':base64.b64encode(body[offset:offset+524288]).decode()})
        assert status==200,response
    status,response=fixture.request('POST',f'/api/pdf/uploads/{identifier}/commit',{})
    assert status==200,response
    job_id=json.loads(response)['jobId']
    deadline=time.monotonic()+300
    while time.monotonic()<deadline:
        status,response=fixture.request('GET',f'/api/pdf/v1/{job_id}')
        result=json.loads(response)
        assert result['status']!='failed',result.get('errmsg')
        if result['status']=='done':break
        time.sleep(.2)
    else:raise AssertionError('Long service job timed out')
    assert result['messageCount']==payload['webDocument']['messageCount']
    assert result['renderStats']['fallbackMessages']==payload['webDocument']['fallbackCount']
    status,pdf=fixture.request('GET',f'/api/pdf/v1/{job_id}/download')
    assert status==200 and pdf.startswith(b'%PDF-')
    with tempfile.TemporaryDirectory(prefix='long-service-pdf-') as temporary:
        path=Path(temporary)/'long.pdf';path.write_bytes(pdf)
        raw=subprocess.check_output(['/usr/bin/swift','-module-cache-path','/tmp/local-pdf-swift-cache',str(Path(__file__).parent/'tests/inspect-long-pdf.swift'),str(path)],env={**os.environ,'CLANG_MODULE_CACHE_PATH':'/tmp/local-pdf-clang-cache'})
        report=json.loads(raw)
        for index in range(payload['webDocument']['messageCount']):
            assert 'OUT_MSG_'+str(index).zfill(5)+'_END' in report['text'],index
    status,html=fixture.request('GET',f'/api/pdf/v1/{job_id}/html')
    assert status==200 and b'pdf-markdown' in html and b'katex' in html
    assert not list((fixture.server.local_state.data_dir()/'uploads').iterdir())
    print(f"PASS real server pipeline: {result['messageCount']} messages, {report['pages']} PDF pages, {report['bookmarks']} bookmarks; chunks -> sanitizer -> Markdown/KaTeX -> Chromium; every message verified and complete HTML retained")
finally:
    fixture.server.POOL.shutdown(wait=True)
    fixture.TEST_DATA.cleanup()
