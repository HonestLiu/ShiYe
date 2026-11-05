import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {renderMarkdown,fallbackStyles} from './markdown-renderer.mjs';
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'markdown-fallback-'));
try{
  await fs.mkdir(path.join(temporary,'files'));
  const hash='a'.repeat(64),image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await fs.writeFile(path.join(temporary,'files',hash+'.png'),image);
  const source='# 标题\n\n行内 $x^2$ 和 \\(\\pi\\)。\n\n\\[\n\\int_0^1 x\,dx\n\\]\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst formula = "$x$";\n```\n\n<script>alert(1)</script>\n\n[不安全](javascript:alert(1))\n\n![本机图](https://export.example/api/file/'+hash+'.png?expires=1&signature=0)\n\n![外部图](https://evil.example/pixel.png)';
  const result=await renderMarkdown(source,{dataDir:temporary,publicOrigin:'https://export.example'});
  assert(result.html.includes('<h1>标题</h1>'));
  assert(result.html.includes('<table>') && result.html.includes('class="katex'));
  assert(result.html.includes('&quot;$x$&quot;') || result.html.includes('"$x$"'),'Fenced code must not turn into math');
  assert(!result.html.includes('<script>') && !/href="javascript:/.test(result.html));
  assert(result.html.includes('data:image/png;base64,'));assert.equal(result.missingImages,1);
  assert(!/<img[^>]*src="https?:/.test(result.html));
  const css=await fallbackStyles();assert(!/url\((?!data:)/.test(css));
  console.log('PASS Markdown fallback: headings/tables/code/math; HTML and unsafe links disabled; owned signed image embedded offline, external image not fetched; all math fonts self-contained');
}finally{await fs.rm(temporary,{recursive:true,force:true});}
