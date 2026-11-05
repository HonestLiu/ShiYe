/* Isolated frozen-page renderer. Browser sandbox stays enabled. */
import { readFile,writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { addHeadingNavigation } from './web-heading-navigation.mjs';
import { preparePagination } from './pdf-pagination.mjs';

export function pdfOptions(options = {}, width = 1000) {
  const sizes = { a3: 'A3', a4: 'A4', a5: 'A5', letter: 'Letter', legal: 'Legal', tabloid: 'Tabloid' };
  const format = sizes[String(options.format || options.pageSize || 'a4').toLowerCase()] || 'A4';
  const margin = { narrow: '10mm', normal: '20mm', wide: '30mm' }[options.margin] || '20mm';
  const dimensions = { A3: [297, 420], A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8] }[format];
  const landscape = Boolean(options.landscape || options.pageOrient === 'landscape');
  const paperWidth = dimensions[landscape ? 1 : 0];
  const printable = (paperWidth - 2 * Number.parseFloat(margin)) * 96 / 25.4;
  const scale = Math.min(1, printable / width);
  if (scale < 0.1) throw new Error('Captured webpage is too wide for the selected paper/margins');
  return { format, landscape, scale,
    margin: { top: margin, bottom: margin, left: margin, right: margin },
    printBackground: true, preferCSSPageSize: false, tagged: true, outline: true,
    displayHeaderFooter: !options.removePageNumber, headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;text-align:center;font-size:9px;color:#666"><span class="pageNumber"></span></div>' };
}

export async function render(spec, chromium) {
  const debug=text=>{if(process.env.LOCAL_EXPORT_DEBUG_RENDER)process.stderr.write('[render] '+text+'\n');};
  const browser = await chromium.launch({ executablePath: spec.executable, headless: true,
    chromiumSandbox: true, timeout: 30000 });
  try {
    const timeout=spec.timeoutMs || 600000;
    const context = await browser.newContext({ viewport: { width: spec.width, height: 1000 },
      javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false,
      colorScheme: spec.theme === 'dark' ? 'dark' : 'light' });
    // No URL fetches, including file:// or loopback, are allowed. Data resources
    // embedded in the captured HTML do not require network access.
    await context.route('**/*', route => route.abort('blockedbyclient'));
    const page = await context.newPage();
    await page.emulateMedia({ media: 'screen', colorScheme: spec.theme === 'dark' ? 'dark' : 'light' });
    const source=await readFile(spec.input, 'utf8');
    await page.setContent(source, { waitUntil: 'load', timeout: Math.min(timeout,120000) });
    debug('document loaded');
    let fallbackMessages=0,missingImages=0;
    if(source.includes('data-local-pdf-markdown="true"')){
      const {renderMarkdown,fallbackStyles}=await import('./markdown-renderer.mjs');
      const nodes=page.locator('[data-local-pdf-markdown="true"]');
      fallbackMessages=await nodes.count();
      await page.evaluate(css=>{const style=document.createElement('style');style.textContent=css;document.head.append(style);},await fallbackStyles());
      debug('fallback styles ready: '+fallbackMessages+' messages');
      for(let index=0;index<fallbackMessages;index++){
        const node=nodes.nth(index),markdown=await node.locator('pre').textContent();
        const rendered=await renderMarkdown(markdown,{dataDir:spec.dataDir,publicOrigin:spec.publicOrigin});
        missingImages+=rendered.missingImages;
        await node.evaluate((node,html)=>{node.classList.add('pdf-markdown');node.innerHTML=html;},rendered.html);
      }
      // Preserve the complete, self-contained result for HTML recovery too.
      await writeFile(spec.input,await page.content(),'utf8');
      debug('fallback messages rendered');
    }
    const navigation = await page.evaluate(addHeadingNavigation, { toc: spec.options?.toc === true });
    debug('heading navigation ready');
    const resources = await page.evaluate(async () => {
      await Promise.race([document.fonts.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Frozen fonts did not finish loading')), 15000))]);
      await Promise.all([...document.images].map(image => image.complete ? Promise.resolve() : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Frozen image did not finish loading')), 15000);
        image.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
        image.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Frozen image failed to load')); }, { once: true });
      })));
      const failed = [...document.images].filter(image => !image.naturalWidth && image.getAttribute('src'));
      if (failed.length) throw new Error(`${failed.length} frozen images failed to decode`);
      return { images: document.images.length, fonts: document.fonts.size };
    });
    const print=pdfOptions(spec.options,spec.width);
    const paper={A3:[297,420],A4:[210,297],A5:[148,210],Letter:[215.9,279.4],Legal:[215.9,355.6],Tabloid:[279.4,431.8]}[print.format];
    const pageHeight=(paper[print.landscape?0:1]-parseFloat(print.margin.top)-parseFloat(print.margin.bottom))*96/25.4/print.scale;
    const pagination=await page.evaluate(preparePagination,{pageHeight});
    await writeFile(spec.input,await page.content(),'utf8');
    await page.pdf({ ...print, path: spec.output,timeout });
    debug('PDF written');
    return { engine: 'chromium', ...resources, ...navigation, pagination, fallbackMessages,missingImages,sandboxEnabled: true, networkEnabled: false };
  } finally { await browser.close(); }
}

async function main() {
  const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
  let chromium;
  try { ({ chromium } = createRequire(import.meta.url)(spec.playwrightModule)); }
  catch (error) { throw new Error(`Cannot load playwright-core from ${spec.playwrightModule}: ${error.message}`); }
  process.stdout.write(JSON.stringify(await render(spec, chromium)) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
}
