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
  const canViewAll = me && ['gm', 'admin', 'viewer'].includes(me.role);
  if (canViewAll) { $('admin-tabs').classList.remove('hidden'); loadPipelinePotential(); }
  if (me && me.role === 'viewer') {
    // Viewers (Nishil/management) are read-only: Dashboard + Equipo, no own pipeline
    $('tab-mine').classList.add('hidden');
    showTab('tab-dash');
    return;
  }
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
const FUNDED_STATUSES = ['Deposited', 'Active (funded)'];
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
    if (!lastNote[id]) return { txt: 'sin actividad', dot: 'gray' };
    const days = Math.floor((Date.now() - new Date(lastNote[id])) / 86400000);
    return { txt: days === 0 ? 'hoy' : days === 1 ? 'ayer' : `hace ${days}d`, dot: days < 3 ? 'green' : days <= 7 ? 'yellow' : 'red' };
  };

  // Global summary strip (whole funnel)
  const totPipe = deals.reduce((s, d) => s + (Number(d.deal_size) || 0), 0);
  const totSig = deals.reduce((s, d) => s + (Number(d.deposit_signal_amount) || 0), 0);
  const totReal = Object.values(realBy).reduce((s, v) => s + v, 0);
  const activos = deals.filter((d) => dealCategory(d) !== 'lost').length;
  $('deals-kpis').innerHTML = [
    ['Pipeline Potential', money(totPipe), 'style="color:var(--blue)"'],
    ['En señales', money(totSig), 'style="color:#facc15"'],
    ['Real depositado (FXBO)', money(totReal), 'class="kpi-val pos"'],
    ['Negocios activos', activos, ''],
  ].map(([lbl, val, attr]) => `<div class="kpi"><div class="kpi-val" ${attr}>${val}</div><div class="kpi-lbl">${lbl}</div></div>`).join('');

  // Sub-tab counts
  const counts = { process: 0, funded: 0, lost: 0 };
  deals.forEach((d) => counts[dealCategory(d)]++);
  $('dsub-process').textContent = `En proceso (${counts.process})`;
  $('dsub-funded').textContent = `Activos (${counts.funded})`;
  $('dsub-lost').textContent = `Perdidos (${counts.lost})`;

  // Filter current sub-tab + its priority sorting
  const subset = deals.filter((d) => dealCategory(d) === dealsSub);
  const sig = (d) => Number(d.deposit_signal_amount) || 0;
  const realOf = (d) => (d.client_login && realBy[d.client_login]) || 0;
  if (dealsSub === 'process') {
    // Closest to FTD first: active signal > stage rank > size
    subset.sort((a, b) => ((sig(b) > 0) - (sig(a) > 0))
      || (STAGE_RANK[a.status] ?? 99) - (STAGE_RANK[b.status] ?? 99)
      || (Number(b.deal_size) || 0) - (Number(a.deal_size) || 0));
    $('deals-hint').textContent = 'Prioridad: señal de depósito activa y cercanía al FTD.';
  } else if (dealsSub === 'funded') {
    // Active deposit signals first (re-deposits about to land)
    subset.sort((a, b) => ((sig(b) > 0) - (sig(a) > 0)) || sig(b) - sig(a) || realOf(b) - realOf(a));
    $('deals-hint').textContent = 'Prioridad: señales de depósito activas (re-depósitos por caer).';
  } else {
    subset.sort((a, b) => (Number(b.deal_size) || 0) - (Number(a.deal_size) || 0));
    $('deals-hint').textContent = 'Negocios perdidos o inactivos — fuera del funnel activo.';
  }

  if (!subset.length) { $('deals-table').innerHTML = '<div class="state">Nada en esta categoría.</div>'; return; }

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
    </tr><tr class="notes-tr hidden" data-notes-for="${d.id}"><td colspan="8" style="background:#10151c"></td></tr>`;
  };
  const THEAD = `<thead><tr>
    <th>Negocio</th><th>BDM</th><th>Status</th><th class="num">Potencial</th><th class="num">Señal</th><th class="num">Real (FXBO)</th><th>Último avance</th><th>Próximo paso</th>
    </tr></thead>`;

  if (dealsMode === 'agent') {
    // Group by team member (subtotals per agent), ordered by pipeline value
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
      .map((g) => `<div style="margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:12px;padding:10px 2px;flex-wrap:wrap">
          <strong style="font-size:14px">${g.agent}</strong>
          <span class="badge">${g.list.length} negocio${g.list.length === 1 ? '' : 's'}</span>
          <span style="font-size:12px;color:var(--blue)">Potencial ${money(g.pot)}</span>
          <span style="font-size:12px;color:#facc15">Señales ${money(g.sigT)}</span>
          <span style="font-size:12px;color:var(--green)">Real ${money(g.real)}</span>
        </div>
        <table>${THEAD}<tbody>${g.list.map(dealRow).join('')}</tbody></table>
      </div>`).join('');
  } else {
    $('deals-table').innerHTML = `<table>${THEAD}<tbody>${subset.map(dealRow).join('')}</tbody></table>`;
  }
  document.querySelectorAll('#deals-table .deal-row').forEach((tr) =>
    tr.addEventListener('click', () => toggleTeamNotes(tr.dataset.id, '#deals-table')));
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
  $('day-label').textContent = teamOffset === 0 ? 'Hoy' : teamOffset === -1 ? 'Ayer' : day;
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
      <span style="color:#fb923c;font-weight:700;margin-left:8px">⚠️ Sin reporte</span></div>`;
    const hora = new Date(r.submitted_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    return `<div style="border:1px solid var(--line);border-radius:10px;background:var(--card);padding:12px 14px;margin:8px 0">
      <strong>${a.full_name}</strong> <span class="badge">${a.role.toUpperCase()}</span>
      <span style="color:var(--green);font-weight:700;margin-left:8px">✓ ${hora}</span>
      <div style="white-space:pre-wrap;margin-top:8px;font-size:13px;color:var(--mut);line-height:1.6">${r.activity_summary || ''}${r.commitments ? '\n— ' + r.commitments : ''}</div></div>`;
  }).join('') || '<div class="state">Sin agentes.</div>';

  // Team pipeline (RLS: admin and viewers see everything)
  const isAdmin = ['gm', 'admin'].includes(me.role);
  const { data: rows } = await db.from('pipeline_entries')
    .select('id, prospect_name, country, status, badge_color, deal_size, next_action, next_action_date, deposit_signal_amount, deposit_signal_date, deposit_signal_type, source, owner:profiles!pipeline_entries_owner_id_fkey(full_name)')
    .order('updated_at', { ascending: false });
  if (!rows || !rows.length) {
    $('funnel-summary').innerHTML = ''; $('team-pipeline').innerHTML = '<div class="state">Sin prospectos aún.</div>';
    $('team-feed').innerHTML = '<div class="state">Sin actividad.</div>'; return;
  }
  rows.forEach((r) => { rowsById[r.id] = r; });

  // Funnel summary: counts by status
  const counts = {};
  rows.forEach((r) => { const k = r.status || '—'; (counts[k] ||= { n: 0, color: r.badge_color || 'gray' }).n++; });
  $('funnel-summary').innerHTML = Object.entries(counts)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([s, c]) => `<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;text-align:center">
      <div style="font-size:20px;font-weight:800">${c.n}</div>
      <span class="pill b-${c.color}">${s}</span></div>`).join('');

  // Pipeline table with expandable evolution (old-dashboard style)
  $('team-pipeline').innerHTML = `<table><thead><tr>
    <th></th><th>Prospecto</th><th>Agente</th><th>Status</th><th class="num">Deal size</th><th>Próximo paso</th><th>Fecha</th>${isAdmin ? '<th></th>' : ''}
    </tr></thead><tbody>${rows.map((r) => `<tr data-id="${r.id}" class="team-row">
      <td style="color:var(--mut)">›</td>
      <td>${r.prospect_name}</td><td>${r.owner?.full_name || '—'}</td>
      <td><span class="pill b-${r.badge_color || 'gray'}">${r.status || '—'}</span></td>
      <td class="num">${r.deal_size ? money(r.deal_size) : '—'}</td>
      <td>${r.next_action || '—'}</td><td>${r.next_action_date || '—'}</td>
      ${isAdmin ? `<td><a href="#" class="team-edit" data-id="${r.id}" style="color:var(--blue);font-size:12px">editar</a></td>` : ''}
    </tr><tr class="notes-tr hidden" data-notes-for="${r.id}"><td></td><td colspan="${isAdmin ? 7 : 6}" style="background:#10151c"></td></tr>`).join('')}</tbody></table>`;

  document.querySelectorAll('#team-pipeline .team-row').forEach((tr) =>
    tr.addEventListener('click', () => toggleTeamNotes(tr.dataset.id)));
  document.querySelectorAll('#team-pipeline .team-edit').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openEdit(a.dataset.id); }));

  // Activity feed: latest notes across all prospects
  const { data: feed } = await db.from('notes')
    .select('note_date, text_original, entity_id, author:profiles!notes_author_id_fkey(full_name)')
    .eq('entity_type', 'pipeline')
    .order('created_at', { ascending: false }).limit(25);
  $('team-feed').innerHTML = (feed || []).map((n) =>
    `<div style="padding:9px 2px;border-bottom:1px solid var(--line);font-size:13px;line-height:1.5">
      <strong style="color:var(--blue)">${n.note_date}</strong>
      <span class="badge" style="margin:0 4px">${rowsById[n.entity_id]?.prospect_name || '—'}</span>
      ${n.text_original} <span style="color:var(--mut);font-size:11px">· ${n.author?.full_name || ''}</span>
    </div>`).join('') || '<div class="state">Sin actividad aún.</div>';
}

