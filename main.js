import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// How far parts travel when fully exploded (multiplies every part's offset).
const EXPLODE = 0.85;
// Scroll range (0–1 of the page) over which the explode happens.
const EXPLODE_START = 0.1;
const EXPLODE_END = 0.86;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarsePointer = matchMedia('(pointer: coarse)').matches;
// Portrait phones/tablets stack the copy under the model. Keep in sync with style.css.
const STACKED_QUERY = '(max-aspect-ratio: 11/10), (max-width: 560px)';
const stackedMQ = matchMedia(STACKED_QUERY);

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
// Glass transmission is expensive; cap resolution a bit lower on touch devices.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarsePointer ? 1.5 : 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(4, 6, 8);
const rim = new THREE.DirectionalLight(0xffb48a, 3.0);
rim.position.set(-6, 3, -6);
scene.add(key, rim, new THREE.HemisphereLight(0xffffff, 0x1a1a1a, 0.35));

// rig: mouse parallax / idle sway · tilt: presentation angle · axis: lens axis is local +Y
const rig = new THREE.Group();
const tilt = new THREE.Group();
const axis = new THREE.Group();
scene.add(rig);
rig.add(tilt);
tilt.add(axis);

// ---------------------------------------------------------------- parts registry
const parts = [];
let recenter = true;

/**
 * Register an explodable part.
 * dir/offset: direction (in parent space) and distance it travels when exploded.
 * spin: radians it rotates about its local Y while exploding.
 * update(t): optional extra animation for t in [0, 1].
 */
function addPart(object, opts) {
  const box = new THREE.Box3().setFromObject(object);
  const part = {
    object,
    name: opts.name,
    note: opts.note ?? '',
    order: opts.order ?? parts.length,
    dir: (opts.dir ?? new THREE.Vector3(0, 1, 0)).clone().normalize(),
    offset: (opts.offset ?? 0) * (opts.raw ? 1 : EXPLODE),
    spin: opts.spin ?? 0,
    radius: opts.radius ?? 1,
    update: opts.update,
    labelMode: opts.labelMode ?? 'axis',
    localCenter: opts.center ?? box.getCenter(new THREE.Vector3()),
    base: object.position.clone(),
    baseRotY: object.rotation.y,
    yMin: box.min.y,
    yMax: box.max.y,
    t: 0,
  };
  if (!opts.keepParent) axis.add(object);
  parts.push(part);
  return part;
}

// ---------------------------------------------------------------- materials
const M = {
  body: new THREE.MeshPhysicalMaterial({
    color: 0x17181b, metalness: 0.55, roughness: 0.42,
    clearcoat: 0.3, clearcoatRoughness: 0.5, side: THREE.DoubleSide,
  }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.82, metalness: 0.05, side: THREE.DoubleSide }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xe4e6ea, metalness: 1, roughness: 0.16, side: THREE.DoubleSide }),
  steel: new THREE.MeshStandardMaterial({ color: 0x8e9299, metalness: 1, roughness: 0.36, side: THREE.DoubleSide }),
  accent: new THREE.MeshStandardMaterial({ color: 0xe0352b, metalness: 0.2, roughness: 0.35, side: THREE.DoubleSide }),
  blade: new THREE.MeshStandardMaterial({ color: 0x202126, metalness: 0.85, roughness: 0.3, side: THREE.DoubleSide }),
  glass: new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.03,
    transmission: 1, thickness: 0.4, ior: 1.52,
    attenuationColor: new THREE.Color(0xa9c9ff), attenuationDistance: 2.5,
    iridescence: 0.9, iridescenceIOR: 1.3, iridescenceThicknessRange: [180, 520],
    specularIntensity: 1, envMapIntensity: 1.3,
  }),
};

// ---------------------------------------------------------------- geometry helpers
const V2 = (x, y) => new THREE.Vector2(x, y);

// Lathe each profile segment separately so edges stay crisp (no smoothed corners).
function crispLathe(pts, { segs = 128, phiStart = 0, phiLength = Math.PI * 2 } = {}) {
  const geos = [];
  for (let i = 0; i < pts.length - 1; i++) {
    geos.push(new THREE.LatheGeometry([V2(...pts[i]), V2(...pts[i + 1])], segs, phiStart, phiLength));
  }
  return mergeGeometries(geos);
}

