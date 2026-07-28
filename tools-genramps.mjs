// Generate single-hue sequential ramps in OKLCH around each anchor hue,
// then validate every one with the official ordinal validator.
// Only ramps that PASS in BOTH modes get shipped as palette presets.
import { validateOrdinal } from '/private/tmp/claude-501/bundled-skills/2.1.220/01cb810d53154c60eb89c3dd1b0f18a0/dataviz/scripts/validate_palette.js';

const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin2s = (c) => { c = Math.max(0, Math.min(1, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
const hex2srgb = (h) => { h = h.trim().replace(/^#/, ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); };

function oklabFromLin([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function linFromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const toHex = ([L, C, h]) => {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  return '#' + linFromOklab([L, a, b]).map((v) => Math.round(lin2s(v) * 255).toString(16).padStart(2, '0')).join('');
};
const oklch = (hex) => {
  const [L, a, b] = oklabFromLin(hex2srgb(hex).map(s2lin));
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
};

// Anchor hues taken from the reference categorical slots.
const ANCHORS = {
  blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a',
  yellow: '#eda100', magenta: '#e87ba4', violet: '#4a3aa7',
  green: '#008300', red: '#e34948',
};

// Lightness targets: 7 steps, oldest(light) -> newest(dark) for light mode,
// and the mirror band for dark mode. Chroma tapers at the pale end.
// Bounds come from the documented ordinal floors: on light, the pale end must
// still clear 2:1 vs the surface (blue step 250 ~ L 0.75); on dark, the dark end
// likewise (blue step 600 ~ L 0.45).
const LIGHT_L = [0.75, 0.682, 0.614, 0.546, 0.478, 0.41, 0.342];
const DARK_L = [0.45, 0.523, 0.596, 0.669, 0.742, 0.815, 0.888];

function ramp(hue, Ls, baseC) {
  return Ls.map((L, i) => {
    const t = i / (Ls.length - 1);
    const C = baseC * (0.45 + 0.55 * (Ls === LIGHT_L ? t : 1 - t * 0.55));
    return toHex([L, Math.min(C, 0.19), hue]);
  });
}

// Snap-to-passing: high chroma clips against the sRGB gamut at the dark and
// light ends, which squashes the lightness steps together. Walk chroma down
// until BOTH modes validate, rather than shipping a ramp that fails.
const results = {};
for (const [name, anchor] of Object.entries(ANCHORS)) {
  const [, C0, h] = oklch(anchor);
  let found = null;
  for (let scale = 1.0; scale >= 0.30; scale -= 0.05) {
    const light = ramp(h, LIGHT_L, C0 * scale);
    const dark = ramp(h, DARK_L, C0 * scale);
    const lOK = validateOrdinal([...light].reverse(), { mode: 'light' });
    const dOK = validateOrdinal([...dark], { mode: 'dark' });
    if (lOK.ok && dOK.ok) { found = { light, dark, chroma: +scale.toFixed(2) }; break; }
  }
  results[name] = found
    ? { ...found, lightOK: true, darkOK: true }
    : { light: [], dark: [], lightOK: false, darkOK: false, chroma: null };
}

for (const [n, r] of Object.entries(results)) {
  console.log(`${n.padEnd(9)} light ${r.lightOK?"PASS":"FAIL"} chroma ${r.chroma} | dark ${r.darkOK?"PASS":"FAIL"}`);
}
console.log('\nPASSING BOTH:', Object.entries(results).filter(([, r]) => r.lightOK && r.darkOK).map(([n]) => n).join(', '));
console.log('\n' + JSON.stringify(Object.fromEntries(
  Object.entries(results).filter(([, r]) => r.lightOK && r.darkOK).map(([n, r]) => [n, { light: r.light, dark: r.dark }])
), null, 1));
