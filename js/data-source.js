/*
 * Data access layer.
 *
 * The UI talks ONLY to `DataSource` and every method is async. To move from the
 * simulated data to a real backend, re-implement these methods with fetch()
 * against the API (e.g. GET /api/branches/:id/products?q=) and keep the same
 * return shapes — no UI or 3D code needs to change.
 */
(function () {
  const db = window.DEMO_DATA;
  const LATENCY_MS = 40;

  const respond = (value) =>
    new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), LATENCY_MS));

  const productsById = new Map(db.products.map((p) => [p.id, p]));
  const branchesById = new Map(db.branches.map((b) => [b.id, b]));
  const STORAGE_TYPES = new Set(['shelf', 'fridge', 'rack']);

  const normalize = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim();

  function fixtureOf(branch, fixtureId) {
    return branch.fixtures.find((f) => f.id === fixtureId);
  }

  function fixtureName(branch, f) {
    if (f.name) return f.name;
    const shelfLabel = branch.schema.find((s) => s.key === 'percha')?.label || 'Percha';
    return `${shelfLabel === 'Ubicación' ? 'Percha' : shelfLabel} ${f.id}`;
  }

  /** Builds the location path following the branch's own schema depth. */
  function buildLocation(branch, fixtureId, level) {
    const f = fixtureOf(branch, fixtureId);
    const segments = [];
    const fields = { zona: null, pasillo: null, percha: f.id, nivel: null };
    for (const s of branch.schema) {
      if (s.key === 'zona' && f.zone) {
        const z = branch.zones[f.zone] || {};
        fields.zona = f.zone;
        segments.push({ key: 'zona', label: s.label, text: z.label || `Zona ${f.zone}`, detail: z.name || '' });
      } else if (s.key === 'pasillo' && f.aisle) {
        fields.pasillo = f.aisle;
        segments.push({ key: 'pasillo', label: s.label, text: `Pasillo ${f.aisle}`, detail: '' });
      } else if (s.key === 'percha') {
        segments.push({
          key: 'percha',
          label: s.label,
          text: fixtureName(branch, f),
          detail: f.type === 'fridge' ? 'Refrigerado 2–8 °C' : '',
        });
      } else if (s.key === 'nivel' && level) {
        fields.nivel = level;
        segments.push({ key: 'nivel', label: s.label, text: `${f.levelLabel || 'Nivel'} ${level}`, detail: '' });
      }
    }
    return {
      fixtureId: f.id,
      level: level || null,
      fields,
      segments,
      text: segments.map((s) => s.text).join(' → '),
    };
  }

  function userFor(productId, offset = 0) {
    return db.meta.users[(productId + offset) % db.meta.users.length];
  }

  function placementsOf(branch) {
    return branch.placements.map((pl) => {
      const product = productsById.get(pl.p);
      return {
        productId: pl.p,
        product,
        stock: pl.stock,
        updatedAt: pl.at,
        updatedBy: userFor(pl.p),
        relocated: Boolean(pl.prev),
        location: buildLocation(branch, pl.f, pl.lvl),
        raw: pl,
      };
    });
  }

  function flatRecord(branch, pl) {
    // Flat shape requested for the demo dataset (one row per product and branch).
    const { product, location } = pl;
    return {
      id: product.id,
      code: product.code,
      barcode: product.barcode,
      name: product.name,
      active: product.active,
      presentation: product.presentation,
      category: product.category,
      categoryName: db.categories[product.category]?.name,
      stock: pl.stock,
      branchId: branch.id,
      branchName: branch.name,
      zona: location.fields.zona,
      pasillo: location.fields.pasillo,
      percha: location.fields.percha,
      nivel: location.fields.nivel,
      updatedAt: pl.updatedAt,
      updatedBy: pl.updatedBy,
      relocated: pl.relocated,
      location,
    };
  }

  function branchSummary(b) {
    return {
      id: b.id,
      name: b.name,
      size: b.size,
      address: b.address,
      schema: b.schema,
      productCount: b.placements.length,
      locationCount: b.fixtures.filter((f) => STORAGE_TYPES.has(f.type)).length,
    };
  }

  function addMinutes(isoLocal, minutes) {
    const d = new Date(isoLocal);
    d.setMinutes(d.getMinutes() + minutes);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const shortPlace = (loc) =>
    loc.segments
      .filter((s) => s.key === 'percha' || s.key === 'nivel')
      .map((s) => s.text)
      .join(', ');

  /** Simulated movement history, derived from the current placement. */
  function synthesizeTracking(branch, pl) {
    const raw = pl.raw;
    const lot = `L${(raw.p * 7919) % 90000 + 10000}`;
    const current = buildLocation(branch, raw.f, raw.lvl);
    const events = [];
    if (raw.prev) {
      const previous = buildLocation(branch, raw.prev.f, raw.prev.lvl);
      events.push(
        { at: addMinutes(raw.at, -196), type: 'received', title: 'Producto recibido', detail: `Recepción de proveedor · Lote ${lot}`, user: userFor(raw.p, 1) },
        { at: addMinutes(raw.at, -176), type: 'inventory', title: 'Ingreso a inventario', detail: `+${raw.stock} unidades registradas`, user: userFor(raw.p, 2) },
        { at: addMinutes(raw.at, -141), type: 'placed', title: `Ubicado en ${shortPlace(previous)}`, detail: previous.text, user: userFor(raw.p, 3) },
        { at: addMinutes(raw.at, -1), type: 'moved', title: `Reubicado en ${shortPlace(current)}`, detail: `Desde ${shortPlace(previous)} · ${current.text}`, user: pl.updatedBy },
        { at: raw.at, type: 'updated', title: 'Ubicación actualizada', detail: 'Ubicación confirmada por escaneo', user: pl.updatedBy },
      );
    } else {
      events.push(
        { at: addMinutes(raw.at, -95), type: 'received', title: 'Producto recibido', detail: `Recepción de proveedor · Lote ${lot}`, user: userFor(raw.p, 1) },
        { at: addMinutes(raw.at, -70), type: 'inventory', title: 'Ingreso a inventario', detail: `+${raw.stock} unidades registradas`, user: userFor(raw.p, 2) },
        { at: addMinutes(raw.at, -1), type: 'placed', title: `Ubicado en ${shortPlace(current)}`, detail: current.text, user: pl.updatedBy },
        { at: raw.at, type: 'updated', title: 'Ubicación actualizada', detail: 'Ubicación confirmada por escaneo', user: pl.updatedBy },
      );
    }
    return events;
  }

  function scoreMatch(product, q) {
    const name = normalize(product.name);
    const active = normalize(product.active);
    const code = normalize(product.code);
    const barcode = product.barcode;
    if (code === q || barcode === q) return { score: 100, field: barcode === q ? 'barcode' : 'code' };
    if (name.startsWith(q)) return { score: 90, field: 'name' };
    if (name.includes(q)) return { score: 80, field: 'name' };
    if (active.startsWith(q)) return { score: 70, field: 'active' };
    if (active.includes(q)) return { score: 60, field: 'active' };
    if (code.includes(q)) return { score: 50, field: 'code' };
    if (barcode.includes(q)) return { score: 40, field: 'barcode' };
    // Multi-word query ("losartan 50"): every token must appear in name or active.
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length > 1 && tokens.every((t) => name.includes(t) || active.includes(t))) {
      return { score: 75, field: 'name' };
    }
    return null;
  }

  window.DataSource = {
    async getMeta() {
      return respond({ now: db.meta.now, categories: db.categories });
    },

    async getBranches() {
      return respond(db.branches.map(branchSummary));
    },

    /** Full branch: layout + per-fixture contents, ready for the 3D scene. */
    async getBranch(branchId) {
      const b = branchesById.get(branchId);
      const contents = {};
      for (const pl of placementsOf(b)) {
        (contents[pl.location.fixtureId] ||= []).push({
          productId: pl.productId,
          name: pl.product.name,
          category: pl.product.category,
          level: pl.location.level,
          stock: pl.stock,
        });
      }
      const fixtures = b.fixtures.map((f) => ({
        ...f,
        displayName: f.name || (STORAGE_TYPES.has(f.type) ? fixtureName(b, f) : f.id),
        isStorage: STORAGE_TYPES.has(f.type),
      }));
      return respond({ ...branchSummary(b), dims: b.dims, zones: b.zones, fixtures, contents, hasLevels: b.schema.some((s) => s.key === 'nivel') });
    },

    async searchProducts(branchId, query, limit = 8) {
      const q = normalize(query);
      if (!q) return respond([]);
      const b = branchesById.get(branchId);
      const inBranch = new Map(placementsOf(b).map((pl) => [pl.productId, pl]));
      const results = [];
      for (const p of db.products) {
        const m = scoreMatch(p, q);
        if (!m) continue;
        const pl = inBranch.get(p.id);
        results.push({
          id: p.id,
          code: p.code,
          barcode: p.barcode,
          name: p.name,
          active: p.active,
          presentation: p.presentation,
          matchedField: m.field,
          score: m.score + (pl ? 5 : 0),
          available: Boolean(pl),
          stock: pl ? pl.stock : 0,
          locationText: pl ? pl.location.text : null,
        });
      }
      results.sort((a, b2) => b2.score - a.score || a.name.localeCompare(b2.name));
      return respond(results.slice(0, limit));
    },

    async getProductDetail(branchId, productId) {
      const product = productsById.get(productId);
      const b = branchesById.get(branchId);
      const pl = placementsOf(b).find((x) => x.productId === productId);
      const otherBranches = db.branches
        .filter((ob) => ob.id !== branchId)
        .map((ob) => {
          const opl = placementsOf(ob).find((x) => x.productId === productId);
          return opl ? { branchId: ob.id, branchName: ob.name, stock: opl.stock, locationText: opl.location.text } : null;
        })
        .filter(Boolean);
      return respond({
        product: { ...product, categoryName: db.categories[product.category]?.name, categoryColor: db.categories[product.category]?.color },
        available: Boolean(pl),
        record: pl ? flatRecord(b, pl) : null,
        otherBranches,
      });
    },

    async getTracking(branchId, productId) {
      const b = branchesById.get(branchId);
      const pl = placementsOf(b).find((x) => x.productId === productId);
      if (!pl) return respond([]);
      return respond(synthesizeTracking(b, pl));
    },

    /** Everything the administration view needs, computed per location. */
    async getAdminOverview(branchId) {
      const b = branchesById.get(branchId);
      const hasLevels = b.schema.some((s) => s.key === 'nivel');
      const pls = placementsOf(b);
      const today = db.meta.now.slice(0, 10);

      const locations = b.fixtures
        .filter((f) => STORAGE_TYPES.has(f.type))
        .map((f) => {
          const items = pls
            .filter((pl) => pl.location.fixtureId === f.id)
            .map((pl) => ({
              productId: pl.productId,
              name: pl.product.name,
              code: pl.product.code,
              level: pl.location.level,
              stock: pl.stock,
              updatedAt: pl.updatedAt,
            }))
            .sort((a, c) => (a.level || 0) - (c.level || 0) || a.name.localeCompare(c.name));
          const usedLevels = new Set(items.map((i) => i.level));
          const emptyLevels = hasLevels
            ? Array.from({ length: f.levels }, (_, i) => i + 1).filter((l) => !usedLevels.has(l))
            : [];
          const capacity = hasLevels ? f.levels : f.capacity || f.levels;
          const occupied = hasLevels ? f.levels - emptyLevels.length : items.length;
          const lastChange = items.reduce((max, i) => (i.updatedAt > max ? i.updatedAt : max), '');
          return {
            fixtureId: f.id,
            name: fixtureName(b, f),
            zone: f.zone || null,
            zoneLabel: f.zone ? b.zones[f.zone]?.label || `Zona ${f.zone}` : null,
            zoneName: f.zone ? b.zones[f.zone]?.name : null,
            aisle: f.aisle || null,
            levelLabel: f.levelLabel || 'Nivel',
            levels: f.levels,
            capacity,
            occupied,
            ratio: capacity ? Math.min(1, occupied / capacity) : 0,
            units: items.reduce((s, i) => s + i.stock, 0),
            items,
            emptyLevels,
            isEmpty: items.length === 0,
            lastChange: lastChange || null,
          };
        });

      const emptySlots = hasLevels
        ? locations.flatMap((l) =>
            l.emptyLevels.map((lv) => ({ fixtureId: l.fixtureId, level: lv, text: buildLocation(b, l.fixtureId, lv).text })),
          )
        : locations.filter((l) => l.isEmpty).map((l) => ({ fixtureId: l.fixtureId, level: null, text: buildLocation(b, l.fixtureId).text }));

      const products = pls
        .map((pl) => flatRecord(b, pl))
        .sort((a, c) => (a.updatedAt < c.updatedAt ? 1 : -1));

      return respond({
        hasLevels,
        kpis: {
          products: pls.length,
          units: pls.reduce((s, pl) => s + pl.stock, 0),
          locations: locations.length,
          slots: hasLevels ? locations.reduce((s, l) => s + l.levels, 0) : locations.length,
          empty: emptySlots.length,
          changesToday: pls.filter((pl) => pl.updatedAt.startsWith(today)).length,
        },
        locations,
        emptySlots,
        products,
      });
    },
  };
})();
