/** Minimal stroke icons on a 24×24 grid. */
const PATHS = {
  move: "M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3",
  "marquee-rect": "M4 4h3M10 4h4M17 4h3v3M20 10v4M20 17v3h-3M14 20h-4M7 20H4v-3M4 14v-4M4 7V4",
  "marquee-ellipse": "M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z",
  lasso: "M7 17c-2-1.5-3-3.4-3-5.5C4 7.4 7.6 4 12 4s8 3.4 8 7.5S16.4 19 12 19c-1.4 0-2.6-.3-3.7-.8M7 17c-1 1.4-1 3 .5 4",
  wand: "M4 20L15 9M17 3v3M20 7h-3M19.5 4.5l-2 2M13 4l1 2M20 11l-2-1",
  brush: "M19 4l1 1-8.5 10.5-3-3L19 4zM8.5 12.5c-2 0-3.5 1.5-3.5 3.5 0 1.5-1 2.5-2 3 3 1 7 0 7.5-3.5",
  eraser: "M15 4l5 5-9 9H7l-3-3 11-11zM11 18h9M9 10l5 5",
  bucket: "M5 11l7-7 7 7-7 7-7-7zM5 11h14M20 15s1.5 2 1.5 3a1.5 1.5 0 0 1-3 0c0-1 1.5-3 1.5-3z",
  eyedropper: "M16 4l4 4-2 2-4-4 2-2zM14 6l-9 9v4h4l9-9",
  hand: "M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 6-6 6-2.5 0-4-1-5.5-3L4 14.5a1.5 1.5 0 0 1 2.3-1.9L8 14",
  zoom: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L20 20M8 10.5h5M10.5 8v5",
  rectangle: "M4 6h16v12H4z",
  ellipse: "M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z",
  triangle: "M12 4l9 16H3z",
  polygon: "M12 3l8.6 6.2-3.3 10.1H6.7L3.4 9.2z",
  line: "M4 20L20 4",
  crop: "M7 2v15h15M2 7h15v15",
  "perspective-crop": "M7 3l-1 14h15M2 8l14-1 1 14M9 12l7-.5",
  straighten: "M3 16L21 8M5 20h14M12 12v.01",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1",
  grid: "M4 4h16v16H4zM9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16",
  smart: "M5 4h10l4 4v12H5zM14 4v5h5M9 14l2 2 4-4",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5a1.5 1.5 0 1 0 0-.01",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  plus: "M12 5v14M5 12h14",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  merge: "M6 4v6l6 6 6-6V4M12 16v4",
  check: "M5 12l5 5L20 7",
  x: "M6 6l12 12M18 6L6 18",
  swap: "M15 4l3 3-3 3M18 7H9M9 20l-3-3 3-3M6 17h9",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  folder: "M3 6h6l2 2h10v11H3z",
  chevron: "M9 6l6 6-6 6",
  adjust: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v18M12 3a9 9 0 0 1 0 18",
  mask: "M4 4h16v16H4zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  clip: "M8 4v9a3 3 0 0 0 3 3h8M16 13l3 3-3 3",
  "type-horizontal": "M5 6V4h14v2M12 4v16M9 20h6",
  "type-vertical": "M4 6V4h10v2M9 4v14M7 18h4M19 8v12M17 18l2 2 2-2",
  "type-mask-horizontal": "M5 6V4h3M11 4h2M16 4h3v2M12 7v2M12 12v2M12 17v3M9 20h1M14 20h1",
  "type-mask-vertical": "M4 6V4h3M10 4h1M13 4h1v2M9 7v2M9 12v2M9 17v1M7 18h1M10 18h1M19 8v12M17 18l2 2 2-2",
  pen: "M5 19l2-6 9-9 4 4-9 9zM7 13l4 4M4 20l4-4M14 6l4 4",
  "freeform-pen": "M13 13l4-4 3 3-4 4zM13 13l-1 4 4-1M3 18c2-4 3 1 5-2s1-3 3-4",
  "curvature-pen": "M13 13l4-4 3 3-4 4zM13 13l-1 4 4-1M3 19c1-8 5-9 8-6",
  "add-anchor": "M4 18l1.5-5 8-8 3.5 3.5-8 8zM6 13l3 3M18 17h4M20 15v4",
  "delete-anchor": "M4 18l1.5-5 8-8 3.5 3.5-8 8zM6 13l3 3M17 18h5",
  "convert-point": "M4 19L12 6l8 13M12 6v.01M8.5 19h7",
  "path-select": "M6 3l12 9-5.2 1 3 6-2.6 1.2-3-6.2L6 19z",
  "direct-select": "M7 3l11 8.5-5.2 1 3 5.7-2.6 1.2-3-5.9L7 17.5zM3 21h3v-3",
  text: "M4 4h16v16H4zM8 8h8M12 8v9",
  warp: "M4 9c4-4 12-4 16 0M4 16c4-4 12-4 16 0M8 6.5V14M12 5v8M16 6.5V14",
  panels: "M4 6h10M4 10h16M4 14h16M4 18h12",
  "align-left": "M4 6h16M4 10h10M4 14h16M4 18h10",
  "align-center": "M4 6h16M7 10h10M4 14h16M7 18h10",
  "align-right": "M4 6h16M10 10h10M4 14h16M10 18h10",
  "justify-left": "M4 6h16M4 10h16M4 14h16M4 18h9",
  "justify-center": "M4 6h16M4 10h16M4 14h16M7.5 18h9",
  "justify-right": "M4 6h16M4 10h16M4 14h16M11 18h9",
  "justify-all": "M4 6h16M4 10h16M4 14h16M4 18h16",
  "orientation": "M4 6V4h9v2M8.5 4v9M14 11h6M17 11v9M15 20h4",
  warning: "M12 3l10 18H2zM12 10v5M12 18v.01",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; class?: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size ?? 18}
      height={props.size ?? 18}
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}
