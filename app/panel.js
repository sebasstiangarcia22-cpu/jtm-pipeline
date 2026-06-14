// Agent panel: login + my pipeline (list + add). Edit/notes/daily report next.
const cfg = window.JTM_CONFIG || {};
const db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

// Canonical statuses -> badge color
const STATUSES = {
  'HOT': 'red', 'Closing': 'red',
  'Negotiating': 'orange', 'Re-engaging': 'orange', 'Call scheduled': 'orange',
  'Meeting scheduled': 'orange', 'Onboarding': 'orange', 'Awaiting response': 'orange',
  'Deposited': 'green', 'Active (funded)': 'green',
  'Proposal pending': 'yellow', 'Under evaluation': 'yellow',
  'Lost': 'gray', 'Inactive': 'gray', 'Declined': 'gray',
};
let me = null;
let rowsById = {};
let isMgmtGlobal = false;
let EN = false; // viewers (Nishil/management) get English UI
const L = (es, en) => (EN ? en : es);

// Auto-translate a note ES->EN (MyMemory, free). Returns null on any failure —
// the note is saved anyway and the original is shown as fallback.
async function translateNote(text) {
  try {
    const u = 'https://api.mymemory.translated.net/get?langpair=es|en&de=sebasstiangarcia22@gmail.com&q='
      + encodeURIComponent(text.slice(0, 490));
    const j = await fetch(u, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
    return (j?.responseStatus == 200 && j.responseData?.translatedText) || null;
  } catch { return null; }
}
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const statusOptions = (sel) => Object.keys(STATUSES).map((s) => `<option ${s === sel ? 'selected' : ''}>${s}</option>`).join('');

async function showPanel() {
  const { data: { user } } = await db.auth.getUser();
  if (!user) return showLogin();
  const { data: profile } = await db.from('profiles').select('id, full_name, role').eq('user_id', user.id).single();
  me = profile;
  $('who-name').textContent = profile ? profile.full_name : user.email;
  $('who-role').textContent = profile ? profile.role.toUpperCase() : '—';
  $('f-status').innerHTML = Object.keys(STATUSES).map((s) => `<option>${s}</option>`).join('');
  $('login').classList.add('hidden'); $('panel').classList.remove('hidden');
  // Role-based tabs — set EVERY login so no state leaks between sessions in
  // the same browser (e.g., admin logs out, agent logs in).
  const role = me?.role || 'bdm';
  const isViewer = role === 'viewer';
  const isMgmt = ['gm', 'admin', 'viewer'].includes(role);
  EN = isViewer; // English UI for viewers (Nishil/management)
  $('admin-tabs').classList.remove('hidden');
  $('tab-mine').classList.toggle('hidden', isViewer);
  $('tab-team').textContent = isViewer ? 'Team' : (isMgmt ? 'Equipo' : 'Mi actividad');
  $('tab-deals').textContent = L('Negocios', 'Deals');
  $('tab-deals').classList.toggle('hidden', !isMgmt);
  $('tab-dash').classList.toggle('hidden', !isMgmt);
  $('help-mgmt').classList.toggle('hidden', !isMgmt);
  // Viewer statics in English
  $('th-reports').textContent = L('Reportes', 'Reports');
  $('th-feed').textContent = L('Actividad reciente', 'Recent activity');
  $('lbl-view').textContent = L('Ver:', 'View:');
  $('dview-flat').textContent = L('Consolidado', 'Consolidated');
  $('dview-agent').textContent = L('Por agente', 'By agent');
  $('help-title').textContent = L('📖 Manual del panel', '📖 Panel guide');
  $('help-es').classList.toggle('hidden', EN);
  $('help-en').classList.toggle('hidden', !EN);
  $('pwd-btn').textContent = L('🔑 Contraseña', '🔑 Password');
  $('pwd-title').textContent = L('🔑 Cambiar contraseña', '🔑 Change password');
  $('pwd-l1').textContent = L('Nueva contraseña (mínimo 8 caracteres)', 'New password (at least 8 characters)');
  $('pwd-l2').textContent = L('Repítela', 'Repeat it');
  $('pwd-save').textContent = L('Guardar', 'Save');
  isMgmtGlobal = isMgmt;
  $('note-title').textContent = L('📌 Nota de mercado del día', '📌 Market note of the day');
  $('note-l1').textContent = L('Mensaje para el equipo (qué pasa hoy + qué hacer)', 'Message for the team (what\'s happening + what to do)');
  $('note-save').textContent = L('Publicar', 'Publish');
  $('note-clear').textContent = L('Borrar nota', 'Clear note');
  if (isMgmt) loadPipelinePotential();
  fetchNews();
  loadMarketNote();
  showTab(isViewer ? 'tab-dash' : 'tab-mine');
  if (isViewer) return;
  await loadPipeline();          // fills rowsById (prospect names for the summary)
  loadDailyReport();
}

// ---- Tabs (Mi panel / Equipo / Negocios / Dashboard) ----
const TABS = { 'tab-mine': 'view-mine', 'tab-team': 'view-team', 'tab-deals': 'view-deals', 'tab-dash': 'view-dash' };
function showTab(tabId) {
  Object.entries(TABS).forEach(([t, v]) => {
    $(t).classList.toggle('active', t === tabId);
    $(v).classList.toggle('hidden', t !== tabId);
  });
  if (tabId === 'tab-team') loadTeam();
  if (tabId === 'tab-deals') loadDeals();
}
Object.keys(TABS).forEach((t) => $(t).addEventListener('click', () => showTab(t)));

// ---- Negocios: one consolidated deals funnel, in 3 sub-tabs ----
const LOST_STATUSES = ['Lost', 'Inactive', 'Declined'];
const FUNDED_STATUSES = ['Deposited', 'Active (funded)', 'Hired'];
// Proximity to FTD: lower rank = closer to closing
const STAGE_RANK = {
  'Closing': 0, 'HOT': 1,
  'Onboarding': 2, 'Meeting scheduled': 3, 'Call scheduled': 4,
  'Negotiating': 5, 'Proposal pending': 6,
  'Under evaluation': 7, 'Awaiting response': 8, 'Re-engaging': 9,
};
let dealsCache = null; // { deals, realBy, lastNote }
let dealsSub = 'process';
let dealsMode = 'flat'; // 'flat' = consolidado · 'agent' = agrupado por miembro

$('dview-flat').addEventListener('click', () => {
  dealsMode = 'flat';
  $('dview-flat').classList.add('active'); $('dview-agent').classList.remove('active');
  renderDeals();
});
$('dview-agent').addEventListener('click', () => {
  dealsMode = 'agent';
  $('dview-agent').classList.add('active'); $('dview-flat').classList.remove('active');
  renderDeals();
});

const DSUBS = { 'dsub-process': 'process', 'dsub-funded': 'funded', 'dsub-lost': 'lost' };
Object.keys(DSUBS).forEach((id) => $(id).addEventListener('click', () => {
  dealsSub = DSUBS[id];
  Object.keys(DSUBS).forEach((b) => $(b).classList.toggle('active', b === id));
  renderDeals();
}));

function dealCategory(d) {
  if (LOST_STATUSES.includes(d.status)) return 'lost';
  if (FUNDED_STATUSES.includes(d.status) || (d.status || '').startsWith('Funded')) return 'funded';
  return 'process';
}

async function loadDeals() {
  const [{ data: deals }, { data: notes }] = await Promise.all([
    db.from('pipeline_entries')
      .select('id, prospect_name, country, status, badge_color, deal_size, client_login, deposit_signal_amount, deposit_signal_date, next_action, next_action_date, owner:profiles!pipeline_entries_owner_id_fkey(full_name)')
      .order('deal_size', { ascending: false, nullsFirst: false }),
    db.from('notes').select('entity_id, created_at').eq('entity_type', 'pipeline')
      .order('created_at', { ascending: false }),
  ]);
  if (!deals || !deals.length) { $('deals-kpis').innerHTML = ''; $('deals-table').innerHTML = '<div class="state">Sin negocios aún.</div>'; return; }
  deals.forEach((r) => { rowsById[r.id] = r; });

  // Real deposited (FXBO) for linked deals
  const logins = deals.map((d) => d.client_login).filter(Boolean);
  const realBy = {};
  if (logins.length) {
    const { data: tx } = await db.from('transactions')
      .select('client_login, amount, type').in('client_login', logins).eq('type', 'deposit');
    (tx || []).forEach((t) => { realBy[t.client_login] = (realBy[t.client_login] || 0) + Number(t.amount); });
  }

  // Last activity per deal
  const lastNote = {};
  (notes || []).forEach((n) => { if (!lastNote[n.entity_id]) lastNote[n.entity_id] = n.created_at; });

  dealsCache = { deals, realBy, lastNote };
  renderDeals();
}

function renderDeals() {
  if (!dealsCache) return;
  const { deals, realBy, lastNote } = dealsCache;
  const aging = (id) => {
    if (!lastNote[id]) return { txt: L('sin actividad', 'no activity'), dot: 'gray' };
    const days = Math.floor((Date.now() - new Date(lastNote[id])) / 86400000);
    return { txt: days === 0 ? L('hoy', 'today') : days === 1 ? L('ayer', 'yesterday') : L(`hace ${days}d`, `${days}d ago`), dot: days < 3 ? 'green' : days <= 7 ? 'yellow' : 'red' };
  };

  // Global summary strip (whole funnel)
  const totPipe = deals.reduce((s, d) => s + (Number(d.deal_size) || 0), 0);
  const totSig = deals.reduce((s, d) => s + (Number(d.deposit_signal_amount) || 0), 0);
  const totReal = Object.values(realBy).reduce((s, v) => s + v, 0);
  const activos = deals.filter((d) => dealCategory(d) !== 'lost').length;
  $('deals-kpis').innerHTML = [
    ['Pipeline Potential', money(totPipe), 'style="color:var(--blue)"'],
    [L('En señales', 'In signals'), money(totSig), 'style="color:#facc15"'],
    [L('Real depositado (FXBO)', 'Real deposited (FXBO)'), money(totReal), 'class="kpi-val pos"'],
    [L('Negocios activos', 'Active deals'), activos, ''],
  ].map(([lbl, val, attr]) => `<div class="kpi"><div class="kpi-val" ${attr}>${val}</div><div class="kpi-lbl">${lbl}</div></div>`).join('');

  // Sub-tab counts
  const counts = { process: 0, funded: 0, lost: 0 };
  deals.forEach((d) => counts[dealCategory(d)]++);
  $('dsub-process').textContent = `${L('En proceso', 'In progress')} (${counts.process})`;
  $('dsub-funded').textContent = `${L('Activos', 'Active')} (${counts.funded})`;
  $('dsub-lost').textContent = `${L('Perdidos', 'Lost')} (${counts.lost})`;

  // Filter current sub-tab + its priority sorting
  const subset = deals.filter((d) => dealCategory(d) === dealsSub);
  const sig = (d) => Number(d.deposit_signal_amount) || 0;
  const realOf = (d) => (d.client_login && realBy[d.client_login]) || 0;
  if (dealsSub === 'process') {
    // Closest to FTD first: active signal > stage rank > size
    subset.sort((a, b) => ((sig(b) > 0) - (sig(a) > 0))
      || (STAGE_RANK[a.status] ?? 99) - (STAGE_RANK[b.status] ?? 99)
      || (Number(b.deal_size) || 0) - (Number(a.deal_size) || 0));
    $('deals-hint').textContent = L('Prioridad: señal de depósito activa y cercanía al FTD.', 'Priority: active deposit signal and proximity to FTD.');
  } else if (dealsSub === 'funded') {
    // Active deposit signals first (re-deposits about to land)
    subset.sort((a, b) => ((sig(b) > 0) - (sig(a) > 0)) || sig(b) - sig(a) || realOf(b) - realOf(a));
    $('deals-hint').textContent = L('Prioridad: señales de depósito activas (re-depósitos por caer).', 'Priority: active deposit signals (re-deposits about to land).');
  } else {
    subset.sort((a, b) => (Number(b.deal_size) || 0) - (Number(a.deal_size) || 0));
    $('deals-hint').textContent = L('Negocios perdidos o inactivos — fuera del funnel activo.', 'Lost or inactive deals — out of the active funnel.');
  }

  if (!subset.length) { $('deals-table').innerHTML = `<div class="state">${L('Nada en esta categoría.', 'Nothing in this category.')}</div>`; return; }

  const isAdmin = ['gm', 'admin'].includes(me.role);
  const dealRow = (d) => {
    const a = aging(d.id);
    const real = d.client_login ? (realBy[d.client_login] || 0) : null;
    return `<tr data-id="${d.id}" class="deal-row">
      <td>${d.prospect_name}${d.country ? ` <span style="color:var(--mut);font-size:11px">· ${d.country}</span>` : ''}</td>
      <td>${d.owner?.full_name || '—'}</td>
      <td><span class="pill b-${d.badge_color || 'gray'}">${d.status || '—'}</span></td>
      <td class="num" style="color:var(--blue)">${d.deal_size ? money(d.deal_size) : '—'}</td>
      <td class="num" style="color:#facc15">${d.deposit_signal_amount ? money(d.deposit_signal_amount) + (d.deposit_signal_date ? ` <span style="color:var(--mut);font-size:11px">→ ${d.deposit_signal_date}</span>` : '') : '—'}</td>
      <td class="num ${real ? 'pos' : ''}">${real != null ? money(real) : '—'}</td>
      <td><span style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;background:${a.dot === 'green' ? 'var(--green)' : a.dot === 'yellow' ? '#facc15' : a.dot === 'red' ? '#f85149' : '#6b7280'}"></span>${a.txt}</td>
      <td>${d.next_action || '—'}${d.next_action_date ? ` <span style="color:var(--mut);font-size:11px">· ${d.next_action_date}</span>` : ''}</td>
      ${isAdmin ? `<td><a href="#" class="deal-edit" data-id="${d.id}" style="color:var(--blue);font-size:12px">${L('editar', 'edit')}</a></td>` : ''}
    </tr><tr class="notes-tr hidden" data-notes-for="${d.id}"><td colspan="${isAdmin ? 9 : 8}" style="background:#10151c"></td></tr>`;
  };
  const THEAD = `<thead><tr>
    <th>${L('Negocio', 'Deal')}</th><th>BDM</th><th>Status</th><th class="num">${L('Potencial', 'Potential')}</th><th class="num">${L('Señal', 'Signal')}</th><th class="num">Real (FXBO)</th><th>${L('Último avance', 'Last activity')}</th><th>${L('Próximo paso', 'Next step')}</th>${isAdmin ? '<th></th>' : ''}
    </tr></thead>`;

  if (dealsMode === 'agent') {
    // Group by team member: collapsed accordion (header = subtotals; click to expand)
    const groups = {};
    subset.forEach((d) => { const k = d.owner?.full_name || '—'; (groups[k] ||= []).push(d); });
    $('deals-table').innerHTML = Object.entries(groups)
      .map(([agent, list]) => ({
        agent, list,
        pot: list.reduce((s, d) => s + (Number(d.deal_size) || 0), 0),
        sigT: list.reduce((s, d) => s + (Number(d.deposit_signal_amount) || 0), 0),
        real: list.reduce((s, d) => s + ((d.client_login && realBy[d.client_login]) || 0), 0),
      }))
      .sort((a, b) => b.pot - a.pot)
      .map((g, i) => `<div style="margin-bottom:10px;border:1px solid var(--line);border-radius:10px;background:var(--card)">
        <div class="agent-head" data-group="${i}" style="display:flex;align-items:center;gap:12px;padding:12px 14px;flex-wrap:wrap;cursor:pointer">
          <span class="agent-arrow" style="color:var(--mut)">›</span>
          <strong style="font-size:14px">${g.agent}</strong>
          <span class="badge">${g.list.length} ${L(g.list.length === 1 ? 'negocio' : 'negocios', g.list.length === 1 ? 'deal' : 'deals')}</span>
          <span style="font-size:12px;color:var(--blue)">${L('Potencial', 'Potential')} ${money(g.pot)}</span>
          <span style="font-size:12px;color:#facc15">${L('Señales', 'Signals')} ${money(g.sigT)}</span>
          <span style="font-size:12px;color:var(--green)">Real ${money(g.real)}</span>
        </div>
        <div class="agent-body hidden" data-group-body="${i}" style="padding:0 10px 10px">
          <table>${THEAD}<tbody>${g.list.map(dealRow).join('')}</tbody></table>
        </div>
      </div>`).join('');
    document.querySelectorAll('#deals-table .agent-head').forEach((h) =>
      h.addEventListener('click', () => {
        const body = document.querySelector(`[data-group-body="${h.dataset.group}"]`);
        const open = !body.classList.contains('hidden');
        body.classList.toggle('hidden');
        h.querySelector('.agent-arrow').textContent = open ? '›' : '⌄';
      }));
  } else {
    $('deals-table').innerHTML = `<table>${THEAD}<tbody>${subset.map(dealRow).join('')}</tbody></table>`;
  }
  document.querySelectorAll('#deals-table .deal-row').forEach((tr) =>
    tr.addEventListener('click', () => toggleTeamNotes(tr.dataset.id, '#deals-table')));
  document.querySelectorAll('#deals-table .deal-edit').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openEdit(a.dataset.id); }));
}

