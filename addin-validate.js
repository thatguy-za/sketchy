// What an add-in package must look like. Used by the server when one is installed and by the app before one is run, so the same
// rules hold in both places. An add-in is a manifest (manifest.json) plus a few text files; it runs sandboxed (see src/addins.js).

export const PERMISSIONS = {
  'document.read': 'See the bodies, parameters and name of the design you have open',
  'document.write': 'Add bodies to the design you have open',
  'files.open': 'Ask you to choose a file and read it',
  'files.save': 'Save a file to your computer',
  geometry: 'Use Sketchy\'s geometry engine to build shapes (it cannot reach the design)',
};
export const LIMITS = {
  files: 40, fileBytes: 1.5e6, totalBytes: 4e6, perUser: 20,
  importers: 8, exporters: 8, commands: 12, extensions: 8,
};
export const ID_RE = /^[a-z0-9][a-z0-9.-]{1,38}[a-z0-9]$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,20})?$/;
const SUB_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const EXT = /^[a-z0-9]{1,8}$/;
const PATH_OK = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,119}$/;
const TEXT_EXT = /\.(js|mjs|json|md|txt|license|css|html)$/i;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => typeof v === 'string' && v.length <= n && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);

/** A path inside an add-in: relative, no "..", no leading slash. */
export const pathOk = (p) => typeof p === 'string' && PATH_OK.test(p) && !p.split('/').some((s) => s === '..' || s === '.' || s === '') && !p.includes('//');

/** Check a manifest. Returns an error message, or null when it is fine. */
export function validateManifest(m) {
  if (!isObj(m)) return 'The manifest must be a JSON object.';
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return 'The manifest "id" must be 3 to 40 characters: lowercase letters, numbers, dots and hyphens (for example "openscad").';
  if (!str(m.name, 60) || !m.name.trim()) return 'The manifest needs a "name" (up to 60 characters).';
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) return 'The manifest "version" must look like 1.0.0.';
  for (const k of ['description', 'author', 'license', 'homepage']) if (m[k] !== undefined && !str(m[k], k === 'description' ? 400 : 120)) return `The manifest "${k}" must be text (${k === 'description' ? 400 : 120} characters at most).`;
  if (m.main !== undefined && (!pathOk(m.main) || !/\.m?js$/.test(m.main))) return 'The manifest "main" must be the path of a .js file inside the add-in (for example "main.js").';
  if (m.runOnStartup !== undefined && typeof m.runOnStartup !== 'boolean') return 'The manifest "runOnStartup" must be true or false.';
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions) || m.permissions.length > 10) return 'The manifest "permissions" must be a list.';
    for (const p of m.permissions) if (!Object.hasOwn(PERMISSIONS, p)) return `Unknown permission "${String(p).slice(0, 30)}". Permissions are: ${Object.keys(PERMISSIONS).join(', ')}.`;
  }
  const c = m.contributes;
  if (c !== undefined) {
    if (!isObj(c)) return 'The manifest "contributes" must be an object.';
    const list = (key, max, check) => {
      if (c[key] === undefined) return null;
      if (!Array.isArray(c[key]) || c[key].length > max) return `"contributes.${key}" must be a list of at most ${max}.`;
      const seen = new Set();
      for (const it of c[key]) {
        if (!isObj(it) || typeof it.id !== 'string' || !SUB_ID.test(it.id)) return `Every entry in "contributes.${key}" needs an "id" (lowercase letters, numbers, - or _).`;
        if (seen.has(it.id)) return `"contributes.${key}" lists "${it.id}" twice.`;
        seen.add(it.id);
        if (!str(it.label, 60) || !it.label.trim()) return `"contributes.${key}" entry "${it.id}" needs a "label".`;
        if (it.description !== undefined && !str(it.description, 300)) return `"contributes.${key}" entry "${it.id}" has a "description" that is too long.`;
        const e = check?.(it); if (e) return e;
      }
      return null;
    };
    const e = list('importers', LIMITS.importers, (it) => (!Array.isArray(it.extensions) || !it.extensions.length || it.extensions.length > LIMITS.extensions || !it.extensions.every((x) => typeof x === 'string' && EXT.test(x)) ? `Importer "${it.id}" needs "extensions": a list of file endings such as ["scad"].` : null))
      || list('exporters', LIMITS.exporters, (it) => (typeof it.extension !== 'string' || !EXT.test(it.extension) ? `Exporter "${it.id}" needs an "extension" such as "scad".` : null))
      || list('commands', LIMITS.commands, null);
    if (e) return e;
    for (const k of Object.keys(c)) if (!['importers', 'exporters', 'commands'].includes(k)) return `"contributes.${k}" is not something add-ins can add.`;
    if (c.exporters?.length && !(m.permissions || []).includes('document.read')) return 'An add-in that adds an exporter needs the "document.read" permission, because it is given the design to write out.';
  }
  return null;
}

/** Check a whole package: the manifest and its files (path -> text). Returns an error message, or null. */
export function validatePackage(manifest, files) {
  const e = validateManifest(manifest);
  if (e) return e;
  if (!isObj(files)) return 'The package needs a list of files.';
  const names = Object.keys(files);
  if (!names.length || names.length > LIMITS.files) return `An add-in can have 1 to ${LIMITS.files} files.`;
  let total = 0;
  for (const n of names) {
    if (!pathOk(n)) return `"${String(n).slice(0, 40)}" is not a usable file path (use letters, numbers, . _ - and /; no "..").`;
    if (n === 'manifest.json') return 'Leave manifest.json out of the files: it is sent separately.';
    if (!TEXT_EXT.test(n) && !/(^|\/)(LICENSE|NOTICE|README)$/i.test(n)) return `"${n}" is not a text file type. Add-ins may contain .js, .json, .md, .txt, .css and .html files.`;
    if (typeof files[n] !== 'string') return `"${n}" must be text.`;
    if (files[n].length > LIMITS.fileBytes) return `"${n}" is larger than ${Math.round(LIMITS.fileBytes / 1e5) / 10} MB.`;
    total += files[n].length;
  }
  if (total > LIMITS.totalBytes) return `The add-in is larger than ${Math.round(LIMITS.totalBytes / 1e5) / 10} MB.`;
  const main = manifest.main || 'main.js';
  if (!(main in files)) return `The manifest's "main" file "${main}" is not in the package.`;
  return null;
}
