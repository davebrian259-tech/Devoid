// Hand-drawn line icons. Square caps, 1.8 stroke; nothing from an icon pack.
const P = {
  send: 'M3 12h13M12 6l6 6-6 6M3 5v14',
  receive: 'M21 12H8M12 6L6 12l6 6M21 5v14',
  activity: 'M3 18h4V9h4v6h4V6h4v12',
  lists: 'M4 5h16M4 10h10M4 15h16M4 20h10',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6',
  sent: 'M5 19L19 5M9 5h10v10',
  received: 'M19 5L5 19M15 19H5V9',
  shielded: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z',
  internal: 'M5 12h14M8 8l-4 4 4 4M16 8l4 4-4 4',
  copy: 'M8 8h11v11H8zM5 15V5h10',
  check: 'M4 12l5 5L20 6',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 016 0v3',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13',
};
export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'square'); s.setAttribute('stroke-linejoin', 'miter');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', P[name] ?? P.check); s.appendChild(p);
  return s;
}
export function mark() {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg'); s.setAttribute('viewBox', '0 0 32 32'); s.setAttribute('aria-hidden', 'true');
  const mk = (t, a) => { const e = document.createElementNS(ns, t); for (const k in a) e.setAttribute(k, a[k]); s.appendChild(e); };
  mk('rect', { width: 32, height: 32, fill: '#0d0f1f' });
  mk('circle', { cx: 16, cy: 16, r: 8.5, fill: 'none', stroke: '#eceee9', 'stroke-width': 3 });
  mk('rect', { x: 4, y: 14, width: 19, height: 4, fill: '#d9980a' });
  return s;
}
