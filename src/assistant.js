// The assistant (MCP) side of the app, as part of the app rather than an add-on:
//   - a live stream from the server, so a design an assistant changes updates on screen as it happens
//   - a chip showing what the assistant is doing, with Stop / Resume
//   - a request box: leave a note (with your selection) that the assistant picks up with list_requests, and see its reply
import { call } from './account.js';
import { uicon } from './ficons.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TOOL_WORDS = {
  add_feature: 'adding a feature', update_feature: 'changing a feature', edit_sketch: 'editing a sketch', delete_feature: 'deleting a feature', move_feature: 'reordering the timeline',
  set_parameters: 'setting parameters', set_appearance: 'changing the appearance', set_units: 'changing units', undo_last_change: 'undoing its last change', save_version: 'saving a version',
  restore_version: 'restoring a version', create_design: 'creating a design', duplicate_design: 'copying a design', complete_request: 'answering a request',
  render_view: 'taking a look', get_design: 'reading the design', inspect_design: 'inspecting the design', find_faces: 'looking at faces', find_edges: 'looking at edges',
  measure: 'measuring', print_check: 'checking it for printing', export_model: 'exporting', export_stl: 'exporting', compare_versions: 'comparing versions',
};
export const toolWords = (t) => TOOL_WORDS[t] || 'working';
const PAST = { add_feature: 'added a feature', update_feature: 'changed a feature', edit_sketch: 'edited a sketch', delete_feature: 'deleted a feature', move_feature: 'reordered the timeline', set_parameters: 'set parameters', set_appearance: 'changed the appearance', set_units: 'changed the units', undo_last_change: 'undid its last change', save_version: 'saved a version', restore_version: 'restored a version', create_design: 'created a design', duplicate_design: 'copied a design', complete_request: 'answered a request', render_view: 'took a look' };
export const toolPast = (t) => PAST[t] || 'changed the design';

/**
 * ctx: { toast, getDoc() -> {name, seq, dirty}, reloadDesign(name, tool), designChangedElsewhere(name, event), getSelection() -> context for a request,
 *        currentDesignName(), onFlash(ids) }
 */
