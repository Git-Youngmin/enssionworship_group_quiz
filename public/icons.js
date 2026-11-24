// 직접 그린 선(stroke) 아이콘. 이모지는 기기마다 모양이 달라서 구조에 쓰이는 아이콘은 모두 이걸로 대체한다.
// 색은 글자색(currentColor)을 따라가고, 굵기는 모두 같다.
const NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  // 어워드
  magnifier: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/><path d="M8.8 9.2a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3"/><path d="M10.5 14h.01"/>',
  mask: '<path d="M3 9c3-2 6-2 9 0 3-2 6-2 9 0v2c0 3-2 5-4.5 5-1.5 0-2.5-1-4.5-1s-3 1-4.5 1C5 16 3 14 3 11z"/><circle cx="8" cy="11.5" r="1.2"/><circle cx="16" cy="11.5" r="1.2"/>',
  book: '<path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5z"/><path d="M12 6.5v13"/>',
  bubble: '<path d="M4 5h16v11h-9l-4 4v-4H4z"/><path d="M12 8.5v3"/><path d="M12 13.5h.01"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 4"/><path d="M17 6h3a3 3 0 0 1-3 4"/><path d="M12 14v4"/><path d="M8.5 20h7"/>',
  // 상태·동작
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M9 21h6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  hourglass: '<path d="M7 3h10"/><path d="M7 21h10"/><path d="M8 3v3.5c0 2 2 3 4 5.5-2 2.5-4 3.5-4 5.5V21"/><path d="M16 3v3.5c0 2-2 3-4 5.5 2 2.5 4 3.5 4 5.5V21"/>',
  clipboard: '<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 11h6"/><path d="M9 15h4"/>',
  share: '<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  join: '<circle cx="10" cy="8" r="3.4"/><path d="M3.5 20c.6-4 3-6 6.5-6s5.9 2 6.5 6"/><path d="M19 5v6"/><path d="M16 8h6"/>',
  door: '<path d="M6 21V4h9v17"/><path d="M4 21h16"/><path d="M12.5 12.5h.01"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.6a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1 .9-1 1.6"/><path d="M12 16.8h.01"/>',
};

export function icon(name, { size = 22, label } = {}) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('class', 'ico');
  if (label) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', label); } else s.setAttribute('aria-hidden', 'true');
  s.innerHTML = PATHS[name] ?? PATHS.question;
  return s;
}