// Hollow ring spanning radius rIn..rOut and height y0..y1 (profile walked counter-clockwise).
const tube = (rIn, rOut, y0, y1, opts) =>
  crispLathe([[rOut, y0], [rOut, y1], [rIn, y1], [rIn, y0], [rOut, y0]], opts);

// Lens with half-thickness `edge` at the rim; `front`/`back` are centre half-thickness
// (bigger than edge = convex, smaller = concave).
function lensGeo(r, edge, front, back, n = 28) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const x = (r * i) / n, k = 1 - (x / r) ** 2;
    pts.push(V2(x, -(edge + (back - edge) * k)));
  }
  for (let i = n; i >= 0; i--) {
    const x = (r * i) / n, k = 1 - (x / r) ** 2;
    pts.push(V2(x, edge + (front - edge) * k));
  }
  return new THREE.LatheGeometry(pts, 96);
}

const mesh = (geo, mat, y = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.y = y;
  return m;
};

// Text printed around a cylinder (lens markings).
function printedBand(text, { radius, y, height, color = '#e9e6df' }) {
  const W = 2048;
  const H = Math.max(16, Math.round((W * height) / (2 * Math.PI * radius)));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.font = `500 ${Math.round(H * 0.62)}px "JetBrains Mono", monospace`;
  g.textBaseline = 'middle';
  const w = g.measureText(text).width;
  for (let x = 12; x < W; x += w) g.fillText(text, x, H / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  return mesh(new THREE.CylinderGeometry(radius, radius, height, 160, 1, true), mat, y);
}

function threads(r, y0, y1, step, mat) {
  const g = new THREE.Group();
  const geo = new THREE.TorusGeometry(r, 0.007, 6, 128);
  for (let y = y0; y <= y1 + 1e-6; y += step) {
    const t = new THREE.Mesh(geo, mat);
    t.rotation.x = Math.PI / 2;
    t.position.y = y;
    g.add(t);
  }
  return g;
}

// ---------------------------------------------------------------- the lens
function buildLens() {
  // Filter ring — front-most, with threads for screw-in filters.
  const filter = new THREE.Group();
  filter.add(mesh(tube(1.04, 1.22, 1.38, 1.62), M.body));
  filter.add(mesh(tube(1.22, 1.235, 1.5, 1.62), M.chrome));
  filter.add(threads(1.045, 1.42, 1.58, 0.032, M.steel));
  filter.add(printedBand('OPTIK 50   ·   Ø62   ·   MULTI-COATED   ·   ', { radius: 1.222, y: 1.44, height: 0.08, color: '#9b978f' }));
  addPart(filter, { name: 'Filter ring', note: 'Ø62 thread, matte black', order: 0, offset: 5.6, spin: 0.5, radius: 1.24 });

  // Front element — big convex glass with a chrome trim.
  const front = new THREE.Group();
  front.add(mesh(lensGeo(1.0, 0.06, 0.3, 0.07), M.glass, 1.48));
  front.add(mesh(tube(1.0, 1.03, 1.42, 1.54), M.chrome));
  addPart(front, { name: 'Front element', note: 'Aspherical, multi-coated', order: 1, offset: 4.7, radius: 1.03 });

  // Bayonet mount — rear, chrome with three lugs and screws.
  const mount = new THREE.Group();
  mount.add(mesh(tube(0.88, 1.08, -1.72, -1.6), M.chrome));
  mount.add(mesh(tube(0.86, 0.94, -1.98, -1.72), M.chrome));
  for (let i = 0; i < 3; i++) {
    mount.add(mesh(tube(0.94, 1.04, -1.98, -1.93, { segs: 24, phiStart: i * (Math.PI * 2 / 3) + 0.2, phiLength: 0.8 }), M.chrome));
  }
  const screwGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.02, 20);
  const slotGeo = new THREE.BoxGeometry(0.06, 0.01, 0.012);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    const s = mesh(screwGeo, M.steel, -1.73);
    s.position.x = Math.sin(a) * 1.0;
    s.position.z = Math.cos(a) * 1.0;
    const slot = mesh(slotGeo, M.blade, -0.01);
    slot.rotation.y = a;
    s.add(slot);
    mount.add(s);
  }
  const dot = mesh(new THREE.SphereGeometry(0.03, 16, 16), M.accent, -1.66);
  dot.position.z = 1.08;
  mount.add(dot);
  addPart(mount, { name: 'Bayonet mount', note: 'Chrome-plated brass, 3 lugs', order: 2, offset: -2.4, spin: -0.9, radius: 1.08 });

  // Focus ring — ribbed rubber grip over a sleeve, distance scale printed on top.
  const focus = new THREE.Group();
  focus.add(mesh(tube(1.0, 1.24, 0.25, 1.38), M.body));
  const ribCount = 112;
  const ribs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.045, 0.7, 0.05), M.rubber, ribCount);
  const d = new THREE.Object3D();
  for (let i = 0; i < ribCount; i++) {
    const a = (i / ribCount) * Math.PI * 2;
    d.position.set(Math.sin(a) * 1.255, 0.74, Math.cos(a) * 1.255);
    d.rotation.set(0, a, 0);
    d.updateMatrix();
    ribs.setMatrixAt(i, d.matrix);
  }
  focus.add(ribs);
  focus.add(printedBand('∞   10   5   3   2   1.5   1.2   1   0.8   0.7   0.6 m   ·   ', { radius: 1.242, y: 1.22, height: 0.1 }));
  addPart(focus, { name: 'Focus ring', note: 'Helicoid drive, 270° throw', order: 3, offset: 3.7, spin: -0.6, radius: 1.28 });

  // Rear element.
  const rear = new THREE.Group();
  rear.add(mesh(lensGeo(0.7, 0.04, 0.16, 0.09), M.glass, -1.38));
  rear.add(mesh(tube(0.7, 0.8, -1.43, -1.33), M.body));
  addPart(rear, { name: 'Rear element', note: 'Low-dispersion glass', order: 4, offset: -1.2, radius: 0.8 });

  // Meniscus (convex front, concave back).
  const glassC = new THREE.Group();
  glassC.add(mesh(lensGeo(0.95, 0.1, 0.22, 0.03), M.glass, 0.88));
  glassC.add(mesh(tube(0.95, 0.99, 0.79, 0.97), M.body));
  addPart(glassC, { name: 'Meniscus group', note: 'Corrects field curvature', order: 5, offset: 2.75, radius: 0.99 });

  // Doublet.
  const glassB = new THREE.Group();
  glassB.add(mesh(lensGeo(0.82, 0.05, 0.15, 0.11), M.glass, 0.45));
  glassB.add(mesh(tube(0.82, 0.92, 0.39, 0.51), M.body));
  addPart(glassB, { name: 'Cemented doublet', note: 'Cancels chromatic aberration', order: 6, offset: 1.95, radius: 0.92 });

  // Aperture — nine overlapping blades that bloom outward as it explodes.
  const aperture = new THREE.Group();
  aperture.add(mesh(tube(0.74, 1.0, -0.06, 0.06), M.steel));
  const shape = new THREE.Shape();
  shape.moveTo(0.8, 0);
  shape.absarc(0, 0, 0.8, 0, 0.95, false);
  shape.quadraticCurveTo(0.26, 0.46, 0.17, 0.08);
  shape.quadraticCurveTo(0.45, -0.06, 0.8, 0);
  const bladeGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.008, bevelEnabled: false, curveSegments: 24 });
  bladeGeo.rotateX(-Math.PI / 2);
  const blades = [];
  for (let i = 0; i < 9; i++) {
    const wrap = new THREE.Group();
    wrap.rotation.y = (i / 9) * Math.PI * 2;
    wrap.position.y = -0.018 + i * 0.004;
    const b = new THREE.Mesh(bladeGeo, M.blade);
    wrap.add(b);
    aperture.add(wrap);
    blades.push(b);
  }
  addPart(aperture, {
    name: 'Aperture', note: '9 rounded blades, f/1.4–16', order: 7, offset: 1.2, radius: 1.0,
    update: (t) => blades.forEach((b) => {
      b.position.x = 0.55 * t;
      b.rotation.y = -0.45 * t;
    }),
  });

  // Main barrel — stays put; everything else moves away from it.
  const barrel = new THREE.Group();
  barrel.add(mesh(tube(1.02, 1.15, -1.6, 0.25), M.body));
  barrel.add(mesh(tube(1.15, 1.17, 0.08, 0.15), M.accent));
  barrel.add(mesh(tube(0.78, 1.02, -1.22, -1.16), M.body));
  barrel.add(mesh(tube(0.76, 1.02, 0.18, 0.25), M.body));
  barrel.add(threads(1.152, -1.5, -1.2, 0.05, M.steel));
  barrel.add(printedBand('OPTIK   50mm   1:1.4   ASPH   ·   ', { radius: 1.152, y: -0.4, height: 0.13 }));
  addPart(barrel, { name: 'Main barrel', note: 'Anodised aluminium housing', order: 8, offset: 0, radius: 1.17 });

  tilt.userData.pose = (wide) => (wide ? [0.35, -0.55, -1.0] : [0.3, -0.45, -0.3]);
}

