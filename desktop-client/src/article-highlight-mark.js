import {Mark} from '@tiptap/core';
import {highlightColors,sourceIds} from './article-highlights.js';
export const ArticleHighlight=Mark.create({
 name:'highlight',inclusive:false,
 addAttributes(){return {color:{default:'yellow',parseHTML:el=>Object.hasOwn(highlightColors,el.dataset.articleHighlight)?el.dataset.articleHighlight:'yellow',renderHTML:()=>({})},sourceIds:{default:'',parseHTML:el=>sourceIds(el.dataset.sourceHighlights).join(' '),renderHTML:()=>({})}};},
 parseHTML(){return [{tag:'mark'}];},
 renderHTML({mark}){const color=Object.hasOwn(highlightColors,mark.attrs.color)?mark.attrs.color:'yellow',ids=sourceIds(mark.attrs.sourceIds);return ['mark',{'data-article-highlight':color,...(ids.length?{'data-source-highlights':ids.join(' ')}:{}),style:'background-color:'+highlightColors[color]+';color:#172b23;box-decoration-break:clone;-webkit-box-decoration-break:clone'},0];}
});
