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
  loadPipeline();
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
  $('edit-modal').classList.remove('hidden');
  $('edit-modal').dataset.id = id;
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

$('edit-close').addEventListener('click', () => $('edit-modal').classList.add('hidden'));
$('edit-modal').addEventListener('click', (e) => { if (e.target.id === 'edit-modal') $('edit-modal').classList.add('hidden'); });
$('edit-save').addEventListener('click', async () => {
  const id = $('edit-modal').dataset.id, status = $('e-status').value;
  const msg = $('edit-msg'), btn = $('edit-save');
  btn.disabled = true; msg.textContent = '';
  const { error } = await db.from('pipeline_entries').update({
    status, badge_color: STATUSES[status] || 'gray',
    deal_size: $('e-deal').value ? Number($('e-deal').value) : null,
    next_action: $('e-next').value.trim() || null,
    next_action_date: $('e-date').value || null,
    deposit_signal_amount: $('e-sig-amt').value ? Number($('e-sig-amt').value) : null,
    deposit_signal_date: $('e-sig-date').value || null,
    deposit_signal_type: $('e-sig-type').value || null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  btn.disabled = false;
  if (error) { msg.textContent = error.message; return; }
  $('edit-modal').classList.add('hidden'); loadPipeline();
});

db.auth.getSession().then(({ data }) => { if (data.session) showPanel(); });
