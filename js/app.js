/*
 * UI controller: branch selection, search, product card, tracking, admin view.
 * Reads data exclusively through window.DataSource (async).
 */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    meta: null,
    branches: [],
    branch: null,
    mode: 'search',
    detail: null,
    located: false,
    admin: null,
    adminTab: 'locations',
    adminFilter: '',
    results: [],
    activeIndex: -1,
    searchSeq: 0,
  };
  let scene = null;

  /* -------------------------------------------------------------- helpers */

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const normalize = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function highlight(text, query) {
    const q = normalize(query).trim();
    if (!q) return esc(text);
    const i = normalize(text).indexOf(q);
    if (i < 0) return esc(text);
    return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
  }

  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function parts(iso) {
    const [date, time] = iso.split('T');
    const [y, m, d] = date.split('-').map(Number);
    return { y, m, d, time, date };
  }
  function fmtDateTime(iso) {
    const p = parts(iso);
    return `${String(p.d).padStart(2, '0')}/${String(p.m).padStart(2, '0')}/${p.y} ${p.time}`;
  }
  function fmtRelative(iso) {
    if (!iso) return '—';
    const p = parts(iso);
    const now = new Date(state.meta.now.slice(0, 10) + 'T00:00');
    const day = new Date(p.date + 'T00:00');
    const diff = Math.round((now - day) / 86400000);
    if (diff === 0) return `Hoy ${p.time}`;
    if (diff === 1) return `Ayer ${p.time}`;
    return `${String(p.d).padStart(2, '0')} ${MONTHS[p.m - 1]} ${p.time}`;
  }
  const fmtInt = (n) => new Intl.NumberFormat('es-EC').format(n);

  const SEG_ICONS = { zona: 'bi-bounding-box', pasillo: 'bi-signpost-split', percha: 'bi-bookshelf', nivel: 'bi-layers' };

  function stockBadge(stock) {
    if (stock <= 5) return '<span class="badge-soft danger"><i class="bi bi-exclamation-circle"></i> Stock crítico</span>';
    if (stock < 10) return '<span class="badge-soft warn"><i class="bi bi-exclamation-triangle"></i> Stock bajo</span>';
    return '<span class="badge-soft ok"><i class="bi bi-check-circle"></i> Disponible</span>';
  }

  /* ----------------------------------------------------------------- boot */

  async function boot() {
    try {
      if (!window.THREE || !THREE.OrbitControls || !THREE.CSS2DRenderer) throw new Error('three.js not loaded');
      scene = new StoreScene($('#scene'), { onFixtureClick, onFixtureHover });
    } catch (err) {
      console.error(err);
      $('#sceneError').hidden = false;
    }

    state.meta = await DataSource.getMeta();
    state.branches = await DataSource.getBranches();
    $('#branchSelect').innerHTML = state.branches
      .map((b) => `<option value="${b.id}">${esc(b.name)} · ${esc(b.size)}</option>`)
      .join('');

    let initial = 'matriz';
    try {
      initial = localStorage.getItem('ubicafarma.branch') || initial;
    } catch (_) {}
    if (!state.branches.some((b) => b.id === initial)) initial = state.branches[0].id;
    $('#branchSelect').value = initial;

    bindEvents();
    renderEmptyCard();
    await selectBranch(initial);
  }

  /* ------------------------------------------------------------- branches */

  async function selectBranch(branchId) {
    state.branch = await DataSource.getBranch(branchId);
    try {
      localStorage.setItem('ubicafarma.branch', branchId);
    } catch (_) {}

    if (scene) scene.load(state.branch, state.meta.categories);
    hideShelfCard();
    hideBanner();
    renderBranchInfo();
    renderLegend();

    if (state.mode === 'admin') await loadAdmin();

    if (state.detail) {
      const keepLocated = state.located;
      await selectProduct(state.detail.product.id, { locate: keepLocated });
    }
    if (!$('#searchResults').hidden) runSearch($('#searchInput').value);
  }

  function renderBranchInfo() {
    const b = state.branch;
    const chain = b.schema.map((s) => `<span>${esc(s.label)}</span>`).join('<i class="bi bi-chevron-right"></i>');
    $('#branchInfo').innerHTML = `
      <div class="vp-branch-top">
        <h1>${esc(b.name)}</h1>
        <span class="size-badge size-${normalize(b.size)}">Sucursal ${esc(b.size.toLowerCase())}</span>
      </div>
      <div class="vp-branch-addr"><i class="bi bi-pin-map"></i> ${esc(b.address)} · ${b.dims.w} × ${b.dims.d} m</div>
      <div class="vp-branch-schema" title="Nivel de detalle de ubicación en esta sucursal">
        <span class="schema-label">Estructura</span><span class="schema-root">Sucursal</span><i class="bi bi-chevron-right"></i>${chain}
      </div>`;
  }

  function renderLegend() {
    const b = state.branch;
    let rows;
    if (state.mode === 'admin') {
      rows = `
        <div class="lg-title">Ocupación</div>
        <div class="lg-row"><span class="lg-sw" style="background:#bbf7d0"></span>Completa</div>
        <div class="lg-row"><span class="lg-sw" style="background:#fde68a"></span>Parcial</div>
        <div class="lg-row"><span class="lg-sw" style="background:#fecaca"></span>Vacía</div>
        ${b.hasLevels ? '<div class="lg-row"><span class="lg-sw" style="background:#f87171;height:4px"></span>Nivel vacío</div>' : ''}`;
    } else {
      const zones = Object.entries(b.zones || {});
      rows = zones.length
        ? `<div class="lg-title">Zonas</div>` +
          zones
            .map(([k, z]) => `<div class="lg-row"><span class="lg-sw" style="background:${z.color}"></span>${esc(z.label || 'Zona ' + k)} · ${esc(z.name)}</div>`)
            .join('')
        : `<div class="lg-title">Perchas</div><div class="lg-row lg-muted">Sucursal sin zonas: ubicación directa por percha</div>`;
    }
    $('#legend').innerHTML = `
      ${rows}
      <div class="lg-sep"></div>
      <div class="lg-row"><i class="bi bi-door-open lg-ico" style="color:#16a34a"></i>Entrada</div>
      <div class="lg-row"><i class="bi bi-receipt lg-ico"></i>Caja / POS</div>
      <div class="lg-row"><i class="bi bi-person-badge lg-ico"></i>Mostrador</div>`;
  }

  /* --------------------------------------------------------------- search */

  let debounce = null;
  function onSearchInput(e) {
    clearTimeout(debounce);
    const value = e.target.value;
    debounce = setTimeout(() => runSearch(value), 110);
  }

  async function runSearch(query) {
    const seq = ++state.searchSeq;
    const results = await DataSource.searchProducts(state.branch.id, query);
    if (seq !== state.searchSeq) return;
    state.results = results;
    state.activeIndex = results.length ? 0 : -1;
    renderResults(query);
  }

  const FIELD_LABEL = { name: 'Nombre', active: 'Principio activo', code: 'Código', barcode: 'Código de barras' };

  function renderResults(query) {
    const box = $('#searchResults');
    if (!query.trim()) {
      box.hidden = true;
      return;
    }
    if (!state.results.length) {
      box.innerHTML = `<div class="sr-empty"><i class="bi bi-search"></i> Sin coincidencias para “${esc(query)}”</div>`;
      box.hidden = false;
      return;
    }
    box.innerHTML = state.results
      .map(
        (r, i) => `
      <button type="button" class="sr-item ${i === state.activeIndex ? 'active' : ''}" role="option" data-index="${i}" aria-selected="${i === state.activeIndex}">
        <div class="sr-main">
          <div class="sr-name">${highlight(r.name, query)}</div>
          <div class="sr-sub">${highlight(r.active, query)} · ${esc(r.presentation)}</div>
          <div class="sr-codes"><span>${highlight(r.code, query)}</span><span>${highlight(r.barcode, query)}</span>
            ${r.matchedField !== 'name' ? `<em>por ${FIELD_LABEL[r.matchedField]}</em>` : ''}</div>
        </div>
        <div class="sr-side">
          ${
            r.available
              ? `<span class="sr-stock">${r.stock} u.</span><span class="sr-loc">${esc(r.locationText.split(' → ').slice(-2).join(' · '))}</span>`
              : '<span class="sr-na">No disponible aquí</span>'
          }
        </div>
      </button>`,
      )
      .join('');
    box.hidden = false;
  }

  function onSearchKey(e) {
    const box = $('#searchResults');
    if (e.key === 'Escape') {
      box.hidden = true;
      return;
    }
    if (box.hidden || !state.results.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = state.results.length;
      state.activeIndex = (state.activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderResults(e.target.value);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickResult(state.activeIndex);
    }
  }

  function pickResult(index) {
    const r = state.results[index];
    if (!r) return;
    $('#searchInput').value = r.name;
    $('#searchResults').hidden = true;
    selectProduct(r.id, { locate: false });
  }

  /* -------------------------------------------------------------- product */

  async function selectProduct(productId, { locate = false } = {}) {
    state.detail = await DataSource.getProductDetail(state.branch.id, productId);
    state.located = false;
    if (scene) scene.clearFocus();
    hideBanner();
    renderCard();
    if (locate && state.detail.available) showLocation();
  }

  function renderEmptyCard() {
    $('#productCard').innerHTML = `
      <div class="empty-state">
        <div class="empty-ico"><i class="bi bi-capsule"></i></div>
        <h2>¿Qué producto busca?</h2>
        <p>Escriba el nombre comercial, el principio activo, el código interno o escanee el código de barras.</p>
        <ol class="flow">
          <li><span>1</span>Seleccione la sucursal</li>
          <li><span>2</span>Busque el medicamento</li>
          <li><span>3</span>Vea dónde está en el mapa</li>
          <li><span>4</span>Consulte su tracking</li>
        </ol>
      </div>`;
  }

  function locationSteps(segments) {
    return `<ol class="loc-steps">${segments
      .map(
        (s) => `
        <li>
          <span class="loc-ico"><i class="bi ${SEG_ICONS[s.key]}"></i></span>
          <div><div class="loc-label">${esc(s.label)}</div>
          <div class="loc-value">${esc(s.text)}${s.detail ? `<span class="loc-detail">${esc(s.detail)}</span>` : ''}</div></div>
        </li>`,
      )
      .join('')}</ol>`;
  }

  function renderCard() {
    const { product, available, record, otherBranches } = state.detail;
    const others = otherBranches.length
      ? `<div class="others">
          <div class="section-title">Disponible en otras sucursales</div>
          ${otherBranches
            .map(
              (o) => `<button type="button" class="other-row" data-branch="${o.branchId}">
                <div><strong>${esc(o.branchName)}</strong><span>${esc(o.locationText)}</span></div>
                <span class="other-stock">${o.stock} u.</span><i class="bi bi-arrow-right-short"></i>
              </button>`,
            )
            .join('')}
        </div>`
      : '';

    const header = `
      <div class="pc-head">
        <span class="cat-chip" style="--cat:${product.categoryColor}">${esc(product.categoryName)}</span>
        ${available ? stockBadge(record.stock) : '<span class="badge-soft muted">Sin stock en sucursal</span>'}
      </div>
      <h2 class="pc-name">${esc(product.name)}</h2>
      <div class="pc-sub">${esc(product.active)} · ${esc(product.presentation)}</div>`;

    if (!available) {
      $('#productCard').innerHTML = `
        <article class="pcard">
          ${header}
          <div class="na-box"><i class="bi bi-shop"></i>
            <div><strong>No se maneja en ${esc(state.branch.name)}</strong>
            <span>Este producto no tiene ubicación asignada en esta sucursal.</span></div>
          </div>
          <dl class="pc-codes">
            <div><dt>Código</dt><dd>${esc(product.code)}</dd></div>
            <div><dt>Código de barras</dt><dd>${esc(product.barcode)}</dd></div>
          </dl>
          ${others}
        </article>`;
      return;
    }

    $('#productCard').innerHTML = `
      <article class="pcard">
        ${header}
        <div class="pc-stock">
          <div><span class="pc-stock-num">${fmtInt(record.stock)}</span><span class="pc-stock-unit">unidades</span></div>
          <span class="pc-stock-label">Stock en ${esc(state.branch.name)}</span>
        </div>
        <div class="section-title">Ubicación</div>
        ${locationSteps(record.location.segments)}
        <div class="pc-actions">
          <button type="button" class="btn btn-primary" id="btnLocate"><i class="bi bi-crosshair"></i> Mostrar ubicación</button>
          <button type="button" class="btn btn-outline-secondary" id="btnTracking"><i class="bi bi-clock-history"></i> Ver tracking</button>
        </div>
        <dl class="pc-codes">
          <div><dt>Código</dt><dd>${esc(product.code)}</dd></div>
          <div><dt>Código de barras</dt><dd>${esc(product.barcode)}</dd></div>
          <div class="wide"><dt>Última actualización</dt><dd class="txt">${fmtDateTime(record.updatedAt)} · ${esc(record.updatedBy)}${
            record.relocated ? ' <span class="badge-soft info">Reubicado</span>' : ''
          }</dd></div>
        </dl>
        ${others}
      </article>`;
  }

  function showLocation() {
    const d = state.detail;
    if (!d || !d.available) return;
    const rec = d.record;
    const segs = rec.location.segments;
    if (scene) {
      scene.focusFixture(rec.location.fixtureId, {
        level: rec.location.level,
        productId: rec.id,
        callout: `<strong>${esc(rec.name)}</strong><span>${esc(segs.slice(-2).map((s) => s.text).join(' · '))}</span>`,
      });
    }
    state.located = true;
    hideShelfCard();
    showBanner({
      title: rec.name,
      segments: segs,
      meta: `${rec.stock} u. · actualizado ${fmtRelative(rec.updatedAt)}`,
      productId: rec.id,
    });
    $('#btnLocate')?.classList.add('is-located');
    if (window.matchMedia('(max-width: 767px)').matches) $('#viewport').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showBanner({ title, segments, meta, productId, empty }) {
    const banner = $('#locationBanner');
    banner.innerHTML = `
      <span class="vb-pin ${empty ? 'empty' : ''}"><i class="bi bi-geo-alt-fill"></i></span>
      <div class="vb-body">
        <div class="vb-title">${esc(title)}${meta ? `<span class="vb-meta">${esc(meta)}</span>` : ''}</div>
        <div class="vb-path">${segments.map((s) => `<span>${esc(s.text)}</span>`).join('<i class="bi bi-chevron-right"></i>')}</div>
      </div>
      <div class="vb-actions">
        ${productId && state.mode === 'search' ? `<button type="button" class="vb-btn" data-act="track" title="Ver tracking"><i class="bi bi-clock-history"></i></button>` : ''}
        ${productId && state.mode === 'admin' ? `<button type="button" class="vb-btn" data-act="open" data-product="${productId}" title="Abrir ficha"><i class="bi bi-box-arrow-up-right"></i></button>` : ''}
        <button type="button" class="vb-btn" data-act="clear" title="Quitar resaltado"><i class="bi bi-x-lg"></i></button>
      </div>`;
    banner.hidden = false;
    banner.classList.remove('vb-in');
    void banner.offsetWidth;
    banner.classList.add('vb-in');
  }

  function hideBanner() {
    $('#locationBanner').hidden = true;
    $('#btnLocate')?.classList.remove('is-located');
  }

  function clearHighlight() {
    if (scene) scene.clearFocus();
    state.located = false;
    hideBanner();
  }

  /* ------------------------------------------------------------- tracking */

  const EVENT_ICON = {
    received: 'bi-truck',
    inventory: 'bi-clipboard-check',
    placed: 'bi-geo-alt',
    moved: 'bi-arrow-left-right',
    updated: 'bi-check2-circle',
  };

  async function openTracking() {
    const d = state.detail;
    if (!d || !d.available) return;
    const events = await DataSource.getTracking(state.branch.id, d.product.id);
    $('#trackingTitle').textContent = d.product.name;
    $('#trackingSub').innerHTML = `<i class="bi bi-shop"></i> ${esc(state.branch.name)} · <i class="bi bi-geo-alt"></i> ${esc(d.record.location.text)}`;

    const byDay = [];
    for (const ev of events) {
      const day = ev.at.slice(0, 10);
      if (!byDay.length || byDay.at(-1).day !== day) byDay.push({ day, items: [] });
      byDay.at(-1).items.push(ev);
    }
    $('#trackingTimeline').innerHTML = byDay
      .map(
        (g) => `
        <li class="tl-day">${fmtRelative(g.day + 'T00:00').replace(/ 00:00$/, '')}</li>
        ${g.items
          .map(
            (ev, i) => `
          <li class="tl-item tl-${ev.type} ${ev === events.at(-1) ? 'is-current' : ''}" style="--i:${i}">
            <span class="tl-time">${ev.at.slice(11)}</span>
            <span class="tl-dot"><i class="bi ${EVENT_ICON[ev.type]}"></i></span>
            <div class="tl-body">
              <div class="tl-title">${esc(ev.title)}</div>
              <div class="tl-detail">${esc(ev.detail)}</div>
              <div class="tl-user"><i class="bi bi-person"></i> ${esc(ev.user)}</div>
            </div>
          </li>`,
          )
          .join('')}`,
      )
      .join('');
    bootstrap.Offcanvas.getOrCreateInstance('#trackingPanel').show();
  }

  /* ------------------------------------------------------- 3D interaction */

  function onFixtureHover(fixtureId, x, y) {
    const tip = $('#hoverTip');
    if (!fixtureId) {
      tip.hidden = true;
      return;
    }
    const f = state.branch.fixtures.find((fx) => fx.id === fixtureId);
    const items = state.branch.contents[fixtureId] || [];
    const r = $('#viewport').getBoundingClientRect();
    tip.innerHTML = `<strong>${esc(f.displayName)}</strong><span>${items.length ? `${items.length} producto${items.length > 1 ? 's' : ''}` : 'Vacía'}</span>`;
    tip.style.left = `${x - r.left + 14}px`;
    tip.style.top = `${y - r.top + 14}px`;
    tip.hidden = false;
  }

  function onFixtureClick(fixtureId) {
    $('#hoverTip').hidden = true;
    if (!fixtureId) {
      hideShelfCard();
      return;
    }
    showShelfCard(fixtureId);
  }

  function showShelfCard(fixtureId) {
    const b = state.branch;
    const f = b.fixtures.find((fx) => fx.id === fixtureId);
    const items = b.contents[fixtureId] || [];
    const zone = f.zone ? b.zones[f.zone] : null;
    const meta = [zone ? `${zone.label || 'Zona ' + f.zone} · ${zone.name}` : null, f.aisle ? `Pasillo ${f.aisle}` : null].filter(Boolean).join(' · ');

    let body;
    if (b.hasLevels) {
      const rows = [];
      for (let lvl = f.levels; lvl >= 1; lvl--) {
        const at = items.filter((i) => i.level === lvl);
        rows.push(`
          <div class="sc-level ${at.length ? '' : 'is-empty'}">
            <span class="sc-lvl">${esc(f.levelLabel || 'Nivel')} ${lvl}</span>
            <div class="sc-lvl-items">${
              at.length
                ? at.map((i) => `<button type="button" class="sc-prod" data-product="${i.productId}"><span>${esc(i.name)}</span><em>${i.stock} u.</em></button>`).join('')
                : `<button type="button" class="sc-empty" data-empty-level="${lvl}">Vacío</button>`
            }</div>
          </div>`);
      }
      body = rows.join('');
    } else {
      body = items.length
        ? items.map((i) => `<button type="button" class="sc-prod" data-product="${i.productId}"><span>${esc(i.name)}</span><em>${i.stock} u.</em></button>`).join('')
        : '<div class="sc-none"><i class="bi bi-inbox"></i> Ubicación vacía</div>';
    }

    const card = $('#shelfCard');
    card.innerHTML = `
      <div class="sc-head">
        <div><div class="sc-title">${esc(f.displayName)}</div>${meta ? `<div class="sc-meta">${esc(meta)}</div>` : ''}</div>
        <button type="button" class="btn-close btn-sm" data-act="close" aria-label="Cerrar"></button>
      </div>
      <div class="sc-stats"><span><strong>${items.length}</strong> productos</span><span><strong>${fmtInt(items.reduce((s, i) => s + i.stock, 0))}</strong> unidades</span></div>
      <div class="sc-body">${body}</div>
      <button type="button" class="btn btn-sm btn-outline-primary w-100 mt-2" data-act="focus"><i class="bi bi-crosshair"></i> Resaltar en el mapa</button>`;
    card.dataset.fixture = fixtureId;
    card.hidden = false;
  }

  function hideShelfCard() {
    $('#shelfCard').hidden = true;
  }

  function focusLocation(fixtureId, level = null) {
    const f = state.branch.fixtures.find((fx) => fx.id === fixtureId);
    const segs = locationSegmentsFor(f, level);
    if (scene) scene.focusFixture(fixtureId, { level, callout: `<strong>${esc(f.displayName)}</strong>${level ? `<span>${esc(f.levelLabel || 'Nivel')} ${level}</span>` : ''}` });
    const items = (state.branch.contents[fixtureId] || []).filter((i) => !level || i.level === level);
    showBanner({
      title: level && !items.length ? 'Ubicación vacía' : f.displayName,
      segments: segs,
      meta: items.length ? `${items.length} producto${items.length > 1 ? 's' : ''}` : 'sin productos',
      empty: !items.length,
    });
  }

  function locationSegmentsFor(f, level) {
    const b = state.branch;
    const segs = [];
    for (const s of b.schema) {
      if (s.key === 'zona' && f.zone) segs.push({ text: b.zones[f.zone].label || `Zona ${f.zone}` });
      if (s.key === 'pasillo' && f.aisle) segs.push({ text: `Pasillo ${f.aisle}` });
      if (s.key === 'percha') segs.push({ text: f.displayName });
      if (s.key === 'nivel' && level) segs.push({ text: `${f.levelLabel || 'Nivel'} ${level}` });
    }
    return segs;
  }

  async function locateProduct(productId) {
    const d = await DataSource.getProductDetail(state.branch.id, productId);
    if (!d.available) return;
    if (state.mode === 'search') {
      await selectProduct(productId, { locate: true });
      $('#searchInput').value = d.product.name;
      return;
    }
    state.detail = d;
    const rec = d.record;
    if (scene) {
      scene.focusFixture(rec.location.fixtureId, {
        level: rec.location.level,
        productId,
        callout: `<strong>${esc(rec.name)}</strong><span>${esc(rec.location.segments.slice(-2).map((s) => s.text).join(' · '))}</span>`,
      });
    }
    showBanner({ title: rec.name, segments: rec.location.segments, meta: `${rec.stock} u. · ${fmtRelative(rec.updatedAt)}`, productId });
  }

  /* ---------------------------------------------------------------- admin */

  async function setMode(mode) {
    if (mode === state.mode) return;
    state.mode = mode;
    $('#appMain').dataset.mode = mode;
    $$('.mode-btn').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });
    $('#searchPanel').hidden = mode !== 'search';
    $('#adminPanel').hidden = mode !== 'admin';
    clearHighlight();
    hideShelfCard();
    renderLegend();
    if (scene) scene.home();
    if (mode === 'admin') await loadAdmin();
    else {
      if (scene) scene.setMode('normal');
      if (state.detail) renderCard();
    }
  }

  async function loadAdmin() {
    state.admin = await DataSource.getAdminOverview(state.branch.id);
    const occ = {};
    for (const l of state.admin.locations) occ[l.fixtureId] = { ratio: l.ratio, emptyLevels: l.emptyLevels };
    if (scene) scene.setMode('occupancy', occ);
    renderAdmin();
  }

  function renderAdmin() {
    const a = state.admin;
    const k = a.kpis;
    const tabs = [
      ['locations', 'Por ubicación', 'bi-bookshelf'],
      ['occupancy', 'Ocupación', 'bi-bar-chart'],
      ['empty', `Vacías (${k.empty})`, 'bi-inbox'],
      ['products', 'Productos', 'bi-list-ul'],
    ];
    $('#adminPanel').innerHTML = `
      <div class="adm-head">
        <div class="eyebrow">Administración</div>
        <h2>${esc(state.branch.name)}</h2>
      </div>
      <div class="kpis">
        <div class="kpi"><span class="kpi-val">${k.products}</span><span class="kpi-lbl">Productos ubicados</span><span class="kpi-sub">${fmtInt(k.units)} unidades</span></div>
        <div class="kpi"><span class="kpi-val">${k.locations}</span><span class="kpi-lbl">Perchas / racks</span><span class="kpi-sub">${a.hasLevels ? `${k.slots} niveles` : 'ubicación por percha'}</span></div>
        <div class="kpi ${k.empty ? 'kpi-warn' : ''}"><span class="kpi-val">${k.empty}</span><span class="kpi-lbl">Ubicaciones vacías</span><span class="kpi-sub">${a.hasLevels ? 'niveles / cajones' : 'perchas'}</span></div>
        <div class="kpi"><span class="kpi-val">${k.changesToday}</span><span class="kpi-lbl">Cambios hoy</span><span class="kpi-sub">movimientos de ubicación</span></div>
      </div>
      <div class="adm-tabs" role="tablist">
        ${tabs
          .map(([id, txt, ico]) => `<button type="button" class="adm-tab ${state.adminTab === id ? 'active' : ''}" data-tab="${id}" role="tab"><i class="bi ${ico}"></i>${txt}</button>`)
          .join('')}
      </div>
      <div class="adm-body" id="adminBody">${renderAdminTab()}</div>`;
  }

  function renderAdminTab() {
    const a = state.admin;
    if (state.adminTab === 'locations') {
      const groups = new Map();
      for (const l of a.locations) {
        const key = l.zone ? `${l.zoneLabel} · ${l.zoneName}` : 'Ubicaciones';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(l);
      }
      return [...groups]
        .map(
          ([title, locs]) => `
        <div class="adm-group">
          <div class="adm-group-title">${esc(title)}</div>
          ${locs
            .map(
              (l) => `
            <details class="loc-item" ${l.items.length ? '' : 'data-empty'}>
              <summary>
                <i class="bi bi-chevron-right chev"></i>
                <div class="li-main"><strong>${esc(l.name)}</strong>${l.aisle ? `<span>Pasillo ${esc(l.aisle)}</span>` : ''}</div>
                <span class="li-count">${l.items.length ? `${l.items.length} prod. · ${fmtInt(l.units)} u.` : 'Vacía'}</span>
                <button type="button" class="icon-btn" data-focus="${l.fixtureId}" title="Ver en el mapa"><i class="bi bi-crosshair"></i></button>
              </summary>
              ${
                l.items.length
                  ? `<ul class="li-products">${l.items
                      .map(
                        (i) => `<li>
                    ${i.level ? `<span class="lvl-badge">${esc(l.levelLabel.slice(0, 1))}${i.level}</span>` : ''}
                    <button type="button" class="link-btn" data-locate="${i.productId}">${esc(i.name)}</button>
                    <span class="li-stock">${i.stock} u.</span>
                  </li>`,
                      )
                      .join('')}</ul>`
                  : '<div class="li-none">Sin productos asignados</div>'
              }
            </details>`,
            )
            .join('')}
        </div>`,
        )
        .join('');
    }

    if (state.adminTab === 'occupancy') {
      return `
        <p class="adm-note">${
          a.hasLevels ? 'Niveles ocupados sobre el total de niveles de cada percha.' : 'Productos asignados sobre la capacidad estimada de cada percha.'
        }</p>
        ${a.locations
          .slice()
          .sort((x, y) => x.ratio - y.ratio)
          .map((l) => {
            const pct = Math.round(l.ratio * 100);
            const tone = l.ratio >= 0.999 ? 'full' : l.ratio > 0 ? 'partial' : 'empty';
            return `
            <button type="button" class="occ-row" data-focus="${l.fixtureId}">
              <div class="occ-top"><strong>${esc(l.name)}</strong><span>${l.occupied}/${l.capacity} ${a.hasLevels ? 'niveles' : 'espacios'}</span></div>
              <div class="occ-bar"><span class="occ-${tone}" style="width:${Math.max(pct, 2)}%"></span></div>
              <div class="occ-meta">${l.zoneLabel ? esc(l.zoneLabel) + ' · ' : ''}${pct}% · último cambio ${fmtRelative(l.lastChange)}</div>
            </button>`;
          })
          .join('')}`;
    }

    if (state.adminTab === 'empty') {
      if (!a.emptySlots.length) return '<div class="adm-none"><i class="bi bi-check2-circle"></i> No hay ubicaciones vacías</div>';
      return `
        <p class="adm-note">Espacios disponibles para reubicar o recibir producto nuevo.</p>
        <ul class="empty-list">${a.emptySlots
          .map(
            (s) => `<li><button type="button" class="empty-row" data-focus="${s.fixtureId}" data-level="${s.level ?? ''}">
              <i class="bi bi-inbox"></i><span>${esc(s.text)}</span><i class="bi bi-crosshair go"></i></button></li>`,
          )
          .join('')}</ul>`;
    }

    // products
    const q = normalize(state.adminFilter);
    const rows = a.products.filter((p) => !q || normalize(`${p.name} ${p.active} ${p.code} ${p.location.text}`).includes(q));
    return `
      <div class="adm-filter"><i class="bi bi-funnel"></i><input type="search" id="adminFilter" class="form-control form-control-sm" placeholder="Filtrar productos o ubicaciones" value="${esc(state.adminFilter)}"></div>
      <div class="table-wrap">
        <table class="adm-table">
          <thead><tr><th>Producto</th><th>Ubicación actual</th><th class="num">Stock</th><th>Último cambio</th></tr></thead>
          <tbody>${
            rows
              .map(
                (p) => `<tr data-locate="${p.id}">
              <td><strong>${esc(p.name)}</strong><span class="t-sub">${esc(p.code)}</span></td>
              <td class="t-loc">${esc(p.location.text)}</td>
              <td class="num ${p.stock < 10 ? 't-low' : ''}">${p.stock}</td>
              <td class="t-date">${fmtRelative(p.updatedAt)}${p.relocated ? '<span class="badge-soft info">Reubicado</span>' : ''}</td>
            </tr>`,
              )
              .join('') || '<tr><td colspan="4" class="t-none">Sin resultados</td></tr>'
          }</tbody>
        </table>
      </div>`;
  }

  /* --------------------------------------------------------------- events */

  function bindEvents() {
    $('#branchSelect').addEventListener('change', (e) => selectBranch(e.target.value));
    $$('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    const input = $('#searchInput');
    input.addEventListener('input', onSearchInput);
    input.addEventListener('keydown', onSearchKey);
    input.addEventListener('focus', () => input.value.trim() && runSearch(input.value));
    $('#searchResults').addEventListener('mousedown', (e) => {
      const item = e.target.closest('.sr-item');
      if (item) {
        e.preventDefault();
        pickResult(Number(item.dataset.index));
      }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search')) $('#searchResults').hidden = true;
    });
    $$('.hint').forEach((h) =>
      h.addEventListener('click', () => {
        input.value = h.dataset.q;
        input.focus();
        runSearch(h.dataset.q);
      }),
    );
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && state.mode === 'search' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });

    $('#productCard').addEventListener('click', (e) => {
      if (e.target.closest('#btnLocate')) showLocation();
      else if (e.target.closest('#btnTracking')) openTracking();
      else {
        const other = e.target.closest('.other-row');
        if (other) {
          $('#branchSelect').value = other.dataset.branch;
          state.located = true;
          selectBranch(other.dataset.branch);
        }
      }
    });

    $('#locationBanner').addEventListener('click', async (e) => {
      const btn = e.target.closest('.vb-btn');
      if (!btn) return;
      if (btn.dataset.act === 'clear') {
        clearHighlight();
        if (scene) scene.home();
      }
      else if (btn.dataset.act === 'track') openTracking();
      else if (btn.dataset.act === 'open') {
        const pid = Number(btn.dataset.product);
        await setMode('search');
        await selectProduct(pid, { locate: true });
        $('#searchInput').value = state.detail.product.name;
      }
    });

    $('#shelfCard').addEventListener('click', (e) => {
      const card = $('#shelfCard');
      const t = e.target;
      if (t.closest('[data-act="close"]')) hideShelfCard();
      else if (t.closest('[data-act="focus"]')) focusLocation(card.dataset.fixture);
      else if (t.closest('.sc-prod')) locateProduct(Number(t.closest('.sc-prod').dataset.product));
      else if (t.closest('.sc-empty')) focusLocation(card.dataset.fixture, Number(t.closest('.sc-empty').dataset.emptyLevel));
    });

    $('#adminPanel').addEventListener('click', (e) => {
      const t = e.target;
      const tab = t.closest('.adm-tab');
      if (tab) {
        state.adminTab = tab.dataset.tab;
        renderAdmin();
        return;
      }
      const focus = t.closest('[data-focus]');
      if (focus) {
        e.preventDefault();
        const lvl = focus.dataset.level ? Number(focus.dataset.level) : null;
        focusLocation(focus.dataset.focus, lvl);
        return;
      }
      const loc = t.closest('[data-locate]');
      if (loc) locateProduct(Number(loc.dataset.locate));
    });
    $('#adminPanel').addEventListener('input', (e) => {
      if (e.target.id !== 'adminFilter') return;
      state.adminFilter = e.target.value;
      const pos = e.target.selectionStart;
      $('#adminBody').innerHTML = renderAdminTab();
      const f = $('#adminFilter');
      f.focus();
      f.setSelectionRange(pos, pos);
    });

    $('.vp-controls').addEventListener('click', (e) => {
      const btn = e.target.closest('.vp-btn');
      if (!btn || !scene) return;
      const act = btn.dataset.action;
      if (act === 'home') scene.home();
      else if (act === 'top') scene.topView();
      else if (act === 'zoom-in') scene.zoom(0.7);
      else if (act === 'zoom-out') scene.zoom(1.4);
      else if (act === 'labels') {
        btn.classList.toggle('active');
        scene.setLabelsVisible(btn.classList.contains('active'));
      }
    });

    $('#scene').addEventListener('pointerdown', () => $('#vpHint').classList.add('is-gone'), { once: true });
  }

  boot();
})();