// ---------------------------------------------------------------- optional: any GLB via ?model=url
async function loadGLB(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()).length();
  const s = 5 / size;
  model.scale.setScalar(s);
  model.position.copy(box.getCenter(new THREE.Vector3()).multiplyScalar(-s));
  axis.add(model);
  model.updateWorldMatrix(true, true);

  // Descend through single-child wrappers to find the real list of parts.
  let root = model;
  while (root.children.length === 1 && root.children[0].children.length) root = root.children[0];

  const center = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
  const items = root.children.map((child) => {
    const b = new THREE.Box3().setFromObject(child);
    const c = b.getCenter(new THREE.Vector3());
    return { child, b, c, dist: c.distanceTo(center) };
  }).sort((a, b) => b.dist - a.dist);

  items.forEach(({ child, b, c }, i) => {
    // Direction from model centre to part centre, expressed in the part's parent space.
    const p0 = child.parent.worldToLocal(center.clone());
    const p1 = child.parent.worldToLocal(c.clone());
    let dir = p1.sub(p0);
    if (dir.lengthSq() < 1e-8) dir = new THREE.Vector3(0, 1, 0);
    const worldSpread = 1.4 + b.getSize(new THREE.Vector3()).length() * 0.3;
    const parentScale = child.parent.getWorldScale(new THREE.Vector3()).x;
    addPart(child, {
      name: child.name || `Part ${i + 1}`,
      order: i,
      dir,
      offset: worldSpread / parentScale,
      raw: true,
      radius: b.getSize(new THREE.Vector3()).length() * 0.3,
      center: child.worldToLocal(c.clone()),
      labelMode: 'radial',
      keepParent: true,
    });
  });
  recenter = false;
  tilt.userData.pose = () => [0.3, -0.6, 0];
}

