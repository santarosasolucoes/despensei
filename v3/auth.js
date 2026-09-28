// ===================== LOGIN COM GOOGLE → SESSÃO DO SUPABASE =====================
// O botão continua sendo o "Continuar com o Google" (Google Identity Services).
// O token que o Google devolve é trocado por uma sessão do Supabase
// (signInWithIdToken), que o próprio supabase-js guarda no aparelho e renova
// sozinho — o usuário não precisa logar de novo a cada hora, como antes.
// Sem internet, o app entra com a última sessão salva e os dados guardados.

const DespenseiAuth = (function () {
  const CHAVE_SESSAO = 'sb-' + new URL(DESPENSEI_CONFIG.SUPABASE_URL).hostname.split('.')[0] + '-auth-token';
  let email = null;
  let nome = null;
  let onLoginCallback = null;
  let googleIniciado = false;

  // Limpa o login da versão anterior do app (token do Google guardado direto).
  ['despensei_id_token', 'despensei_email', 'despensei_nome'].forEach(function (k) {
    try { localStorage.removeItem(k); } catch (e) { /* ignora */ }
  });

  // Lê a sessão salva sem precisar de internet.
  function sessaoSalva_() {
    try {
      const bruto = JSON.parse(localStorage.getItem(CHAVE_SESSAO) || 'null');
      const s = bruto && (bruto.currentSession || bruto);
      return s && s.user ? s : null;
    } catch (e) {
      return null;
    }
  }

  function guardarUsuario_(user) {
    email = user && user.email ? String(user.email).toLowerCase() : null;
    const meta = (user && user.user_metadata) || {};
    nome = meta.full_name || meta.name || null;
  }

  function init(onLogin) {
    onLoginCallback = onLogin;
    const s = sessaoSalva_();
    if (s) {
      guardarUsuario_(s.user);
      onLoginCallback && onLoginCallback();
      return;
    }
    iniciarGoogle_(true);
  }

  function iniciarGoogle_(pedirLoginAutomatico) {
    if (!window.google || !google.accounts || !google.accounts.id) {
      const el = document.getElementById('login-erro-config');
      if (el) {
        el.textContent = navigator.onLine
          ? 'Não foi possível carregar o login do Google. Recarregue a página.'
          : 'Sem internet. Conecte-se para entrar pela primeira vez.';
        el.classList.remove('hidden');
      }
      return;
    }
    if (!googleIniciado) {
      google.accounts.id.initialize({
        client_id: DESPENSEI_CONFIG.GOOGLE_CLIENT_ID,
        callback: aoReceberCredencialGoogle_,
        auto_select: true
      });
      const botao = document.getElementById('google-signin-button');
      if (botao) {
        google.accounts.id.renderButton(botao, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 280 });
      }
      googleIniciado = true;
    }
    if (pedirLoginAutomatico) google.accounts.id.prompt();
  }

  async function aoReceberCredencialGoogle_(response) {
    const loader = document.getElementById('loader-overlay');
    if (loader) loader.classList.remove('hidden');
    try {
      const { data, error } = await DespenseiApi.cliente.auth.signInWithIdToken({ provider: 'google', token: response.credential });
      if (error) throw error;
      guardarUsuario_(data.user);
      onLoginCallback && onLoginCallback();
    } catch (err) {
      const el = document.getElementById('login-erro-config');
      if (el) {
        el.textContent = 'Não foi possível entrar: ' + (err.message || err);
        el.classList.remove('hidden');
      }
    } finally {
      if (loader) loader.classList.add('hidden');
    }
  }

  // Sessão recusada pelo servidor (revogada/expirada de vez): volta pra tela de
  // login. A fila de alterações pendentes fica guardada e é enviada depois que
  // a mesma conta entrar de novo.
  async function pedirNovoLogin() {
    try { await DespenseiApi.cliente.auth.signOut({ scope: 'local' }); } catch (e) { /* ignora */ }
    document.querySelectorAll('#view-familia, #view-bloqueado, #view-app').forEach(function (v) { v.classList.add('hidden'); });
    document.getElementById('view-login').classList.remove('hidden');
    iniciarGoogle_(true);
  }

  async function logout() {
    try { await DespenseiApi.cliente.auth.signOut({ scope: 'local' }); } catch (e) { /* ignora */ }
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf('despensei_cache_v3') === 0 || k.indexOf('despensei_carrinho_v3') === 0) localStorage.removeItem(k);
      });
    } catch (e) { /* ignora */ }
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    location.reload();
  }

  function getEmail() { return email; }
  function getNome() { return nome; }

  return { init, logout, pedirNovoLogin, getEmail, getNome };
})();

window.DespenseiAuth = DespenseiAuth;
