#!/usr/bin/env python3
"""Authenticated deployment integration test; isolated storage, real PDF engines."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import struct
import subprocess
import tempfile
import time
import sys
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError
from urllib.parse import urlsplit
import zlib

parser = argparse.ArgumentParser()
parser.add_argument('--server-dir', type=Path, default=Path(__file__).resolve().parent)
args = parser.parse_args()
sys.path.insert(0, str(args.server_dir))
import server_security
assert server_security.normalize_origin('https://Example.COM:443/') == 'https://example.com'
assert server_security.normalize_origin('http://example.com:8765') == 'http://example.com:8765'
for invalid in ('https://user:password@example.com', 'https://example.com/api', 'file:///tmp/test'):
    try:
        server_security.normalize_origin(invalid)
    except ValueError:
        pass
    else:
        raise AssertionError('Invalid service origin accepted')
with socket.socket() as reservation:
    reservation.bind(('127.0.0.1', 0))
    port = reservation.getsockname()[1]
base = f'http://127.0.0.1:{port}'
public = 'https://pdf.example.test'
token = secrets.token_urlsafe(32)
opener = build_opener(ProxyHandler({}))


def request(path, body=None, auth=True, headers=None, raw=False):
    # Model a reverse proxy preserving Host, without requiring a public DNS/TLS endpoint.
    combined = {'Host': 'pdf.example.test', **({'Authorization': 'Bearer ' + token} if auth else {}), **(headers or {})}
    if isinstance(body, dict):
        body = json.dumps(body).encode()
        combined['Content-Type'] = 'application/json'
    req = Request(base + path, data=body, headers=combined)
    try:
        response = opener.open(req, timeout=30)
    except HTTPError as error:
        response = error
    data = response.read()
    return response.status, data if raw else json.loads(data), response.headers


def png():
    def chunk(kind, value):
        return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 32, 24, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\0' + b'\x20\x80\xc0' * 32) * 24)) + chunk(b'IEND', b'')


def upload(data):
    body = b'--fixture\r\nContent-Disposition: form-data; name="file"; filename="fixture"\r\nContent-Type: application/octet-stream\r\n\r\n' + data + b'\r\n--fixture--\r\n'
    status, result, _ = request('/api/file/u/v1', body, headers={'Content-Type': 'multipart/form-data; boundary=fixture'})
    assert status == 200, result
    assert result['url'].startswith(public + '/api/file/')
    return result['url']


def target(url):
    parsed = urlsplit(url)
    assert parsed.scheme + '://' + parsed.netloc == public
    return parsed.path + '?' + parsed.query


def generate(payload):
    status, job, _ = request('/api/pdf/v1', payload)
    assert status == 200, job
    path = '/api/pdf/v1/' + job['jobId']
    for _ in range(120):
        status, result, _ = request(path)
        assert status == 200 and result['status'] != 'failed', result
        if result['status'] == 'done':
            break
        time.sleep(.25)
    else:
        raise AssertionError('PDF job timed out')
    assert result['downloadUrl'].startswith(public + path)
    status, pdf, _ = request(target(result['downloadUrl']), auth=False, raw=True)
    assert status == 200 and pdf.startswith(b'%PDF-'), (status, pdf[:200])
    assert request(path + '/download', auth=False)[0] == 401
    assert request(path + '/download?expires=1&signature=' + '0' * 64, auth=False)[0] == 401
    assert request(target(result['downloadUrl']).replace('/download', '/html'), auth=False)[0] == 401
    return pdf


with tempfile.TemporaryDirectory(prefix='deployment-test-') as temporary:
    environment = {**os.environ, 'LOCAL_EXPORT_DATA_DIR': temporary, 'LOCAL_EXPORT_HOST': '0.0.0.0',
                   'LOCAL_EXPORT_PUBLIC_URL': public, 'LOCAL_EXPORT_API_TOKEN': token,
                   'PATH': os.environ.get('PATH', '') + ':/Library/TeX/texbin'}
    service = subprocess.Popen(['python3', str(args.server_dir / 'server.py'), '--port', str(port)], env=environment,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(100):
            try:
                if request('/health')[0] == 200:
                    break
            except OSError:
                pass
            if service.poll() is not None:
                raise AssertionError(service.stdout.read())
            time.sleep(.1)
        status, health, _ = request('/health')
        assert status == 200 and health['authenticationRequired'] and health['version'] == 4
        assert health['engines']['chromium']['available'] and health['engines']['pandoc']['available'], health
        assert request('/api/jobs', auth=False)[0] == 401
        assert request('/health', headers={'Authorization': 'Bearer wrong'})[0] == 401
        assert request('/api/settings', {'settings': {}}, headers={'Origin': 'https://evil.example'})[0] == 403
        assert request('/health', headers={'Host': 'evil.example'})[0] == 403
        status, root, _ = request('/', auth=False, raw=True)
        assert status == 200
        csrf = re.search(rb'name="local-csrf" content="([^"]+)"', root)[1].decode()
        assert request('/api/session', {}, headers={'Origin': public})[0] == 403
        status, _, headers = request('/api/session', {}, headers={'Origin': public, 'X-Local-CSRF': csrf})
        assert status == 200 and 'HttpOnly' in headers['Set-Cookie'] and 'Secure' in headers['Set-Cookie']
        cookie = headers['Set-Cookie'].split(';')[0]
        assert request('/api/jobs', auth=False, headers={'Cookie': cookie})[0] == 200
        assert request('/api/logout', {}, auth=False, headers={'Cookie': cookie, 'Origin': public, 'X-Local-CSRF': csrf})[0] == 200
        image_url = upload(png())
        assert request(target(image_url), auth=False, raw=True)[1] == png()
        if os.name == 'posix' and Path('/usr/bin/chromium').exists():
            from PIL import Image
            for image_format in ('GIF', 'WEBP'):
                image = io.BytesIO()
                Image.new('RGB', (20, 20), 'blue').save(image, format=image_format)
                converted = upload(image.getvalue())
                assert request(target(converted), auth=False, raw=True)[1].startswith(b'\x89PNG')
        for family in ('default', 'serif', 'mono'):
            pdf = generate({'engine': 'pandoc', 'title': '部署测试', 'markdown': '# 中文标题\n\n数学公式 $x^2+1$。\n\n![图片](' + image_url + ')', 'options': {'fontFamily': family, 'toc': False}})
            assert re.search(rb'/Subtype\s*/Image', pdf), 'Uploaded remote-origin image must embed in Pandoc PDF'
            output = Path(temporary) / ('pandoc-' + family + '.pdf')
            output.write_bytes(pdf)
            if Path('/usr/bin/pdftotext').exists():
                text = subprocess.check_output(['pdftotext', str(output), '-'], text=True)
                assert '中文标题' in text, text
        encoded = base64.b64encode(png()).decode()
        for toc in (False, True):
            document = '<main class="pdf-document"><h1>中文标题</h1><p>网页正文</p><h2>二级标题</h2><img src="data:image/png;base64,' + encoded + '"><svg width="100" height="40" xmlns="http://www.w3.org/2000/svg"><path d="M0 0L90 30" stroke="blue"/></svg></main>'
            pdf = generate({'engine': 'chromium', 'title': '网页部署测试', 'webDocument': {'html': document, 'css': 'body{font:16px "Noto Sans CJK SC",sans-serif}', 'width': 760, 'theme': 'light'}, 'options': {'toc': toc}})
            assert b'/Outlines' in pdf, 'Both modes must retain PDF bookmarks'
            assert (b'/Subtype /Link' in pdf) == toc, 'Only opt-in TOC should add links to this fixture'
        history = request('/api/jobs')[1]
        assert history['total'] == 5 and all(job['status'] == 'done' for job in history['items'])
        assert all(job['downloadUrl'].startswith(public + '/') for job in history['items'])
        print('PASS deployment: remote Host/origin/token/session/CSRF; signed scoped downloads; PNG/GIF/WebP; real Chinese Pandoc default/serif/mono with images; real sandboxed Chromium SVG/bookmarks/optional TOC')
    finally:
        service.send_signal(signal.SIGINT)
        try:
            service.wait(timeout=20)
        except subprocess.TimeoutExpired:
            service.kill()
            service.wait()
        if service.returncode not in (0, -signal.SIGINT):
            print(service.stdout.read()[-6000:])