// ---------------------------------------------------------------- labels
const labelLayer = document.getElementById('labels');
const svg = document.getElementById('leaders');
const SVGNS = 'http://www.w3.org/2000/svg';

function buildLabels() {
  // Alternate sides by position along the axis so neighbours don't collide.
  const sorted = [...parts].sort((a, b) => (a.yMin + a.yMax) - (b.yMin + b.yMax));
  sorted.forEach((p, i) => {
    p.side = i % 2 ? 1 : -1;
    p.el = document.createElement('div');
    p.el.className = 'label';
    p.el.innerHTML = `<b></b><small></small>`;
    p.el.querySelector('b').textContent = p.name;
    p.el.querySelector('small').textContent = p.note;
    labelLayer.appendChild(p.el);
    p.line = document.createElementNS(SVGNS, 'line');
    p.dot = document.createElementNS(SVGNS, 'circle');
    p.dot.setAttribute('r', '2.5');
    svg.append(p.line, p.dot);
  });
  document.getElementById('total').textContent = String(parts.length).padStart(2, '0');
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const modelCenter = new THREE.Vector3();

function toScreen(v, w, h) {
  v.project(camera);
  return [(v.x + 1) * 0.5 * w, (1 - v.y) * 0.5 * h];
}

function updateLabels(w, h, dist) {
  const pxPerUnit = h / (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));

  // Screen-space direction of the lens axis, and its perpendicular (pointing up).
  const [ax0, ay0] = toScreen(axis.localToWorld(tmp.set(0, -1, 0)), w, h);
  const [ax1, ay1] = toScreen(axis.localToWorld(tmp.set(0, 1, 0)), w, h);
  let dx = ax1 - ax0, dy = ay1 - ay0;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  let nx = -dy, ny = dx;
  if (ny > 0) { nx = -nx; ny = -ny; }

  const [cx, cy] = toScreen(axis.localToWorld(modelCenter.set(0, 0, 0)), w, h);

  for (const p of parts) {
    const [sx, sy] = toScreen(p.object.localToWorld(tmp2.copy(p.localCenter)), w, h);
    let ux, uy;
    if (p.labelMode === 'radial') {
      ux = sx - cx; uy = sy - cy;
      const l = Math.hypot(ux, uy);
      if (l < 4) { ux = nx; uy = ny; } else { ux /= l; uy /= l; }
    } else {
      ux = nx * p.side; uy = ny * p.side;
    }
    const r = p.radius * pxPerUnit;
    const ex = sx + ux * r, ey = sy + uy * r;
    const lead = wide ? 48 : 22;
    const tx = sx + ux * (r + lead), ty = sy + uy * (r + lead);

    const o = THREE.MathUtils.smoothstep(p.t, 0.7, 1);
    const right = ux < 0;
    p.el.classList.toggle('right', right);
    p.el.style.opacity = o;
    // Keep the label fully on screen (and below the top bar).
    const lx = THREE.MathUtils.clamp(right ? tx - 6 - p.w : tx + 6, 10, w - 10 - p.w);
    const ly = THREE.MathUtils.clamp(ty, 64, h - 16);
    p.el.style.transform = `translate(${lx}px, ${ly}px) translateY(-50%)`;
    p.line.setAttribute('x1', ex); p.line.setAttribute('y1', ey);
    p.line.setAttribute('x2', tx); p.line.setAttribute('y2', ty);
    p.line.style.opacity = o;
    p.dot.setAttribute('cx', ex); p.dot.setAttribute('cy', ey);
    p.dot.style.opacity = o;
  }
}

