# -*- coding: utf-8 -*-
"""Measure notehead positions against staff lines on a scanned page.

usage: python -I omr.py <pdf> <outdir> [page ...]
Writes, per page: staves found, and an enlarged overlay image per system with
each detected notehead labelled by its pitch (treble clef, no accidentals).
"""
import sys, os, json
import numpy as np
import cv2
import fitz

STEPS = "CDEFGAB"


def name_of(pos):
    """pos = diatonic steps above E4 (bottom line of the treble staff)."""
    n = pos + 2 + 4 * 7  # E4 -> index of E in octave 4
    return "%s%d" % (STEPS[n % 7].lower(), n // 7)


def load_pages(pdf):
    d = fitz.open(pdf)
    out = []
    for pg in d:
        xref = pg.get_images(full=True)[0][0]
        pix = fitz.Pixmap(d, xref)
        if pix.n - pix.alpha >= 4:
            pix = fitz.Pixmap(fitz.csRGB, pix)
        a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        g = cv2.cvtColor(a[:, :, :3], cv2.COLOR_RGB2GRAY) if pix.n >= 3 else a[:, :, 0].copy()
        out.append(g)
    return out


def find_staves(g, scale):
    """Return list of staves; each is a function x -> 5 line y's (top..bottom), plus bbox."""
    H, W = g.shape
    bw = (g < 170).astype(np.uint8)
    # long horizontal runs only
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (int(40 * scale), 1))
    lines = cv2.morphologyEx(bw, cv2.MORPH_OPEN, k)
    # work in vertical strips so skew does not smear the peaks
    strip = int(60 * scale)
    xs = list(range(int(0.1 * W), int(0.92 * W) - strip, strip))
    per_strip = []
    for x0 in xs:
        prof = lines[:, x0:x0 + strip].sum(axis=1).astype(float)
        rows = np.flatnonzero(prof > 0.5 * strip)
        groups = []
        for y in rows:
            if groups and y - groups[-1][-1] <= 1 + int(scale):
                groups[-1].append(y)
            else:
                groups.append([y])
        per_strip.append((x0 + strip / 2.0, [float(np.mean(gp)) for gp in groups]))
    return lines, per_strip


def group_staves(ys, scale):
    """Group line y's into staves of 5 evenly spaced lines."""
    staves = []
    i = 0
    ys = sorted(ys)
    while i + 4 < len(ys):
        five = ys[i:i + 5]
        d = np.diff(five)
        if d.min() > 4 * scale and d.max() < 11 * scale and d.max() - d.min() < 2.5 * scale:
            staves.append(five)
            i += 5
        else:
            i += 1
    return staves


