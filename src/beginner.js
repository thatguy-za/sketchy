// Help for people new to 3D printing: print setup (printer, nozzle, fit), a template gallery with sliders, a welcome card for an
// empty design and a guided first model. main.js passes in what it owns (the design, undo, the viewport).
import { MATERIALS } from './materials.js';
import { TEMPLATES, templateById } from './templates.js';
import { DEFAULT_PROFILE, NOZZLES, FITS, cleanProfile, withProfileParams, profileOfParams } from './printprofile.js';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
/** The print settings kept in this browser: what a new design and the print check start from. */
export const loadProfile = () => { try { return cleanProfile(JSON.parse(store.get('sketchy.printprofile') || '{}')); } catch { return cleanProfile(); } };
export const saveProfile = (p) => store.set('sketchy.printprofile', JSON.stringify(cleanProfile(p)));
/** The settings of this design when it has them, else the browser's. */
export const designProfile = (doc) => profileOfParams(doc?.params) || loadProfile();

const TOUR = [
  { id: 'sketch', title: 'Start a sketch', text: 'Every part starts as a flat drawing. Click <b>Create Sketch</b>, then click the blue square, the <b>top plane</b>, in the 3D view.', target: 'Create Sketch', done: (s) => s.sketch || s.hasSketch },
  { id: 'plane', title: 'Choose the plane', text: 'Click one of the flat squares in the view. That is the surface you will draw on.', target: null, done: (s) => (s.sketch && !s.picking) || s.hasSketch },
  { id: 'rect', title: 'Draw a rectangle', text: 'Pick <b>Rectangle</b>, click one corner, then the opposite corner. Type numbers if you want exact sizes (for example 60, Tab, 40, Enter).', target: '2-Point Rectangle', done: (s) => s.shapes > 0 || s.hasShapes },
  { id: 'finish', title: 'Finish the sketch', text: 'Click the green <b>Finish sketch</b> button on the right of the toolbar.', target: 'finish', done: (s) => !s.sketch && s.hasSketch },
  { id: 'extrude', title: 'Pull it into a solid', text: 'Click <b>Extrude</b>, choose your rectangle, type a height like 20 and press OK.', target: 'Extrude', done: (s) => s.has('extrude') && !s.dialog },
  { id: 'fillet', title: 'Round the edges', text: 'Sharp corners snap and hurt. Click <b>Fillet</b>, click some edges, type 2 mm and press OK.', target: 'Fillet', done: (s) => s.has('fillet') && !s.dialog },
  { id: 'export', title: 'Get it ready to print', text: 'Open <b>Print Check</b> to see if it fits your printer, then <b>Export</b> a 3MF file and open it in your slicer.', target: 'Export', done: (s) => s.exported },
];

