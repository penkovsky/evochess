// Pictograms for the mobile widget bar. Inline SVG (rather than an icon font
// or emoji) so they inherit `currentColor` from the button and render
// identically across platforms.

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Svg({ children, ...rest }: { children: React.ReactNode } & React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

/** Academic bonnet — the tutorial. */
export function CapIcon() {
  return (
    <Svg fill="currentColor">
      <path d="M12 3.2 1.4 8.4 12 13.6l10.6-5.2L12 3.2z" />
      <path d="M5.6 11.4v3.9c0 1.7 2.9 3 6.4 3s6.4-1.3 6.4-3v-3.9L12 14.6l-6.4-3.2z" />
      <path d="M21.4 9.2v4.6" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
    </Svg>
  );
}

/** Papyrus scroll — the rules summary. */
export function ScrollIcon() {
  return (
    <Svg {...stroke}>
      <path d="M7 4.5h10a1.5 1.5 0 0 1 1.5 1.5v11.5a2 2 0 0 0 2 2H8.5a2 2 0 0 1-2-2V6a1.5 1.5 0 0 0-3 0v1.8H6.5" />
      <path d="M9.8 9h5.6M9.8 12.4h5.6" />
    </Svg>
  );
}

/** Bound journal — the move log. */
export function BookIcon() {
  return (
    <Svg {...stroke}>
      <path d="M4.5 5A2.5 2.5 0 0 1 7 2.5h12.5v15.8H7A2.5 2.5 0 0 0 4.5 20.8V5z" />
      <path d="M4.5 20.8A2.5 2.5 0 0 1 7 18.3h12.5v3.2H7a2.5 2.5 0 0 1-2.5-2.5" />
      <path d="M8.5 7h7.5M8.5 10.4h7.5" />
    </Svg>
  );
}

/** Gear — the settings sheet. */
export function GearIcon() {
  return (
    <Svg fill="currentColor">
      <path d="M19.2 12.9a7.1 7.1 0 0 0 0-1.9l2-1.6a.5.5 0 0 0 .1-.6l-1.9-3.3a.5.5 0 0 0-.6-.2l-2.4 1a7 7 0 0 0-1.6-1l-.4-2.5a.5.5 0 0 0-.5-.4h-3.8a.5.5 0 0 0-.5.4l-.4 2.5c-.6.2-1.1.6-1.6 1l-2.4-1a.5.5 0 0 0-.6.2L2.7 8.8a.5.5 0 0 0 .1.6l2 1.6a7.1 7.1 0 0 0 0 1.9l-2 1.6a.5.5 0 0 0-.1.6l1.9 3.3c.1.2.4.3.6.2l2.4-1c.5.4 1 .7 1.6 1l.4 2.5c0 .2.3.4.5.4h3.8c.3 0 .5-.2.5-.4l.4-2.5c.6-.2 1.1-.6 1.6-1l2.4 1c.2.1.5 0 .6-.2l1.9-3.3a.5.5 0 0 0-.1-.6l-2-1.6zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" />
    </Svg>
  );
}

/** Arrow curving back on itself — the takeback. */
export function UndoIcon() {
  return (
    <Svg {...stroke} strokeWidth={2}>
      <path d="M4 8.5h9.5a5.5 5.5 0 1 1 0 11H7" />
      <path d="M7.5 4.5 3.5 8.5l4 4" />
    </Svg>
  );
}

/** Chevron left — step one ply back. */
export function ChevronLeftIcon() {
  return (
    <Svg {...stroke} strokeWidth={2.2}>
      <path d="M15 5 8 12l7 7" />
    </Svg>
  );
}

/** Chevron right — step one ply forward. */
export function ChevronRightIcon() {
  return (
    <Svg {...stroke} strokeWidth={2.2}>
      <path d="M9 5l7 7-7 7" />
    </Svg>
  );
}

/** Pawn — play on from the ply on screen, discarding what came after. */
export function PawnIcon() {
  return (
    <Svg fill="currentColor">
      <circle cx="12" cy="6.2" r="3.1" />
      <path d="M9.1 9.4h5.8l-.9 2.2c-.6 1.5.1 3 1.1 4.2 1 1.2 1.6 2.2 1.8 3.2H7.1c.2-1 .8-2 1.8-3.2 1-1.2 1.7-2.7 1.1-4.2L9.1 9.4z" />
      <rect x="5.8" y="19.6" width="12.4" height="2.2" rx="1.1" />
    </Svg>
  );
}

/** Jigsaw piece — a tab on one edge, a socket on another — the daily puzzle. */
export function PuzzleIcon() {
  return (
    <Svg {...stroke}>
      <path d="M4.5 9.2V5.4a.9.9 0 0 1 .9-.9h3.8a2 2 0 1 1 4 0h3.4a.9.9 0 0 1 .9.9v3.8a2 2 0 1 1 0 4v4.4a.9.9 0 0 1-.9.9h-4.4a2 2 0 1 0-4 0H5.4a.9.9 0 0 1-.9-.9v-3.4a2 2 0 1 1 0-4z" />
    </Svg>
  );
}

/** Share graph — one node fanning out to two — the outbound share dialog. */
export function ShareIcon() {
  return (
    <Svg {...stroke}>
      <circle cx="7" cy="12" r="2.2" />
      <circle cx="16.5" cy="6.8" r="2.2" />
      <circle cx="16.5" cy="17.2" r="2.2" />
      <path d="M9 10.9 14.5 7.9" />
      <path d="M9 13.1 14.5 16.1" />
    </Svg>
  );
}