// ---------------------------------------------------------------- scroll + layout
let width = 0, height = 0, wide = true;

function resize() {
  // Canvas is sized in CSS with lvh, so this stays stable while mobile URL bars slide.
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h || (w === width && h === height)) return;
  width = w;
  height = h;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  wide = !stackedMQ.matches;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const pose = tilt.userData.pose?.(wide);
  if (pose) tilt.rotation.set(...pose);
  for (const p of parts) if (p.el) p.w = p.el.offsetWidth;
  readScroll();
}
addEventListener('resize', resize);
stackedMQ.addEventListener('change', () => { width = 0; resize(); });

let target = 0;
let progress = 0;
function readScroll() {
  const max = document.documentElement.scrollHeight - innerHeight;
  target = max > 0 ? THREE.MathUtils.clamp(scrollY / max, 0, 1) : 0;
  document.getElementById('hint').style.opacity = scrollY > 40 ? 0 : 1;
  updatePanels();
}
addEventListener('scroll', readScroll, { passive: true });

const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return; // no parallax from touch drags
  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = (e.clientY / innerHeight) * 2 - 1;
});

document.getElementById('again').addEventListener('click', () => {
  scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
});

// Which copy panel is showing. Wide layouts scroll the panels normally and light
// whichever is in view; the stacked (mobile) layout pins them to the bottom and
// switches by scroll progress, timed to the explode sequence.
const panels = [...document.querySelectorAll('.panel')];
const PANEL_BREAKS = [0.08, 0.3, 0.5, 0.82]; // progress where panels 1..4 take over
const inView = new Set();

