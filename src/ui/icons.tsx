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
