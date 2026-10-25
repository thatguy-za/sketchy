// OpenSCAD import and export, as a Sketchy add-in. It runs in the add-in sandbox (see src/addins.js): it can only ask Sketchy
// for the open design and for shapes to be built, never touch the page, the network or your other files.
import { runScad } from './scad.js';
import { exportScad } from './export.js';

const base = (name) => String(name).replace(/\.[^.]+$/, '') || 'OpenSCAD';

export async function activate(sketchy) {
  sketchy.on('importer', 'scad', async ({ name, bytes }) => {
    const text = new TextDecoder().decode(bytes);
    let overrides = {};
    const first = runScad(text); // a first run reads the settings (and shows problems early); a second run uses the values chosen
    if (first.parameters.length) {
      const values = await sketchy.ui.form({
        title: `${name}: settings`,
        intro: 'These are the settings at the top of the script. Change any, then import.',
        ok: 'Import',
        fields: first.parameters.map((p) => ({ name: p.name, label: p.name.replace(/_/g, ' '), type: p.type === 'boolean' ? 'bool' : p.type === 'number' ? 'number' : 'text', value: p.value })),
      });
      if (!values) throw new Error('cancelled');
      overrides = values;
    }
    const r = Object.keys(overrides).length ? runScad(text, { overrides }) : first;
    if (!r.tree) throw new Error('The script does not make a solid shape. (It may only set variables or define modules.)');
    const mesh = await sketchy.geometry.build(r.tree);
    if (!mesh) throw new Error('The script makes an empty shape.');
    const notes = [...r.warnings, ...r.echoes.slice(0, 5).map((e) => `echo: ${e}`)];
    return { parts: [{ name: base(name), verts: mesh.verts, tris: mesh.tris, notes }] };
  });

  sketchy.on('exporter', 'scad', async ({ design }) => ({ filename: `${design.name}.scad`, mime: 'text/plain', text: exportScad(design) }));
}
