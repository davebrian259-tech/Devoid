// Layout check run inside the page by the browser tests (ui-smoke.py, web-smoke.py). Returns a list
// of problems, empty when the layout is clean:
//  - two visible, in-flow siblings whose boxes overlap (the classic "one card sits on another");
//  - an element whose content spills out of a box that hides or scrolls it sideways, and the page
//    itself scrolling sideways;
//  - a fixed bar (the phone tab bar) that would cover the end of the page: the page must leave
//    room under its last content for it;
//  - an absolutely positioned picture (the landing page's phone mockup) sitting on top of text that
//    belongs to the page's flow.
// Positioned elements (absolute, fixed, sticky) are decoration or overlays by design and are skipped
// as siblings, as is anything marked data-overlap-ok, which also exempts an overlay meant to cover
// the page.
(() => {
  const problems = [];
  const visible = (e) => {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const inFlow = (e) => !['absolute', 'fixed', 'sticky'].includes(getComputedStyle(e).position) && !e.closest('[data-overlap-ok]');
  const name = (e) => {
    let n = e.tagName.toLowerCase();
    if (e.id) n += `#${e.id}`;
    const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) n += `.${cls.join('.')}`;
    const text = (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return text ? `${n} "${text}"` : n;
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'svg', 'SVG', 'BR', 'OPTION', 'TEMPLATE', 'HEAD']);

  // Boxes inside a 3D-tilted element are projected, so they can intersect when the layout does not.
  const tilted = (e) => { for (let x = e; x; x = x.parentElement) if (getComputedStyle(x).transform.startsWith('matrix3d')) return true; return false; };

  for (const parent of document.querySelectorAll('body, body *')) {
    if (SKIP.has(parent.tagName) || parent.closest('svg') || !visible(parent) || tilted(parent)) continue;
    const kids = [...parent.children].filter((k) => !SKIP.has(k.tagName) && visible(k) && inFlow(k));
    const boxes = kids.map((k) => k.getBoundingClientRect());
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = boxes[i], b = boxes[j];
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        // Inline text boxes can touch by a pixel or two at line edges; a real overlap is bigger.
        if (w > 2 && h > 2) problems.push(`overlap: ${name(kids[i])} and ${name(kids[j])} (${Math.round(w)}x${Math.round(h)}px)`);
      }
    }
    // Two things lifted out of the same box can still collide with each other: the hero's phone
    // mockup once sat on the caption beside it, and both were absolute. An overlay meant to cover
    // what is under it belongs in a [data-overlap-ok] box.
    const lifts = [...parent.children].filter((k) => !SKIP.has(k.tagName) && visible(k) && getComputedStyle(k).position === 'absolute' && !k.closest('[data-overlap-ok]'));
    for (let i = 0; i < lifts.length; i++) {
      for (let j = i + 1; j < lifts.length; j++) {
        const a = lifts[i].getBoundingClientRect(), b = lifts[j].getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 2) problems.push(`overlap: ${name(lifts[i])} and ${name(lifts[j])} (${Math.round(w)}x${Math.round(h)}px)`);
      }
    }

    const s = getComputedStyle(parent);
    if (['hidden', 'clip'].includes(s.overflowX) && parent.scrollWidth > parent.clientWidth + 2 && s.textOverflow !== 'ellipsis' && !parent.matches('.sens, .redact, .redact *')) {
      problems.push(`clipped: ${name(parent)} needs ${parent.scrollWidth}px, has ${parent.clientWidth}px`);
    }
  }
  // A picture lifted out of the flow still owes the flow its space: the hero's phone mockup once
  // covered the caption that explains it. Text inside anything positioned is skipped, since an
  // overlay is free to cover the page beneath it.
  const lifted = (e) => { for (let x = e; x && x !== document.body; x = x.parentElement) if (['absolute', 'fixed', 'sticky'].includes(getComputedStyle(x).position)) return true; return false; };
  const words = [...document.querySelectorAll('body *')].filter((e) => !SKIP.has(e.tagName) && !e.closest('svg') && !e.children.length && (e.innerText || '').trim() && visible(e) && !lifted(e) && !e.closest('[data-overlap-ok]'));
  for (const pic of document.querySelectorAll('img, picture, video, [style*="background-image"]')) {
    let box = null;
    for (let x = pic; x && x !== document.body; x = x.parentElement) if (getComputedStyle(x).position === 'absolute') { box = x; break; }
    if (!box || !visible(box) || box.closest('[data-overlap-ok]') || tilted(box)) continue;
    const a = box.getBoundingClientRect();
    for (const w of words) {
      if (box.contains(w)) continue;
      const b = w.getBoundingClientRect();
      const ow = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oh = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ow > 2 && oh > 2) problems.push(`covered: ${name(box)} sits on ${name(w)} (${Math.round(ow)}x${Math.round(oh)}px)`);
    }
  }

  if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth}px wide in a ${innerWidth}px window`);

  // Fixed bars along the bottom must not be able to hide the last of the page.
  for (const bar of document.querySelectorAll('body *')) {
    if (getComputedStyle(bar).position !== 'fixed' || !visible(bar)) continue;
    const r = bar.getBoundingClientRect();
    if (r.bottom < innerHeight - 4 || r.top < innerHeight / 2 || bar.tagName === 'DIALOG' || bar.classList.contains('toast')) continue;
    const room = innerHeight - r.top;
    const end = document.scrollingElement.scrollHeight;
    let last = 0;
    for (const e of document.querySelectorAll('main *')) {
      if (!visible(e) || bar.contains(e) || !inFlow(e) || e.children.length) continue;
      last = Math.max(last, e.getBoundingClientRect().bottom + scrollY);
    }
    if (last && end - last < room - 1) problems.push(`covered: ${name(bar)} hides the last ${Math.round(room - (end - last))}px of the page`);
  }
  return [...new Set(problems)];
})()