export function createBeginner(ctx) {
  const { $, esc, modal, toast } = ctx;
  let flow = false, tour = null, tourTimer = null, welcomeClosed = store.get('sketchy.welcomeOff') === '1', czDoc = null;

  // ------------------------------------------------------------ print setup
  function printSetup() {
    const cur = ctx.designProfile(), printers = ctx.printers(), bed = ctx.bedName();
    const mats = MATERIALS.filter((m) => m.group === 'Printing');
    const fitFor = (t) => FITS.find((f) => Math.abs(f[2] - t) < 1e-9)?.[0] || 'custom';
    const m = modal(`<div class="modal-title">Print setup</div><div class="modal-body bg-body">
      <p class="bg-lead">Tell Sketchy about your printer once. Print Check and the templates use it.</p>
      <label class="set-row"><span>Printer</span><select id="ps-printer" aria-label="Printer">${printers.map((p) => `<option value="${esc(p.name)}"${p.name === bed ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__add">Add another printer…</option></select></label>
      <label class="set-row"><span>Nozzle size <i class="set-note">(printed on the nozzle)</i></span><select id="ps-nozzle" aria-label="Nozzle size">${NOZZLES.map((n) => `<option value="${n}"${n === cur.nozzle ? ' selected' : ''}>${n} mm${n === 0.4 ? ' (most common)' : ''}</option>`).join('')}</select></label>
      <label class="set-row"><span>Layer height <i class="set-note">(0.2 is a good start)</i></span><input id="ps-layer" type="number" min="0.04" max="1.2" step="0.04" value="${cur.layer}" aria-label="Layer height in millimetres"></label>
      <label class="set-row"><span>Material</span><select id="ps-material" aria-label="Material">${mats.map((x) => `<option value="${x.id}"${x.id === cur.material ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <div class="bg-h">How snug should parts fit?</div>
      <div class="bg-fits" role="radiogroup" aria-label="Fit">${FITS.map(([id, name, gap, text]) => `<label class="bg-fit"><input type="radio" name="fit" value="${id}"${fitFor(cur.tol) === id ? ' checked' : ''}><b>${name}</b><span>${gap} mm gap</span><em>${text}</em></label>`).join('')}</div>
      <label class="set-row"><span>Gap on each side (mm)</span><input id="ps-tol" type="number" min="0" max="1" step="0.05" value="${cur.tol}" aria-label="Fit gap in millimetres"></label>
      <div class="hint-sm">Holes print a little small. This gap is added wherever parts meet. In your own designs type <code>tol</code> in a size field, like <code>5 mm + 2 * tol</code>.</div>
      <label class="bg-check"><input type="checkbox" id="ps-apply"${ctx.doc().features.length || ctx.doc().params?.length ? '' : ' checked'}> Also use these in this design <span>(adds the parameters <code>nozzle</code>, <code>layer</code> and <code>tol</code>)</span></label>
    </div><div class="modal-foot"><button class="btn primary" id="ps-save" type="button">Save</button></div>`);
    const q = (s) => m.el.querySelector(s);
    q('#ps-printer').onchange = (e) => { if (e.target.value === '__add') { e.target.value = bed; m.close(); ctx.addPrinter(); } };
    m.el.querySelectorAll('input[name=fit]').forEach((r) => (r.onchange = () => { q('#ps-tol').value = FITS.find((f) => f[0] === r.value)[2]; }));
    q('#ps-tol').oninput = () => { const id = fitFor(+q('#ps-tol').value); m.el.querySelectorAll('input[name=fit]').forEach((r) => (r.checked = r.value === id)); };
    q('#ps-save').onclick = () => {
      const p = cleanProfile({ nozzle: +q('#ps-nozzle').value, layer: +q('#ps-layer').value, tol: +q('#ps-tol').value, material: q('#ps-material').value });
      saveProfile(p);
      const name = q('#ps-printer').value;
      if (name && name !== bed && name !== '__add') ctx.setPrinter(name);
      if (q('#ps-apply').checked) { ctx.pushUndo(ctx.snapshot()); ctx.doc().params = withProfileParams(ctx.doc().params, p); ctx.refresh(); }
      m.close(); ctx.afterSetup?.();
      toast(q('#ps-apply').checked ? 'Print setup saved and added to this design.' : 'Print setup saved.');
    };
  }

  // ------------------------------------------------------------ templates
  function templatePicker() {
    const m = modal(`<div class="modal-title">Start from a template</div><div class="modal-body bg-body">
      <p class="bg-lead">Ready-made parts you can change with sliders. They use your printer's fit gap, so they print right the first time.</p>
      <div class="bg-cards">${TEMPLATES.map((t) => `<button type="button" class="bg-card" data-id="${t.id}"><div class="bg-thumb">${thumb(t.id)}</div><b>${esc(t.name)}</b><span>${esc(t.blurb)}</span></button>`).join('')}</div>
    </div>`);
    m.el.querySelectorAll('.bg-card').forEach((b) => (b.onclick = async () => { m.close(); await ctx.openTemplate(b.dataset.id); }));
  }
  const thumb = (id) => ({
    'box-lid': '<svg viewBox="0 0 80 56"><rect x="8" y="22" width="40" height="26" rx="4" class="a"/><rect x="12" y="26" width="32" height="18" rx="2" class="b"/><rect x="50" y="36" width="24" height="12" rx="3" class="c"/></svg>',
    'phone-stand': '<svg viewBox="0 0 80 56"><path d="M10 46h60v-6H10z" class="a"/><path d="M14 40v-8h6v8z" class="a"/><path d="M34 40L52 8l6 3-14 29z" class="c"/></svg>',
    'cable-clip': '<svg viewBox="0 0 80 56"><rect x="8" y="40" width="64" height="8" rx="2" class="a"/><circle cx="40" cy="28" r="15" class="c"/><circle cx="40" cy="28" r="8" class="b"/><rect x="34" y="10" width="12" height="14" class="b"/></svg>',
    'wall-bracket': '<svg viewBox="0 0 80 56"><path d="M12 8h8v32h40v8H12z" class="a"/><circle cx="16" cy="18" r="2.2" class="b"/><circle cx="50" cy="44" r="2.2" class="b"/></svg>',
  }[id] || '');

  // ------------------------------------------------------------ customizer (sliders of a template)
  const num = (e) => { const v = parseFloat(String(e)); return Number.isFinite(v) ? v : null; };
  function customizer() {
    const d = ctx.doc(), t = d.template;
    if (!t) return;
    czDoc = d;
    const wrap = $('#props-wrap');
    const rows = t.sliders.map((s) => {
      const p = (d.params || []).find((x) => x.name === s.name), v = p ? num(p.expr) : null;
      if (v === null) return `<div class="cz-row"><label><span>${esc(s.label)}</span><i class="cz-custom">${esc(p?.expr ?? '?')}</i></label><div class="hint-sm">Set by an expression in Parameters.</div></div>`;
      return `<div class="cz-row"><label for="cz-${s.name}"><span>${esc(s.label)}</span><span class="cz-val"><input class="cz-num" type="number" data-n="${s.name}" min="${s.min}" max="${s.max * 3}" step="${s.step}" value="${+v.toFixed(3)}" aria-label="${esc(s.label)}"> ${s.unit}</span></label>
        <input id="cz-${s.name}" class="cz-range" type="range" data-n="${s.name}" min="${s.min}" max="${s.max}" step="${s.step}" value="${Math.min(s.max, Math.max(s.min, v))}">${s.hint ? `<div class="hint-sm">${esc(s.hint)}</div>` : ''}</div>`;
    }).join('');
    const prof = ctx.designProfile();
    wrap.innerHTML = `<div class="props" id="cz-root"><div class="title">CUSTOMIZE · ${esc(d.name || 'Design')}</div><div class="body">
      ${rows}
      <div class="sep"></div>
      <div class="hint-sm">${esc(t.tip || '')}</div>
      <div class="stat"><span>Printer fit gap</span><b>${prof.tol} mm per side</b></div>
      <div class="stat"><span>Nozzle</span><b>${prof.nozzle} mm</b></div>
      <button class="btn" id="cz-setup" type="button">Print setup…</button>
    </div><div class="foot"><button class="btn" id="cz-check" type="button">Check for printing</button><button class="btn primary" id="cz-close" type="button">Done</button></div></div>`;
    wrap.classList.add('open');
    let gesture = false;
    const set = (name, value, final) => {
      if (!gesture) { ctx.pushUndo(ctx.snapshot()); gesture = true; }
      const unit = (ctx.doc().params.find((x) => x.name === name)?.unit);
      ctx.doc().params = ctx.doc().params.map((x) => (x.name === name ? { ...x, expr: unit === 'angle' || unit === 'number' ? String(value) : `${value} mm` } : x));
      wrap.querySelectorAll(`[data-n="${name}"]`).forEach((el) => { if (+el.value !== value) el.value = value; });
      ctx.refresh();
      if (final) gesture = false;
    };
    wrap.querySelectorAll('input[data-n]').forEach((el) => {
      el.addEventListener('input', () => { const v = +el.value; if (Number.isFinite(v) && v > 0) set(el.dataset.n, v, false); });
      el.addEventListener('change', () => { gesture = false; });
    });
    $('#cz-close').onclick = closeCustomizer;
    $('#cz-setup').onclick = printSetup;
    $('#cz-check').onclick = () => ctx.run('printcheck');
  }
  function closeCustomizer() { if ($('#cz-root')) $('#props-wrap').classList.remove('open'); }
  const customizerOpen = () => !!$('#cz-root');

  // ------------------------------------------------------------ welcome card (empty design)
  // ------------------------------------------------------------ the modelling engine (the 23 MB kernel) downloads while you are here
  const mbs = (n) => (n / 1048576).toFixed(1);
  const kernelText = (k) => `Getting the modelling engine ready… ${mbs(k.n)} of ${mbs(k.total)} MB`;
  /** Shows how far the download is on the welcome card and the guide's first step; the bottom pill hides while one of them says it. */
  function syncKernel() {
    const k = ctx.kernel(), pct = k.total ? Math.min(100, Math.round((k.n / k.total) * 100)) : 0;
    const put = (box) => { if (!box) return; box.hidden = k.ok; box.querySelector('progress').value = pct; box.querySelector('span').textContent = kernelText(k); };
    put($('#w-kernel')); put($('#t-kernel'));
    if (tour && tour.step === 0 && !!tour.waiting === k.ok) renderTour(); // the first step starts the moment the engine is ready
    document.body.classList.toggle('kernel-inline', !k.ok && (!!$('#w-kernel') || !!$('#t-kernel')));
  }
  addEventListener('sketchy-kernel', syncKernel);

  /** Wait until no window is open: the next step of a journey never opens on top of one. */
  const noModal = () => new Promise((resolve) => { const t = setInterval(() => { if (!document.querySelector('.modal-back')) { clearInterval(t); resolve(); } }, 250); });
  /** The three ways in. Each hides the card first, then runs its steps one after the other, so no window opens over another. */
  async function choose(kind) {
    if (flow) return;
    flow = true; $('#welcome')?.remove();
    try {
      if (kind === 'ai') {
        if (!ctx.canConnect()) toast('Assistants connect to a Sketchy server. Sign in to one, and ask its administrator if assistant access is off.', true);
        else { ctx.connectAssistant(); await noModal(); }
      } else if (await ctx.nameNow()) { // the new design is named first
        if (kind === 'tour') startTour();
        else { welcomeClosed = true; ctx.run('importstl'); } // the file chooser, then the import's own steps; the card stays away for now
      }
    } finally { flow = false; ctx.renderRibbon(); }
  }
  function renderWelcome() {
    let el = $('#welcome');
    const empty = ctx.isEmpty() && !ctx.state().sketch && !ctx.state().dialog && !tour && !flow && !welcomeClosed && !document.querySelector('.modal-back');
    if (!empty) { el?.remove(); return; }
    if (el) return;
    el = document.createElement('div');
    el.id = 'welcome'; el.className = 'welcome';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Welcome to Sketchy');
    el.innerHTML = `<button type="button" class="welcome-x" aria-label="Close">×</button><div class="welcome-title">Welcome to Sketchy</div>
      <div class="welcome-sub">What would you like to do today?</div>
      <div class="welcome-btns">
        <button type="button" class="wbtn primary" data-a="tour"><b>Make my first part</b><span>A guided two-minute walk-through, from a sketch to a file ready for your slicer.</span></button>
        <button type="button" class="wbtn" data-a="open"><b>Import an existing model file</b><span>Start from an STL, 3MF, OBJ or STEP file.</span></button>
        <button type="button" class="wbtn" data-a="ai"><b>Start making with your LLM</b><span>Connect Claude, ChatGPT or another assistant, then describe what you want.</span></button>
      </div>
      <div class="welcome-kernel" id="w-kernel" hidden><progress max="100" value="0"></progress><span></span></div>`;
    $('#viewport').appendChild(el);
    el.querySelector('.welcome-x').onclick = async () => {
      welcomeClosed = true; store.set('sketchy.welcomeOff', '1'); el.remove();
      await ctx.nameNow();
      toast('Templates and the guided tour are in the Utilities tab, or use the search button at the top.');
    };
    el.querySelectorAll('.wbtn').forEach((b) => (b.onclick = () => choose(b.dataset.a)));
    syncKernel();
  }
  /** True when the welcome card should be the first thing seen, so the design is not named before it. */
  const welcomeWanted = () => !welcomeClosed;

  // ------------------------------------------------------------ guided first model
  function startTour() {
    $('#welcome')?.remove();
    tour = { step: 0 };
    renderTour();
    clearInterval(tourTimer); tourTimer = setInterval(tick, 400);
  }
  function endTour(finished) {
    tour = null; document.body.classList.remove('kernel-inline'); clearInterval(tourTimer); tourTimer = null;
    $('#tour')?.remove(); glow(null);
    if (finished) store.set('sketchy.tour', 'done');
  }
  function glow(label) {
    document.querySelectorAll('.tour-glow').forEach((e) => e.classList.remove('tour-glow'));
    if (!label) return;
    const hit = label === 'finish' ? document.querySelector('#ribbon .fbtn.finish') : [...document.querySelectorAll('#ribbon .fbtn')].find((b) => b.getAttribute('aria-label') === label);
    hit?.classList.add('tour-glow');
    if (!hit && label === 'Export') document.querySelector('#tabs .tab[data-t="UTILITIES"]')?.classList.add('tour-glow');
  }
  function renderTour() {
    if (!tour) return;
    let el = $('#tour');
    if (!el) { el = document.createElement('div'); el.id = 'tour'; el.setAttribute('role', 'status'); $('#viewport').appendChild(el); }
    if (tour.step >= TOUR.length) {
      el.innerHTML = `<div class="tour-t">That's your first part.</div><div class="tour-x">Check it with <b>Print Check</b>, or try a template next.</div><div class="tour-b"><button class="btn" id="tour-tpl" type="button">See templates</button><button class="btn primary" id="tour-done" type="button">Done</button></div>`;
      el.querySelector('#tour-tpl').onclick = () => { endTour(true); templatePicker(); };
      el.querySelector('#tour-done').onclick = () => endTour(true);
      glow(null); return;
    }
    tour.waiting = tour.step === 0 && !ctx.kernel().ok;
    if (tour.waiting) {
      el.innerHTML = `<div class="tour-n">Step 1 of ${TOUR.length}</div><div class="tour-t">Getting ready</div><div class="tour-x">The modelling engine is still arriving. This happens once, and your first step starts as soon as it is here.</div><div class="welcome-kernel" id="t-kernel"><progress max="100" value="0"></progress><span></span></div><div class="tour-b"><button class="btn" id="tour-skip" type="button">Skip tour</button></div>`;
      el.querySelector('#tour-skip').onclick = () => endTour(false);
      glow(null); syncKernel(); return;
    }
    const s = TOUR[tour.step];
    el.innerHTML = `<div class="tour-n">Step ${tour.step + 1} of ${TOUR.length}</div><div class="tour-t">${s.title}</div><div class="tour-x">${s.text}</div><div class="tour-b"><button class="btn" id="tour-skip" type="button">Skip tour</button></div>`;
    el.querySelector('#tour-skip').onclick = () => endTour(false);
    glow(s.target);
  }
  function tick() {
    if (!tour || tour.waiting) return;
    const st = ctx.tourState();
    let moved = false;
    while (tour.step < TOUR.length && TOUR[tour.step].done(st)) { tour.step++; moved = true; }
    if (moved) renderTour(); else if (tour.step < TOUR.length) glow(TOUR[tour.step].target);
  }

  return {
    printSetup, templatePicker, welcomeWanted, customizer, closeCustomizer, customizerOpen, startTour, tour: () => tour,
    noteExport() { if (tour) tour.exported = true; },
    exported: () => !!tour?.exported,
    /** Called after the design or the toolbar changes. */
    update() {
      renderWelcome();
      if (customizerOpen() && (czDoc !== ctx.doc() || !ctx.doc().template)) closeCustomizer();
      else if (customizerOpen() && !document.activeElement?.closest?.('#cz-root')) customizer();
    },
    hasTemplate: () => !!ctx.doc().template,
    firstRun: () => store.get('sketchy.tour') !== 'done' && store.get('sketchy.welcomed') !== '1',
    markWelcomed: () => store.set('sketchy.welcomed', '1'),
  };
}
export { templateById, DEFAULT_PROFILE };
