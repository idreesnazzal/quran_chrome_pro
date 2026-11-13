/* Tafsir text → readable HTML: every quoted saying is marked from its first word to its last,
 * so the reader sees where each hadith, saying, verse or poem begins and ends.
 *
 * The tafsir books already mark them; nothing is guessed from the meaning:
 *   ﴿…﴾ and {…}            a Qur'an verse                                   → .tf-q
 *   "…"  «…»  “…”           a quotation, named by what is around it:
 *       ﷺ / رسول الله / النبي … just before          → .tf-hadith  (a prophetic hadith)
 *       its words are in the mushaf, or [سورة: رقم] follows → .tf-q (a verse in quotation marks)
 *       one to three words                            → .tf-term    (a word being explained)
 *       anything else                                 → .tf-say     (a Companion, a scholar, a saying)
 *   a paragraph that is one verse of poetry (two halves joined by «...») → .tf-poem
 *   [[…]]                   the modern editor's footnote, small and faint     → .tf-fn
 *
 * Straight quotes " have no direction. They are paired inside one paragraph by their sides (a mark
 * glued to the word after it opens, glued to the word before it closes), al-Qurtubi's «"…)» closes
 * at the bracket, and when a paragraph is left with one stray mark (al-Wasit writes " … " with
 * spaces on both sides) the stray is the one whose removal leaves the most natural pairs.
 * A pair that still looks wrong is left plain: no highlight is better than one that runs on.
 *
 * TafsirRich.html(text) → HTML;  TafsirRich.legend(html) → the key for the kinds present;
 * TafsirRich.isQuran = fn(text) → true when the words are in the mushaf (set by the page).
 */