// Expand/collapse a prospect's evolution under its row (scoped per table,
// since the same prospect can appear in Equipo and Negocios)
async function toggleTeamNotes(id, containerSel = '#team-pipeline') {
  const tr = document.querySelector(`${containerSel} tr[data-notes-for="${id}"]`);
  if (!tr) return;
  if (!tr.classList.contains('hidden')) { tr.classList.add('hidden'); return; }
  const cell = tr.querySelector('td[colspan]');
  cell.innerHTML = '<div class="state">Cargando evolución…</div>';
  tr.classList.remove('hidden');
  const { data: notes } = await db.from('notes')
    .select('note_date, text_original, author:profiles!notes_author_id_fkey(full_name)')
    .eq('entity_type', 'pipeline').eq('entity_id', id)
    .order('created_at', { ascending: false });
  cell.innerHTML = (notes || []).length
    ? notes.map((n) => `<div style="padding:7px 6px;font-size:13px;line-height:1.5;border-bottom:1px solid var(--line)">
        <strong style="color:var(--blue)">${n.note_date}</strong> — ${n.text_original}
        <span style="color:var(--mut);font-size:11px">· ${n.author?.full_name || ''}</span></div>`).join('')
    : '<div class="state">Sin notas aún.</div>';
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
  el.innerHTML = `<table><thead><tr>
    <th>Prospecto</th><th>País</th><th>Fuente</th><th>Status</th><th class="num">Deal size</th><th>Próximo paso</th><th>Fecha</th>
    </tr></thead><tbody>${rows.map((r) => `<tr data-id="${r.id}">
      <td>${r.prospect_name}</td><td>${r.country || '—'}</td><td>${r.source || '—'}</td>
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
    .select('note_date, text_original, created_at')
    .eq('entity_type', 'pipeline').eq('entity_id', id)
    .order('created_at', { ascending: false });
  if (error) { el.innerHTML = `<div class="state">Error: ${error.message}</div>`; return; }
  if (!notes.length) { el.innerHTML = '<div class="state">Sin notas aún. Agrega la primera.</div>'; return; }
  el.innerHTML = notes.map((n) =>
    `<div style="padding:9px 2px;border-bottom:1px solid var(--line);font-size:13px;line-height:1.5">
      <strong style="color:var(--blue)">${n.note_date}</strong> — ${n.text_original}
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
  const { error } = await db.from('daily_reports').upsert({
    agent_id: me.id, report_date: today,
    activity_summary: $('dr-summary').value.trim() || null,
    commitments: $('dr-commit').value.trim() || null,
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
    await db.from('notes').insert({
      entity_type: 'pipeline', entity_id: id, author_id: me.id,
      text_original: `💰 Señal de depósito: ${money(sigAmt)} — ${tipo}${sigDate ? ` — esperado para ${sigDate}` : ''}`,
    });
  }
  $('edit-modal').classList.add('hidden'); loadPipeline();
});

db.auth.getSession().then(({ data }) => { if (data.session) showPanel(); });
