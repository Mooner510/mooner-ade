// Shared by t-composer-align: pixel "ink" bounds of page rects, measured on a 4x supersampled screenshot (what the eye sees, not the layout box).
export async function inkOf(c, rects, S = 4) {
  const minX = Math.min(...rects.map(r => r.l)) - 2, minY = Math.min(...rects.map(r => r.t)) - 2, maxX = Math.max(...rects.map(r => r.r)) + 2, maxY = Math.max(...rects.map(r => r.b)) + 2;
  const shot = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: minX, y: minY, width: maxX - minX, height: maxY - minY, scale: S } });
  return c.ev(`
    const img = new Image(); img.src = 'data:image/png;base64,${shot.data}'; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const rects = ${JSON.stringify(rects)}, S = ${S}, ox = ${minX}, oy = ${minY}; const out = [];
    for (const r of rects) {
      const x0 = Math.max(0, Math.round((r.l - ox) * S)), y0 = Math.max(0, Math.round((r.t - oy) * S)), x1 = Math.min(cv.width, Math.round((r.r - ox) * S)), y1 = Math.min(cv.height, Math.round((r.b - oy) * S));
      const w = x1 - x0, h = y1 - y0; if (w <= 0 || h <= 0) { out.push(null); continue; } const d = g.getImageData(x0, y0, w, h).data; const counts = new Map();
      for (let i = 0; i < d.length; i += 4) { const k = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3); counts.set(k, (counts.get(k) || 0) + 1); }
      let bgk = 0, best = -1; for (const [k, n] of counts) if (n > best) { best = n; bgk = k; }
      const br = (bgk >> 10 << 3) + 4, bg = ((bgk >> 5) & 31) * 8 + 4, bb = (bgk & 31) * 8 + 4; let t = h, b = -1, l = w, rr = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb) > 60) { if (y < t) t = y; if (y > b) b = y; if (x < l) l = x; if (x > rr) rr = x; } }
      out.push(b < 0 ? { none: true } : { t: +(r.t + t / S).toFixed(2), b: +(r.t + (b + 1) / S).toFixed(2), l: +(r.l + l / S).toFixed(2), r: +(r.l + (rr + 1) / S).toFixed(2), cy: +(r.t + (t + b + 1) / 2 / S).toFixed(2), cx: +(r.l + (l + rr + 1) / 2 / S).toFixed(2) });
    }
    return out;`);
}