// Pipeline Potential KPI (sum of deal sizes — login-only, like the old $530K+)
async function loadPipelinePotential() {
  const { data } = await db.from('pipeline_entries').select('deal_size');
  const total = (data || []).reduce((s, r) => s + (Number(r.deal_size) || 0), 0);
  $('kpi-extra').innerHTML = `<div class="kpi"><div class="kpi-val" style="color:var(--blue)">${money(total)}</div>
    <div class="kpi-lbl">Pipeline Potential</div></div>`;
}

let teamOffset = 0; // 0 = today, -1 = yesterday, ...
const dayStr = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return d.toLocaleDateString('sv-SE'); };

$('day-prev').addEventListener('click', () => { teamOffset--; loadTeam(); });
$('day-next').addEventListener('click', () => { if (teamOffset < 0) { teamOffset++; loadTeam(); } });

async function loadTeam() {
  const day = dayStr(teamOffset);
  $('day-label').textContent = teamOffset === 0 ? L('Hoy', 'Today') : teamOffset === -1 ? L('Ayer', 'Yesterday') : day;
  // Selected day's reports + who's missing
  const [{ data: agents }, { data: reps }] = await Promise.all([
    db.from('profiles').select('id, full_name, role').eq('active', true)
      .in('role', ['bdm', 'asm', 'team_leader', 'gm']),
    db.from('daily_reports').select('agent_id, activity_summary, commitments, submitted_at')
      .eq('report_date', day),
  ]);
  const repBy = {}; (reps || []).forEach((r) => { repBy[r.agent_id] = r; });
  $('team-reports').innerHTML = (agents || []).map((a) => {
    const r = repBy[a.id];
    if (!r) return `<div style="border:1px solid var(--line);border-radius:10px;background:var(--card);padding:12px 14px;margin:8px 0">
      <strong>${a.full_name}</strong> <span class="badge">${a.role.toUpperCase()}</span>
      <span style="color:#fb923c;font-weight:700;margin-left:8px">⚠️ ${L('Sin reporte', 'No report')}</span></div>`;
    const hora = new Date(r.submitted_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    return `<div style="border:1px solid var(--line);border-radius:10px;background:var(--card);padding:12px 14px;margin:8px 0">
      <strong>${a.full_name}</strong> <span class="badge">${a.role.toUpperCase()}</span>
      <span style="color:var(--green);font-weight:700;margin-left:8px">✓ ${hora}</span>
      <div style="white-space:pre-wrap;margin-top:8px;font-size:13px;color:var(--mut);line-height:1.6">${r.activity_summary || ''}${r.commitments ? '\n— ' + r.commitments : ''}</div></div>`;
  }).join('') || `<div class="state">${L('Sin agentes.', 'No agents.')}</div>`;

  // Prospect names for the feed (the funnel/pipeline itself lives in Negocios)
  const { data: names } = await db.from('pipeline_entries').select('id, prospect_name');
  (names || []).forEach((r) => { rowsById[r.id] = { ...(rowsById[r.id] || {}), ...r }; });

  // Activity feed: latest notes across all prospects
  const { data: feed } = await db.from('notes')
    .select('note_date, text_original, text_en, entity_id, author_name, author_is_mgmt')
    .eq('entity_type', 'pipeline')
    .order('created_at', { ascending: false }).limit(25);
  $('team-feed').innerHTML = (feed || []).map((n) =>
    `<div style="padding:9px 2px;border-bottom:1px solid var(--line);font-size:13px;line-height:1.5">
      ${n.author_is_mgmt ? '<span style="color:var(--blue);font-weight:700">💬</span> ' : ''}<strong style="color:var(--blue)">${n.note_date}</strong>
      <span class="badge" style="margin:0 4px">${rowsById[n.entity_id]?.prospect_name || '—'}</span>
      ${EN ? (n.text_en || n.text_original) : n.text_original} <span style="color:var(--mut);font-size:11px">· ${n.author_name || ''}</span>
    </div>`).join('') || `<div class="state">${L('Sin actividad aún.', 'No activity yet.')}</div>`;
}

// Expand/collapse a prospect's evolution under its row
async function toggleTeamNotes(id, containerSel = '#deals-table') {
  const tr = document.querySelector(`${containerSel} tr[data-notes-for="${id}"]`);
  if (!tr) return;
  if (!tr.classList.contains('hidden')) { tr.classList.add('hidden'); return; }
  const cell = tr.querySelector('td[colspan]');
  cell.innerHTML = `<div class="state">${L('Cargando evolución…', 'Loading history…')}</div>`;
  tr.classList.remove('hidden');
  const { data: notes } = await db.from('notes')
    .select('note_date, text_original, text_en, author_is_mgmt, author_name')
    .eq('entity_type', 'pipeline').eq('entity_id', id)
    .order('created_at', { ascending: false });
  // Management (gm/admin/viewer) can drop a note/question right here
  const isMgmt = ['gm', 'admin', 'viewer'].includes(me.role);
  const commentBox = isMgmt ? `<div style="padding:8px 6px;border-bottom:1px solid var(--line);display:flex;gap:8px">
      <input class="mgmt-comment" placeholder="${L('💬 Deja una nota o pregunta al BDM…', '💬 Leave a note or question for the BDM…')}" style="flex:1;padding:8px 10px;background:#0e1116;border:1px solid var(--line);border-radius:8px;color:var(--txt);font-size:13px;outline:none" />
      <button class="btn-add mgmt-comment-send">${L('Enviar', 'Send')}</button></div>` : '';
  cell.innerHTML = commentBox + ((notes || []).length
    ? notes.map((n) => `<div style="padding:7px 6px;font-size:13px;line-height:1.5;border-bottom:1px solid var(--line)${n.author_is_mgmt ? ';background:#15233a;border-left:3px solid var(--blue)' : ''}">
        ${n.author_is_mgmt ? '<span style="color:var(--blue);font-weight:700">💬</span> ' : ''}<strong style="color:var(--blue)">${n.note_date}</strong> — ${EN ? (n.text_en || n.text_original) : n.text_original}
        <span style="color:var(--mut);font-size:11px">· ${n.author_name || ''}</span></div>`).join('')
    : `<div class="state">${L('Sin notas aún.', 'No notes yet.')}</div>`);
  const sendBtn = cell.querySelector('.mgmt-comment-send');
  if (sendBtn) sendBtn.addEventListener('click', async () => {
    const text = cell.querySelector('.mgmt-comment').value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    const { error } = await db.from('notes').insert({
      entity_type: 'pipeline', entity_id: id, author_id: me.id, text_original: text,
      text_en: EN ? text : await translateNote(text), // viewers already write in English
    });
    sendBtn.disabled = false;
    if (!error) { tr.classList.add('hidden'); toggleTeamNotes(id, containerSel); }
  });
}

// ---- Manager market note (editable by gm/admin/viewer, read by all) ----
async function loadMarketNote() {
  const el = $('news-note'); if (!el) return;
  let n = null;
  try { const { data } = await db.rpc('get_market_note'); n = data && data[0]; } catch {}
  const text = n && n.note ? (EN ? (n.note_en || n.note) : n.note) : '';
  if (!text && !isMgmtGlobal) { el.style.display = 'none'; return; }
  if (!text) {
    el.innerHTML = `<span class="nn-text" style="color:var(--mut)">📌 ${L('Sin nota de mercado hoy', 'No market note today')}</span>`
      + `<button class="nn-edit" id="nn-edit">✏️ ${L('Agregar', 'Add')}</button>`;
  } else {
    el.innerHTML = `<span class="nn-text">📌 ${text}${n.updated_by ? ` <span class="nn-by">· ${n.updated_by}</span>` : ''}</span>`
      + (isMgmtGlobal ? `<button class="nn-edit" id="nn-edit">✏️ ${L('Editar', 'Edit')}</button>` : '');
  }
  el.style.display = 'flex';
  const eb = document.getElementById('nn-edit');
  if (eb) eb.addEventListener('click', () => {
    $('note-text').value = (n && n.note) || ''; $('note-msg').textContent = '';
    $('note-modal').classList.remove('hidden');
  });
}

// ---- Market news bar: today's high-impact economic events (Forex Factory
// calendar, refreshed daily server-side into Supabase). Hides on any failure. ----
async function fetchNews() {
  const bar = $('news-bar'); if (!bar) return;
  try {
    const { data: items, error } = await db.rpc('public_market_today');
    if (error || !items || !items.length) { bar.style.display = 'none'; return; }
    bar.innerHTML = `<span class="news-label">📅 ${L('Mercado hoy', 'Market today')}</span>`
      + items.map((i) => `<span class="news-item">${i.title}${i.meta ? ` <span style="color:#5a6573">${i.meta}</span>` : ''}</span>`).join('<span class="news-sep">•</span>');
    bar.style.display = 'flex';
  } catch { bar.style.display = 'none'; }
}

// ---- Daily report ----
// Compile today's activity: all notes (incl. deposit signals) the agent wrote
// today, grouped with each prospect's name, plus prospects created today.
async function buildTodaySummary() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const [{ data: notes }, { data: newPros }] = await Promise.all([
    db.from('notes')
      .select('text_original, created_at, entity_id')
      .eq('author_id', me.id).gte('created_at', start.toISOString())
      .order('created_at', { ascending: true }),
    db.from('pipeline_entries')
      .select('prospect_name').gte('created_at', start.toISOString()),
  ]);
  const lines = [];
  if (newPros?.length) lines.push(`Prospectos nuevos hoy (${newPros.length}): ${newPros.map((p) => p.prospect_name).join(', ')}`);
  (notes || []).forEach((n) => {
    const name = rowsById[n.entity_id]?.prospect_name || 'Prospecto';
    lines.push(`• [${name}] ${n.text_original}`);
  });
  return lines.join('\n');
}