(function (G) {
  'use strict';
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var DIAC = /[ً-ْٰـ]/g;
  function plain(s) { return s.replace(DIAC, ''); }
  function wordCh(c) { return !!c && /[ء-يً-ْٰٱ-ۓA-Za-z0-9٠-٩ﷺ]/.test(c); }
  var MAX_SPAN = 1600;                      // longer than this, a «quote» is a pairing slip
  // the Prophet ﷺ named just before the quote (and no full stop in between): his words
  var PROPHET_NEAR = /(صلى الله عليه و(آله و)?سلم|ﷺ|رسول الله|النبي|نبي الله|عليه الصلاة والسلام|عليه السلام قال|قوله عليه السلام|الخبر عن النبي)[^.؟!]{0,60}$/;

  /* ---------------- straight quotes: which ones belong together ---------------- */
  function side(s, i) {
    var p = s[i - 1], n = s[i + 1];
    // the punctuation around decides first: «قال:"» opens; «… ص ٢١٧. "وَ» (al-Qurtubi) closes
    var j = i - 1; while (j >= 0 && s[j] === ' ') j--;
    var pn = s[j];
    if (pn === ':') return 'o';
    if (/[.!؟?0-9٠-٩]/.test(pn || '') && j < i - 1) return 'c';
    var pw = wordCh(p), nw = wordCh(n);
    if (!pw && nw) return 'o';
    if (pw && !nw) return 'c';
    if (/[.!؟?،؛]/.test(p || '') && !nw) return 'c';
    return 'a';
  }
  function plausible(s, a, b) {
    var before = plain(s.slice(Math.max(0, a - 30), a)).trim(), after = s.slice(b + 1, b + 12).trim(), inner = s.slice(a + 1, b).trim();
    var sc = 0;
    if (/(:|قال|يقول|قالت|قالوا|وسلم|ﷺ|بلفظ|قوله|بقوله)$/.test(before)) sc += 2;
    if (!after || /^[.،؛:)\]]/.test(after) || /^(رواه|أخرجه|وفي|وقال|وهذا|ثم|أي)/.test(plain(after))) sc += 1;
    if (/^[.،؛]/.test(inner) || /^(وقال|وفي|وهذا|وروى|قال)\s/.test(plain(inner))) sc -= 2;
    if (b - a > MAX_SPAN) sc -= 3;
    return sc;
  }
  function pairStraight(s) {
    var qs = [], i;
    for (i = 0; i < s.length; i++) if (s[i] === '"') qs.push(i);
    if (!qs.length) return [];
    var sides = qs.map(function (j) { return side(s, j); });
    var amb = sides.filter(function (x) { return x === 'a'; }).length;
    var pairs;
    if (qs.length % 2 && amb * 2 >= qs.length) {
      // one stray among marks with no side (al-Wasit): drop the one that leaves the most natural pairs
      var best = null;
      for (var k = 0; k < qs.length; k++) {
        var rest = qs.filter(function (_, n) { return n !== k; }), cand = [], sc = 0;
        for (var m = 0; m + 1 < rest.length; m += 2) { cand.push([rest[m], rest[m + 1]]); sc += plausible(s, rest[m], rest[m + 1]); }
        if (!best || sc > best.sc) best = { sc: sc, pairs: cand };
      }
      pairs = best.pairs;
    } else {
      // a stack: a mark glued to the next word opens (also inside an open quote: «قال: "يقول الله: "أنا…""»),
      // one glued to the word before closes, one with no side closes if something is open
      pairs = []; var stack = [];
      for (var n = 0; n < qs.length; n++) {
        var j = qs[n], sd = sides[n];
        if (sd === 'o') stack.push(j);
        else if (stack.length) pairs.push([stack.pop(), j]);
        else if (sd === 'a') stack.push(j);
      }
    }
    // al-Qurtubi: «"…)» — a quote that meets a bracket it did not open closes there
    return pairs.map(function (p) {
      var depth = 0;
      for (var x = p[0] + 1; x < p[1]; x++) {
        if (s[x] === '(') depth++;
        else if (s[x] === ')') { if (depth) depth--; else return [p[0], x, true]; }
      }
      return p;
    }).filter(function (p) { return sound(s, p[0], p[1]); });
  }
  // a pair the eye would accept: not a new sentence inside, and a long one is introduced («قال:», «:»)
  var INTRO = /(:|قال|يقول|قالت|قالوا|وسلم|ﷺ|بلفظ|ولفظه|نصه|حديث)\s*$/;
  function sound(s, a, b) {
    var inner = s.slice(a + 1, b).trim();
    if (!inner || /^[.،؛:]/.test(inner) || b - a > MAX_SPAN) return false;
    if (plausible(s, a, b) <= -2) return false;
    if (b - a > 400 && !INTRO.test(plain(s.slice(Math.max(0, a - 30), a)).trim())) return false;
    return true;
  }

  /* ---------------- one paragraph ---------------- */
  function quotes(s) {
    var pairs = pairStraight(s), stack = [];
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === '«' || ch === '“' || ch === '﴿' || ch === '{') stack.push(i);
      else if (ch === '»' || ch === '”' || ch === '﴾' || ch === '}') {
        var want = { '»': '«', '”': '“', '﴾': '﴿', '}': '{' }[ch];
        for (var k = stack.length - 1; k >= 0; k--) if (s[stack[k]] === want) { pairs.push([stack[k], i]); stack.splice(k); break; }
      }
    }
    // keep the outermost (a verse inside a hadith stays inside the hadith's mark)
    pairs.sort(function (a, b) { return a[0] - b[0] || b[1] - a[1]; });
    var top = [], end = -1;
    pairs.forEach(function (q) { if (q[0] > end) { top.push(q); end = q[1]; } });
    // the text of each narration (after its chain of narrators), around the quotes it holds
    var matn = findMatn(s, top), html = '', at = 0;
    function region(from, to) {
      var h = '', pos = from;
      top.forEach(function (q) {
        if (q[0] < from || q[1] >= to) return;
        var a = q[0], b = q[1], kind = classify(s, a, b);
        h += esc(s.slice(pos, a));
        h += kind ? '<span class="tf-' + kind + '"><i class="tf-m">' + esc(s[a]) + '</i>' + esc(s.slice(a + 1, b)) + '<i class="tf-m">' + esc(s[b]) + '</i></span>'
                  : esc(s.slice(a, b + 1));
        pos = b + 1;
      });
      return h + esc(s.slice(pos, to));
    }
    matn.forEach(function (m) { html += region(at, m[0]) + '<span class="tf-matn">' + region(m[0], m[1]) + '</span>'; at = m[1]; });
    return html + region(at, s.length);
  }

  /* ---------------- the text of a narration, without its chain ----------------
   * «حدثنا أبي، حدثنا عبيد، عن مجاهد، عن أبي ذر: أنه سأل رسول الله ﷺ …» — the chain runs from its first
   * «حدثنا / أخبرنا / أنبأنا / سمعت» (or «روى/أخرج … عن») to the first colon that is not followed by more
   * of the chain; the narration's text runs from there to where the author speaks again («رواه…»,
   * «وهذا إسناد…», «وقال فلان:», «قلت:») or to the end of the paragraph. */
  var CHAIN_START = /(^|[^ء-ي])و?(حدثنا|حدثني|أخبرنا|أخبرني|أنبأنا|أنبأني|ثنا|(?:روى|رواه|أخرج|أخرجه)(?![ء-ي])[^.:]{0,60}?عن)(?![ء-ي])/g;
  var CHAIN_GOES_ON = /^\s*(\u0001\d+\u0002\s*)*(و?حدثنا|و?حدثني|و?أخبرنا|و?أخبرني|أنبأنا|ثنا|ثني|سمعت|عن|حدثه|أخبره)(?![ء-ي])/;
  var AUTHOR_AGAIN = /^\s*(\u0001\d+\u0002\s*)*((و?رواه|و?أخرجه|[وف]?هذا|[وف]?هذه|[وف]?هكذا|و?اعلم|و?كذا رواه|و?إسناده|و?قد رواه|و?خرجه|و?ذكره|وذكر (?!لنا)|و?في رواية|و?في لفظ|تفرد|هذا حديث|و?قيل|و?المعنى|و?معنى|و?المراد|و?قد ذكر|و?في الحديث|و?في الصحيح|و?روى|و?أخرج)(?![ء-ي])|و?عن |و?قال (?:العلماء|المفسرون|علماؤنا)|ثم قال: (صحيح|حسن|غريب|هذا|إسناده)|وقال (?!رسول|النبي|لي|لهم|له|لها|لنا|الآخر|أحدهما|الرجل|رجل|الأعرابي|الملك|الغلام|المرأة|بعضهم)[^:.]{1,40}:|و?قال (?:الترمذي|البيهقي|الدارقطني|الحاكم|البخاري|النسائي|أبو داود|ابن ماجه|أبو زرعة|أبو حاتم|ابن المديني|علي بن المديني|ابن حبان|ابن عبد البر|أبو عمر|ابن العربي|النحاس|الأخفش|سيبويه|الفراء|الزجاج|القاضي|ابن عطية|الجوهري|القشيري|الأزهري|الزمخشري|ابن الأنباري|الطبري|ابن جرير|ابن عدي|العقيلي|الحافظ)|(?:الأولى|الثانية|الثالثة|الرابعة|الخامسة|السادسة|السابعة|الثامنة|التاسعة|العاشرة|الحادية|مسألة)\s*[-–:]|(?![^.:؟]{0,60}?قالوا:)[^.:؟]{0,60}:\s*(حدثنا|حدثني|أخبرنا|أخبرني|أنبأنا)\s+(?!ما|عن|بما|من|أي|كيف|لم|ب))/;
  function findMatn(s, top) {
    var P = plain(s), map = [], out = [];
    // plain text without tashkeel, with each plain index pointing back into s
    for (var i = 0, j = 0; i < s.length; i++) if (!/[ً-ْٰـ]/.test(s[i])) map[j++] = i;
    map[P.length] = s.length;
    var inPair = function (x) { return top.some(function (q) { return x > q[0] && x < q[1]; }); };
    CHAIN_START.lastIndex = 0;
    var m, from = 0;
    while ((m = CHAIN_START.exec(P))) {
      var at0 = m.index + m[1].length;
      if (at0 < from || inPair(map[at0])) continue;
      // the colon that ends the chain
      var c = at0, start = -1;
      while ((c = P.indexOf(':', c + 1)) >= 0 && c - at0 < 320) {
        if (inPair(map[c])) continue;
        if (CHAIN_GOES_ON.test(P.slice(c + 1, c + 30))) continue;
        if (/(يعني|أي)\s*$/.test(P.slice(c - 8, c))) continue;                       // «سمعت داود -يعني: ابن أبي هند- عن عامر:»
        if (/^[^.:؟!"«﴿]{0,60}?\s(أخبرته|أخبره|حدثته|حدثه|أخبرتني|حدثتني)(?![ء-ي])/.test(P.slice(c + 1, c + 80))) continue;
        // «-قال عبد الرحمن: حسين بن علي -قال: …» — a narrator's name and another «قال:» still belong to the chain
        var nx = /^[^.؟!"«﴿(:]{1,45}?[\s-]قال:/.exec(P.slice(c + 1, c + 60));
        if (nx && !/رسول|النبي|ﷺ/.test(nx[0])) continue;
        start = c + 1; break;
      }
      // «عن أبي هريرة، أن رسول الله ﷺ كان…» — a chain may end in «أن» instead of a colon
      var an = /\sعن\s[^:.؟]{2,70}?،?\s(?=(أن|أنه|أنها|أنهم)\s)/.exec(P.slice(at0, at0 + 320));
      if (an && (start < 0 || at0 + an.index + an[0].length < start)) start = at0 + an.index + an[0].length;
      // a sentence ends inside the «chain»: it was not a chain (or it is over), and what follows is the author's
      if (start < 0 || /[^\d]\.\s/.test(P.slice(at0, start).replace(/\d+/g, ''))) { CHAIN_START.lastIndex = at0 + 2; continue; }
      if (/^(أخبرنا|حدثنا)/.test(P.slice(at0, at0 + 6)) &&
          (/^\S+\s*(بذلك|بهذا|به|بأن|أن|أنه|الله|ربنا|،\s*ف)/.test(P.slice(at0, at0 + 20)) || /(الذي|التي|لقد|قد|كما|ما|لا|الله)\s*$/.test(P.slice(Math.max(0, at0 - 8), at0)))) {
        CHAIN_START.lastIndex = at0 + 2; continue;                                   // «لأنه هو الذي أخبرنا بذلك» is not a chain
      }
      while (P[start] === ' ') start++;
      // where the author speaks again
      var end = P.length, re = /[.؟!](?=\s|[^\d.])|["»”](?=\s*[.،]?\s)/g, e;
      re.lastIndex = start;
      while ((e = re.exec(P))) {
        var cut = e.index + 1;
        if (inPair(map[e.index])) continue;
        var rest = P.slice(cut).replace(/^[\s.،]+/, ' ');
        if (AUTHOR_AGAIN.test(rest) || (P[e.index] === '.' && !/["»”]\s*$/.test(P.slice(e.index - 3, e.index)) && /^\s*قلت\s*:/.test(rest))) { end = cut; break; }
        // a quoted saying closed by a full stop, after which the text is not the story going on
        if (/["»”)]/.test(P[e.index]) && /^\s*\./.test(P.slice(cut)) &&
            !/^\s*\[?(ف|ثم|قال|قلت|قالت|حتى|و?لما|وقال|وقالت|وكان|وإذا|قلنا|قلت يا)/.test(rest)) { end = cut; break; }
      }
      // a narration quoted in the middle of the author's own paragraph (al-Wasit, al-Qurtubi) is short:
      // without a clear end it stops at its first full stop
      if (at0 > 80 && end - start > 1200) {
        var dot = /\.(?!\d)/g, d;
        dot.lastIndex = start + 20;
        while ((d = dot.exec(P)) && d.index < end) if (!inPair(map[d.index])) { end = d.index + 1; break; }
      }
      // «…عن ابن عباس قال: كذا، وقد روى ابن أبي حاتم في هذا حديثا…» — the author takes over mid-sentence
      var cm = /،\s*(وقد روى|وقد رواه|ورواه|وأخرجه|وقد أخرجه|وهذا إسناد|وهذا حديث|وروى)(?![ء-ي])/g, k;
      cm.lastIndex = start;
      while ((k = cm.exec(P)) && k.index < end) if (!inPair(map[k.index])) { end = k.index; break; }
      // a grading on its own («صحيح على شرطهما») is not a narration
      if (/^(حسن|صحيح|غريب|حديث|إسناده|هذا حديث|هذا إسناد|لم يسمع)/.test(P.slice(start, start + 12))) { from = end; CHAIN_START.lastIndex = end; continue; }
      var a = map[start], b = map[end];
      // never cut a quotation: the text grows to cover a quote it starts inside
      top.forEach(function (q) { if (q[0] < b && q[1] >= b) b = q[1] + 1; });
      while (b > a && /[\s.،\u0001\u0002\d]/.test(s[b - 1]) && !/["»”]/.test(s[b - 1])) {
        if (s[b - 1] === '\u0002') { var o = s.lastIndexOf('\u0001', b); if (o > a) { b = o; continue; } }
        b--;
      }
      if (b - a > 12 && !inPair(a)) out.push([a, b]);
      from = end;
      CHAIN_START.lastIndex = end;
    }
    return out;
  }

  function classify(s, a, b) {
    var open = s[a], inner = s.slice(a + 1, b);
    if (open === '﴿' || open === '{') return 'q';
    var words = plain(inner).trim().split(/\s+/).filter(Boolean).length;
    if (!words) return '';
    var after = s.slice(b + 1, b + 40);
    if (/^\s*[\[(][^\]\)]{2,30}:\s*[0-9٠-٩\s]+[\])]/.test(after)) return 'q';
    if (/راجع ج\s*[0-9٠-٩]+\s*ص\s*[0-9٠-٩]+\.?\s*$/.test(inner)) return 'q';      // al-Qurtubi's «… راجع ج ٣ ص ٣٧٥.»
    if (words >= 2 && G.TafsirRich.isQuran && G.TafsirRich.isQuran(inner)) return 'q';
    if (words <= 3) return 'term';
    var before = plain(s.slice(Math.max(0, a - 200), a)).replace(/\s+/g, ' ');
    if (PROPHET_NEAR.test(before)) return 'hadith';
    return 'say';
  }

  // a verse of poetry standing as its own paragraph: two halves joined by «...», no long prose
  function poetryLine(p) {
    var t = plain(p).replace(/\u0001\d+\u0002/g, '').trim();
    var halves = t.split(/\s*\.\.\.\s*/);
    return halves.length === 2 && halves[0].split(/\s+/).length >= 2 && halves[1].split(/\s+/).length >= 2 &&
      t.split(/\s+/).length <= 22 && !/[:"«]/.test(t);
  }

  function html(text) {
    if (!text) return '';
    var notes = [];
    // the editor's footnotes first, across lines: their own quotes stay theirs, never a highlight
    var t = String(text).replace(/\r/g, '').replace(/\[\[([\s\S]*?)\]\]/g, function (m, inner) { notes.push(inner); return '\u0001' + (notes.length - 1) + '\u0002'; });
    // consecutive verses of one poem are one block, a line per verse
    var out = '', poem = [];
    function flush() { if (poem.length) { out += '<p class="tf-p"><span class="tf-poem">' + poem.map(esc).join('<br>') + '</span></p>'; poem = []; } }
    t.split(/\n/).map(function (p) { return p.trim(); }).filter(Boolean).forEach(function (p) {
      if (poetryLine(p)) { poem.push(p); return; }
      flush();
      out += '<p class="tf-p">' + quotes(p) + '</p>';
    });
    flush();
    return out.replace(/\u0001(\d+)\u0002/g, function (m, i) {
      return '<span class="tf-fn" title="حاشية المحقق">' + esc(notes[+i]).replace(/\n+/g, ' ') + '</span>';
    });
  }

  var KINDS = [['matn', 'نص الرواية'], ['hadith', 'حديث نبوي'], ['say', 'كلام منقول'], ['q', 'آية'], ['poem', 'شعر'], ['fn', 'حاشية المحقق']];
  function legend(h) {
    var have = KINDS.filter(function (k) { return h.indexOf('class="tf-' + k[0] + '"') >= 0; });
    if (!have.length) return '';
    return '<div class="tf-legend" aria-hidden="true">' + have.map(function (k) {
      return '<span class="tf-key tf-key-' + k[0] + '">' + k[1] + '</span>'; }).join('') + '</div>';
  }

  /* is this quoted text a piece of the Qur'an? The mushaf's spelling (السماوات، الصلوة) and the books'
     (السموات، الصلاة) differ in their long vowels, so a second index keeps only the consonant skeleton */
  var QI = null;
  function nrm(t) {
    return String(t).replace(/[ً-ْٰـۖ-ۭ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه').replace(/[^ء-ي ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function skel(t) { return nrm(t).replace(/[اويءؤئ]/g, '').replace(/\s+/g, ' ').trim(); }
  function isQuran(t) {
    if (!QI) {
      var texts = G.TafsirRich.quranTexts ? G.TafsirRich.quranTexts() : null;
      if (!texts || !texts.length) return false;
      QI = { exact: ' ' + texts.map(nrm).join(' ') + ' ', skel: ' ' + texts.map(skel).join(' ') + ' ' };
    }
    var n = nrm(t), w = n.split(' ').length;
    if (w >= 2 && QI.exact.indexOf(' ' + n + ' ') >= 0) return true;
    var k = skel(t);
    return w >= 3 && k.length >= 8 && QI.skel.indexOf(' ' + k + ' ') >= 0;
  }

  // quranTexts: set by the page — a function returning every ayah's text (read once, on first use)
  G.TafsirRich = { html: html, legend: legend, isQuran: isQuran, quranTexts: null, _pair: pairStraight, _classify: classify };
})(typeof window !== 'undefined' ? window : globalThis);
