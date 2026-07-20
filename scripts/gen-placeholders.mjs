/**
 * Generates the placeholder frames used by seeded reports.
 *
 * These are labelled "SEEDED SAMPLE" on their face on purpose. A demo that
 * shows indistinguishable-from-real photographs for reports nobody took is the
 * same category of dishonesty this product exists to argue against.
 *
 * Palette tracks the light theme in globals.css. These are committed assets in
 * public/ — they do NOT follow CSS token changes, so re-run this after any
 * palette change or you get dark slabs sitting on white cards.
 *
 *   node scripts/gen-placeholders.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "public", "data");
mkdirSync(OUT, { recursive: true });

// Mirrors :root in globals.css.
const C = {
  surface: "#ffffff",
  bg: "#f1f3f7",
  grid: "#e4e8ef",
  road: "#e9edf3",
  roadEdge: "#dde2ea",
  marking: "#cfd6e0",
  object: "#c3cbd8",
  objectDark: "#9aa5b5",
  hole: "#6b7387",
  text: "#0f1620",
  textDim: "#6b7387",
  accent: "#2563eb",
  success: "#059669",
  warning: "#d97706",
  water: "#cfe3dc",
  waterDark: "#7ba99a",
};

const GLYPHS = {
  pothole: `<ellipse cx="320" cy="300" rx="104" ry="52" fill="${C.objectDark}"/>
            <ellipse cx="320" cy="292" rx="104" ry="52" fill="${C.object}"/>
            <ellipse cx="308" cy="288" rx="62" ry="30" fill="${C.hole}"/>
            <path d="M232 272q40-22 92-14t100 26" stroke="${C.objectDark}" stroke-width="3" fill="none"/>`,
  storm_water_drain: `<rect x="222" y="246" width="196" height="112" rx="8" fill="${C.object}" stroke="${C.objectDark}" stroke-width="3"/>
            ${[0, 1, 2, 3, 4]
              .map((i) => `<rect x="${242 + i * 34}" y="264" width="18" height="76" rx="4" fill="${C.hole}"/>`)
              .join("")}
            <path d="M180 246h280" stroke="${C.objectDark}" stroke-width="4"/>`,
  sewage_overflow: `<rect x="200" y="300" width="240" height="70" rx="10" fill="${C.water}"/>
            <circle cx="320" cy="268" r="52" fill="${C.object}" stroke="${C.objectDark}" stroke-width="3"/>
            <circle cx="320" cy="268" r="26" fill="${C.hole}"/>
            <path d="M212 330q38-18 76 0t76 0 76 0" stroke="${C.waterDark}" stroke-width="4" fill="none"/>`,
  garbage: `<rect x="248" y="250" width="144" height="118" rx="10" fill="${C.object}" stroke="${C.objectDark}" stroke-width="3"/>
            <rect x="232" y="232" width="176" height="22" rx="8" fill="${C.objectDark}"/>
            <circle cx="286" cy="222" r="15" fill="${C.object}"/>
            <circle cx="352" cy="216" r="19" fill="${C.object}"/>
            <circle cx="320" cy="208" r="13" fill="${C.objectDark}"/>`,
  streetlight: `<rect x="306" y="196" width="12" height="188" rx="5" fill="${C.objectDark}"/>
            <path d="M312 200q0-44 52-44" stroke="${C.objectDark}" stroke-width="12" fill="none" stroke-linecap="round"/>
            <ellipse cx="368" cy="164" rx="30" ry="15" fill="${C.object}"/>
            <path d="M368 180 320 300h96Z" fill="${C.warning}" opacity="0.16"/>`,
  other: `<circle cx="320" cy="284" r="62" fill="${C.object}" stroke="${C.objectDark}" stroke-width="3"/>
            <path d="M320 250v42" stroke="${C.hole}" stroke-width="9" stroke-linecap="round"/>
            <circle cx="320" cy="314" r="6" fill="${C.hole}"/>`,
  fixed: `<path d="M262 288l40 40 82-88" stroke="${C.success}" stroke-width="15" fill="none"
            stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="320" cy="286" r="92" stroke="${C.success}" stroke-width="4" fill="none" opacity="0.35"/>`,
};

const LABELS = {
  pothole: "Pothole",
  storm_water_drain: "Storm water drain",
  sewage_overflow: "Sewage overflow",
  garbage: "Garbage",
  streetlight: "Streetlight",
  other: "Civic defect",
  fixed: "Repair confirmed",
};

function svg(key) {
  const accent = key === "fixed" ? C.success : C.accent;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480" role="img" aria-label="${LABELS[key]} — seeded sample image">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.surface}"/>
      <stop offset="1" stop-color="${C.bg}"/>
    </linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke="${C.grid}" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="640" height="480" fill="url(#bg)"/>
  <rect width="640" height="480" fill="url(#grid)"/>

  <!-- road surface band -->
  <rect y="196" width="640" height="200" fill="${C.road}"/>
  <path d="M0 396h640" stroke="${C.roadEdge}" stroke-width="2"/>
  <path d="M40 420h84M180 420h84M320 420h84M460 420h84" stroke="${C.marking}" stroke-width="6" stroke-linecap="round"/>

  ${GLYPHS[key]}

  <rect x="20" y="20" width="152" height="26" rx="13" fill="${C.surface}" fill-opacity="0.9" stroke="${accent}" stroke-opacity="0.45"/>
  <circle cx="36" cy="33" r="4" fill="${accent}"/>
  <text x="48" y="37" font-family="ui-monospace, monospace" font-size="11" fill="${C.textDim}" letter-spacing="0.06em">SEEDED SAMPLE</text>

  <text x="20" y="462" font-family="ui-sans-serif, system-ui, sans-serif" font-size="15" font-weight="600" fill="${C.text}">${LABELS[key]}</text>
</svg>
`;
}

for (const key of Object.keys(GLYPHS)) {
  const name = key === "fixed" ? "placeholder-fixed.svg" : `placeholder-${key}.svg`;
  writeFileSync(join(OUT, name), svg(key), "utf8");
  console.log("wrote", name);
}