async function loadDailyReport() {
  const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD local
  const { data: rep } = await db.from('daily_reports')
    .select('activity_summary, commitments, submitted_at')
    .eq('agent_id', me.id).eq('report_date', today).maybeSingle();
  const st = $('dr-status'), form = $('dr-form');
  if (rep) {
    const hora = new Date(rep.submitted_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    st.innerHTML = `<span style="color:var(--green);font-weight:700">✓ Reporte de hoy enviado</span>
      <span style="color:var(--mut)"> · ${hora}</span>
      <a href="#" id="dr-edit" style="color:var(--blue);font-size:12px;margin-left:8px">editar</a>
      <div style="margin-top:10px;font-size:13px;color:var(--mut);white-space:pre-wrap;line-height:1.6">${rep.activity_summary || ''}${rep.commitments ? '\n— ' + rep.commitments : ''}</div>`;
    form.classList.add('hidden');
    $('dr-summary').value = rep.activity_summary || '';
    $('dr-commit').value = rep.commitments || '';
    document.getElementById('dr-edit').addEventListener('click', async (e) => {
      e.preventDefault(); form.classList.remove('hidden');
    });
  } else {
    st.innerHTML = `<span style="color:#fb923c;font-weight:700">⏳ Aún no envías tu reporte de hoy</span>`;
    form.classList.remove('hidden');
    $('dr-summary').value = await buildTodaySummary();
    if (!$('dr-summary').value) $('dr-summary').placeholder = 'Sin actividad registrada hoy. Agrega notas a tus prospectos y aparecerán aquí, o escribe tu resumen.';
  }
}
function showLogin() { $('panel').classList.add('hidden'); $('login').classList.remove('hidden'); }

async function loadPipeline() {
  const { data: rows, error } = await db.from('pipeline_entries')
    .select('id, prospect_name, country, source, status, badge_color, deal_size, deposit_signal_amount, deposit_signal_date, deposit_signal_type, next_action, next_action_date')
    .order('updated_at', { ascending: false });
  const el = $('pipeline');
  if (error) { el.innerHTML = `<div class="state">Error: ${error.message}</div>`; return; }
  if (!rows.length) { el.innerHTML = '<div class="state">Aún no tienes prospectos. Agrega el primero. 👆</div>'; return; }
  rowsById = {};
  rows.forEach((r) => { rowsById[r.id] = r; });
  // 💬 unanswered-management-note flag (agents only): latest note per deal is from mgmt
  const lastMgmt = {};
  if (!['gm', 'admin', 'viewer'].includes(me.role)) {
    const { data: flags } = await db.from('notes')
      .select('entity_id, author_is_mgmt').eq('entity_type', 'pipeline')
      .order('created_at', { ascending: false });
    (flags || []).forEach((n) => { if (!(n.entity_id in lastMgmt)) lastMgmt[n.entity_id] = n.author_is_mgmt; });
  }
  el.innerHTML = `<table><thead><tr>
    <th>Prospecto</th><th>País</th><th>Fuente</th><th>Status</th><th class="num">Deal size</th><th>Próximo paso</th><th>Fecha</th>
    </tr></thead><tbody>${rows.map((r) => `<tr data-id="${r.id}">
      <td>${r.prospect_name}${lastMgmt[r.id] ? ' <span title="Nota de management — respóndele con una nota">💬</span>' : ''}</td><td>${r.country || '—'}</td><td>${r.source || '—'}</td>
      <td><span class="pill b-${r.badge_color || 'gray'}">${r.status || '—'}</span></td>
      <td class="num">${r.deal_size ? money(r.deal_size) : '—'}</td>
      <td>${r.next_action || '—'}</td><td>${r.next_action_date || '—'}</td>
    </tr>`).join('')}</tbody></table>`;
  el.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => openEdit(tr.dataset.id)));
}

