/* Arabic letters join across inline elements: «<b>تجادل</b><span>تدافع</span>» is shaped as ONE word, so the last
 * letter of the first takes its joined form and the two run into each other (the «cut» word of 2026-11-19).
 * In the page: window.__joinAudit() -> the places where two inline runs touch with an Arabic letter on both sides
 * and no space between them, inside the same line box. Used by tests/arabic_join_e2e.py. */
window.__joinAudit = function (root) {
  const AR = /[ؠ-يٮ-ۓۺ-ۿ]/;            // letters (not marks, not digits)
  const MARKS = /[ً-ٰٟۖ-ۭـ‍]*$/;   // harakat at a word's end do not separate
  const lineBox = (n) => {                                              // the box whose text is shaped together
    let e = n.parentElement;
    while (e && getComputedStyle(e).display === 'inline') e = e.parentElement;
    return e;
  };
  const visible = (n) => { const e = n.parentElement; return e && e.getClientRects().length > 0; };
  const w = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.textContent.length && visible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  const out = [];
  let prev = null;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (prev && prev.parentElement !== n.parentElement) {
      const a = prev.textContent.replace(MARKS, ''), b = n.textContent;
      if (a && b && AR.test(a.slice(-1)) && AR.test(b[0]) && lineBox(prev) === lineBox(n)) {
        // nothing between them but inline elements (a <br> or an image would end the run)
        const r = document.createRange(); r.setStartAfter(prev); r.setEndBefore(n);
        const between = r.cloneContents().querySelector('br, img, svg, input, button');
        if (!between) {
          const box = lineBox(n);
          out.push({ a: a.slice(-12), b: b.slice(0, 12), where: (box.id ? '#' + box.id : '') + '.' + String(box.className).split(' ')[0] });
        }
      }
    }
    prev = n;
  }
  return out;
};
