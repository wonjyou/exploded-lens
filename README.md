# Exploded Lens

A scroll-driven exploded view built with [Three.js](https://threejs.org). A 3D
camera lens sits assembled on screen. As you scroll, it comes apart into nine
labelled parts, one after another. Scroll back up and it reassembles.

The lens is generated in code, so there are no model files to download.
No build step either: it's plain HTML, CSS and JavaScript, with Three.js
loaded from a CDN.

## Run it locally

ES modules need to be served over HTTP. Opening `index.html` directly from disk
won't work. From this folder:

```bash
python3 -m http.server 8774
```

Then open <http://localhost:8774>.

## How it works

- **Scroll → explode.** Scroll position is mapped to a 0–1 progress value and
  smoothed every frame. Each part has its own time window inside that range,
  so the parts separate in sequence rather than all at once.
- **Parts.** Every part is registered with `addPart()` in `main.js` with a
  direction, a travel distance (`offset`), a spin, and an `order` in the
  sequence. The aperture also gets a custom `update()` so its nine blades fan
  outward.
- **Geometry.** Rings and barrels are built from lathe profiles (each segment
  lathed separately to keep edges crisp). Lenses use a physical glass material
  with transmission and an iridescent coating. Printed markings are canvas
  textures wrapped around cylinders.
- **Labels.** Each part's centre is projected to screen space every frame, and
  an HTML label with an SVG leader line is placed beside it, kept within the
  viewport.
- **Framing.** As the parts spread out, the camera pulls back and the assembly
  stays centred.

## Responsive layout

| Screen | Layout |
| --- | --- |
| Desktop / landscape | Copy on the left scrolls normally; the model sits to the right. |
| Phone / portrait tablet | The model fills the upper part of the screen; the copy is pinned to the bottom and crossfades between sections as you scroll. The parts counter and label notes are hidden. |

The breakpoint is `STACKED_QUERY` in `main.js`, mirrored by a media query in
`style.css`. Keep them in sync if you change it. The page also handles mobile
browser toolbars, safe-area insets (notches) and `prefers-reduced-motion`.

## Customising

All in `main.js`:

| Setting | What it does |
| --- | --- |
| `EXPLODE` | How far the parts travel |
| `EXPLODE_START` / `EXPLODE_END` | The part of the page scroll over which the explode happens |
| `PANEL_BREAKS` | Scroll points where the mobile text switches to the next section |
| `addPart({ offset, order, spin, name, note })` | Per-part travel, timing, rotation and label text |

Section copy lives in `index.html`; colours and type are CSS variables at the
top of `style.css`.

## Using your own model

Append `?model=path/to/model.glb` to the URL to load any glTF/GLB file instead
of the built-in lens. Each top-level child of the model becomes a part. Parts
move outward from the model's centre and are labelled with their node names.

## Files

```
index.html   page structure and scroll sections
style.css    layout, typography, responsive rules
main.js      scene, procedural lens, explode logic, labels
```