// ---- Edit prospect ----
function openEdit(id) {
  const r = rowsById[id];
  if (!r) return;
  $('edit-title').textContent = r.prospect_name;
  $('e-status').innerHTML = statusOptions(r.status);
  $('e-deal').value = r.deal_size ?? '';
  $('e-next').value = r.next_action ?? '';
  $('e-date').value = r.next_action_date ?? '';
  $('e-sig-amt').value = r.deposit_signal_amount ?? '';
  $('e-sig-date').value = r.deposit_signal_date ?? '';
  $('e-sig-type').value = r.deposit_signal_type ?? '';
  $('edit-msg').textContent = '';
  $('n-text').value = ''; $('n-msg').textContent = '';
  $('edit-modal').classList.remove('hidden');
  $('edit-modal').dataset.id = id;
  loadNotes(id);
}

async function loadNotes(id) {
  const el = $('n-list');
  el.innerHTML = '<div class="state">Cargando notas…</div>';
  const { data: notes, error } = await db.from('notes')
    .select('note_date, text_original, created_at, author_is_mgmt, author_name')
    .eq('entity_type', 'pipeline').eq('entity_id', id)
    .order('created_at', { ascending: false });
  if (error) { el.innerHTML = `<div class="state">Error: ${error.message}</div>`; return; }
  if (!notes.length) { el.innerHTML = '<div class="state">Sin notas aún. Agrega la primera.</div>'; return; }
  el.innerHTML = notes.map((n) =>
    `<div style="padding:9px ${n.author_is_mgmt ? '8px' : '2px'};border-bottom:1px solid var(--line);font-size:13px;line-height:1.5${n.author_is_mgmt ? ';background:#15233a;border-left:3px solid var(--blue);border-radius:4px' : ''}">
      ${n.author_is_mgmt ? `<span style="color:var(--blue);font-weight:700">💬 ${n.author_name || 'Management'}</span> · ` : ''}<strong style="color:var(--blue)">${n.note_date}</strong> — ${n.text_original}
    </div>`).join('');
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn'), msg = $('login-msg');
  btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Entrando…';
  const { error } = await db.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  btn.disabled = false;
  if (error) { msg.className = 'msg err'; msg.textContent = 'Email o contraseña incorrectos.'; return; }
  msg.textContent = ''; showPanel();
});
$('logout').addEventListener('click', async () => { await db.auth.signOut(); showLogin(); });

