// Agent panel: email/password login + show identity. Pipeline CRUD comes next.
const cfg = window.JTM_CONFIG || {};
const db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
const loginView = $('login'), panelView = $('panel'), msg = $('login-msg');

async function showPanel() {
  const { data: { user } } = await db.auth.getUser();
  if (!user) return showLogin();
  // Fetch the logged-in user's profile (name + role)
  const { data: profile } = await db.from('profiles')
    .select('full_name, role').eq('user_id', user.id).single();
  $('who-name').textContent = profile ? profile.full_name : user.email;
  $('who-role').textContent = profile ? profile.role.toUpperCase() : '—';
  loginView.classList.add('hidden');
  panelView.classList.remove('hidden');
}
function showLogin() {
  panelView.classList.add('hidden');
  loginView.classList.remove('hidden');
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Entrando…';
  const { error } = await db.auth.signInWithPassword({
    email: $('email').value.trim(), password: $('password').value,
  });
  btn.disabled = false;
  if (error) { msg.className = 'msg err'; msg.textContent = 'Email o contraseña incorrectos.'; return; }
  msg.textContent = '';
  showPanel();
});

$('logout').addEventListener('click', async () => { await db.auth.signOut(); showLogin(); });

// On load: if already logged in, go straight to the panel.
db.auth.getSession().then(({ data }) => { if (data.session) showPanel(); });
