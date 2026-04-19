const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${body}</svg>`;

export const ICONS: Record<string, string> = {
  pencil: svg(`<path d="M4 20l4-1 10-10-3-3L5 16l-1 4z"/><path d="M14 6l3 3"/>`),
  erase: svg(`<path d="M4 17l7 7 9-9-7-7z"/><path d="M10 10l7 7"/>`),
  fill: svg(`<path d="M5 11l7-7 8 8-7 7a2 2 0 0 1-3 0l-5-5a2 2 0 0 1 0-3z"/><path d="M20 18c0 1.5-1.5 3-1.5 3S17 19.5 17 18a1.5 1.5 0 0 1 3 0z" fill="currentColor"/>`),
  undo: svg(`<path d="M8 5L3 10l5 5"/><path d="M3 10h11a6 6 0 1 1 0 12h-3"/>`),
  clear: svg(`<path d="M5 7h14"/><path d="M9 7V4h6v3"/><path d="M7 7l1 14h8l1-14"/>`),
  "flip-h": svg(`<path d="M12 3v18"/><path d="M8 7l-5 5 5 5z" fill="currentColor"/><path d="M16 7l5 5-5 5z"/>`),
  "flip-v": svg(`<path d="M3 12h18"/><path d="M7 8l5-5 5 5z" fill="currentColor"/><path d="M7 16l5 5 5-5z"/>`),
  rotate: svg(`<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 4v5h-5"/>`),
  "shift-right": svg(`<path d="M4 12h14"/><path d="M14 6l6 6-6 6"/>`),
  "shift-up": svg(`<path d="M12 20V6"/><path d="M6 10l6-6 6 6"/>`),
  "add-frame": svg(`<path d="M12 5v14"/><path d="M5 12h14"/>`),
  download: svg(`<path d="M12 4v12"/><path d="M6 10l6 6 6-6"/><path d="M4 20h16"/>`),
  share: svg(`<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="5" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8 11l8-5"/><path d="M8 13l8 5"/>`),
  publish: svg(`<path d="M12 20V6"/><path d="M6 12l6-6 6 6"/><path d="M4 4h16"/>`),
};