// Help / manual modal
$('help-btn').addEventListener('click', () => $('help-modal').classList.remove('hidden'));
$('help-close').addEventListener('click', () => $('help-modal').classList.add('hidden'));
$('help-modal').addEventListener('click', (e) => { if (e.target.id === 'help-modal') $('help-modal').classList.add('hidden'); });

// Market note modal (management)
$('note-close').addEventListener('click', () => $('note-modal').classList.add('hidden'));
$('note-modal').addEventListener('click', (e) => { if (e.target.id === 'note-modal') $('note-modal').classList.add('hidden'); });
$('note-save').addEventListener('click', async () => {
  const text = $('note-text').value.trim(), msg = $('note-msg'), btn = $('note-save');
  if (!text) { msg.className = 'msg err'; msg.textContent = L('Escribe algo.', 'Write something.'); return; }
  btn.disabled = true; msg.className = 'msg'; msg.textContent = '…';
  const en = EN ? text : await translateNote(text);
  const { error } = await db.rpc('set_market_note', { p_note: text, p_note_en: en });
  btn.disabled = false;
  if (error) { msg.className = 'msg err'; msg.textContent = error.message; return; }
  $('note-modal').classList.add('hidden'); loadMarketNote();
});
$('note-clear').addEventListener('click', async () => {
  const { error } = await db.rpc('set_market_note', { p_note: null, p_note_en: null });
  if (!error) { $('note-modal').classList.add('hidden'); loadMarketNote(); }
});

