// Help for people new to 3D printing: print setup (printer, nozzle, fit), a welcome card for an
// empty design and a guided first model. main.js passes in what it owns (the design, undo, the viewport).
import { MATERIALS } from './materials.js';
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
  let flow = false, tour = null, tourTimer = null, welcomeClosed = store.get('sketchy.welcomeOff') === '1';

  // ------------------------------------------------------------ print setup
  function printSetup() {
    const cur = ctx.designProfile(), printers = ctx.printers(), bed = ctx.bedName();
    const mats = MATERIALS.filter((m) => m.group === 'Printing');
    const fitFor = (t) => FITS.find((f) => Math.abs(f[2] - t) < 1e-9)?.[0] || 'custom';
    const m = modal(`<div class="modal-title">Print setup</div><div class="modal-body bg-body">
      <p class="bg-lead">Tell Sketchy about your printer once. Print Check uses it.</p>
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

  // ------------------------------------------------------------ welcome card (empty design)
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
      </div>`;
    $('#viewport').appendChild(el);
    el.querySelector('.welcome-x').onclick = async () => {
      welcomeClosed = true; store.set('sketchy.welcomeOff', '1'); el.remove();
      await ctx.nameNow();
      toast('The guided tour is on the welcome card, or use the search button at the top.');
    };
    el.querySelectorAll('.wbtn').forEach((b) => (b.onclick = () => choose(b.dataset.a)));
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
    tour = null; clearInterval(tourTimer); tourTimer = null;
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
      el.innerHTML = `<div class="tour-t">That's your first part.</div><div class="tour-x">Check it with <b>Print Check</b> before you slice it.</div><div class="tour-b"><button class="btn primary" id="tour-done" type="button">Done</button></div>`;
      el.querySelector('#tour-done').onclick = () => endTour(true);
      glow(null); return;
    }
    const s = TOUR[tour.step];
    el.innerHTML = `<div class="tour-n">Step ${tour.step + 1} of ${TOUR.length}</div><div class="tour-t">${s.title}</div><div class="tour-x">${s.text}</div><div class="tour-b"><button class="btn" id="tour-skip" type="button">Skip tour</button></div>`;
    el.querySelector('#tour-skip').onclick = () => endTour(false);
    glow(s.target);
  }
  function tick() {
    if (!tour) return;
    const st = ctx.tourState();
    let moved = false;
    while (tour.step < TOUR.length && TOUR[tour.step].done(st)) { tour.step++; moved = true; }
    if (moved) renderTour(); else if (tour.step < TOUR.length) glow(TOUR[tour.step].target);
  }

  return {
    printSetup, welcomeWanted, startTour, tour: () => tour,
    noteExport() { if (tour) tour.exported = true; },
    exported: () => !!tour?.exported,
    /** Called after the design or the toolbar changes. */
    update() {
      renderWelcome();
    },
    firstRun: () => store.get('sketchy.tour') !== 'done' && store.get('sketchy.welcomed') !== '1',
    markWelcomed: () => store.set('sketchy.welcomed', '1'),
  };
}
export { DEFAULT_PROFILE };
