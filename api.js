// ===================== PONTE COM A API (Apps Script) =====================
// TODO(Daiane): depois de implantar o Apps Script como Web App, cole aqui a URL
// terminada em /exec (Implantar → Gerenciar implantações → copiar URL do app da Web).
const API_BASE_URL = 'https://script.google.com/macros/s/AKfycbyymP9fz14iAYSh9kVoXbr39myA8keM_pMv3ud3m9mxWwGRvdDMxkekkzHUVUNx4bCtLw/exec';

// Envia POST com Content-Type "text/plain" de propósito: isso faz o navegador tratar
// a requisição como "simples" (sem preflight OPTIONS), que o Apps Script não sabe
// responder. O corpo continua sendo JSON de verdade — o backend faz JSON.parse nele.
async function chamarApi(action, payload) {
  if (!API_BASE_URL || API_BASE_URL.indexOf('COLE_AQUI') === 0) {
    throw new Error('API_BASE_URL não configurada em web/api.js.');
  }

  const idToken = window.DespenseiAuth ? window.DespenseiAuth.getIdToken() : null;
  const body = Object.assign({ action: action, idToken: idToken }, payload || {});

  let resp;
  try {
    resp = await fetch(API_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new Error('Não foi possível falar com o servidor. Verifique sua conexão.');
  }

  if (!resp.ok) throw new Error('Erro de rede (' + resp.status + ')');

  let json;
  try {
    json = await resp.json();
  } catch (err) {
    throw new Error('Resposta inválida do servidor.');
  }

  if (!json.ok) {
    const erro = new Error(json.error || 'Erro desconhecido no servidor.');
    erro.eSessaoInvalida = /token inválido|expirado|não autenticado/i.test(json.error || '');
    throw erro;
  }
  return json.data;
}