// Change password modal
$('pwd-btn').addEventListener('click', () => {
  $('pwd-new').value = ''; $('pwd-confirm').value = ''; $('pwd-msg').textContent = '';
  $('pwd-modal').classList.remove('hidden');
});
$('pwd-close').addEventListener('click', () => $('pwd-modal').classList.add('hidden'));
$('pwd-modal').addEventListener('click', (e) => { if (e.target.id === 'pwd-modal') $('pwd-modal').classList.add('hidden'); });
$('pwd-save').addEventListener('click', async () => {
  const p1 = $('pwd-new').value, p2 = $('pwd-confirm').value, msg = $('pwd-msg'), btn = $('pwd-save');
  msg.className = 'msg err';
  if (p1.length < 8) { msg.textContent = L('Mínimo 8 caracteres.', 'At least 8 characters.'); return; }
  if (p1 !== p2) { msg.textContent = L('No coinciden.', 'Passwords do not match.'); return; }
  btn.disabled = true; msg.className = 'msg'; msg.textContent = '…';
  const { error } = await db.auth.updateUser({ password: p1 });
  btn.disabled = false;
  if (error) { msg.className = 'msg err'; msg.textContent = error.message; return; }
  msg.className = 'msg ok'; msg.textContent = L('✓ Contraseña actualizada', '✓ Password updated');
  setTimeout(() => $('pwd-modal').classList.add('hidden'), 1200);
});
$('add-toggle').addEventListener('click', () => $('add-form').classList.toggle('hidden'));

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('f-status').value, msg = $('add-msg'), btn = $('save-btn');
  btn.disabled = true; msg.textContent = '';
  const { error } = await db.from('pipeline_entries').insert({
    owner_id: me.id,
    prospect_name: $('f-name').value.trim(),
    country: $('f-country').value.trim() || null,
    source: $('f-source').value,
    status, badge_color: STATUSES[status] || 'gray',
    deal_size: $('f-deal').value ? Number($('f-deal').value) : null,
    next_action: $('f-next').value.trim() || null,
    next_action_date: $('f-date').value || null,
  });
  btn.disabled = false;
  if (error) { msg.textContent = error.message; return; }
  e.target.reset(); $('add-form').classList.add('hidden'); loadPipeline();
});

