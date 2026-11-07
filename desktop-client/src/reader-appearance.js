export const readerPalettes={
 graphite:{background:'#24262b',text:'#dfe2e7',heading:'#f1f2f5',muted:'#b5bfce',link:'#abc0ff',border:'#596273',code:'#30343c'},
 obsidian:{background:'#111214',text:'#d8d8da',heading:'#f5f5f5',muted:'#b8b8bc',link:'#b8c8ff',border:'#50525a',code:'#202124'},
 glacier:{background:'#f5f9fc',text:'#344554',heading:'#243746',muted:'#657c8b',link:'#356ca2',border:'#cadce8',code:'#e9f1f6'},
 galaxy:{background:'#f6f4fc',text:'#45405b',heading:'#332e4c',muted:'#77708f',link:'#6c59a6',border:'#ded8ef',code:'#eeebf8'}
};
export const readerFonts={system:'-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',serif:'"Songti SC", "STSong", Georgia, serif',sans:'"PingFang SC", "Microsoft YaHei", sans-serif'};
export function normalizeReaderAppearance(value={}){return {dark:['graphite','obsidian'].includes(value.dark)?value.dark:'graphite',light:['glacier','galaxy'].includes(value.light)?value.light:'glacier',font:Object.hasOwn(readerFonts,value.font)?value.font:'system',size:Math.min(26,Math.max(14,Number(value.size)||18))};}
export function readReaderAppearance(){try{return normalizeReaderAppearance(JSON.parse(localStorage.getItem('reader-appearance')||'{}'));}catch{return normalizeReaderAppearance();}}
export function saveReaderAppearance(value){const next=normalizeReaderAppearance(value);localStorage.setItem('reader-appearance',JSON.stringify(next));return next;}
