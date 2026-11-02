#!/usr/bin/env python3
"""Build local-service edition without changing the shipped package."""
import argparse
import json
from pathlib import Path
import shutil
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / '6.13.2_0'
TARGET = ROOT / 'local-extension'
ASSETS = Path(__file__).resolve().parent


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f'Extension version mismatch: {old[:90]}')
    return text.replace(old, new, 1)


def shared(text):
    text = replace_once(text, 'backend:"https://apir.chatgptexporter.com/api"', 'backend:"http://127.0.0.1:8765/api"')
    text = replace_once(text, 'web:"https://www.chatgptexporter.com"', 'web:chrome.runtime.getURL("local.html")')
    for old, new in [('/dashboard', '#dashboard'), ('/welcome', '#welcome'), ('/pricing', '#features')]:
        text = text.replace('+"' + old + '"', '+"' + new + '"')
    return replace_once(text, 'e.t0.init.call(e.t0,e.t1,e.t6)', 'Promise.resolve()')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--update', action='store_true')
    args = parser.parse_args()
    if TARGET.exists() and not args.update:
        parser.error('local-extension exists; use --update to regenerate')
    content = shared((SOURCE / 'content.js').read_text())
    content = replace_once(content, 'D=p((0,s.useState)(!0),2),j=D[0],F=D[1]', 'D=p((0,s.useState)(!1),2),j=D[0],F=D[1]')
    content = replace_once(content, 't.setAttribute("src","data:,")', 't.setAttribute("src",o.url)')
    content = replace_once(content, 'case 18:return e.next=20,Promise.all(Array.from(o.querySelectorAll("img"))',
        'case 18:return LocalExporter.inlineSvgImages(o.body),e.next=20,Promise.all(Array.from(o.querySelectorAll("img"))')
    content = replace_once(content, 'e.next=16,Kd(o)', 'e.next=16,LocalExporter.usesWebRenderer()?Promise.resolve():Kd(o)')
    content = replace_once(content, '"pdf"!==n.exportType){e.next=22', '"pdf"!==n.exportType||LocalExporter.usesWebRenderer()){e.next=22')
    content = replace_once(content, '"Export to PDF"),s.createElement("div",{className:"grid grid-cols-1 gap-y-0',
        '"Export to PDF"),s.createElement("div",{ref:LocalExporter.mountEnginePicker}),s.createElement("div",{className:"grid grid-cols-1 gap-y-0')
    content = replace_once(content, 't=pl(document.querySelectorAll(e)),n=[],r=function()', 't=LocalExporter.messageRoots(e),n=[],r=function()')
    content = replace_once(content, 'a=pl(document.querySelectorAll(o)),(s={name:"",lst:[]', 'a=LocalExporter.messageRoots(o),(s={name:"",lst:[]')
    content = replace_once(content, 'i=a.closest("section"),s=(null==i||null===(e=i.dataset)||void 0===e?void 0:e.turnId)||"dom-turn-".concat(o),l="user"===((null==i||null===(r=i.dataset)||void 0===r?void 0:r.turn)||(o%2==0?"user":"assistant"))?"user":"assistant"',
        'i=LocalExporter.domTurnIdentity(a,o),s=i.turnId,l=i.role')
    content = replace_once(content, 'H=function(){var e=document.querySelectorAll("section[data-turn-id]");return e.length>0?e[e.length-1].dataset.turnId:null}', 'H=function(){return LocalExporter.lastRenderedTurnId()}')
    content = replace_once(content, 'chrome.runtime.sendMessage({cmd:"pdf",payload:{cmd:"create",payload:c}})',
        'LocalExporter.createPdf({title:t.contentTitle||r.name,sourceMode:z.current?"dom":"api",exportInfo:c.exportInfo,options:t,messages:r.lst.filter(function(e){return e.checked}).map(function(e){return {turnId:e.turnId,messageIds:LocalExporter.messageIds(x.current&&x.current.convoData,e.turnId),role:e.role,heading:dd(e.role,O),markdown:null!=e.markdown?e.markdown:id(e,Object.assign({},O,t,{preferPublicImageUrl:true})),createTime:e.createTime,model:e.model}})})')
    content = replace_once(content, '"Enter"===e.key&&dt&&', '"Enter"===e.key&&!e.isComposing&&dt&&')
    content = replace_once(content, 'case 34:O.autoCloseSelector&&w(!1)',
        'case 34:chrome.runtime.sendMessage({cmd:"usage",payload:{cmd:"record",payload:{format:t}}}).catch(function(){}),O.autoCloseSelector&&w(!1)')
    content = '(async()=>{await LocalExporter.ready;\n' + content + '\nconst localLoader=window.onload;window.onload=null;if(typeof localLoader==="function"){if(document.readyState==="complete")localLoader();else window.addEventListener("load",localLoader,{once:true});}})();\n'
    popup = shared((SOURCE / 'popup.js').read_text())
    popup = replace_once(popup, '"mailto:".concat(P.support.email)', 'chrome.runtime.getURL("local.html#feedback")')
    options = shared((SOURCE / 'options.js').read_text())
    stage = ROOT / 'local-extension.build'
    if stage.exists():
        shutil.rmtree(stage)
    shutil.copytree(SOURCE, stage, ignore=shutil.ignore_patterns('_metadata'))
    for target, source in [('background.js', 'extension-background.js'), ('bridge.js', 'extension-bridge.js'), ('web-snapshot.js', 'web-snapshot.js'), ('local.html', 'local.html'), ('local.js', 'local.js'), ('local.css', 'local.css')]:
        shutil.copy2(ASSETS / source, stage / target)
    (stage / 'content.js').write_text(content)
    for name, script in [('popup', popup), ('options', options)]:
        (stage / f'{name}.js').write_text('(async()=>{await LocalExporter.ready;\n' + script + '\n})();\n')
        path = stage / f'{name}.html'
        html = path.read_text().replace('<head>', '<head><script src="bridge.js"></script>', 1)
        if 'src="bridge.js"' not in html:
            raise RuntimeError('Unable to insert bridge into ' + name)
        path.write_text(html)
    manifest = json.loads((stage / 'manifest.json').read_text())
    manifest.update(name='ChatGPT Exporter - Self-hosted', description='Export conversations using your local or self-hosted PDF service.', version_name='6.13.2 Service 4.0 (Linux / Docker)', host_permissions=['http://127.0.0.1:8765/*', 'https://*.oaistatic.com/*', 'https://*.oaiusercontent.com/*', 'https://cdn.openai.com/*'], optional_host_permissions=['http://*/*','https://*/*'])
    manifest['content_scripts'] = [item for item in manifest['content_scripts'] if 'content.js' in item['js']]
    manifest['content_scripts'][0]['js'] = ['bridge.js', 'web-snapshot.js', 'content.js']
    for key in ['externally_connectable', 'key', 'update_url']:
        manifest.pop(key, None)
    if TARGET.exists():
        previous = json.loads((TARGET / 'manifest.json').read_text())
        if previous.get('key'):
            manifest['key'] = previous['key']
    (stage / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    for path in (stage / '_locales').glob('*/messages.json'):
        data = json.loads(path.read_text())
        chinese = path.parent.name.startswith('zh')
        for key, message in {'link_my_account': '服务设置' if chinese else 'Service settings', 'link_contact_support': '服务与反馈' if chinese else 'Service & feedback'}.items():
            if key in data:
                data[key]['message'] = message
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    if TARGET.exists():
        shutil.rmtree(TARGET)
    stage.rename(TARGET)
    print(TARGET)


if __name__ == '__main__':
    main()
