// In-app file dialogs: Save (name + folder), name prompts, confirmations and the folder tree. These replace the browser's
// prompt()/confirm() popups so saving never leaves Sketchy.
import { call, modal } from './account.js';
import { uicon } from './ficons.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const safeName = (n) => String(n).replace(/[^\w .()-]/g, '_').trim().slice(0, 80);
export const ROOT_LABEL = 'My designs';
const depthOf = (p) => (p ? p.split('/').length : 0);
const leafOf = (p) => p.split('/').pop();

/** Folder tree as a list of buttons (role=tree). Resolves nothing; call api.select(path) / api.set(folders). */
export function folderTree(host, folders, { selected = '', onSelect = () => {}, counts = {} } = {}) {
  host.setAttribute('role', 'tree'); host.className = (host.className + ' ft').trim();
  let cur = selected, list = folders;
  const draw = () => {
    host.innerHTML = '';
    const rows = [''].concat([...list].sort((a, b) => a.localeCompare(b)));
    for (const p of rows) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ft-row' + (p === cur ? ' on' : '');
      b.setAttribute('role', 'treeitem'); b.setAttribute('aria-selected', String(p === cur)); b.setAttribute('aria-level', String(depthOf(p) + 1));
      b.dataset.path = p; b.tabIndex = p === cur ? 0 : -1;
      b.style.paddingLeft = 8 + depthOf(p) * 16 + 'px';
      b.innerHTML = `${uicon('folder', 16)}<span>${esc(p ? leafOf(p) : ROOT_LABEL)}</span>${counts[p] ? `<small>${counts[p]}</small>` : ''}`;
      b.onclick = () => { cur = p; draw(); host.querySelector('.ft-row.on')?.focus(); onSelect(p); };
      b.onkeydown = (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const all = [...host.querySelectorAll('.ft-row')], i = all.indexOf(b), n = all[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (n) n.click();
      };
      host.appendChild(b);
    }
  };
  draw();
  return { select(p) { cur = p; draw(); onSelect(p); }, set(f, c) { list = f; if (c) counts = c; if (cur && !list.includes(cur)) cur = ''; draw(); }, get value() { return cur; } };
}

const countsOf = (designs) => { const c = {}; for (const d of designs) c[d.folder || ''] = (c[d.folder || ''] || 0) + 1; return c; };

/** Small name prompt as an in-app dialog. Resolves the trimmed string, or null when cancelled. */
export function askName({ title, label = 'Name', value = '', ok = 'OK', hint = '', raw = false, validate = null }) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal(`<div class="modal-title">${esc(title)}</div>
      <form class="modal-body"><label>${esc(label)}<input id="an-v" maxlength="80" autocomplete="off" spellcheck="false" value="${esc(value)}"></label>
      <div class="note err-note" id="an-err" role="alert">${esc(hint)}</div>
      <div class="modal-foot flush"><button type="button" class="btn" id="an-c">Cancel</button><button type="submit" class="btn primary">${esc(ok)}</button></div></form>`, () => finish(null));
    const inp = m.el.querySelector('#an-v');
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
    m.el.querySelector('#an-c').onclick = () => m.close();
    m.el.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const v = raw ? inp.value.trim() : safeName(inp.value);
      const bad = !v ? 'Enter a value.' : validate?.(v);
      if (bad) { m.el.querySelector('#an-err').textContent = bad; return; }
      finish(v); m.close();
    };
  });
}

/** In-app notice with one button. Resolves when it is closed. */
export function alertBox({ title, message, ok = 'OK' }) {
  return new Promise((resolve) => {
    const m = modal(`<div class="modal-title">${esc(title)}</div><div class="modal-body"><p class="p-tight">${esc(message)}</p></div>
      <div class="modal-foot"><button class="btn primary" id="ab-ok">${esc(ok)}</button></div>`, () => resolve());
    m.el.querySelector('#ab-ok').onclick = () => m.close();
    setTimeout(() => m.el.querySelector('#ab-ok').focus(), 0);
  });
}

/** In-app confirmation. Resolves true / false. */
export function confirmBox({ title, message, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal(`<div class="modal-title">${esc(title)}</div><div class="modal-body"><p class="p-tight">${esc(message)}</p></div>
      <div class="modal-foot"><button class="btn" id="cb-c">Cancel</button><button class="btn primary${danger ? ' destructive' : ''}" id="cb-ok">${esc(ok)}</button></div>`, () => finish(false));
    m.el.querySelector('#cb-c').onclick = () => m.close();
    m.el.querySelector('#cb-ok').onclick = () => { finish(true); m.close(); };
    setTimeout(() => m.el.querySelector('#cb-ok').focus(), 0);
  });
}

async function loadFileState() {
  const [f, p] = await Promise.all([call('GET', '/folders'), call('GET', '/projects')]);
  return { folders: f.ok ? f.data.folders : [], designs: p.ok ? p.data : [] };
}