$('dr-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('dr-msg'), btn = $('dr-send');
  btn.disabled = true; msg.textContent = '';
  const today = new Date().toLocaleDateString('sv-SE');
  const summary = $('dr-summary').value.trim() || null;
  const commit = $('dr-commit').value.trim() || null;
  const { error } = await db.from('daily_reports').upsert({
    agent_id: me.id, report_date: today,
    activity_summary: summary, commitments: commit,
    activity_summary_en: summary ? await translateNote(summary) : null,
    commitments_en: commit ? await translateNote(commit) : null,
    submitted_at: new Date().toISOString(),
  }, { onConflict: 'agent_id,report_date' });
  btn.disabled = false;
  if (error) { msg.textContent = error.message; return; }
  loadDailyReport();
});

$('n-add').addEventListener('click', async () => {
  const id = $('edit-modal').dataset.id, text = $('n-text').value.trim();
  const msg = $('n-msg'), btn = $('n-add');
  if (!text) return;
  btn.disabled = true; msg.textContent = '';
  const { error } = await db.from('notes').insert({
    entity_type: 'pipeline', entity_id: id, author_id: me.id, text_original: text,
    text_en: await translateNote(text),
  });
  btn.disabled = false;
  if (error) { msg.textContent = error.message; return; }
  $('n-text').value = '';
  loadNotes(id);
});

