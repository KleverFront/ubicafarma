/*
 * StoreScene — 3D (2.5D-style) rendering of a branch layout with Three.js.
 *
 * Public API:
 *   load(branch, categories)                 build the layout of a branch
 *   focusFixture(id, { level, productId, callout })   highlight + fly camera
 *   clearFocus()                             remove highlight
 *   setMode('normal' | 'occupancy', occupancyMap)
 *   home() / topView() / zoom(factor) / setLabelsVisible(bool)
 */
(function () {
  const C = {
    background: 0xeef2f6,
    floor: 0xfbfcfd,
    floorEdge: 0xcbd5e1,
    grid: 0xe6ebf1,
    wall: 0xd5dde6,
    wallTop: 0x94a3b8,
    shelf: 0xffffff,
    plinth: 0x475569,
    plank: 0xe2e8f0,
    metal: 0x64748b,
    counter: 0xf5f5f4,
    counterTop: 0x78716c,
    pos: 0xe2e8f0,
    posTop: 0x334155,
    screen: 0x0f172a,
    fridge: 0xf1f5f9,
    glass: 0xbae6fd,
    carton: 0xc9a77c,
    select: 0x0f766e,
    selectTint: 0xccfbf1,
    level: 0xf59e0b,
    pin: 0xe11d48,
    entrance: 0x16a34a,
    occFull: 0xd1fae5,
    occPartial: 0xfef3c7,
    occEmpty: 0xffe4e6,
    emptyPlank: 0xf87171,
  };

  const STORAGE = new Set(['shelf', 'fridge', 'rack']);
  const deg = (d) => THREE.MathUtils.degToRad(d || 0);
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return ((h >>> 0) % 1000) / 1000;
  };

  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function label(className, html) {
    return new THREE.CSS2DObject(el('div', className, html));
  }

  class StoreScene {
    constructor(container, { onFixtureClick, onFixtureHover } = {}) {
      this.container = container;
      this.onFixtureClick = onFixtureClick || (() => {});
      this.onFixtureHover = onFixtureHover || (() => {});
      this.fixtures = new Map();
      this.pickables = [];
      this.mode = 'normal';
      this.occupancy = {};
      this.selected = null; // { id, level, productId }
      this.hoverId = null;
      this.focusObjects = [];
      this.tween = null;
      this.clock = new THREE.Clock();

      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      container.appendChild(this.renderer.domElement);

      this.labelRenderer = new THREE.CSS2DRenderer();
      this.labelRenderer.domElement.className = 'scene-labels';
      container.appendChild(this.labelRenderer.domElement);

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(C.background);

      this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 300);
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.maxPolarAngle = Math.PI * 0.44;
      this.controls.minDistance = 2.5;
      this.controls.maxDistance = 70;
      this.controls.screenSpacePanning = false;
      this.controls.addEventListener('start', () => (this.tween = null));

      this.scene.add(new THREE.HemisphereLight(0xffffff, 0xdbe3ea, 0.75));
      this.sun = new THREE.DirectionalLight(0xffffff, 0.65);
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      this.sun.shadow.bias = -0.0008;
      this.sun.shadow.radius = 4;
      this.scene.add(this.sun, this.sun.target);

      this.root = new THREE.Group();
      this.scene.add(this.root);

      this.raycaster = new THREE.Raycaster();
      this.pointer = new THREE.Vector2();
      this._bindPointer();

      this._resize();
      new ResizeObserver(() => this._resize()).observe(container);
      this.renderer.setAnimationLoop(() => this._tick());
    }

    /* ------------------------------------------------------------ building */

    load(branch, categories) {
      this.clearFocus();
      this._clear();
      this.branch = branch;
      this.categories = categories || {};
      const { w, d } = branch.dims;

      this._buildFloor(w, d, branch.fixtures.find((f) => f.type === 'entrance'));
      this._buildZones(branch);
      for (const f of branch.fixtures) {
        if (STORAGE.has(f.type)) this._buildStorage(f, branch.contents[f.id] || [], branch);
        else if (f.type === 'counter') this._buildCounter(f);
        else if (f.type === 'pos') this._buildPos(f);
        else if (f.type === 'entrance') this._buildEntrance(f, d);
        else if (f.type === 'room') this._buildRoom(f);
      }

      const span = Math.max(w, d);
      this.sun.position.set(span * 0.4, span * 1.1, span * 0.7);
      Object.assign(this.sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.5, far: span * 4 });
      this.sun.shadow.camera.updateProjectionMatrix();

      this._refreshStyles();
      this.home(false);
    }

    _clear() {
      for (const child of [...this.root.children]) {
        this._disposeTree(child);
        this.root.remove(child);
      }
      this.fixtures.clear();
      this.pickables = [];
      this.hoverId = null;
    }

    _disposeTree(obj) {
      obj.traverse((o) => {
        // CSS2DRenderer only detaches the element of the object removed directly,
        // nested labels must be detached by hand.
        if (o.isCSS2DObject && o.element.parentNode) o.element.parentNode.removeChild(o.element);
        if (o.geometry) o.geometry.dispose();
        if (o.material) [].concat(o.material).forEach((m) => m.dispose());
      });
    }

    _mesh(geometry, material, { shadow = true, receive = true } = {}) {
      const m = new THREE.Mesh(geometry, material);
      m.castShadow = shadow;
      m.receiveShadow = receive;
      return m;
    }

    _buildFloor(w, d, entrance) {
      const floor = this._mesh(
        new THREE.BoxGeometry(w + 0.24, 0.14, d + 0.24),
        new THREE.MeshStandardMaterial({ color: C.floor, roughness: 0.95 }),
        { shadow: false },
      );
      floor.position.y = -0.07;
      this.root.add(floor);

      const pts = [];
      for (let x = Math.ceil(-w / 2); x <= w / 2; x++) pts.push(x, 0.002, -d / 2, x, 0.002, d / 2);
      for (let z = Math.ceil(-d / 2); z <= d / 2; z++) pts.push(-w / 2, 0.002, z, w / 2, 0.002, z);
      const grid = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
        new THREE.LineBasicMaterial({ color: C.grid }),
      );
      this.root.add(grid);

      const wallMat = new THREE.MeshStandardMaterial({ color: C.wall, roughness: 0.9 });
      const capMat = new THREE.MeshStandardMaterial({ color: C.wallTop, roughness: 0.8 });
      const H = 0.9;
      const T = 0.12;
      const addWall = (x1, z1, x2, z2) => {
        const len = Math.hypot(x2 - x1, z2 - z1);
        if (len < 0.05) return;
        const horizontal = Math.abs(z2 - z1) < 1e-6;
        const geo = horizontal ? new THREE.BoxGeometry(len + T, H, T) : new THREE.BoxGeometry(T, H, len + T);
        const wall = this._mesh(geo, wallMat);
        wall.position.set((x1 + x2) / 2, H / 2, (z1 + z2) / 2);
        const capGeo = horizontal ? new THREE.BoxGeometry(len + T, 0.03, T + 0.01) : new THREE.BoxGeometry(T + 0.01, 0.03, len + T);
        const cap = this._mesh(capGeo, capMat, { shadow: false });
        cap.position.set(wall.position.x, H + 0.015, wall.position.z);
        this.root.add(wall, cap);
      };
      const hw = w / 2;
      const hd = d / 2;
      addWall(-hw, -hd, hw, -hd);
      addWall(-hw, -hd, -hw, hd);
      addWall(hw, -hd, hw, hd);
      if (entrance) {
        const gx1 = entrance.x - entrance.w / 2;
        const gx2 = entrance.x + entrance.w / 2;
        addWall(-hw, hd, gx1, hd);
        addWall(gx2, hd, hw, hd);
      } else {
        addWall(-hw, hd, hw, hd);
      }
    }

    _zoneRect(branch, key) {
      const room = branch.fixtures.find((f) => f.type === 'room' && f.zone === key);
      if (room) return { x1: room.x - room.w / 2, x2: room.x + room.w / 2, z1: room.z - room.d / 2, z2: room.z + room.d / 2 };
      let r = null;
      for (const f of branch.fixtures) {
        if (!STORAGE.has(f.type) || f.zone !== key) continue;
        const sideways = Math.abs(Math.round((f.rot || 0) / 90)) % 2 === 1;
        const hx = (sideways ? f.d : f.w) / 2;
        const hz = (sideways ? f.w : f.d) / 2;
        const b = { x1: f.x - hx, x2: f.x + hx, z1: f.z - hz, z2: f.z + hz };
        r = r ? { x1: Math.min(r.x1, b.x1), x2: Math.max(r.x2, b.x2), z1: Math.min(r.z1, b.z1), z2: Math.max(r.z2, b.z2) } : b;
      }
      if (!r) return null;
      const pad = 0.6;
      const { w, d } = branch.dims;
      return {
        x1: Math.max(-w / 2 + 0.08, r.x1 - pad),
        x2: Math.min(w / 2 - 0.08, r.x2 + pad),
        z1: Math.max(-d / 2 + 0.08, r.z1 - pad),
        z2: Math.min(d / 2 - 0.08, r.z2 + pad),
      };
    }

    _buildZones(branch) {
      for (const [key, zone] of Object.entries(branch.zones || {})) {
        const r = this._zoneRect(branch, key);
        if (!r) continue;
        const color = new THREE.Color(zone.color);
        const w = r.x2 - r.x1;
        const d = r.z2 - r.z1;
        const patch = new THREE.Mesh(
          new THREE.PlaneGeometry(w, d),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, depthWrite: false }),
        );
        patch.rotation.x = -Math.PI / 2;
        patch.position.set((r.x1 + r.x2) / 2, 0.004, (r.z1 + r.z2) / 2);
        patch.receiveShadow = true;

        const border = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(r.x1, 0.006, r.z1),
            new THREE.Vector3(r.x2, 0.006, r.z1),
            new THREE.Vector3(r.x2, 0.006, r.z2),
            new THREE.Vector3(r.x1, 0.006, r.z2),
          ]),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
        );

        const tag = label(
          'lbl-zone',
          `<span class="lbl-zone-dot" style="background:${zone.color}"></span>${zone.label || 'Zona ' + key}<span class="lbl-zone-name">${zone.name || ''}</span>`,
        );
        tag.position.set((r.x1 + r.x2) / 2, 0.02, r.z2 - 0.05);
        this.root.add(patch, border, tag);
      }
    }

    _buildStorage(f, items, branch) {
      const group = new THREE.Group();
      group.position.set(f.x, 0, f.z);
      group.rotation.y = deg(f.rot);
      const w = f.w;
      const d = f.d || 0.5;
      const h = f.h || 2;
      const n = f.levels || 4;
      const isFridge = f.type === 'fridge';
      const isRack = f.type === 'rack';
      const zoneColor = f.zone && branch.zones[f.zone] ? branch.zones[f.zone].color : '#0f766e';

      const frameMat = new THREE.MeshStandardMaterial({ color: isFridge ? C.fridge : C.shelf, roughness: 0.6, metalness: 0.02 });
      const darkMat = new THREE.MeshStandardMaterial({ color: isRack ? C.metal : C.plinth, roughness: 0.6 });
      const accentMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(zoneColor), roughness: 0.5 });
      const rec = {
        f,
        group,
        frameMats: [frameMat],
        fixedMats: [darkMat, accentMat],
        plankMats: [],
        productMats: [],
        productMeshes: new Map(),
        levels: [],
        dims: { w, d, h, n },
      };

      const add = (geo, mat, x, y, z, opts) => {
        const m = this._mesh(geo, mat, opts);
        m.position.set(x, y, z);
        m.userData.fixtureId = f.id;
        group.add(m);
        this.pickables.push(m);
        return m;
      };

      const base = 0.1;
      const levelH = (h - base - 0.04) / n;

      if (isRack) {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.BoxGeometry(0.05, h, 0.05), darkMat, sx * (w / 2 - 0.025), h / 2, sz * (d / 2 - 0.025));
      } else {
        add(new THREE.BoxGeometry(w, base, d), darkMat, 0, base / 2, 0);
        add(new THREE.BoxGeometry(w, h - base, 0.04), frameMat, 0, base + (h - base) / 2, -d / 2 + 0.02);
        add(new THREE.BoxGeometry(0.04, h - base, d), frameMat, -w / 2 + 0.02, base + (h - base) / 2, 0);
        add(new THREE.BoxGeometry(0.04, h - base, d), frameMat, w / 2 - 0.02, base + (h - base) / 2, 0);
        add(new THREE.BoxGeometry(w, 0.04, d), frameMat, 0, h - 0.02, 0);
        add(new THREE.BoxGeometry(w, 0.1, 0.03), accentMat, 0, h - 0.07, d / 2 - 0.01, { shadow: false });
      }

      for (let i = 0; i < n; i++) {
        const y0 = base + i * levelH;
        const plankMat = new THREE.MeshStandardMaterial({ color: isFridge ? 0xcbd5e1 : C.plank, roughness: 0.7 });
        rec.plankMats.push(plankMat);
        add(new THREE.BoxGeometry(w - 0.08, 0.025, d - 0.05), plankMat, 0, y0 + 0.0125, 0.01);
        rec.levels.push({ y0, y1: y0 + levelH });
      }

      if (isFridge) {
        const glassMat = new THREE.MeshStandardMaterial({ color: C.glass, transparent: true, opacity: 0.22, roughness: 0.1, metalness: 0.1, depthWrite: false });
        rec.glassMat = glassMat;
        add(new THREE.BoxGeometry(w - 0.04, h - base - 0.06, 0.02), glassMat, 0, base + (h - base) / 2, d / 2 - 0.01, { shadow: false, receive: false });
      }

      // Products: real level when the branch tracks levels, otherwise spread for visuals only.
      const byLevel = new Map();
      items.forEach((it, k) => {
        const lvl = it.level || ((k + 1) % n) + 1;
        if (!byLevel.has(lvl)) byLevel.set(lvl, []);
        byLevel.get(lvl).push(it);
      });
      const innerW = w - 0.14;
      for (const [lvl, list] of byLevel) {
        const L = rec.levels[lvl - 1];
        if (!L) continue;
        const slots = Math.max(list.length, 3);
        const segW = innerW / slots;
        list.forEach((it, idx) => {
          const color = isRack ? C.carton : new THREE.Color(this.categories[it.category]?.color || '#94a3b8');
          const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
          rec.productMats.push(mat);
          const bh = Math.min((L.y1 - L.y0) * (0.5 + hash(it.name) * 0.25), 0.34);
          const bw = 0.13 + hash(it.name + 'w') * 0.05;
          const count = Math.max(1, Math.floor((segW - 0.04) / (bw + 0.015)));
          const geo = new THREE.BoxGeometry(bw, bh, (d - 0.12) * 0.8);
          const startX = -innerW / 2 + idx * segW + 0.02 + bw / 2;
          const meshes = [];
          for (let c = 0; c < count; c++) {
            const m = add(geo, mat, startX + c * (bw + 0.015), L.y0 + 0.025 + bh / 2, 0.03, { receive: false });
            m.userData.productId = it.productId;
            meshes.push(m);
          }
          rec.productMeshes.set(it.productId, { meshes, mat, level: lvl });
        });
      }

      const tag = label('lbl-fixture', f.id === 'BOD' ? 'Bodega' : f.id);
      tag.element.style.setProperty('--zone', zoneColor);
      tag.position.set(0, h + 0.22, 0);
      group.add(tag);
      rec.tag = tag;

      this.root.add(group);
      this.fixtures.set(f.id, rec);
    }

    _buildCounter(f) {
      const g = new THREE.Group();
      g.position.set(f.x, 0, f.z);
      g.rotation.y = deg(f.rot);
      const body = this._mesh(new THREE.BoxGeometry(f.w, 0.95, f.d), new THREE.MeshStandardMaterial({ color: C.counter, roughness: 0.8 }));
      body.position.y = 0.475;
      const top = this._mesh(new THREE.BoxGeometry(f.w + 0.06, 0.05, f.d + 0.08), new THREE.MeshStandardMaterial({ color: C.counterTop, roughness: 0.5 }));
      top.position.y = 0.975;
      const tag = label('lbl-service', `<i class="bi bi-person-badge"></i>${f.name}`);
      tag.position.set(0, 1.25, 0);
      g.add(body, top, tag);
      this.root.add(g);
    }

    _buildPos(f) {
      const g = new THREE.Group();
      g.position.set(f.x, 0, f.z);
      g.rotation.y = deg(f.rot);
      const body = this._mesh(new THREE.BoxGeometry(f.w, 0.92, f.d), new THREE.MeshStandardMaterial({ color: C.pos, roughness: 0.7 }));
      body.position.y = 0.46;
      const top = this._mesh(new THREE.BoxGeometry(f.w + 0.04, 0.04, f.d + 0.04), new THREE.MeshStandardMaterial({ color: C.posTop, roughness: 0.4 }));
      top.position.y = 0.94;
      const screenMat = new THREE.MeshStandardMaterial({ color: C.screen, roughness: 0.3 });
      const stand = this._mesh(new THREE.BoxGeometry(0.05, 0.22, 0.05), screenMat);
      stand.position.set(0, 1.07, -0.05);
      const screen = this._mesh(new THREE.BoxGeometry(0.42, 0.28, 0.03), screenMat);
      screen.position.set(0, 1.28, -0.05);
      const tag = label('lbl-service lbl-pos', `<i class="bi bi-receipt"></i>${f.name}`);
      tag.position.set(0, 1.62, 0);
      g.add(body, top, stand, screen, tag);
      this.root.add(g);
    }

    _buildEntrance(f, depth) {
      const z = depth / 2;
      const mat = this._mesh(
        new THREE.BoxGeometry(f.w, 0.012, 1.1),
        new THREE.MeshStandardMaterial({ color: C.entrance, transparent: true, opacity: 0.28 }),
        { shadow: false },
      );
      mat.position.set(f.x, 0.006, z - 0.6);
      const postMat = new THREE.MeshStandardMaterial({ color: 0x334155 });
      const p1 = this._mesh(new THREE.BoxGeometry(0.1, 2.1, 0.14), postMat);
      const p2 = p1.clone();
      p1.position.set(f.x - f.w / 2, 1.05, z);
      p2.position.set(f.x + f.w / 2, 1.05, z);
      const header = this._mesh(new THREE.BoxGeometry(f.w + 0.1, 0.12, 0.14), postMat);
      header.position.set(f.x, 2.1, z);

      const arrowShape = new THREE.Shape();
      arrowShape.moveTo(-0.22, 0.3);
      arrowShape.lineTo(0.22, 0.3);
      arrowShape.lineTo(0.22, -0.05);
      arrowShape.lineTo(0.42, -0.05);
      arrowShape.lineTo(0, -0.45);
      arrowShape.lineTo(-0.42, -0.05);
      arrowShape.lineTo(-0.22, -0.05);
      const arrow = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape), new THREE.MeshBasicMaterial({ color: C.entrance, transparent: true, opacity: 0.55 }));
      arrow.rotation.x = -Math.PI / 2;
      arrow.position.set(f.x, 0.014, z - 0.6);

      const tag = label('lbl-entrance', '<i class="bi bi-door-open"></i>Entrada');
      tag.position.set(f.x, 0.05, z + 0.55);
      this.root.add(mat, p1, p2, header, arrow, tag);
    }

    _buildRoom(f) {
      const H = 1.15;
      const T = 0.08;
      const wallMat = new THREE.MeshStandardMaterial({ color: 0xc3ccd7, roughness: 0.9 });
      const x1 = f.x - f.w / 2;
      const x2 = f.x + f.w / 2;
      const z1 = f.z - f.d / 2;
      const z2 = f.z + f.d / 2;
      const door = 1.2;
      const segs = [
        [x1, z1, x1, z2],
        [x2, z1, x2, z2],
        [x1, z2, f.x - door / 2, z2],
        [f.x + door / 2, z2, x2, z2],
      ];
      for (const [ax, az, bx, bz] of segs) {
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.05) continue;
        const horizontal = Math.abs(bz - az) < 1e-6;
        const wall = this._mesh(horizontal ? new THREE.BoxGeometry(len, H, T) : new THREE.BoxGeometry(T, H, len), wallMat);
        wall.position.set((ax + bx) / 2, H / 2, (az + bz) / 2);
        this.root.add(wall);
      }
      const tag = label('lbl-room', `<i class="bi bi-box-seam"></i>${f.name}`);
      tag.position.set(f.x, H + 0.15, z2);
      this.root.add(tag);
    }

    /* ------------------------------------------------------------- styling */

    setMode(mode, occupancy = {}) {
      this.mode = mode;
      this.occupancy = occupancy;
      this._refreshStyles();
    }

    _refreshStyles() {
      const sel = this.selected;
      for (const [id, rec] of this.fixtures) {
        const isSel = sel && sel.id === id;
        const dim = sel && !isSel;
        const hover = this.hoverId === id && !isSel;
        const occ = this.occupancy[id];

        let frameColor = rec.f.type === 'fridge' ? C.fridge : C.shelf;
        if (this.mode === 'occupancy' && occ) {
          frameColor = occ.ratio >= 0.999 ? C.occFull : occ.ratio > 0 ? C.occPartial : C.occEmpty;
        }
        if (isSel) frameColor = C.selectTint;

        for (const m of rec.frameMats) {
          m.color.setHex(frameColor);
          m.emissive.setHex(isSel || hover ? C.select : 0x000000);
          m.emissiveIntensity = isSel ? 0.12 : hover ? 0.08 : 0;
        }
        rec.plankMats.forEach((m, i) => {
          const empty = this.mode === 'occupancy' && occ && occ.emptyLevels && occ.emptyLevels.includes(i + 1);
          m.color.setHex(empty ? C.emptyPlank : rec.f.type === 'fridge' ? 0xcbd5e1 : C.plank);
        });
        for (const [pid, pm] of rec.productMeshes) {
          const glow = isSel && sel.productId === pid;
          pm.mat.emissive.setHex(glow ? C.level : 0x000000);
          pm.mat.emissiveIntensity = glow ? 0.55 : 0;
        }

        const all = [...rec.frameMats, ...rec.fixedMats, ...rec.plankMats, ...rec.productMats];
        for (const m of all) {
          m.transparent = Boolean(dim);
          m.opacity = dim ? 0.22 : 1;
          m.depthWrite = !dim;
          m.needsUpdate = true;
        }
        if (rec.glassMat) rec.glassMat.opacity = dim ? 0.08 : 0.22;

        rec.tag.element.classList.toggle('is-selected', Boolean(isSel));
        rec.tag.element.classList.toggle('is-dim', Boolean(dim));
        rec.tag.element.classList.toggle('is-hover', Boolean(hover));
      }
    }

    /* --------------------------------------------------------------- focus */

    focusFixture(fixtureId, { level = null, productId = null, callout = '' } = {}) {
      const rec = this.fixtures.get(fixtureId);
      if (!rec) return;
      this._removeFocusObjects();
      this.selected = { id: fixtureId, level, productId };
      this._refreshStyles();

      const { w, d, h } = rec.dims;
      const group = rec.group;

      if (level && rec.levels[level - 1]) {
        const L = rec.levels[level - 1];
        const lh = L.y1 - L.y0;
        const boxGeo = new THREE.BoxGeometry(w - 0.06, lh - 0.02, d + 0.04);
        const box = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ color: C.level, transparent: true, opacity: 0.2, depthWrite: false }));
        box.position.set(0, L.y0 + lh / 2, 0.01);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo), new THREE.LineBasicMaterial({ color: C.level }));
        edges.position.copy(box.position);
        const strip = new THREE.Mesh(new THREE.BoxGeometry(w - 0.04, 0.035, 0.035), new THREE.MeshBasicMaterial({ color: C.level }));
        strip.position.set(0, L.y0 + 0.02, d / 2 + 0.02);
        group.add(box, edges, strip);
        this.focusObjects.push({ obj: box, parent: group, pulse: 'box' }, { obj: edges, parent: group }, { obj: strip, parent: group });

        const lvlTag = label('lbl-level', `${rec.f.levelLabel || 'Nivel'} ${level}`);
        lvlTag.position.set(w / 2 + 0.05, L.y0 + lh / 2, d / 2);
        group.add(lvlTag);
        this.focusObjects.push({ obj: lvlTag, parent: group });
      }

      const pin = new THREE.Group();
      const pinMat = new THREE.MeshStandardMaterial({ color: C.pin, emissive: C.pin, emissiveIntensity: 0.25, roughness: 0.35 });
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 16), pinMat);
      head.position.y = 0.48;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.115, 0.42, 24), pinMat);
      tip.rotation.x = Math.PI;
      tip.position.y = 0.22;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.065, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      dot.position.set(0, 0.5, 0.13);
      head.castShadow = tip.castShadow = true;
      pin.add(head, tip, dot);
      pin.position.set(0, h + 0.45, 0);
      pin.userData.baseY = h + 0.45;
      group.add(pin);
      this.focusObjects.push({ obj: pin, parent: group, pulse: 'pin' });

      if (callout) {
        const tag = label('lbl-callout', callout);
        tag.position.set(0, 1.05, 0);
        pin.add(tag);
      }

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.32, 0.4, 48),
        new THREE.MeshBasicMaterial({ color: C.pin, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, 0.02, d / 2 + 0.55);
      group.add(ring);
      this.focusObjects.push({ obj: ring, parent: group, pulse: 'ring' });

      rec.tag.element.classList.add('is-selected');

      // Camera: in front of the fixture face, slightly to the side and above.
      const yFocus = level && rec.levels[level - 1] ? (rec.levels[level - 1].y0 + rec.levels[level - 1].y1) / 2 : h * 0.55;
      group.updateMatrixWorld();
      const target = group.localToWorld(new THREE.Vector3(0, yFocus, 0));
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(group.quaternion);
      const lateral = new THREE.Vector3(1, 0, 0).applyQuaternion(group.quaternion);
      target.y = (yFocus + h + 1.1) / 2; // midpoint between the level and the pin, keeps both in frame
      const dist = THREE.MathUtils.clamp(w * 1.2 + 3.4, 5.2, 10);
      const pos = target
        .clone()
        .addScaledVector(normal, dist * 0.78)
        .addScaledVector(lateral, dist * 0.22)
        .add(new THREE.Vector3(0, dist * 0.72, 0));
      this._flyTo(pos, target);
    }

    clearFocus() {
      this._removeFocusObjects();
      if (this.selected) {
        this.selected = null;
        this._refreshStyles();
      }
    }

    _removeFocusObjects() {
      for (const { obj, parent } of this.focusObjects) {
        parent.remove(obj);
        this._disposeTree(obj);
      }
      this.focusObjects = [];
    }

    /* -------------------------------------------------------------- camera */

    _fovs() {
      const v = deg(this.camera.fov);
      return { v, h: 2 * Math.atan(Math.tan(v / 2) * this.camera.aspect) };
    }

    _homePose() {
      const { w, d } = this.branch.dims;
      const { v, h } = this._fovs();
      const radius = Math.hypot(w, d) / 2;
      const dist = (radius / Math.sin(Math.min(v, h) / 2)) * 0.8;
      const target = new THREE.Vector3(0, 0, -0.06 * d);
      const dir = new THREE.Vector3(0.3, 0.85, 0.75).normalize();
      return { pos: target.clone().addScaledVector(dir, dist), target };
    }

    home(animate = true) {
      const { pos, target } = this._homePose();
      if (animate) this._flyTo(pos, target);
      else {
        this.camera.position.copy(pos);
        this.controls.target.copy(target);
        this.controls.update();
      }
    }

    topView() {
      const { w, d } = this.branch.dims;
      const { v, h } = this._fovs();
      const height = Math.max(d / 2 / Math.tan(v / 2), w / 2 / Math.tan(h / 2)) * 1.18 + 2.2;
      this._flyTo(new THREE.Vector3(0, height, 0.01), new THREE.Vector3(0, 0, -0.04 * d));
    }

    zoom(factor) {
      const dir = this.camera.position.clone().sub(this.controls.target);
      const len = THREE.MathUtils.clamp(dir.length() * factor, this.controls.minDistance, this.controls.maxDistance);
      this._flyTo(this.controls.target.clone().add(dir.setLength(len)), this.controls.target.clone(), 450);
    }

    _flyTo(pos, target, duration = 1100) {
      this.tween = {
        fromPos: this.camera.position.clone(),
        fromTarget: this.controls.target.clone(),
        toPos: pos,
        toTarget: target,
        start: performance.now(),
        duration,
      };
    }

    setLabelsVisible(visible) {
      this.container.classList.toggle('hide-labels', !visible);
    }

    /* ------------------------------------------------------------- picking */

    _bindPointer() {
      const dom = this.renderer.domElement;
      let down = null;
      let pending = null;

      const pick = (e) => {
        const r = dom.getBoundingClientRect();
        this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
        return hit ? hit.object.userData.fixtureId : null;
      };

      dom.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
      dom.addEventListener('pointerup', (e) => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        down = null;
        if (moved < 6) this.onFixtureClick(pick(e));
      });
      dom.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') return;
        if (pending) return;
        pending = requestAnimationFrame(() => {
          pending = null;
          const id = down ? null : pick(e);
          dom.style.cursor = id ? 'pointer' : '';
          if (id !== this.hoverId) {
            this.hoverId = id;
            this._refreshStyles();
          }
          this.onFixtureHover(id, e.clientX, e.clientY);
        });
      });
      dom.addEventListener('pointerleave', () => {
        this.hoverId = null;
        this._refreshStyles();
        this.onFixtureHover(null);
      });
    }

    /* ---------------------------------------------------------------- loop */

    _resize() {
      const w = this.container.clientWidth || 1;
      const h = this.container.clientHeight || 1;
      this.renderer.setSize(w, h);
      this.labelRenderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    _tick() {
      const t = this.clock.getElapsedTime();
      if (this.tween) {
        const tw = this.tween;
        const p = Math.min(1, (performance.now() - tw.start) / tw.duration);
        const e = easeInOutCubic(p);
        this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
        this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
        if (p >= 1) this.tween = null;
      }
      for (const fo of this.focusObjects) {
        if (fo.pulse === 'pin') fo.obj.position.y = fo.obj.userData.baseY + Math.sin(t * 3) * 0.07;
        else if (fo.pulse === 'ring') {
          const ph = (t % 1.6) / 1.6;
          fo.obj.scale.setScalar(1 + ph * 1.8);
          fo.obj.material.opacity = 0.8 * (1 - ph);
        } else if (fo.pulse === 'box') fo.obj.material.opacity = 0.16 + 0.12 * (0.5 + 0.5 * Math.sin(t * 4));
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
    }
  }

  window.StoreScene = StoreScene;
})();
