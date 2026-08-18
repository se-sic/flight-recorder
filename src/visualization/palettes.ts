export type CommitDecorationPalette = {
  backgroundColor: string;
  borderColor: string;
  overviewRulerColor: string;
};

export type SequentialPalette = {
  value: string;
  label: string;
  stops: readonly string[];
  light: { start: number; end: number };
  dark: { start: number; end: number };
};

export type QualitativePalette = {
  value: string;
  label: string;
  agentEdit: string;
  inlineCompletion: string;
  mixed: string;
  unknown: string;
};

// --- Utilities ---

/** Converts a `#rrggbb` hex color plus an alpha value into an `rgba(...)` CSS color string. */
export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Linearly interpolates a hex color `t` of the way toward an RGB target, returning an `rgba(...)` string with the given alpha. */
export function hexMix(hex: string, toward: readonly [number, number, number], t: number, alpha: number): string {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * (1 - t) + toward[0] * t);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * (1 - t) + toward[1] * t);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * (1 - t) + toward[2] * t);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Samples a color from a sequential palette's gradient stops at a normalized [0,1] position, for the given theme. */
export function sampleSequential(palette: SequentialPalette, normalized: number, isDark: boolean): string {
  const { start, end } = isDark ? palette.dark : palette.light;
  const pos = start + normalized * (end - start);
  const lo = Math.min(palette.stops.length - 2, Math.floor(pos));
  const hi = lo + 1;
  const t = pos - lo;
  const r = Math.round(parseInt(palette.stops[lo].slice(1, 3), 16) * (1 - t) + parseInt(palette.stops[hi].slice(1, 3), 16) * t);
  const g = Math.round(parseInt(palette.stops[lo].slice(3, 5), 16) * (1 - t) + parseInt(palette.stops[hi].slice(3, 5), 16) * t);
  const b = Math.round(parseInt(palette.stops[lo].slice(5, 7), 16) * (1 - t) + parseInt(palette.stops[hi].slice(5, 7), 16) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// --- Sequential palettes ---
// Based Paul Tol's sequential colour schemes: https://sronpersonalpages.nl/~pault/#sec:sequential
export const SEQUENTIAL_PALETTES: readonly SequentialPalette[] = [
  {
    value: "sunset",
    label: "Sunset",
    stops: [
      "#364B9A", "#4A7BB7", "#6EA6CD", "#98CAE1", "#C2E4EF",
      "#EAECCC", "#FEDA8B", "#FDB366", "#F67E4B", "#DD3D2D", "#A50026",
    ],
    light: { start: 0, end: 10 },
    dark: { start: 0, end: 10 },
  },
  {
    value: "nightfall",
    label: "Nightfall",
    stops: [
      "#125A56", "#00767B", "#238F9D", "#42A7C6", "#60BCE9",
      "#9DCCEF", "#C6DBED", "#DEE6E7", "#ECEADA", "#F0E6B2",
      "#F9D576", "#FFB954", "#FD9A44", "#F57634", "#E94C1F",
      "#D11807", "#A01813",
    ],
    light: { start: 0, end: 16 },
    dark: { start: 2, end: 14 },
  },
  {
    value: "incandescent",
    label: "Incandescent",
    stops: [
      "#CEFFFF", "#C6F7D6", "#A2F49B", "#BBE453", "#D5CE04",
      "#E7B503", "#F19903", "#F6790B", "#F94902", "#E40515", "#A80003",
    ],
    light: { start: 1, end: 10 },
    dark: { start: 0, end: 10 },
  },
  {
    value: "iridescent",
    label: "Iridescent",
    stops: [
      "#FEFBE9", "#FCF7D5", "#F5F3C1", "#EAF0B5", "#DDECBF",
      "#D0E7CA", "#C2E3D2", "#B5DDD8", "#A8D8DC", "#9BD2E1",
      "#8DCBE4", "#81C4E7", "#7BBCE7", "#7EB2E4", "#88A5DD",
      "#9398D2", "#9B8AC4", "#9D7DB2", "#9A709E", "#906388",
      "#805770", "#684957", "#46353A",
    ],
    light: { start: 0, end: 22 },
    dark: { start: 6, end: 20 },
  },
  {
    value: "smooth-rainbow",
    label: "Smooth Rainbow",
    stops: [
      "#E8ECFB", "#DDD8EF", "#D1C1E1", "#C3A8D1", "#B58FC2",
      "#A778B4", "#9B62A7", "#8C4E99", "#6F4C9B", "#6059A9",
      "#5568B8", "#4E79C5", "#4D8AC6", "#4E96BC", "#549EB3",
      "#59A5A9", "#60AB9E", "#69B190", "#77B77D", "#8CBC68",
      "#A6BE54", "#BEBC48", "#D1B541", "#DDAA3C", "#E49C39",
      "#E78C35", "#E67932", "#E4632D", "#DF4828", "#DA2222",
      "#B8221E", "#95211B", "#721E17", "#521A13",
    ],
    light: { start: 3, end: 30 },
    dark: { start: 5, end: 28 },
  },
  {
    value: "ylorbr",
    label: "Yellow–Orange–Brown",
    stops: [
      "#FFFFE5", "#FFF7BC", "#FEE391", "#FEC44F", "#FB9A29",
      "#EC7014", "#CC4C02", "#993404", "#662506",
    ],
    light: { start: 0, end: 8 },
    dark: { start: 1, end: 7 },
  },
];

export const DEFAULT_SEQUENTIAL_PALETTE_VALUE = "sunset";

/** Looks up a sequential palette by its identifier, falling back to the first palette if not found. */
export function findSequentialPalette(value: string): SequentialPalette {
  return SEQUENTIAL_PALETTES.find((p) => p.value === value) ?? SEQUENTIAL_PALETTES[0];
}

// --- Qualitative palettes ---
// Based Paul Tol's qualitative colour schemes: https://sronpersonalpages.nl/~pault/#sec:qualitative
export const QUALITATIVE_PALETTES: readonly QualitativePalette[] = [
  {
    value: "vibrant",
    label: "Vibrant",
    agentEdit: "#0077BB",
    inlineCompletion: "#EE7733",
    mixed: "#EE3377",
    unknown: "#BBBBBB",
  },
  {
    value: "bright",
    label: "Bright",
    agentEdit: "#4477AA",
    inlineCompletion: "#CCBB44",
    mixed: "#EE6677",
    unknown: "#BBBBBB",
  },
  {
    value: "high-contrast",
    label: "High-contrast",
    agentEdit: "#004488",
    inlineCompletion: "#DDAA33",
    mixed: "#BB5566",
    unknown: "#888888",
  },
  {
    value: "muted",
    label: "Muted",
    agentEdit: "#88CCEE",
    inlineCompletion: "#DDCC77",
    mixed: "#CC6677",
    unknown: "#BBBBBB",
  },
  {
    value: "light",
    label: "Light",
    agentEdit: "#77AADD",
    inlineCompletion: "#EE8866",
    mixed: "#FFAABB",
    unknown: "#DDDDDD",
  },
];

export const DEFAULT_QUALITATIVE_PALETTE_VALUE = "vibrant";

/** Looks up a qualitative palette by its identifier, falling back to the first palette if not found. */
export function findQualitativePalette(value: string): QualitativePalette {
  return QUALITATIVE_PALETTES.find((p) => p.value === value) ?? QUALITATIVE_PALETTES[0];
}