def main():
    pdf, outdir = sys.argv[1], sys.argv[2]
    want = [int(x) for x in sys.argv[3:]]
    os.makedirs(outdir, exist_ok=True)
    SC = 3  # upscale before processing: more pixels per staff space
    pages = load_pages(pdf)
    result = {}
    for pn, g0 in enumerate(pages, 1):
        if want and pn not in want:
            continue
        g = cv2.resize(g0, None, fx=SC, fy=SC, interpolation=cv2.INTER_CUBIC)
        H, W = g.shape
        lines, per_strip = find_staves(g, SC)
        # staves per strip
        strips = [(x, group_staves(ys, SC)) for x, ys in per_strip]
        # choose the most common stave count, then track staves across strips by nearest y
        counts = [len(s) for _, s in strips]
        if not counts:
            continue
        # cluster staves seen in each strip by the y of their middle line (skew is small)
        allst = sorted(((st[2], x, st) for x, sts in strips for st in sts), key=lambda t: t[0])
        tracks = []
        for mid, x, st in allst:
            if tracks and mid - tracks[-1][-1][1][2] < 14 * SC and all(abs(x - t[0]) > 1 for t in tracks[-1]):
                tracks[-1].append((x, st))
            else:
                tracks.append([(x, st)])
        tracks = [sorted(t) for t in tracks if len(t) >= 4]
        nst = len(tracks)
        print("page", pn, "size", g0.shape, "staves", nst, "strip counts", counts)
        staves = []
        for j, tr in enumerate(tracks):
            if len(tr) < 3:
                continue
            xs = np.array([t[0] for t in tr])
            ys = np.array([t[1] for t in tr])  # n x 5
            fits = [np.polyfit(xs, ys[:, k], 1) for k in range(5)]
            sp = float(np.mean(np.diff(ys, axis=1)))
            staves.append({"fits": fits, "space": sp, "x0": float(xs.min()), "x1": float(xs.max()),
                           "top": float(ys[:, 0].mean()), "bottom": float(ys[:, 4].mean())})
            print("  staff", j, "top %.0f bottom %.0f space %.1f (orig px %.1f) strips %d" % (
                ys[:, 0].mean() / SC, ys[:, 4].mean() / SC, sp, sp / SC, len(tr)))
        result[pn] = staves

        # ---- noteheads ----
        bw = (g < 150).astype(np.uint8)
        # remove staff lines where the vertical run is thin
        nolines = bw.copy()
        ly, lx = np.nonzero(lines)
        for st in staves:
            for k in range(5):
                a, b = st["fits"][k]
                x = np.arange(0, W)
                yy = np.rint(a * x + b).astype(int)
                for dy in range(-SC, SC + 1):
                    yc = np.clip(yy + dy, 0, H - 1)
                    col = bw[yc, x]
                    # keep the pixel if ink continues well above and below (a notehead or stem crosses)
                    up = bw[np.clip(yc - 2 * SC, 0, H - 1), x]
                    dn = bw[np.clip(yc + 2 * SC, 0, H - 1), x]
                    kill = (col == 1) & ~((up == 1) & (dn == 1))
                    nolines[yc[kill], x[kill]] = 0
        over = cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)
        heads = []
        for si, st in enumerate(staves):
            sp = st["space"]
            kw, kh = int(round(sp * 0.95)), int(round(sp * 0.72))
            ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kw, kh))
            y0 = int(st["top"] - 4.5 * sp)
            y1 = int(st["bottom"] + 4.5 * sp)
            # Staff lines, stems and beams are all thinner than a notehead, so opening with a
            # notehead-sized ellipse removes them without a separate line-removal step.
            soft = (g[max(0, y0):y1, :] < 185).astype(np.uint8)
            op = cv2.morphologyEx(soft, cv2.MORPH_OPEN, ker)
            n, lab, stats, cent = cv2.connectedComponentsWithStats(op, 8)
            for i in range(1, n):
                x, y, w, h, area = stats[i]
                if w > 2.2 * sp or h > 1.5 * sp or area < 0.35 * sp * sp:
                    continue
                cx, cy = cent[i][0], cent[i][1] + max(0, y0)
                if cx < st["x0"] - 2 * sp or cx > st["x1"] + 6 * sp:
                    continue
                bottom = st["fits"][4][0] * cx + st["fits"][4][1]
                pos = (bottom - cy) / (sp / 2.0)
                heads.append({"staff": si, "x": float(cx), "y": float(cy), "pos": float(pos)})
                p = int(round(pos))
                col = (0, 0, 220) if abs(pos - p) < 0.3 else (0, 140, 255)
                if abs(sp - 20.8) > 2.5:      # piano staves (smaller): skip labels
                    continue
                if pos < -6.6 or pos > 12.6:  # far outside the staff: lyrics, dynamics
                    continue
                cv2.circle(over, (int(cx), int(cy)), int(sp * 0.62), col, 2)
                tx, ty = int(cx) - int(sp * 0.9), int(st["top"] - 1.7 * sp) - (18 if len(heads) % 2 else 0)
                cv2.rectangle(over, (tx - 2, ty - 17), (tx + 34, ty + 4), (255, 255, 255), -1)
                cv2.putText(over, name_of(p), (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.62, col, 2)
        json.dump({"staves": [{k: (v if not isinstance(v, list) else [list(map(float, f)) for f in v]) for k, v in s.items()} for s in staves],
                   "heads": heads}, open(os.path.join(outdir, "p%02d.json" % pn), "w"))
        cv2.imwrite(os.path.join(outdir, "p%02d_overlay.png" % pn), over)
        cv2.imwrite(os.path.join(outdir, "p%02d_nolines.png" % pn), nolines * 255)


if __name__ == "__main__":
    main()
