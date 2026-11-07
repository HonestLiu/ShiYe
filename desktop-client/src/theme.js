const media=window.matchMedia('(prefers-color-scheme: dark)');
const allowed=new Set(['system','light','dark']);
export function getTheme(){try{const value=localStorage.getItem('appearance-theme');return allowed.has(value)?value:'system';}catch{return 'system';}}
export function applyTheme(value=getTheme()){
 const mode=allowed.has(value)?value:'system';
 document.documentElement.dataset.theme=mode==='system'?(media.matches?'dark':'light'):mode;
 document.documentElement.dataset.themePreference=mode;
 window.dispatchEvent(new CustomEvent('shiye-theme-change',{detail:document.documentElement.dataset.theme}));
}
export function setTheme(value){const mode=allowed.has(value)?value:'system';localStorage.setItem('appearance-theme',mode);applyTheme(mode);return mode;}
media.addEventListener('change',()=>{if(getTheme()==='system')applyTheme();});
window.addEventListener('storage',e=>{if(e.key==='appearance-theme')applyTheme();});
applyTheme();