/** Add an inline "new folder" row under a tree. Returns a function to call to open it. */
function newFolderRow(m, tree, getFolders, setFolders) {
  const row = m.el.querySelector('.sv-newrow'), inp = row.querySelector('input');
  const show = (on) => { row.hidden = !on; if (on) { inp.value = ''; inp.focus(); } };
  const create = async () => {
    const nm = safeName(inp.value);
    if (!nm) return;
    const path = (tree.value ? tree.value + '/' : '') + nm;
    const r = await call('POST', '/folders', { path });
    const err = m.el.querySelector('#sv-err');
    if (!r.ok && r.status !== 409) { err.textContent = r.data?.error || 'Could not create the folder.'; return; }
    err.textContent = '';
    const list = getFolders(); if (!list.includes(path)) list.push(path);
    // also add ancestors for display
    path.split('/').reduce((acc, seg) => { const q = acc ? acc + '/' + seg : seg; if (!list.includes(q)) list.push(q); return q; }, '');
    setFolders(list); tree.set(list); tree.select(path); show(false);
  };
  row.querySelector('.sv-create').onclick = create;
  row.querySelector('.sv-cancel').onclick = () => { show(false); m.el.querySelector('#sv-newbtn').focus(); };
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); create(); } else if (e.key === 'Escape') { e.stopPropagation(); show(false); m.el.querySelector('#sv-newbtn').focus(); } };
  return show;
}

/**
 * Save dialog: pick a folder (creating new ones as needed) and name the design. Resolves { name, folder } or null.
 * `designs` already in the chosen folder are listed so you can see what you might replace.
 */
export async function saveDialog({ name = '', folder = '', title = 'Save design', okLabel = 'Save' } = {}) {
  const st = await loadFileState();
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let folders = st.folders.slice();
    const m = modal(`<div class="modal-title">${esc(title)}</div>
      <form class="modal-body sv">
        <label>Name<input id="sv-name" maxlength="80" autocomplete="off" spellcheck="false" value="${esc(name)}"></label>
        <div class="sv-loc"><span class="sv-lab" id="sv-lab">Save in</span>
          <div class="sv-bar"><button type="button" class="btn sm" id="sv-newbtn">${uicon('plus', 14)} New folder</button></div>
          <div class="sv-newrow" hidden><input aria-label="New folder name" maxlength="80" placeholder="Folder name" autocomplete="off"><button type="button" class="btn sm primary sv-create">Create</button><button type="button" class="btn sm sv-cancel">Cancel</button></div>
          <div class="sv-tree" aria-labelledby="sv-lab"></div></div>
        <div class="sv-here" id="sv-here" aria-live="polite"></div>
        <div class="note err-note" id="sv-err" role="alert"></div>
        <div class="modal-foot flush"><button type="button" class="btn" id="sv-c">Cancel</button><button type="submit" class="btn primary">${esc(okLabel)}</button></div>
      </form>`, () => finish(null));
    m.el.style.width = 'min(460px, 94vw)';
    const nameIn = m.el.querySelector('#sv-name'), here = m.el.querySelector('#sv-here');
    const onSel = (p) => {
      const inF = st.designs.filter((d) => (d.folder || '') === p).map((d) => d.name).sort((a, b) => a.localeCompare(b));
      here.innerHTML = inF.length ? `<b>${inF.length}</b> design${inF.length === 1 ? '' : 's'} in this folder: ${inF.slice(0, 6).map(esc).join(', ')}${inF.length > 6 ? '…' : ''}` : 'This folder is empty.';
    };
    const tree = folderTree(m.el.querySelector('.sv-tree'), folders, { selected: folders.includes(folder) ? folder : '', onSelect: onSel, counts: countsOf(st.designs) });
    onSel(tree.value);
    const showNew = newFolderRow(m, tree, () => folders, (l) => { folders = l; });
    m.el.querySelector('#sv-newbtn').onclick = () => showNew(true);
    m.el.querySelector('#sv-c').onclick = () => m.close();
    setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
    m.el.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      if (!m.el.querySelector('.sv-newrow').hidden && document.activeElement?.closest('.sv-newrow')) return;
      const nm = safeName(nameIn.value);
      if (!nm || nm === 'Untitled') { m.el.querySelector('#sv-err').textContent = 'Give the design a name.'; nameIn.focus(); return; }
      finish({ name: nm, folder: tree.value }); m.close();
    };
  });
}

/** Pick a destination folder for a design or folder. Resolves the path ('' = top level) or null. */
export async function chooseFolder({ title = 'Move to', current = '', exclude = '', ok = 'Move here' } = {}) {
  const st = await loadFileState();
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let folders = st.folders.filter((f) => !exclude || (f !== exclude && !f.startsWith(exclude + '/')));
    const m = modal(`<div class="modal-title">${esc(title)}</div>
      <form class="modal-body sv"><div class="sv-loc"><div class="sv-bar"><button type="button" class="btn sm" id="sv-newbtn">${uicon('plus', 14)} New folder</button></div>
        <div class="sv-newrow" hidden><input aria-label="New folder name" maxlength="80" placeholder="Folder name" autocomplete="off"><button type="button" class="btn sm primary sv-create">Create</button><button type="button" class="btn sm sv-cancel">Cancel</button></div>
        <div class="sv-tree" aria-label="Folders"></div></div>
      <div class="note err-note" id="sv-err" role="alert"></div>
      <div class="modal-foot flush"><button type="button" class="btn" id="sv-c">Cancel</button><button type="submit" class="btn primary">${esc(ok)}</button></div></form>`, () => finish(null));
    const tree = folderTree(m.el.querySelector('.sv-tree'), folders, { selected: folders.includes(current) ? current : '', counts: countsOf(st.designs) });
    const showNew = newFolderRow(m, tree, () => folders, (l) => { folders = l; });
    m.el.querySelector('#sv-newbtn').onclick = () => showNew(true);
    m.el.querySelector('#sv-c').onclick = () => m.close();
    m.el.querySelector('form').onsubmit = (e) => { e.preventDefault(); if (document.activeElement?.closest('.sv-newrow')) return; finish(tree.value); m.close(); };
    setTimeout(() => m.el.querySelector('.ft-row.on')?.focus(), 0);
  });
}