function updatePanels() {
  let active;
  if (stackedMQ.matches) {
    const i = PANEL_BREAKS.filter((b) => target >= b).length;
    active = (el) => el === panels[i];
  } else {
    active = (el) => inView.has(el);
  }
  for (const el of panels) el.classList.toggle('is-active', active(el));
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) e.isIntersecting ? inView.add(e.target) : inView.delete(e.target);
  updatePanels();
}, { threshold: 0.35 });
panels.forEach((el) => io.observe(el));
stackedMQ.addEventListener('change', updatePanels);

// ---------------------------------------------------------------- animate
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const revealedEl = document.getElementById('revealed');
const barEl = document.getElementById('bar');
const clock = new THREE.Clock();
let intro = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  progress += (target - progress) * (reducedMotion ? 1 : 1 - Math.exp(-dt * 6));
  intro = Math.min(1, intro + dt * 0.8);

  const e = clamp01((progress - EXPLODE_START) / (EXPLODE_END - EXPLODE_START));
  const n = parts.length;
  const maxOrder = Math.max(...parts.map((p) => p.order), 1);
  let sum = 0, revealed = 0, yMin = Infinity, yMax = -Infinity;

  for (const p of parts) {
    // Stagger: each part gets its own window inside the explode range.
    const start = (p.order / maxOrder) * 0.55;
    p.t = ease(clamp01((e - start) / 0.45));
    p.object.position.copy(p.base).addScaledVector(p.dir, p.offset * p.t);
    p.object.rotation.y = p.baseRotY + p.spin * p.t;
    p.update?.(p.t);
    sum += p.t;
    if (p.t > 0.5) revealed++;
    yMin = Math.min(yMin, p.yMin + p.object.position.y);
    yMax = Math.max(yMax, p.yMax + p.object.position.y);
  }
  const avg = n ? sum / n : 0;

  // Keep the spread-out assembly centred on screen.
  if (recenter && n) axis.position.y += (-(yMin + yMax) / 2 - axis.position.y) * 0.5;
  axis.rotation.y = progress * 1.4;

  mouse.sx += (mouse.x - mouse.sx) * 0.05;
  mouse.sy += (mouse.y - mouse.sy) * 0.05;
  const sway = reducedMotion ? 0 : Math.sin(time * 0.35) * 0.06;
  rig.rotation.set(mouse.sy * 0.08, sway + mouse.sx * 0.15, 0);
  const s = 0.85 + 0.15 * ease(intro);
  rig.scale.setScalar(s);

  // Wide: model sits right of the copy, easing toward centre as it spreads out.
  // Stacked: model sits in the upper part of the screen, above the copy.
  const aspectFactor = wide
    ? THREE.MathUtils.clamp(1.6 / camera.aspect, 1, 2.4)
    : THREE.MathUtils.clamp(1.6 / camera.aspect, 1.3, 2.6);
  const dist = THREE.MathUtils.lerp(9.5, 17, avg) * aspectFactor;
  if (width && height) {
    if (wide) camera.setViewOffset(width, height, -width * 0.16 * (1 - 0.45 * avg), 0, width, height);
    else camera.setViewOffset(width, height, 0, height * 0.17, width, height);
    camera.updateProjectionMatrix();
  }
  camera.position.set(0, 0.2, dist);
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
  if (width && height) updateLabels(width, height, dist);

  revealedEl.textContent = String(revealed).padStart(2, '0');
  barEl.style.width = `${progress * 100}%`;

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot
(async () => {
  try { await document.fonts.load('500 32px "JetBrains Mono"'); } catch {}
  const url = new URLSearchParams(location.search).get('model');
  if (url) {
    try { await loadGLB(url); } catch (err) { console.error('Could not load model, using built-in lens', err); buildLens(); }
  } else {
    buildLens();
  }
  buildLabels();
  resize();
  readScroll();
  progress = target;
  requestAnimationFrame(frame);
  requestAnimationFrame(() => document.getElementById('loader').classList.add('done'));
})();
