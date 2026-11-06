// Runs inside the frozen document. Reflow layout boxes, not mathematical/graphic geometry.
export function preparePagination({pageHeight,document:documentOverride}) {
  const document=documentOverride||globalThis.document;
  const getComputedStyle=node=>node.ownerDocument.defaultView.getComputedStyle(node);
  const roots=[...document.querySelectorAll('.pdf-message, main>section[data-role]')];
  const stats={reflowed:0,splitBlocks:0,resizedMedia:0,keptFigures:0,scaledFigures:0};
  // Frozen screen-reader labels can retain absolute coordinates from the full
  // transcript. Expanding their overflow creates pages far beyond the message.
  // Keep aria-hidden visual math/graphics: only remove explicitly nonvisual UI.
  for(const root of roots)for(const node of root.querySelectorAll('.sr-only,[hidden],[data-message-role-label],[data-role-label]')){
    const selector='defs,symbol,clipPath,mask,pattern,filter,linearGradient,radialGradient';
    const definitions=[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)];
    if(definitions.length){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('aria-hidden','true');svg.style.cssText='position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;overflow:hidden!important';for(const def of definitions.filter(n=>!definitions.some(p=>p!==n&&p.contains(n))))svg.append(def.cloneNode(true));root.prepend(svg);}
    node.remove();
  }
  const nodes=[...new Set(roots.flatMap(root=>[root,...root.querySelectorAll('*')]))];
  const nodeSet=new Set(nodes);
  // WebKit's PDF capture can paint the code action bar's translucent flat
  // gradient as opaque black. Flatten only uniform code-surface overlays;
  // preserve actual gradients in diagrams and syntax highlighting.
  for(const node of nodes.filter(n=>n.matches('[data-code-block], [data-code-block] [data-markdown-copy="exclude"]'))){
    const c=getComputedStyle(node),match=c.backgroundImage.match(/^linear-gradient\(\s*(rgba?\([^)]+\))\s*,\s*\1\s*\)$/);
    if(!match)continue;
    const overlay=match[1].match(/[\d.]+/g).map(Number),alpha=overlay[3]??1;
    let base=c.backgroundColor.match(/[\d.]+/g)?.map(Number);
    if(!base||base.length===4&&base[3]<1)continue;
    const rgb=overlay.slice(0,3).map((channel,i)=>Math.round(channel*alpha+base[i]*(1-alpha)));
    node.style.setProperty('background-image','none','important');
    node.style.setProperty('background-color',`rgb(${rgb.join(',')})`,'important');
  }
  // A code viewer is an interactive viewport on the site, but must be a flow
  // box in a PDF. Include inline-block viewers and their clipping ancestors.
  for(const pre of nodes.filter(node=>node.matches('pre'))){
    if(!pre.textContent.trim())continue;
    pre.setAttribute('data-local-pdf-code','true');
    for(let box=pre;box&&nodeSet.has(box);box=box.parentElement){
      if(['inline-block','inline-flex','inline-grid'].includes(getComputedStyle(box).display))box.style.setProperty('display','block','important');
      for(const [key,value] of Object.entries({height:'auto','min-height':'0','max-height':'none','overflow':'visible','overflow-x':'visible','overflow-y':'visible','min-width':'0','max-width':'100%',contain:'none'}))box.style.setProperty(key,value,'important');
    }
    pre.style.setProperty('display','block','important');
    for(const node of [pre,...pre.querySelectorAll('code,span')]){
      node.style.setProperty('white-space','pre-wrap','important');
      node.style.setProperty('overflow-wrap','anywhere','important');
    }
  }
  // DIL address/timeline diagrams use a definite row height with proportional
  // flex children. Their geometry is content, not a virtual transcript spacer.
  const graphicRows=nodes.filter(node=>node.matches('[data-d-component="row"][data-d-has-height]')&&node.getBoundingClientRect().height>0);
  const candidates=new Set(graphicRows.map(row=>{
    const box=row.closest('[data-d-component="box"][data-d-has-border]')||row.closest('[data-d-component="box"]');
    return box&&nodeSet.has(box)&&!box.querySelector('pre,table')?box:row;
  }));
  for(const figure of nodes.filter(node=>node.matches('figure')&&node.querySelector('svg,img,canvas')&&!node.querySelector('pre,table')))candidates.add(figure);
  const figures=[...candidates].filter(node=>![...candidates].some(other=>other!==node&&other.contains(node)));
  const graphicGeometry=new Set([...figures,...graphicRows].flatMap(node=>[node,...node.querySelectorAll('*')]));
  const protectedNode=node=>node.namespaceURI!=='http://www.w3.org/1999/xhtml'||node.closest('.katex,math,svg')||graphicGeometry.has(node);
  const replaced='img,canvas,video,iframe,object,embed';
  // Decide protection before modifying any styles: charts can rely on absolute children.
  const anchored=new Set(nodes.filter(node=>{
    if(protectedNode(node)||!node.querySelector('svg,img,canvas'))return false;
    const children=[...node.children];
    const meaningful=child=>(child.textContent||'').trim()||child.matches('svg,img,canvas')||child.querySelector('svg,img,canvas');
    return children.some(child=>meaningful(child)&&['absolute','fixed'].includes(getComputedStyle(child).position))&&
      !children.some(child=>meaningful(child)&&!['absolute','fixed'].includes(getComputedStyle(child).position));
  }));
  // Read display values together before invalidating layout on each box.
  const layoutNodes=nodes.filter(node=>!protectedNode(node)&&!node.matches(replaced)&&!anchored.has(node)).map(node=>({node,display:getComputedStyle(node).display})).filter(({display})=>/^(block|flow-root|flex|grid|list-item|table|table-row|table-row-group|table-header-group|table-footer-group|table-cell)$/.test(display));
  for(const {node} of layoutNodes){
    for(const [key,value] of Object.entries({height:'auto','min-height':'0','max-height':'none',overflow:'visible','overflow-x':'visible','overflow-y':'visible','content-visibility':'visible',contain:'none'}))node.style.setProperty(key,value,'important');
    stats.reflowed++;
  }
  const tallGrids=layoutNodes.filter(({node,display})=>display==='grid'&&node.getBoundingClientRect().height>pageHeight);
  for(const {node} of tallGrids){node.style.setProperty('grid-template-rows','none','important');node.style.setProperty('grid-auto-rows','auto','important');}
  for(const root of roots){
    const source=root.querySelector(':scope > [data-local-pdf-expand]');
    if(source&&!protectedNode(source)&&!anchored.has(source)){
      for(const [key,value] of Object.entries({position:'relative',top:'auto',right:'auto',bottom:'auto',left:'auto',transform:'none','margin-left':'0','margin-right':'0'}))source.style.setProperty(key,value,'important');
    }
  }
  // Put the whole graphic (including its labels) in an atomic print box. The
  // browser moves that box to the next page instead of fragmenting its flex
  // geometry. Zoom affects layout size as well as paint, unlike transform.
  for(const figure of figures){
    const rect=figure.getBoundingClientRect();
    if(!rect.width||!rect.height)continue;
    const wrapper=document.createElement('div');
    wrapper.setAttribute('data-local-pdf-figure','true');
    wrapper.style.cssText='display:inline-block;vertical-align:top;width:100%;min-width:0;break-inside:avoid!important;page-break-inside:avoid!important;';
    figure.before(wrapper);wrapper.append(figure);
    const height=figure.getBoundingClientRect().height;
    if(height>pageHeight*.96){
      const currentZoom=parseFloat(getComputedStyle(figure).zoom)||1;
      figure.style.setProperty('box-sizing','border-box','important');
      figure.style.setProperty('width',String(figure.getBoundingClientRect().width/currentZoom)+'px','important');
      figure.style.setProperty('zoom',String(currentZoom*pageHeight*.96/height),'important');
      stats.scaledFigures++;
    }
    stats.keptFigures++;
  }
  // Keep small tables/code together; permit fragmentation only when taller than a page.
  for(const node of nodes){
    if(protectedNode(node))continue;
    if(node.getBoundingClientRect().height>pageHeight&&/avoid/.test(getComputedStyle(node).breakInside)){
      node.style.setProperty('break-inside','auto','important');
      node.style.setProperty('page-break-inside','auto','important');stats.splitBlocks++;
    }
  }
  for(const node of document.querySelectorAll('.pdf-message img,.pdf-message svg,main>section[data-role] img,main>section[data-role] svg')){
    if(node.closest('.katex,math')||node.getBoundingClientRect().height<=pageHeight)continue;
    node.style.setProperty('max-height',Math.floor(pageHeight*.98)+'px','important');
    node.style.setProperty('max-width','100%','important');
    node.style.setProperty('height','auto','important');node.style.setProperty('width','auto','important');
    node.style.setProperty('object-fit','contain','important');stats.resizedMedia++;
  }
  return stats;
}
