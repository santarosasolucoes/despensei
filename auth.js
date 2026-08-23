// ===================== LOGIN COM GOOGLE (Google Identity Services) =====================
// TODO(Daiane): depois de criar o OAuth Client ID no Google Cloud Console, cole o Client ID aqui.
const GOOGLE_CLIENT_ID = '429667579829-p5shhj2gh4tpj07qbgk0pqd8ha3gl9v0.apps.googleusercontent.com';

const DespenseiAuth = (function () {
  let idToken = sessionStorage.getItem('despensei_id_token') || null;
  let email = sessionStorage.getItem('despensei_email') || null;
  let nome = sessionStorage.getItem('despensei_nome') || null;
  let onLoginCallback = null;

  function init(onLogin) {
    onLoginCallback = onLogin;

    if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.indexOf('COLE_AQUI') === 0) {
      console.error('GOOGLE_CLIENT_ID não configurado em web/auth.js.');
      mostrarErroConfiguracao_();
      return;
    }
    if (!window.google || !google.accounts || !google.accounts.id) {
      console.error('Google Identity Services não carregou (sem internet?).');
      return;
    }

    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleCredentialResponse_,
      auto_select: true
    });

    const botao = document.getElementById('google-signin-button');
    if (botao) {
      google.accounts.id.renderButton(botao, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 280 });
    }

    if (idToken) {
      onLoginCallback && onLoginCallback();
    } else {
      google.accounts.id.prompt();
    }
  }

  function handleCredentialResponse_(response) {
    idToken = response.credential;
    sessionStorage.setItem('despensei_id_token', idToken);
    const payload = decodeJwtPayload_(idToken);
    email = (payload && payload.email) || null;
    if (email) sessionStorage.setItem('despensei_email', email);
    nome = (payload && payload.name) || null;
    if (nome) sessionStorage.setItem('despensei_nome', nome);
    onLoginCallback && onLoginCallback();
  }

  function decodeJwtPayload_(token) {
    try {
      const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(base64))));
    } catch (e) {
      return null;
    }
  }

  function mostrarErroConfiguracao_() {
    const el = document.getElementById('login-erro-config');
    if (el) el.classList.remove('hidden');
  }

  function pedirNovoLogin() {
    idToken = null;
    sessionStorage.removeItem('despensei_id_token');
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.prompt();
  }

  function logout() {
    idToken = null;
    email = null;
    nome = null;
    sessionStorage.removeItem('despensei_id_token');
    sessionStorage.removeItem('despensei_email');
    sessionStorage.removeItem('despensei_nome');
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    location.reload();
  }

  function getIdToken() { return idToken; }
  function getEmail() { return email; }
  function getNome() { return nome; }

  return { init, logout, pedirNovoLogin, getIdToken, getEmail, getNome };
})();

window.DespenseiAuth = DespenseiAuth;
