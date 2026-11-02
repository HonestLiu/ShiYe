import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, pdfOptions } from './render-webpage.mjs';

const directory = await mkdtemp(join(tmpdir(), 'web-runner-test-'));
try {
  const input = join(directory, 'original.html');
  await writeFile(input, '<!doctype html><p>网页原样测试</p>');
  const spec = { input, output: join(directory, 'document.pdf'), executable: '/mock/chromium', width: 760, theme: 'dark', options: { format: 'a4', margin: 'normal', removePageNumber: true } };
  let launch, contextOptions, media, printed, interceptor, closed = false;
  const page = {
    emulateMedia: async options => { media = options; },
    setContent: async (html, options) => { assert(html.includes('网页原样测试')); assert.equal(options.waitUntil, 'load'); },
    evaluate: async callback => { assert(String(callback).includes('document.fonts.ready')); return { images: 1, fonts: 2 }; },
    pdf: async options => { printed = options; await writeFile(options.path, '%PDF-1.7\nmock'); }
  };
  const chromium = { launch: async options => {
    launch = options;
    return { newContext: async options => {
      contextOptions = options;
      return { route: async (pattern, callback) => { assert.equal(pattern, '**/*'); interceptor = callback; }, newPage: async () => page };
    }, close: async () => { closed = true; } };
  } };
  const result = await render(spec, chromium);
  assert.equal(launch.chromiumSandbox, true);
  assert(!launch.args?.includes('--no-sandbox'));
  assert.equal(contextOptions.javaScriptEnabled, false);
  assert.equal(contextOptions.serviceWorkers, 'block');
  assert.equal(media.media, 'screen');
  let aborted;
  await interceptor({ abort: async reason => { aborted = reason; } });
  assert.equal(aborted, 'blockedbyclient');
  assert.equal(printed.printBackground, true);
  assert.equal(printed.preferCSSPageSize, false);
  assert.equal(printed.displayHeaderFooter, false);
  assert(Math.abs(printed.scale - ((210 - 40) * 96 / 25.4) / 760) < 1e-9);
  assert.equal(pdfOptions({ format: 'letter', landscape: true, margin: 'wide' }, 760).format, 'Letter');
  assert.equal(pdfOptions({ format: 'a4', landscape: true }, 760).scale, 1);
  assert.equal(result.networkEnabled, false);
  assert(closed);
  closed = false;
  page.evaluate = async () => { throw new Error('Frozen image failed to load'); };
  await assert.rejects(render(spec, chromium), /Frozen image failed/);
  assert(closed, 'Browser must close on image/font failure');
  console.log('PASS: screen media, font/image readiness boundary, sandbox on, JS off, network blocking, color/background, paper fitting, cleanup on failure');
} finally { await rm(directory, { recursive: true, force: true }); }
