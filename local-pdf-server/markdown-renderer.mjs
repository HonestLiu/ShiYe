/* Complete API-only messages with the same Chromium engine, without page JS. */
import MarkdownIt from 'markdown-it';
import katex from 'katex';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const md=new MarkdownIt({html:false,linkify:true,breaks:false});
const math=(source,display)=>katex.renderToString(source,{displayMode:display,output:'html',throwOnError:false,trust:false,strict:'ignore',maxExpand:1000,maxSize:100});
md.inline.ruler.before('escape','local_math',(state,silent)=>{
  const start=state.pos,opening=state.src.startsWith('\\(',start)?'\\(':state.src[start]==='$' && state.src[start+1]!=='$'?'$':null;
  if(!opening)return false;
  if(opening==='$' && /\s/.test(state.src[start+1]||' '))return false;
  const closing=opening==='$'?'$':'\\)';let end=state.src.indexOf(closing,start+opening.length);
  while(end>=0 && state.src[end-1]==='\\')end=state.src.indexOf(closing,end+closing.length);
  if(end<0 || state.src.slice(start,end).includes('\n\n'))return false;
  if(opening==='$' && (/\s/.test(state.src[end-1]) || /\d/.test(state.src[end+1]||'')))return false;
  if(!silent){const token=state.push('local_math_inline','math',0);token.content=state.src.slice(start+opening.length,end);}
  state.pos=end+closing.length;return true;
});
md.block.ruler.before('fence','local_math_block',(state,start,end,silent)=>{
  const first=state.src.slice(state.bMarks[start]+state.tShift[start],state.eMarks[start]).trim();
  const opening=first.startsWith('$$')?'$$':first.startsWith('\\[')?'\\[':null;
  if(!opening)return false;
  const closing=opening==='$$'?'$$':'\\]';let content=first.slice(2),line=start;
  while(!content.includes(closing) && ++line<Math.min(end,start+1000))content+='\n'+state.src.slice(state.bMarks[line]+state.tShift[line],state.eMarks[line]);
  const position=content.indexOf(closing);if(position<0)return false;
  if(silent)return true;
  const token=state.push('local_math_block','math',0);token.content=content.slice(0,position);token.block=true;state.line=line+1;return true;
});
md.renderer.rules.local_math_inline=(tokens,index)=>math(tokens[index].content,false);
md.renderer.rules.local_math_block=(tokens,index)=>math(tokens[index].content,true)+'\n';
let stylesheet;
export async function fallbackStyles(){
  if(!stylesheet)stylesheet=(async()=>{
    const dist=path.dirname(createRequire(import.meta.url).resolve('katex'));
    let css=await fs.readFile(path.join(dist,'katex.min.css'),'utf8');
    // One embedded WOFF2 per face; no server font URLs or repeated TTF copies.
    const faces=[...css.matchAll(/src:([^;]+);/g)];
    for(const face of faces){
      const font=face[1].match(/url\((?:["']?)(fonts\/[\w.-]+\.woff2)(?:["']?)\)/);
      if(font){const data=await fs.readFile(path.join(dist,font[1]));css=css.replace(face[0],`src:url(data:font/woff2;base64,${data.toString('base64')}) format("woff2");`);}
    }
    return css+`\n.pdf-markdown{font:inherit;line-height:1.75;overflow-wrap:anywhere}.pdf-markdown h1{font-size:1.9em}.pdf-markdown h2{font-size:1.5em}.pdf-markdown h3{font-size:1.25em}.pdf-markdown h4{font-size:1.1em}.pdf-markdown h1,.pdf-markdown h2,.pdf-markdown h3,.pdf-markdown h4{line-height:1.4;margin:1.4em 0 .65em}.pdf-markdown p{margin:.8em 0}.pdf-markdown pre{padding:1em;border:1px solid #8884;background:#8881;white-space:pre-wrap;overflow-wrap:anywhere;break-inside:auto}.pdf-markdown code{font-family:ui-monospace,"Noto Sans Mono CJK SC",monospace;font-size:.9em}.pdf-markdown table{width:100%;border-collapse:collapse}.pdf-markdown th,.pdf-markdown td{border:1px solid #8885;padding:.5em;text-align:left}.pdf-markdown blockquote{border-left:3px solid #8887;margin:1em 0;padding-left:1em}.pdf-markdown img,.pdf-markdown svg{max-width:100%;height:auto}.pdf-markdown .katex-display{margin:1em 0}.pdf-markdown hr{height:0;border:0;border-top:1px solid #8885;margin:1.5em 0}`;
  })();
  return stylesheet;
}

export async function renderMarkdown(markdown,{dataDir,publicOrigin}={}){
  let html=md.render(markdown);const matches=[...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"[^>]*>/g)];let missingImages=0;
  for(const match of matches){
    const source=md.utils.unescapeAll(match[1]);
    if(/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(source))continue;
    try{
      const url=new URL(source,publicOrigin || 'http://127.0.0.1');
      const local=['127.0.0.1','localhost'].includes(url.hostname) || (publicOrigin && url.origin===publicOrigin);
      const file=url.pathname.match(/^\/api\/file\/([a-f0-9]{64}\.(png|jpg))$/);
      if(!local || !file || !dataDir)throw new Error('Image not in owned storage');
      const image=await fs.readFile(path.join(dataDir,'files',file[1]));
      html=html.replace(match[0],match[0].replace(match[1],`data:image/${file[2]==='png'?'png':'jpeg'};base64,${image.toString('base64')}`));
    }catch{missingImages++;html=html.replace(match[0],'<span role="img">[图片未能读取]</span>');}
  }
  return {html,missingImages};
}