$('edit-close').addEventListener('click', () => $('edit-modal').classList.add('hidden'));
$('edit-modal').addEventListener('click', (e) => { if (e.target.id === 'edit-modal') $('edit-modal').classList.add('hidden'); });
$('edit-save').addEventListener('click', async () => {
  const id = $('edit-modal').dataset.id, status = $('e-status').value;
  const msg = $('edit-msg'), btn = $('edit-save');
  const prev = rowsById[id] || {};
  const sigAmt = $('e-sig-amt').value ? Number($('e-sig-amt').value) : null;
  const sigDate = $('e-sig-date').value || null;
  const sigType = $('e-sig-type').value || null;
  btn.disabled = true; msg.textContent = '';
  const { error } = await db.from('pipeline_entries').update({
    status, badge_color: STATUSES[status] || 'gray',
    deal_size: $('e-deal').value ? Number($('e-deal').value) : null,
    next_action: $('e-next').value.trim() || null,
    next_action_date: $('e-date').value || null,
    deposit_signal_amount: sigAmt,
    deposit_signal_date: sigDate,
    deposit_signal_type: sigType,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  btn.disabled = false;
  if (error) { msg.textContent = error.message; return; }
  // If the deposit signal is new or changed, log it to the timeline (audit trail)
  const sigChanged = sigAmt !== (prev.deposit_signal_amount ? Number(prev.deposit_signal_amount) : null)
    || sigDate !== (prev.deposit_signal_date ?? null) || sigType !== (prev.deposit_signal_type ?? null);
  if (sigAmt && sigChanged) {
    const tipo = sigType === 'new_ftd' ? 'Nuevo depósito (FTD)' : sigType === 'redeposit' ? 'Re-depósito' : 'Depósito';
    const tipoEn = sigType === 'new_ftd' ? 'New deposit (FTD)' : sigType === 'redeposit' ? 'Re-deposit' : 'Deposit';
    await db.from('notes').insert({
      entity_type: 'pipeline', entity_id: id, author_id: me.id,
      text_original: `💰 Señal de depósito: ${money(sigAmt)} — ${tipo}${sigDate ? ` — esperado para ${sigDate}` : ''}`,
      text_en: `💰 Deposit signal: ${money(sigAmt)} — ${tipoEn}${sigDate ? ` — expected for ${sigDate}` : ''}`,
    });
  }
  $('edit-modal').classList.add('hidden'); loadPipeline();
});

db.auth.getSession().then(({ data }) => { if (data.session) showPanel(); });
