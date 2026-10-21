// The add-in manager: keeps the list of add-ins, starts the ones that should run, routes imports, exports and commands to them,
// and shows the "Scripts and Add-Ins" dialog (UTILITIES, ADD-INS), modelled on Fusion's.
import { modal } from './account.js';
import { uicon } from './ficons.js';
import { listAddins, packageOf, installAddin, removeAddin, setAddinState } from './addin-store.js';
import { createAddinHost, describePermissions, packageFromFiles } from './addins.js';
import { PERMISSIONS } from '../addin-validate.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * @param o.runtime  text of src/addin-runtime.js
 * @param o.hooks    { toast, confirm, form, pickFile, readDocument, addBody, buildGeometry, saveFile } (see src/addins.js)
 * @param o.onChange called when the list, a status or the contributed commands change
 */
export function createAddinManager({ runtime, hooks, onChange = () => {} }) {
  const host = createAddinHost({ runtime, hooks });
  let list = [], canInstall = true, loaded = false;
  const find = (id) => list.find((a) => a.manifest.id === id);
  const pkgCache = new Map();
  const pkgOf = async (a) => { const k = a.manifest.id + '@' + a.manifest.version + (a.builtin ? 'b' : 'u'); if (!pkgCache.has(k)) pkgCache.set(k, await packageOf(a)); return pkgCache.get(k); };
  host.onChange(() => onChange());

  async function refresh() {
    const r = await listAddins();
    list = r.addins; canInstall = r.canInstall; loaded = true; pkgCache.clear();
    onChange();
    return list;
  }
  const enabled = () => list.filter((a) => a.enabled);

  return {
    refresh, host, get list() { return list; }, get loaded() { return loaded; }, get canInstall() { return canInstall; },
    /** Start the add-ins that are switched on and set to run at startup. */
    async startup() {
      await refresh();
      for (const a of enabled()) if (a.runOnStartup) { try { await host.start(await pkgOf(a)); } catch (e) { hooks.toast(`${a.manifest.name} could not start: ${e.message}`, true); } }
    },
    /** File endings add-ins can import, e.g. ['scad']. */
    importExtensions: () => enabled().flatMap((a) => (a.manifest.contributes?.importers || []).flatMap((i) => i.extensions)),
    importerFor(ext) {
      for (const a of enabled()) for (const i of a.manifest.contributes?.importers || []) if (i.extensions.includes(ext)) return { addin: a, importer: i };
      return null;
    },
    /** Read a file with an add-in: [{ name, soup, notes }] in the form the importer pipeline expects. */
    async readFile(file, ref) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const out = await host.invoke(await pkgOf(ref.addin), 'importer', ref.importer.id, { name: file.name, bytes });
      const parts = Array.isArray(out?.parts) ? out.parts : [];
      if (!parts.length) throw new Error(`${ref.addin.manifest.name} did not return anything to import.`);
      return parts.slice(0, 200).map((p, i) => {
        if (!(p.verts instanceof Float32Array) || !(p.tris instanceof Uint32Array) || p.tris.length % 3 || p.verts.length % 3) throw new Error(`${ref.addin.manifest.name} returned a part that is not a triangle mesh.`);
        const n = p.tris.length / 3, soup = new Float32Array(n * 9);
        for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) { const v = p.tris[t * 3 + k]; if (v * 3 + 2 >= p.verts.length) throw new Error('A triangle refers to a point that does not exist.'); soup.set(p.verts.subarray(v * 3, v * 3 + 3), t * 9 + k * 3); }
        return { name: String(p.name || `Part ${i + 1}`).slice(0, 60), soup, notes: Array.isArray(p.notes) ? p.notes.map((x) => String(x).slice(0, 200)).slice(0, 20) : [] };
      });
    },
    /** Export formats add-ins add: [{ value: 'addin:openscad:scad', label, extension, description }]. */
    exporters: () => enabled().flatMap((a) => (a.manifest.contributes?.exporters || []).map((e) => ({ value: `addin:${a.manifest.id}:${e.id}`, label: e.label, extension: e.extension, description: e.description || `From the add-in "${a.manifest.name}".` }))),
    async runExporter(value, design) {
      const [, id, ex] = value.split(':'), a = find(id);
      if (!a || !a.enabled) throw new Error('That add-in is not available.');
      const out = await host.invoke(await pkgOf(a), 'exporter', ex, { design });
      if (!out || (typeof out.text !== 'string' && !(out.bytes instanceof Uint8Array))) throw new Error(`${a.manifest.name} did not return a file.`);
      return { name: String(out.filename || `${design.name}.${a.manifest.contributes.exporters.find((e) => e.id === ex)?.extension || 'txt'}`), text: out.text, bytes: out.bytes, mime: out.mime };
    },
    /** Commands add-ins contribute: [{ ref: 'openscad:about', label, description, addin }]. */
    commands: () => enabled().flatMap((a) => (a.manifest.contributes?.commands || []).map((c) => ({ ref: `${a.manifest.id}:${c.id}`, label: c.label, description: c.description || '', addin: a.manifest.name }))),
    async runCommand(ref) {
      const [id, cmd] = ref.split(':'), a = find(id);
      if (!a || !a.enabled) throw new Error('That add-in is not available.');
      return host.invoke(await pkgOf(a), 'command', cmd, {});
    },

    // ------------------------------------------------------------------------------------------ the dialog
    showDialog() {
      const m = modal(`<div class="modal-title">Scripts and Add-Ins</div>
        <div class="modal-body ai-dlg">
          <p class="ai-note">Add-ins are small JavaScript packages that run in a sandbox. They can only do what they list under Permissions. <b>Fusion 360 add-ins (Python or C++) cannot run here</b>; Sketchy add-ins use Sketchy's own API.</p>
          <div class="ai-cols">
            <div class="ai-list-wrap">
              <div class="ai-tabs" role="tablist"><button type="button" role="tab" aria-selected="true" class="on">Add-Ins</button></div>
              <div class="ai-items" id="ai-items" role="listbox" aria-label="Add-ins"></div>
              <div class="ai-add"><button type="button" class="btn sm" id="ai-plus" title="Add an add-in from a zip file or a folder">+ Add…</button></div>
            </div>
            <div class="ai-detail" id="ai-detail" aria-live="polite"></div>
          </div>
        </div>
        <input type="file" id="ai-file" accept=".zip,.json,.js,.md,.txt" multiple hidden>
        <input type="file" id="ai-folder" webkitdirectory hidden>
        <div class="modal-foot"><button type="button" class="btn primary" id="ai-done">Close</button></div>`);
      const items = m.el.querySelector('#ai-items'), detail = m.el.querySelector('#ai-detail');
      let sel = list[0]?.manifest.id || null;
      const paint = () => {
        items.innerHTML = list.length ? list.map((a) => {
          const st = host.status(a.manifest.id);
          return `<button type="button" role="option" class="ai-item${a.manifest.id === sel ? ' on' : ''}${a.enabled ? '' : ' off'}" data-id="${esc(a.manifest.id)}" aria-selected="${a.manifest.id === sel}"><span class="ai-dot ${st}" title="${esc(st)}"></span><span class="ai-name">${esc(a.manifest.name)}</span><small>${a.builtin ? 'Built in' : 'Installed'} · ${esc(a.manifest.version)}</small></button>`;
        }).join('') : '<p class="ai-none">No add-ins yet. Use + Add… to install one.</p>';
        items.querySelectorAll('.ai-item').forEach((b) => (b.onclick = () => { sel = b.dataset.id; paint(); }));
        const a = find(sel);
        if (!a) { detail.innerHTML = '<p class="ai-none">Select an add-in to see what it does.</p>'; return; }
        const mf = a.manifest, st = host.status(mf.id), c = mf.contributes || {};
        const perms = describePermissions(mf);
        detail.innerHTML = `<h3>${esc(mf.name)} <small>${esc(mf.version)}</small></h3>
          <p>${esc(mf.description || 'No description.')}</p>
          <dl class="ai-meta"><dt>By</dt><dd>${esc(mf.author || 'Unknown')}</dd><dt>Licence</dt><dd>${esc(mf.license || 'Not stated')}</dd><dt>Source</dt><dd>${a.builtin ? 'Shipped with Sketchy' : 'Installed by you'}</dd></dl>
          <div class="ai-sec"><b>Permissions</b>${perms.length ? '<ul>' + perms.map((p) => `<li>${esc(p)}</li>`).join('') + '</ul>' : '<p class="ai-none">None. It cannot see your design or your files.</p>'}</div>
          <div class="ai-sec"><b>Adds</b><ul>${(c.importers || []).map((i) => `<li>Import: ${esc(i.label)} (.${esc(i.extensions.join(', .'))})</li>`).join('')}${(c.exporters || []).map((e) => `<li>Export: ${esc(e.label)} (.${esc(e.extension)})</li>`).join('')}${(c.commands || []).map((x) => `<li>Command: ${esc(x.label)}</li>`).join('')}${!(c.importers || c.exporters || c.commands) ? '<li>Nothing yet</li>' : ''}</ul></div>
          ${st === 'failed' ? `<div class="ai-err" role="alert">${esc(host.error(mf.id))}</div>` : ''}
          <div class="ai-actions">
            <label class="chk"><input type="checkbox" id="ai-en" ${a.enabled ? 'checked' : ''}> Enabled</label>
            <label class="chk"><input type="checkbox" id="ai-su" ${a.runOnStartup ? 'checked' : ''} ${a.enabled ? '' : 'disabled'}> Run on startup</label>
            ${st === 'running' ? '<button type="button" class="btn" id="ai-stop">Stop</button>' : `<button type="button" class="btn primary" id="ai-run" ${a.enabled ? '' : 'disabled'}>${st === 'starting' ? 'Starting…' : 'Run'}</button>`}
            ${a.builtin ? '' : '<button type="button" class="btn danger" id="ai-rm">Remove</button>'}
          </div>
          <div class="ai-cmds">${st === 'running' ? (c.commands || []).map((x) => `<button type="button" class="btn sm" data-cmd="${esc(x.id)}" title="${esc(x.description || '')}">${esc(x.label)}</button>`).join('') : ''}</div>`;
        detail.querySelector('#ai-en')?.addEventListener('change', async (e) => { setAddinState(mf.id, { enabled: e.target.checked }); if (!e.target.checked) host.stop(mf.id); await refresh(); paint(); });
        detail.querySelector('#ai-su')?.addEventListener('change', async (e) => { setAddinState(mf.id, { runOnStartup: e.target.checked }); await refresh(); paint(); });
        detail.querySelector('#ai-run')?.addEventListener('click', async () => { try { const p = host.start(await pkgOf(a)); paint(); await p; hooks.toast(`${mf.name} is running.`); } catch (e) { hooks.toast(`${mf.name}: ${e.message}`, true); } paint(); });
        detail.querySelector('#ai-stop')?.addEventListener('click', () => { host.stop(mf.id); paint(); });
        detail.querySelector('#ai-rm')?.addEventListener('click', async () => { if (!(await hooks.confirm(`Remove "${mf.name}"?`, { ok: 'Remove', danger: true, title: 'Remove add-in' }))) return; host.stop(mf.id); await removeAddin(mf.id); await refresh(); sel = list[0]?.manifest.id || null; paint(); });
        detail.querySelectorAll('[data-cmd]').forEach((b) => (b.onclick = async () => { try { await host.invoke(await pkgOf(a), 'command', b.dataset.cmd, {}); } catch (e) { hooks.toast(`${mf.name}: ${e.message}`, true); } }));
      };
      const off = host.onChange(() => { if (m.el.isConnected) paint(); });
      const add = async (files) => {
        if (!canInstall) return hooks.toast('Installing add-ins is turned off on this server.', true);
        try {
          const pkg = await packageFromFiles([...files]);
          const perms = (pkg.manifest.permissions || []).map((p) => `• ${PERMISSIONS[p]}`).join('\n') || '• None';
          const ok = await hooks.confirm(`Install "${pkg.manifest.name}" ${pkg.manifest.version} by ${pkg.manifest.author || 'an unknown author'}?\n\nIt will be allowed to:\n${perms}\n\nOnly install add-ins from people you trust.`, { ok: 'Install', title: 'Install add-in' });
          if (!ok) return;
          await installAddin(pkg); await refresh(); sel = pkg.manifest.id; paint(); hooks.toast(`Installed ${pkg.manifest.name}.`);
        } catch (e) { hooks.toast(e.message, true); }
      };
      m.el.querySelector('#ai-plus').onclick = (e) => {
        const b = e.currentTarget.getBoundingClientRect();
        hooks.menu(b.left, b.bottom + 2, [{ label: 'From a zip file…', run: () => m.el.querySelector('#ai-file').click() }, { label: 'From a folder…', run: () => m.el.querySelector('#ai-folder').click() }]);
      };
      m.el.querySelector('#ai-file').onchange = (e) => { const f = e.target.files; e.target.value = ''; if (f.length) add(f); };
      m.el.querySelector('#ai-folder').onchange = (e) => { const f = e.target.files; e.target.value = ''; if (f.length) add(f); };
      m.el.querySelector('#ai-done').onclick = () => { off(); m.close(); };
      refresh().then(() => { sel = sel && find(sel) ? sel : list[0]?.manifest.id || null; paint(); });
      paint();
    },
    uicon,
  };
}
