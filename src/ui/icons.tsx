// 24px stroke icons.
const P: Record<string, JSX.Element> = {
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  bell: <><path d="M6 9a6 6 0 1 1 12 0c0 6.5 2.5 8 2.5 8h-17S6 15.5 6 9z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>,
  egg: <path d="M12 3C8.2 3 5.5 8.6 5.5 13a6.5 6.5 0 0 0 13 0C18.5 8.6 15.8 3 12 3z" />,
  crack: <><path d="M12 3C8.2 3 5.5 8.6 5.5 13a6.5 6.5 0 0 0 13 0C18.5 8.6 15.8 3 12 3z" /><path d="M7 12l2.5 1.5L11 11l2 2.5 1.6-1.6L17 13" /></>,
  sack: <><path d="M8 3h8l-1.5 3.5L18 11v8.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5V11l3.5-4.5z" /><path d="M9.5 6.5h5M9 15h6" /></>,
  scoop: <><path d="M4 14h12l3-6H7z" /><path d="M16 14v6M8 11h2" /></>,
  drop: <path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z" />,
  tank: <><rect x="5" y="4" width="14" height="16" rx="2" /><path d="M5 13h14M9 4v2M15 4v2" /></>,
  syringe: <path d="M17 3l4 4M19 5l-8.5 8.5M14 6l4 4M11.5 8.5L5 15v4h4l6.5-6.5M3 21l2-2" />,
  bird: <><path d="M16 7h.01" /><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.3-2.3L2 20" /><path d="M20 7l2 .5-2 .5M10 18v3M14 17.7V21" /></>,
  truck: <><path d="M2 6h12v10H2zM14 9.5h4l3.5 3.5v3H14" /><circle cx="6" cy="17.5" r="1.8" /><circle cx="17.5" cy="17.5" r="1.8" /></>,
  store: <path d="M4 10v10h16V10M3 10l2-6h14l2 6zM9.5 20v-5h5v5" />,
  cash: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6 9.5v5M18 9.5v5" /></>,
  swap: <path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5" />,
  report: <><path d="M6 2.5h8.5L19 7v14.5H6z" /><path d="M14 2.5V7h5M9 12.5h7M9 16.5h5" /></>,
  dash: <><rect x="3.5" y="3.5" width="7" height="8" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="5" rx="1.5" /><rect x="13.5" y="11.5" width="7" height="9" rx="1.5" /><rect x="3.5" y="14.5" width="7" height="6" rx="1.5" /></>,
  box: <><path d="M3 7.5L12 3l9 4.5-9 4.5z" /><path d="M3 7.5v9L12 21l9-4.5v-9M12 12v9" /></>,
  list: <path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M4.5 12.5l5 5L20 7" />,
  alert: <><path d="M12 3.5L22 20.5H2z" /><path d="M12 10v4.5M12 17.5h.01" /></>,
  inbox: <><path d="M12 3v11M7.5 9.5L12 14l4.5-4.5" /><path d="M3.5 14v6h17v-6" /></>,
  wallet: <><path d="M3.5 7.5h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-15z" /><path d="M3.5 7.5l11-3.5v3.5M15.5 14h2" /></>,
  receipt: <><path d="M6 2.5h12v19l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14a6.5 6.5 0 0 1 3 6" /></>,
  crown: <path d="M3 18h18M4 8l4 4 4-7 4 7 4-4-1.5 10h-13z" />,
  sliders: <><path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h12" /><circle cx="16" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  logout: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11" />,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  pulse: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  count: <><rect x="4" y="3.5" width="16" height="17" rx="2" /><path d="M8 8h8M8 12h8M8 16h4" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  undo: <><path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" /><path d="M4 4v4.5h4.5" /></>,
  back: <path d="M15 5l-7 7 7 7" />,
};
export function Icon({ name, size }: { name: string; size?: number }) {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true" style={size ? { width: size, height: size } : undefined}>
      {P[name] ?? null}
    </svg>
  );
}
