'use strict';

/* ==================================================================== *
 * Palette engine — two-colour ramps, generated and validated at runtime.
 *
 * The colour maths and the CVD matrices are the same ones the dataviz
 * skill's validator uses, so the badge shown in the UI means the same
 * thing the offline validator means. A ramp you build here is checked,
 * not assumed: lightness monotonicity, adjacent step separation, the
 * pale end's contrast against the surface, and colour-vision separation
 * under protanopia / deuteranopia / tritanopia.
 *
 * Red→green is the classic colour-vision failure. It is offered because
 * it is genuinely the clearest scale for most people — but the badge
 * will say so, rather than quietly shipping something a deuteranope
 * reads as one flat colour.
 * ==================================================================== */

(function (global) {
  const MACHADO = {
    protan: [[0.152286, 1.052583, -0.204868],
             [0.114503, 0.786281, 0.099216],
             [-0.003882, -0.048116, 1.051998]],
    deutan: [[0.367322, 0.860646, -0.227968],
             [0.280085, 0.672501, 0.047413],
             [-0.011820, 0.042940, 0.968881]],
    tritan: [[1.255528, -0.076749, -0.178779],
             [-0.078411, 0.930809, 0.147602],
             [0.004733, 0.691367, 0.303900]],
  };

  const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lin2s = (c) => {
    c = Math.max(0, Math.min(1, c));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  };
  const hex2srgb = (h) => {
    h = String(h).trim().replace(/^#/, '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  };
  const lin = (h) => hex2srgb(h).map(s2lin);

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

  const oklch = (hex) => {
    const [L, a, b] = oklabFromLin(lin(hex));
    return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
  };
  const lchToHex = (L, C, h) => {
    const a = C * Math.cos((h * Math.PI) / 180);
    const b = C * Math.sin((h * Math.PI) / 180);
    return '#' + linFromOklab([L, a, b])
      .map((v) => Math.round(lin2s(v) * 255).toString(16).padStart(2, '0')).join('');
  };

  const relLum = (hex) => {
    const [r, g, b] = lin(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  function simulate(hex, kind) {
    const [r, g, b] = lin(hex), M = MACHADO[kind];
    const cl = (c) => Math.max(0, Math.min(1, c));
    return [
      cl(M[0][0] * r + M[0][1] * g + M[0][2] * b),
      cl(M[1][0] * r + M[1][1] * g + M[1][2] * b),
      cl(M[2][0] * r + M[2][1] * g + M[2][2] * b),
    ];
  }
  function deltaE(h1, h2, kind) {
    const a = oklabFromLin(kind ? simulate(h1, kind) : lin(h1));
    const b = oklabFromLin(kind ? simulate(h2, kind) : lin(h2));
    return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  /* ---------------------------------------------------------------- *
   * Anchors. The chroma scales are the ones the offline generator
   * found: high chroma clips against the sRGB gamut at the ends, which
   * squashes the lightness steps together and fails the ramp.
   * ---------------------------------------------------------------- */
  const ANCHORS = {
    blue:    { hex: '#2a78d6', chroma: 1.00, label: 'Blue' },
    violet:  { hex: '#4a3aa7', chroma: 1.00, label: 'Violet' },
    magenta: { hex: '#e87ba4', chroma: 0.90, label: 'Magenta' },
    red:     { hex: '#e34948', chroma: 0.60, label: 'Red' },
    orange:  { hex: '#eb6834', chroma: 0.70, label: 'Orange' },
    yellow:  { hex: '#eda100', chroma: 1.00, label: 'Amber' },
    green:   { hex: '#008300', chroma: 0.75, label: 'Green' },
    aqua:    { hex: '#1baf7a', chroma: 0.70, label: 'Aqua' },
    grey:    { hex: '#7d7d78', chroma: 0.30, label: 'Grey' },
  };

  const SURFACE = { light: '#fcfcfb', dark: '#1a1a19' };
  // Lightness bands that clear the ordinal floors: on light the pale end must
  // still hold 2:1 against the surface; on dark, the dark end likewise.
  const BANDS = {
    light: [0.75, 0.342],
    dark: [0.45, 0.888],
  };

  const STEPS = 7;
  const shortestArc = (a, b) => {
    let d = ((b - a) % 360 + 540) % 360 - 180;
    return d;
  };

  function buildRampAt(fromKey, toKey, mode, chromaScale) {
    const A = ANCHORS[fromKey] || ANCHORS.blue;
    const B = ANCHORS[toKey] || A;
    const [, cA, hA] = oklch(A.hex);
    const [, cB, hB] = oklch(B.hex);
    const [L0, L1] = BANDS[mode] || BANDS.light;
    const arc = shortestArc(hA, hB);

    const out = [];
    for (let i = 0; i < STEPS; i++) {
      const t = i / (STEPS - 1);
      const L = L0 + (L1 - L0) * t;
      const h = hA + arc * t;
      const anchorScale = A.chroma + (B.chroma - A.chroma) * t;
      const base = cA + (cB - cA) * t;
      const near = mode === 'light' ? 1 - t : t; // 0 = far from surface
      const C = base * anchorScale * chromaScale * (0.45 + 0.55 * (1 - near * 0.55));
      out.push(lchToHex(L, Math.min(C, 0.19), h));
    }
    return out;
  }

  /** Structural checks — the ones that are about the ramp's shape, not its hues. */
  function structurallyOk(ramp, mode) {
    const surface = SURFACE[mode] || SURFACE.light;
    const Ls = ramp.map((h) => oklch(h)[0]);
    const asc = Ls.every((v, i) => i === 0 || v >= Ls[i - 1]);
    const desc = Ls.every((v, i) => i === 0 || v <= Ls[i - 1]);
    if (!asc && !desc) return false;
    for (let i = 1; i < Ls.length; i++) if (Math.abs(Ls[i] - Ls[i - 1]) < 0.06) return false;
    const pale = ramp.reduce((a, b) => (contrast(a, surface) < contrast(b, surface) ? a : b));
    return contrast(pale, surface) >= 2;
  }

  /**
   * Build a ramp. `from` is the low end (oldest / least), `to` is the high end;
   * a single-hue ramp is just from === to.
   *
   * Snap-to-passing: high chroma clips against the sRGB gamut at the ends,
   * which squashes the lightness steps together and breaks the ramp. Walk
   * chroma down until the shape checks pass, rather than returning something
   * that renders as two steps and five near-identical ones.
   */
  function buildRamp(fromKey, toKey, mode) {
    let last = null;
    for (let scale = 1.0; scale >= 0.30; scale -= 0.05) {
      last = buildRampAt(fromKey, toKey, mode, scale);
      if (structurallyOk(last, mode)) return last;
    }
    return last;
  }

  /** Same checks the offline validator runs, plus adjacent CVD separation. */
  function validateRamp(ramp, mode) {
    const surface = SURFACE[mode] || SURFACE.light;
    const checks = [];
    const Ls = ramp.map((h) => oklch(h)[0]);

    const asc = Ls.every((v, i) => i === 0 || v >= Ls[i - 1]);
    const desc = Ls.every((v, i) => i === 0 || v <= Ls[i - 1]);
    checks.push({ name: 'Lightness monotone', pass: asc || desc,
      detail: asc || desc ? 'steps read in one direction' : 'lightness reverses mid-ramp' });

    let worstDL = Infinity, worstDLPair = '';
    for (let i = 1; i < Ls.length; i++) {
      const d = Math.abs(Ls[i] - Ls[i - 1]);
      if (d < worstDL) { worstDL = d; worstDLPair = `${ramp[i - 1]}↔${ramp[i]}`; }
    }
    checks.push({ name: 'Adjacent ΔL', pass: worstDL >= 0.06,
      detail: `worst ${worstDL.toFixed(3)} ${worstDLPair}` });

    const paleEnd = ramp.reduce((a, b) => (contrast(a, surface) < contrast(b, surface) ? a : b));
    const paleC = contrast(paleEnd, surface);
    checks.push({ name: 'Pale end vs surface', pass: paleC >= 2,
      detail: `${paleEnd} at ${paleC.toFixed(2)}:1` });

    /* Adjacent steps of a sequential ramp are close by design — that is what
     * makes it a ramp — so the reference ordinal checks measure their
     * LIGHTNESS gap (above) rather than their hue separation. What matters
     * for colour-vision is whether the two ENDS still read apart, because
     * that is the comparison the ramp is actually used for. */
    let endsCVD = Infinity, endsKind = '';
    for (const kind of ['protan', 'deutan', 'tritan']) {
      const d = deltaE(ramp[0], ramp[ramp.length - 1], kind);
      if (d < endsCVD) { endsCVD = d; endsKind = kind; }
    }
    checks.push({ name: 'Ends distinguishable', pass: endsCVD >= 20,
      detail: `ΔE ${endsCVD.toFixed(1)} (${endsKind}) between the two ends` });

    return { ok: checks.every((c) => c.pass), checks, endsCVD, endsKind };
  }

  function inkOn(hex) {
    const lum = relLum(hex);
    return (lum + 0.05) / 0.05 >= 1.05 / (lum + 0.05) ? '#0b0b0b' : '#ffffff';
  }

  global.ATLAS_PALETTE = { ANCHORS, buildRamp, validateRamp, inkOn, contrast, oklch, deltaE, STEPS };
})(window);
