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
  if (canViewAll) $('admin-tabs').classList.remove('hidden');
  if (me && me.role === 'viewer') {
    // Viewers (Nishil/management) are read-only: team view only, no own pipeline
    $('tab-mine').classList.add('hidden');
    $('tab-team').click();
    return;
  }
  await loadPipeline();          // fills rowsById (prospect names for the summary)
  loadDailyReport();
}

// ---- Admin: team view ----
$('tab-mine').addEventListener('click', () => {
  $('tab-mine').classList.add('active'); $('tab-team').classList.remove('active');
  $('view-mine').classList.remove('hidden'); $('view-team').classList.add('hidden');
});
$('tab-team').addEventListener('click', () => {
  $('tab-team').classList.add('active'); $('tab-mine').classList.remove('active');
  $('view-team').classList.remove('hidden'); $('view-mine').classList.add('hidden');
  loadTeam();
});

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

// Expand/collapse a prospect's evolution under its row
async function toggleTeamNotes(id) {
  const tr = document.querySelector(`tr[data-notes-for="${id}"]`);
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
