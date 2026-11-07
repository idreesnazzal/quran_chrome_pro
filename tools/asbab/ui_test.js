/* سبب النزول — real headless-Chrome test of the shipped page.
 *
 * usage:  NODE_PATH=<dir with puppeteer-core/@sparticuz/chromium> node tools/asbab/ui_test.js [baseUrl]
 *
 * Opens the app in a real browser at desktop and at 375 px, in the dark and the
 * light theme, and for each test ayah checks:
 *   - zero console errors / page errors / failed requests on the local origin;
 *   - the nuzul tab shows what the data says (summary, grade, book text toggle,
 *     the honest «no sabab» line, the range note);
 *   - the copy button copies ayah + summary + grade + text;
 *   - no horizontal overflow (scrollWidth <= clientWidth + 1) at 375 px;
 * then it checks the search result badge «سبب النزول», and saves screenshots in
 * tools/asbab/screens/.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium').default;

const BASE = process.argv[2] || 'http://127.0.0.1:8000/index.html';
const OUT = path.join(__dirname, 'screens');
const AYAHS = [
  { s: 2, a: 144, expect: 'summary' },
  { s: 2, a: 187, expect: 'summary' },
  { s: 3, a: 188, expect: 'summary' },
  { s: 33, a: 37, expect: 'summary' },
  { s: 80, a: 1, expect: 'summary' },
  { s: 111, a: 1, expect: 'summary' },
  { s: 74, a: 15, expect: 'range' },      // the sabab covers 74:11-24
  { s: 36, a: 1, expect: 'empty' },       // no sabab in either book
];

// Errors that the untouched app already produced before this feature existed, and
// that have nothing to do with it: the sandbox blocks Google Fonts, the page probes
// the optional local server at /health, and a «PDF» link points at a file the repo
// does not ship. They are counted separately so the run still proves the feature clean.
const PRE_EXISTING = [
  /fonts\.googleapis\.com/,
  /\/health\b/,
  /Quran_Complete_Mushaf_Searchable\.pdf/,
];
const preExisting = (e) => PRE_EXISTING.some((re) => re.test(e));

let failures = 0;
const fail = (m) => { failures++; console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    executablePath: await chromium.executablePath(),
    headless: true,
  });

  for (const view of [{ w: 1280, h: 900, name: 'desktop' }, { w: 375, h: 812, name: 'mobile375' }]) {
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage();
      const errors = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push('console: ' + m.text() + ' :: ' + (((m.location() || {}).url) || ''));
      });
      page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      page.on('requestfailed', (r) => { if (r.url().startsWith(BASE.replace(/index\.html$/, ''))) errors.push('requestfailed: ' + r.url()); });
      await page.setViewport({ width: view.w, height: view.h, deviceScaleFactor: 1 });
      await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
      await page.evaluate(() => { try { setTheme('dark'); } catch (e) {} });
      await page.evaluate((t) => { try { setTheme(t); } catch (e) {} }, theme);
      // the asbab data is loaded late on purpose (reader-plus.js); wait for it
      await page.waitForFunction('window.ASBAB_DATA && window.ASBAB_DATA.index', { timeout: 60000 });

      for (const ay of AYAHS) {
        const tag = `${view.name}/${theme}/${ay.s}:${ay.a}`;
        const info = await page.evaluate((s, a) => {
          openAyahTafsir(s, a);
          switchTafsirTab('nuzul');
          const q = (sel) => document.querySelector(sel);
          const body = document.getElementById('nuzulReasonBody');
          const det = body.querySelector('details.asbab-texts');
          const out = {
            html: body.innerHTML.length,
            summaries: [...body.querySelectorAll('.asbab-summary')].map((e) => e.textContent.trim()),
            grades: [...body.querySelectorAll('.asbab-grade')].map((e) => e.textContent.trim()),
            evidence: [...body.querySelectorAll('.asbab-evidence')].map((e) => e.textContent.trim()),
            ranges: [...body.querySelectorAll('.asbab-range-tag')].map((e) => e.textContent.trim()),
            empty: body.querySelector('.asbab-empty-title') ? body.querySelector('.asbab-empty-title').textContent.trim() : '',
            emptySub: body.querySelector('.asbab-empty-sub') ? body.querySelector('.asbab-empty-sub').textContent.trim() : '',
            textCount: det ? det.querySelectorAll('.asbab-text-part').length : 0,
            textHead: det ? det.querySelector('.asbab-text-part').textContent.slice(0, 120) : '',
            toggle: det ? det.querySelector('summary').textContent.trim() : '',
            badge: document.getElementById('nuzulStatusBadge').textContent.trim(),
            books: document.getElementById('nuzulSourceLabel').textContent.trim(),
            chip: document.getElementById('chipReasonVal').textContent.trim(),
            overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth,
          };
          return out;
        }, ay.s, ay.a);

        if (ay.expect === 'empty') {
          if (info.summaries.length) fail(`${tag}: expected no sabab, got a summary`);
          else if (!/لم يرد في هذين الكتابين/.test(info.empty)) fail(`${tag}: empty line is “${info.empty}”`);
          else ok(`${tag}: «${info.empty}» / ${info.emptySub}`);
        } else {
          if (!info.summaries.length) fail(`${tag}: no summary rendered`);
          if (!info.grades.length) fail(`${tag}: no grade pill`);
          if (ay.expect === 'range' && !info.ranges.some((r) => /11–24/.test(r))) fail(`${tag}: range note missing (${info.ranges})`);
          if (!info.textCount || !/النص من الكتب \(\d+\)/.test(info.toggle)) fail(`${tag}: book text toggle missing`);
          if (!info.books) fail(`${tag}: no source label`);
          if (info.summaries.length && info.summaries[0].split(/\s+/).length > 40) fail(`${tag}: summary over 40 words`);
          if (!info.evidence.length && info.grades[0] !== 'لم يُحكم عليه') fail(`${tag}: grade without the book's sentence`);
          if (info.summaries.length) ok(`${tag}: [${info.grades.join('/')}] ${info.summaries[0].slice(0, 70)}… · ${info.toggle}`);
        }

        // the copy button must carry the ayah, the summary, the grade and the texts
        const copied = await page.evaluate(() => new Promise((res) => {
          let got = '';
          navigator.clipboard.writeText = (t) => { got = t; return Promise.resolve(); };
          document.getElementById('tafsirCopyBtn').click();
          setTimeout(() => res(got), 60);
        }));
        if (!/سورة/.test(copied) || !/﴿/.test(copied)) fail(`${tag}: copy text is not the ayah block`);
        if (ay.expect === 'empty') {
          if (!/لم يرد في/.test(copied)) fail(`${tag}: copy text lacks the honest line`);
        } else {
          if (!/الحكم:/.test(copied)) fail(`${tag}: copy text lacks the grade`);
          if (!/النص من/.test(copied)) fail(`${tag}: copy text lacks the book texts`);
          if (!info.summaries.length || copied.indexOf(info.summaries[0]) < 0) fail(`${tag}: copy text lacks the summary`);
        }

        if (view.name === 'mobile375' && info.overflowX > 1) fail(`${tag}: horizontal overflow ${info.overflowX}px`);
        if (info.overflowX > 1 && view.name !== 'mobile375') fail(`${tag}: horizontal overflow ${info.overflowX}px`);

        if ((ay.s === 2 && ay.a === 144) || (ay.s === 36 && ay.a === 1) || (ay.s === 111 && ay.a === 1) ||
            (ay.s === 74 && ay.a === 15) || (ay.s === 80 && ay.a === 1)) {
          const file = path.join(OUT, `nuzul_${view.name}_${theme}_${ay.s}-${ay.a}.png`);
          // the panel itself, with the toggle opened once so the book text is visible
          await page.evaluate(() => { const d = document.querySelector('#nuzulReasonBody details.asbab-texts'); if (d) d.open = true; });
          const panel = await page.$('#nuzulReasonBody');
          await page.evaluate(() => { const el = document.getElementById('tabBtnNuzul'); if (el) el.scrollIntoView({ block: 'start' }); });
          if (panel) await panel.screenshot({ path: file }).catch(async () => { await page.screenshot({ path: file }); });
          await page.evaluate(() => { const d = document.querySelector('#nuzulReasonBody details.asbab-texts'); if (d) d.open = false; });
        }
      }

      // search: an ayah with a sabab must be flagged in the result list
      const search = await page.evaluate(async () => {
        if (document.getElementById('tafsirModalBackdrop').classList.contains('active')) closeTafsirModal();
        openModal();
        const inp = document.getElementById('modalSearchInput');
        inp.value = 'قد نرى تقلب';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 600));
        const cards = [...document.querySelectorAll('.result-item-card')].slice(0, 5);
        return {
          results: cards.length,
          badges: [...document.querySelectorAll('.badge-asbab-available')].map((e) => e.textContent.trim()),
          overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth,
        };
      });
      if (!search.results) fail(`${view.name}/${theme}: search returned nothing`);
      else if (!search.badges.length) fail(`${view.name}/${theme}: search results show no «سبب النزول» badge`);
      else ok(`${view.name}/${theme}: search badge → ${search.badges[0]}`);
      if (search.overflowX > 1) fail(`${view.name}/${theme}: search overflow ${search.overflowX}px`);
      await page.screenshot({ path: path.join(OUT, `search_${view.name}_${theme}.png`) });

      const mine = errors.filter((e) => !preExisting(e));
      const old = errors.filter(preExisting);
      if (mine.length) {
        for (const e of mine.slice(0, 6)) fail(`${view.name}/${theme}: ${e}`);
      } else {
        ok(`${view.name}/${theme}: 0 console errors from this feature` +
           (old.length ? ` (${old.length} pre-existing: fonts/health/pdf link)` : ''));
      }
      await page.close();
    }
  }

  await browser.close();
  console.log(failures ? `\nFAILED: ${failures} problem(s)` : '\nALL BROWSER CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
