// Runs inside the frozen document. Reflow layout boxes, not mathematical/graphic geometry.
export function preparePagination({pageHeight}) {
  const roots=[...document.querySelectorAll('.pdf-message, main>section[data-role]')];
  const stats={reflowed:0,splitBlocks:0,resizedMedia:0};
  const nodes=[...new Set(roots.flatMap(root=>[root,...root.querySelectorAll('*')]))];
  // DIL address/timeline diagrams use a definite row height with proportional
  // flex children. Their geometry is content, not a virtual transcript spacer.
  const graphicRows=nodes.filter(node=>node.matches('[data-d-component="row"][data-d-has-height]')&&node.getBoundingClientRect().height>0&&node.getBoundingClientRect().height<=pageHeight);
  const graphicGeometry=new Set(graphicRows.flatMap(node=>[node,...node.querySelectorAll('*')]));
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
  for(const node of nodes){
    if(protectedNode(node)||node.matches(replaced)||anchored.has(node))continue;
    const computed=getComputedStyle(node);
    if(computed.display==='none'||! /^(block|flow-root|flex|grid|list-item|table|table-row|table-row-group|table-header-group|table-footer-group|table-cell)$/.test(computed.display))continue;
    // Computed pixel heights from a continuous/virtualized page are not print heights.
    for(const [key,value] of Object.entries({height:'auto','min-height':'0','max-height':'none','overflow':'visible','overflow-x':'visible','overflow-y':'visible','content-visibility':'visible',contain:'none'}))node.style.setProperty(key,value,'important');
    // Preserve flex sizing and centering on both axes. Clearing a child's grow
    // collapses horizontal diagrams whose basis is 0%, even with a frozen width.
    if(computed.display==='grid'&&node.getBoundingClientRect().height>pageHeight){
      node.style.setProperty('grid-template-rows','none','important');
      node.style.setProperty('grid-auto-rows','auto','important');
    }
    stats.reflowed++;
  }
  for(const root of roots){
    const source=root.querySelector(':scope > [data-local-pdf-expand]');
    if(source&&!protectedNode(source)&&!anchored.has(source)){
      for(const [key,value] of Object.entries({position:'relative',top:'auto',right:'auto',bottom:'auto',left:'auto',transform:'none','margin-left':'0','margin-right':'0'}))source.style.setProperty(key,value,'important');
    }
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