export function createAssistant(ctx) {
  let lastClient = '', es = null, held = false, requests = [], panel = null, chipTimer = null, lastDone = null;
  const DONE_MS = 2800; // what the assistant just did stays readable this long: with a fast kernel a call is over in a few milliseconds and the chip would only flash
  const busy = new Map(); // key -> { tool, design, write }
  const chip = document.createElement('div');
  chip.id = 'ai-chip'; chip.hidden = true; chip.setAttribute('role', 'status'); chip.setAttribute('aria-live', 'polite');
  const slot = () => document.querySelector('#appbar .ab-right');
  const place = () => { const s = slot(); if (s && !chip.isConnected) s.insertBefore(chip, s.firstChild); };

  const open = () => requests.filter((r) => r.status === 'open').length;
  function paintChip() {
    place();
    const b = [...busy.values()].filter((x) => x.write || x.tool === 'render_view');
    if (held) {
      chip.hidden = false; chip.className = 'held';
      chip.innerHTML = `${uicon('lock', 14, 1.7)}<span>${esc(lastClient || 'Assistant')} paused</span><button type="button" class="btn sm" id="ai-resume">Resume</button>`;
      chip.querySelector('#ai-resume').onclick = () => hold(false);
    } else if (b.length) {
      const x = b[b.length - 1];
      chip.hidden = false; chip.className = 'busy';
      chip.innerHTML = `${uicon('sparkle', 14, 1.7)}<span>${esc(x.client || 'The assistant')} is ${esc(toolWords(x.tool))}${x.design ? ` in <b>${esc(x.design)}</b>` : ''}</span><button type="button" class="btn sm" id="ai-stop" title="Stop the assistant: its changes are refused until you press Resume">Stop</button>`;
      chip.querySelector('#ai-stop').onclick = () => hold(true);
    } else if (lastDone && Date.now() - lastDone.at < DONE_MS) { // it has just finished: say what it did, for a moment
      chip.hidden = false; chip.className = 'done';
      chip.innerHTML = `${uicon('check', 14, 2)}<span>${esc(lastDone.client || 'The assistant')} ${esc(toolPast(lastDone.tool))}${lastDone.design ? ` in <b>${esc(lastDone.design)}</b>` : ''}</span>`;
      clearTimeout(chipTimer); chipTimer = setTimeout(paintChip, DONE_MS - (Date.now() - lastDone.at) + 30);
    } else { chip.hidden = true; chip.innerHTML = ''; lastDone = null; }
    const btn = document.querySelector('#btn-ai');
    if (btn) { btn.classList.toggle('has', open() > 0); btn.dataset.count = open() ? String(open()) : ''; btn.title = open() ? `Ask the assistant (${open()} waiting)` : 'Ask the assistant'; }
  }
  async function hold(on) {
    const r = await call('POST', '/mcp/hold', { on });
    if (!r.ok) return ctx.toast('Could not reach the server.', true);
    held = !!r.data.held; paintChip();
    ctx.toast(held ? 'Stopped. The assistant cannot change anything until you press Resume.' : 'Resumed. The assistant can make changes again.');
  }

  function onEvent(ev) {
    if (ev.type === 'hello') { held = !!ev.hold; paintChip(); loadRequests(); return; }
    if (ev.type === 'hold') { held = !!ev.on; paintChip(); return; }
    if (ev.type === 'requests') { loadRequests(); return; }
    if (ev.type === 'activity') {
      if (ev.client) lastClient = ev.client;
      const key = ev.tool + '|' + ev.design;
      if (ev.state === 'start') busy.set(key + Math.random(), { ...ev, key });
      else for (const [k, v] of busy) if (v.key === key) { busy.delete(k); if (v.write || v.tool === 'render_view') lastDone = { tool: v.tool, design: v.design, client: v.client, at: Date.now() }; break; }
      clearTimeout(chipTimer); chipTimer = setTimeout(paintChip, 300); paintChip();
      return;
    }
    if (ev.type === 'design') ctx.designChanged(ev);
    if (ev.type === 'ui') ctx.showInApp(ev);
  }
  function start() {
    if (es || typeof EventSource === 'undefined') return;
    place();
    try { es = new EventSource('/api/events'); es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* a malformed event is ignored */ } }; }
    catch { es = null; }
  }
  function stop() { es?.close(); es = null; busy.clear(); held = false; paintChip(); }

  async function loadRequests() {
    const r = await call('GET', '/requests');
    if (r.ok && Array.isArray(r.data)) { requests = r.data; paintChip(); if (panel) paintPanel(); }
  }

  // ---- the request box
  function paintPanel() {
    const list = panel.querySelector('#ai-list');
    list.innerHTML = requests.length ? requests.map((r) => `<div class="ai-req ${esc(r.status)}"><div class="ai-req-h"><span class="ai-st">${r.status === 'open' ? 'Waiting' : r.status === 'done' ? 'Done' : 'Could not'}</span><span class="ai-when">${new Date(r.created).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><button type="button" class="ai-x" data-del="${esc(r.id)}" aria-label="Delete this request" title="Delete">×</button></div><div class="ai-text">${esc(r.text)}</div>${r.context?.summary ? `<div class="ai-ctx">${esc(r.context.summary)}</div>` : ''}${r.reply ? `<div class="ai-reply">${uicon('sparkle', 13, 1.6)} ${esc(r.reply)}</div>` : ''}</div>`).join('') : '<p class="ai-none">Nothing yet. Ask for a change, a check or an explanation.</p>';
    list.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { await call('DELETE', '/requests/' + b.dataset.del); loadRequests(); }));
  }
  function closePanel() { panel?.remove(); panel = null; document.querySelector('#btn-ai')?.setAttribute('aria-expanded', 'false'); }
  function togglePanel(mcpEnabled) {
    if (panel) return closePanel();
    const sel = ctx.getSelection();
    panel = document.createElement('div');
    panel.id = 'ai-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Ask the assistant');
    panel.innerHTML = `<div class="ai-head"><span>${uicon('sparkle', 16, 1.6)} ASK THE ASSISTANT</span><button type="button" class="tmin" id="ai-close" aria-label="Close">×</button></div>
      <div class="ai-body">
        ${mcpEnabled ? '' : '<p class="ai-warn">Assistant access is turned off on this server, so nobody can pick requests up.</p>'}
        <textarea id="ai-text" rows="3" maxlength="2000" placeholder="Make the base 5 mm thicker and round its corners…" aria-label="What should the assistant do?"></textarea>
        ${sel ? `<label class="ai-sel"><input type="checkbox" id="ai-with" checked> <span>Include my selection: ${esc(sel.summary)}</span></label>` : ''}
        <div class="ai-row"><button type="button" class="btn primary" id="ai-send">Leave request</button><span class="ai-help">Your assistant reads this when you ask it to <em>check my Sketchy requests</em>, or by itself when it starts.</span></div>
        <div id="ai-list" class="ai-list"></div>
        <div class="ai-foot"><button type="button" class="btn sm" id="ai-copy">Copy the prompt for your assistant</button></div>
      </div>`;
    document.querySelector('#viewport').appendChild(panel);
    document.querySelector('#btn-ai')?.setAttribute('aria-expanded', 'true');
    panel.querySelector('#ai-close').onclick = closePanel;
    panel.querySelector('#ai-copy').onclick = async () => { try { await navigator.clipboard.writeText('Use Sketchy: call list_requests, do what the open requests ask, and answer each with complete_request.'); ctx.toast('Copied. Paste it into your assistant.'); } catch { ctx.toast('Could not copy.', true); } };
    panel.querySelector('#ai-send').onclick = async () => {
      const text = panel.querySelector('#ai-text').value.trim();
      if (!text) return panel.querySelector('#ai-text').focus();
      const withSel = panel.querySelector('#ai-with')?.checked && sel;
      const r = await call('POST', '/requests', { text, design: ctx.currentDesignName() || '', ...(withSel ? { context: sel.context } : {}) });
      if (!r.ok) return ctx.toast(r.data?.error || 'Could not save the request.', true);
      panel.querySelector('#ai-text').value = ''; ctx.toast('Request left. Your assistant will see it.'); loadRequests();
    };
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } });
    paintPanel(); loadRequests();
    setTimeout(() => panel?.querySelector('#ai-text')?.focus(), 0);
  }

  return { start, stop, togglePanel, closePanel, hold, isHeld: () => held, loadRequests, paintChip };
}
