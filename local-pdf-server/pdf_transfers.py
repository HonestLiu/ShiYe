"""Bounded, ordered disk staging for payloads larger than extension IPC limits."""
import base64
import binascii
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time
import uuid
import local_state

LOCK=threading.Lock()


def root():
    directory=local_state.data_dir()/'uploads'
    directory.mkdir(exist_ok=True)
    return directory


def begin(size):
    limit=int(os.environ.get('LOCAL_EXPORT_MAX_PAYLOAD_MB','256'))*1024*1024
    if not isinstance(size,int) or not 0<size<=limit:
        raise ValueError(f'Export payload must be at most {limit//1048576} MiB')
    with LOCK:
        directory=root()
        for item in directory.iterdir():
            if item.is_dir() and time.time()-item.stat().st_mtime>3600:
                shutil.rmtree(item)
        if len(list(directory.iterdir()))>=8:
            raise ValueError('Too many incomplete uploads; finish or retry later')
        identifier=uuid.uuid4().hex
        target=directory/identifier;target.mkdir()
        (target/'meta.json').write_text(json.dumps({'size':size,'received':0,'next':0}))
        (target/'payload.json').touch()
        return {'errcode':0,'uploadId':identifier,'chunkBytes':524288}


def target(identifier):
    if not re.fullmatch('[a-f0-9]{32}',identifier):
        raise ValueError('Invalid upload ID')
    value=root()/identifier
    if not value.is_dir():
        raise ValueError('Upload expired or does not exist')
    return value


def append(identifier,index,data):
    if not isinstance(data,str) or len(data)>710000:
        raise ValueError('Upload chunk is too large')
    try:
        decoded=base64.b64decode(data,validate=True)
    except (ValueError,binascii.Error) as error:
        raise ValueError('Invalid upload chunk encoding') from error
    if not decoded or len(decoded)>524288:
        raise ValueError('Upload chunks must be 1 byte to 512 KiB')
    with LOCK:
        directory=target(identifier)
        meta=json.loads((directory/'meta.json').read_text())
        if index!=meta['next'] or meta['received']+len(decoded)>meta['size']:
            raise ValueError('Upload chunk is out of order or exceeds declared size')
        with (directory/'payload.json').open('ab') as stream:
            stream.write(decoded)
        meta.update(received=meta['received']+len(decoded),next=index+1)
        (directory/'meta.json').write_text(json.dumps(meta))
        os.utime(directory,None)
        return {'errcode':0,'received':meta['received']}


def finish(identifier):
    with LOCK:
        directory=target(identifier)
        meta=json.loads((directory/'meta.json').read_text())
        if meta['received']!=meta['size']:
            raise ValueError('Upload is incomplete')
        try:
            with (directory/'payload.json').open(encoding='utf8') as stream:
                payload=json.load(stream)
            if not isinstance(payload,dict):
                raise ValueError('Export payload must be an object')
            return payload
        finally:
            shutil.rmtree(directory)


def cancel(identifier):
    with LOCK:
        shutil.rmtree(target(identifier))
    return {'errcode':0}
