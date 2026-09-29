// ===================== PONTE COM O BANCO (Supabase) + FILA OFFLINE =====================
// Duas formas de falar com o servidor:
//  - rpc(nome, params): chamada direta, precisa de internet (cadastros, convites…);
//  - enfileirar(nome, params): ações do dia a dia (estoque, lista, finalizar compra).
//    O app já aplicou a mudança na tela; aqui ela entra numa fila guardada no
//    aparelho e é enviada assim que houver internet — no mercado sem sinal, nada
//    se perde. Cada ação leva um id único (p_op_id) e o banco ignora reenvios da
//    mesma ação, então repetir o envio nunca soma estoque ou compra em dobro.

const DespenseiApi = (function () {
  const cliente = supabase.createClient(DESPENSEI_CONFIG.SUPABASE_URL, DESPENSEI_CONFIG.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  let chaveFila = null; // fila separada por conta (e-mail)
  let fila = [];
  let processando = false;
  const ouvintes = { mudou: [], erroOperacao: [], filaVazia: [], sessaoInvalida: [] };

  function on(evento, fn) { ouvintes[evento].push(fn); }
  function emitir(evento, arg) { ouvintes[evento].forEach(function (fn) { try { fn(arg); } catch (e) { console.error(e); } }); }

  function ehErroDeRede(err) {
    const msg = String((err && (err.message || err.details)) || err || '');
    return /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|aborted/i.test(msg);
  }

  async function rpc(nome, params) {
    let resp;
    try {
      resp = await cliente.rpc(nome, params || {});
    } catch (err) {
      throw erroSemRede_();
    }
    if (resp.error) {
      if (ehErroDeRede(resp.error)) throw erroSemRede_();
      const msg = resp.error.message || 'Erro desconhecido no servidor.';
      const erro = new Error(msg);
      erro.eSessaoInvalida = resp.status === 401 || /jwt|não autenticado|nao autenticado|token/i.test(msg);
      throw erro;
    }
    return resp.data;
  }

  function erroSemRede_() {
    const e = new Error('Sem conexão com a internet. Tente de novo quando o sinal voltar.');
    e.semRede = true;
    return e;
  }

  function novoId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ----- fila -----

  function usarConta(email) {
    chaveFila = email ? 'despensei_fila_v3:' + email : null;
    try { fila = chaveFila ? JSON.parse(localStorage.getItem(chaveFila) || '[]') : []; } catch (e) { fila = []; }
    emitir('mudou');
  }

  function salvarFila_() {
    if (!chaveFila) return;
    try { localStorage.setItem(chaveFila, JSON.stringify(fila)); } catch (e) { console.error('Falha ao salvar fila', e); }
  }

  function enfileirar(nome, params, descricao) {
    const id = novoId();
    fila.push({ id: id, nome: nome, params: Object.assign({}, params, { p_op_id: id }), descricao: descricao || nome, criadoEm: Date.now() });
    salvarFila_();
    emitir('mudou');
    processarFila();
  }

  async function processarFila() {
    if (processando || !fila.length) return;
    processando = true;
    emitir('mudou');
    try {
      while (fila.length) {
        const op = fila[0];
        try {
          await rpc(op.nome, op.params);
          fila.shift();
          salvarFila_();
          emitir('mudou');
        } catch (err) {
          if (err.semRede) break;             // sem internet: tenta de novo mais tarde
          if (err.eSessaoInvalida) { emitir('sessaoInvalida'); break; } // guarda a fila até logar de novo
          // Erro de regra (ex.: produto apagado por outra pessoa): essa ação não
          // tem como ser aplicada — sai da fila e o app avisa e recarrega do servidor.
          fila.shift();
          salvarFila_();
          emitir('erroOperacao', { op: op, erro: err });
        }
      }
    } finally {
      processando = false;
      emitir('mudou');
      if (!fila.length) emitir('filaVazia');
    }
  }

  // Envia tudo o que está na fila e só resolve quando ela esvaziar (usado antes
  // de ações que precisam de internet, pra manter a ordem das mudanças).
  async function esvaziarFila() {
    await processarFila();
    if (fila.length) throw erroSemRede_();
  }

  function pendentes() { return fila.length; }
  function enviando() { return processando; }

  window.addEventListener('online', processarFila);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) processarFila(); });
  setInterval(function () { if (fila.length) processarFila(); }, 20000);

  // Pede pra ponte do Apps Script mandar agora os e-mails pendentes (teste
  // grátis, convite). Se não der, ela manda sozinha na próxima rodada (gatilho).
  function acordarPonteDeEmails() {
    try {
      fetch(DESPENSEI_CONFIG.PONTE_URL, {
        method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ acao: 'processarFilaEmails' })
      }).catch(function () { /* o gatilho periódico cobre */ });
    } catch (e) { /* idem */ }
  }

  return { cliente, rpc, enfileirar, processarFila, esvaziarFila, pendentes, enviando, usarConta, on, acordarPonteDeEmails };
})();

window.DespenseiApi = DespenseiApi;
