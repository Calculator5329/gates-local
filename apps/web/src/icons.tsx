// The send arrow adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The sprite's icons except i-mark are Lucide icons, copied or simplified (ISC, Lucide Contributors; portions MIT, Cole Bemis, Feather); full notice in LICENSES/Lucide-ISC.txt.
// The icon sprite from docs/design/shell.html, verbatim, and the two ways the
// client draws from it. Render <Sprite /> once at the root; <Icon id="pen" />
// then draws <svg class="ic"><use href="#i-pen"/></svg> like the design does.

export type IconId =
  | "star" | "mark" | "pen" | "search" | "gear" | "down" | "up" | "vol" | "vol-off" | "left" | "arrow" | "check" | "checkc"
  | "x" | "xc" | "clock" | "plus" | "clip" | "alert" | "lock" | "file" | "image" | "bulb" | "copy" | "redo"
  | "spin" | "download" | "more" | "chat" | "book" | "cpu" | "server" | "db" | "folder" | "sliders"
  | "pencil" | "trash" | "box" | "wrench" | "keyboard" | "menu" | "gauge" | "right" | "speed"
  | "refresh" | "fetch" | "external" | "bot" | "bars" | "snail";

export function Icon({ id, cls }: { id: IconId; cls?: string }) {
  return (
    <svg className={cls ? `ic ${cls}` : "ic"} aria-hidden="true">
      <use href={`#i-${id}`} />
    </svg>
  );
}

/** The send arrow, drawn inline at 14 px like the design's ARROW constant. */
export function SendArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Sprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <symbol id="i-star" viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" /></symbol>
        <symbol id="i-mark" viewBox="0 0 20 20">
          <path d="M3 17V5.5h14V17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M1.5 3h17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M7.5 17V9.5h5V17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </symbol>
        <symbol id="i-pen" viewBox="0 0 24 24"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z" /></symbol>
        <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></symbol>
        <symbol id="i-gear" viewBox="0 0 24 24"><path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.6a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.6a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3" /></symbol>
        <symbol id="i-down" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></symbol>
        <symbol id="i-left" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></symbol>
        <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></symbol>
        <symbol id="i-up" viewBox="0 0 24 24"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></symbol>
        <symbol id="i-vol" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.4 5.6a9 9 0 0 1 0 12.8" /></symbol>
        <symbol id="i-vol-off" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="m16 9 6 6" /><path d="m22 9-6 6" /></symbol>
        <symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></symbol>
        <symbol id="i-checkc" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></symbol>
        <symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></symbol>
        <symbol id="i-xc" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" /></symbol>
        <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></symbol>
        <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
        <symbol id="i-clip" viewBox="0 0 24 24"><path d="m21.4 11-8.9 8.9a5.5 5.5 0 0 1-7.8-7.8l8.9-8.9a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.9a1.8 1.8 0 0 1-2.6-2.6l8.2-8.2" /></symbol>
        <symbol id="i-alert" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 8v4" /><path d="M12 16h.01" /></symbol>
        <symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></symbol>
        <symbol id="i-file" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></symbol>
        <symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" /></symbol>
        <symbol id="i-bulb" viewBox="0 0 24 24"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" /><path d="M9 18h6" /><path d="M10 22h4" /></symbol>
        <symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></symbol>
        <symbol id="i-redo" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></symbol>
        <symbol id="i-spin" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.6" /></symbol>
        <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 15V3" /><path d="m7 10 5 5 5-5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></symbol>
        <symbol id="i-more" viewBox="0 0 24 24"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></symbol>
        <symbol id="i-chat" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></symbol>
        <symbol id="i-book" viewBox="0 0 24 24"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></symbol>
        <symbol id="i-cpu" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></symbol>
        <symbol id="i-server" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01" /></symbol>
        <symbol id="i-db" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></symbol>
        <symbol id="i-folder" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></symbol>
        <symbol id="i-wrench" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" /></symbol>
        <symbol id="i-keyboard" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" /></symbol>
        <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M20 7h-9" /><path d="M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></symbol>
        <symbol id="i-pencil" viewBox="0 0 24 24"><path d="M12 20h9" /><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></symbol>
        {/* client addition: the phone top bar's drawer button, two lines like T3's and Claude's */}
        <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 8h16" /><path d="M4 16h10" /></symbol>
        <symbol id="i-right" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></symbol>
        <symbol id="i-gauge" viewBox="0 0 24 24"><path d="m12 14 4-4" /><path d="M3.3 19a10 10 0 1 1 17.4 0" /></symbol>
        <symbol id="i-trash" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15" /></symbol>
        <symbol id="i-box" viewBox="0 0 24 24"><path d="M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8" /></symbol>
        {/* client addition: measured speed (Lucide circle-gauge), apart from the context gauge above */}
        <symbol id="i-speed" viewBox="0 0 24 24"><path d="M15.6 2.7a10 10 0 1 0 5.7 5.7" /><circle cx="12" cy="12" r="2" /><path d="M13.4 10.6 19 5" /></symbol>
        {/* client addition: a measured model too slow to use (Lucide snail) */}
        <symbol id="i-snail" viewBox="0 0 24 24"><path d="M2 13a6 6 0 1 0 12 0 4 4 0 1 0-8 0 2 2 0 0 0 4 0" /><circle cx="10" cy="13" r="8" /><path d="M2 21h12c4.4 0 8-3.6 8-8V7a2 2 0 1 0-4 0v6" /><path d="M18 3 19.1 5.2" /><path d="M22 3 20.9 5.2" /></symbol>
        {/* client addition: Models everywhere (Lucide bot) and the footer's Usage (Lucide chart-no-axes-column) */}
        <symbol id="i-bot" viewBox="0 0 24 24"><path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2M20 14h2M15 13v2M9 13v2" /></symbol>
        <symbol id="i-bars" viewBox="0 0 24 24"><path d="M18 20V10M12 20V4M6 20v-6" /></symbol>
        {/* client addition: the sidebar footer's update icon (idle and ready, available, cannot update itself) */}
        <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></symbol>
        <symbol id="i-fetch" viewBox="0 0 24 24"><path d="M12 4v11" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></symbol>
        <symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4h6v6" /><path d="m20 4-9 9" /><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4" /></symbol>
      </defs>
    </svg>
  );
}
