const authIcons = { radio:'<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M16.5 4.5 14 7"/>', lock:'<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>' };
const authIcon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${authIcons[name]}</svg>`;
document.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = authIcon(element.dataset.icon); });
const content = document.querySelector('#auth-content');
let error = document.querySelector('#auth-error');
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
const api = async (url, options) => { const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options?.headers || {}) }, ...options }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a operação.'); return data; };

async function renderAuth() {
  const status = await api('/api/auth/status');
  if (status.authenticated) { window.location.replace('/'); return; }
  if (!status.configured) renderSetup();
}
function renderSetup() {
  content.innerHTML = `<p class="eyebrow">PRIMEIRO ACESSO</p><h1 id="auth-title">Crie o acesso da rádio</h1><p class="auth-description">Defina uma senha para proteger o painel contra acessos na rede local.</p><form id="setup-form" class="auth-form"><label>Senha do administrador<input id="password" type="password" minlength="8" autocomplete="new-password" required></label><label>Confirmar senha<input id="confirmation" type="password" minlength="8" autocomplete="new-password" required></label><button class="primary-btn" type="submit">Criar acesso</button><p id="auth-error" class="auth-error" role="alert"></p></form>`;
  error = document.querySelector('#auth-error');
  document.querySelector('#setup-form').onsubmit = async event => { event.preventDefault(); setBusy(event.currentTarget, true); try { await api('/api/auth/setup', { method:'POST', body:JSON.stringify({ password:document.querySelector('#password').value, confirmation:document.querySelector('#confirmation').value }) }); window.location.reload(); } catch (exception) { document.querySelector('#auth-error').textContent = exception.message; setBusy(event.currentTarget, false); } };
}
function setBusy(form, busy) { const button = form.querySelector('button'); button.disabled = busy; button.textContent = busy ? 'Salvando…' : (form.id === 'setup-form' ? 'Criar acesso' : 'Entrar'); }
document.querySelector('#login-form').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget; setBusy(form, true); try { await api('/api/auth/login', { method:'POST', body:JSON.stringify({ username:document.querySelector('#username').value, password:document.querySelector('#password').value }) }); window.location.replace('/'); } catch (exception) { document.querySelector('#auth-error').textContent = exception.message; setBusy(form, false); } };
renderAuth().catch(exception => { error.textContent = exception.message; });
