// ===================== DESPENSEI — LÓGICA DA INTERFACE =====================
// Versão 3 (Supabase, offline primeiro). O app guarda no aparelho os produtos
// da família e monta sozinho a Despensa, a Lista de Compras e o Catálogo a
// partir deles. Toda mudança do dia a dia (estoque, lista, finalizar compra)
// aparece na hora e vai pra fila de envio (web/api.js), funcionando mesmo sem
// internet.
//
// Regras (v3.1):
//  - Catálogo = todos os produtos cadastrados (o que PODE ser comprado).
//  - Despensa = só o que existe em casa (estoque > 0).
//  - Lista    = só o que alguém pediu (📋 na Despensa/Catálogo, busca da Lista
//               ou item avulso). Estoque zerado NÃO entra sozinho.
//  - Carrinho = cada lançamento é uma linha própria (nunca soma lançamentos).

const DespenseiApp = (function () {
  const APP = {
    email: null,
    produtos: [],          // produtos crus da família (fonte de tudo)
    categorias: [],
    estabelecimentos: [],
    ultimaQtd: {},         // idProduto -> quantidade na compra mais recente
    familia: null,
    // derivados (recalcular())
    despensa: [],
    listaCompras: [],
    catalogo: {},
    produtosCompraveis: [],
    carrinho: [] // { idLinha, idProduto, nome, quantidade, precoUnitario, marca }
  };

  let codigoBarrasPendente = null;   // código lido que ainda não pertence a nenhum produto
  let idSelecionadoCarrinho = null;  // produto escolhido no formulário do carrinho
  let idProdutoEmEdicao = null;
  let categoriaParaExcluir = null;
  let aoCriarProduto = null;         // o que fazer depois de cadastrar pelo modal "Novo produto"
  let toastTimer = null;
  let geracaoLocal = 0; // muda a cada alteração local (evita sobrescrever com dado velho do servidor)
  let appVisivel = false;

  const ICONE_CATEGORIA = {
    'Cereais/Grãos': '🌾', 'Açougue': '🥩', 'Laticínios': '🧀', 'Bebidas': '🥤',
    'Higiene': '🧴', 'Limpeza': '🧽', 'Hortifruti': '🥬', 'Enlatados/Conservas': '🥫', 'Padaria': '🍞',
    'Descartáveis': '🧻', 'Pet': '🐾', 'Farmácia': '💊', 'Avulso': '📌'
  };

  function icone(cat) { return ICONE_CATEGORIA[cat] || '📦'; }

  function formatMoeda(v) { return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ','); }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML.replace(/"/g, '&quot;');
  }

  // Busca sem diferenciar maiúscula/acento: "agua" acha "Água Mineral".
  function normalizar(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }

  function termosBusca(texto) { return normalizar(texto).split(/\s+/).filter(Boolean); }

  // Todas as palavras digitadas precisam aparecer (em qualquer ordem) no nome
  // ou no código de barras: "lasanha queijo" acha "Lasanha Pif Paf 4 Queijos".
  function casaBusca(p, termos) {
    if (!termos.length) return true;
    const alvo = normalizar(p.nome) + ' ' + String(p.codigoBarras || '');
    return termos.every(function (t) { return alvo.includes(t); });
  }

  function compararTexto(a, b) { return String(a || '').localeCompare(String(b || ''), 'pt-BR'); }

  // Categorias em ordem alfabética, com "Avulso"/"Outros" no fim.
  function ordemCategorias(lista) {
    const fim = { 'Avulso': 2, 'Outros': 1 };
    return lista.slice().sort(function (a, b) { return ((fim[a] || 0) - (fim[b] || 0)) || compararTexto(a, b); });
  }

  function agruparPorCategoria(lista) {
    const grupos = {};
    lista.forEach(function (item) {
      const cat = item.categoria || 'Outros';
      if (!grupos[cat]) grupos[cat] = [];
      grupos[cat].push(item);
    });
    return grupos;
  }

  function showLoader() { document.getElementById('loader-overlay').classList.remove('hidden'); }
  function hideLoader() { document.getElementById('loader-overlay').classList.add('hidden'); }

  function showToast(msg, tipo) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast fixed bottom-24 left-1/2 z-[70] px-4 py-2.5 rounded-xl shadow-lg text-sm font-bold text-white max-w-[85%] text-center ' +
      (tipo === 'erro' ? 'bg-terracotta-600' : 'bg-sage-700');
    el.style.transform = 'translateX(-50%)';
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, tipo === 'erro' ? 4000 : 2600);
  }

  // ===================== JANELA DE DIÁLOGO DO APP =====================
  // Substitui confirm()/prompt() do navegador (que mostram "site… diz").
  // Uso: await dialogo({ titulo, mensagem, icone, tipo: 'confirmar' | 'quantidade' | 'texto',
  //        valor, okTexto, cancelarTexto, perigo }) → null se cancelar;
  //        true (confirmar), número (quantidade) ou texto (texto) se confirmar.
  let dialogoAtual = null;

  function dialogo(op) {
    return new Promise(function (resolve) {
      if (dialogoAtual) dialogoAtual.resolve(null);
      const tipo = op.tipo || 'confirmar';
      dialogoAtual = { resolve: resolve, tipo: tipo };

      document.getElementById('dialogo-icone').textContent = op.icone || (op.perigo ? '🗑️' : '💬');
      document.getElementById('dialogo-icone').className = 'shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center text-2xl ' +
        (op.perigo ? 'bg-terracotta-50' : 'bg-sage-100');
      document.getElementById('dialogo-titulo').textContent = op.titulo || '';
      const msg = document.getElementById('dialogo-mensagem');
      msg.textContent = op.mensagem || '';
      msg.classList.toggle('hidden', !op.mensagem);

      const caixaQtd = document.getElementById('dialogo-qtd');
      const inputQtd = document.getElementById('dialogo-qtd-input');
      const inputTexto = document.getElementById('dialogo-texto');
      caixaQtd.classList.toggle('hidden', tipo !== 'quantidade');
      inputTexto.classList.toggle('hidden', tipo !== 'texto');
      inputQtd.value = tipo === 'quantidade' ? (op.valor || 1) : '';
      inputTexto.value = tipo === 'texto' ? (op.valor || '') : '';
      inputTexto.placeholder = op.placeholder || '';
      [inputQtd, inputTexto].forEach(function (i) { i.classList.remove('dialogo-erro'); });

      const ok = document.getElementById('dialogo-ok');
      ok.textContent = op.okTexto || (tipo === 'confirmar' ? 'Confirmar' : 'Salvar');
      ok.className = 'flex-1 font-extrabold rounded-2xl py-3 text-sm text-white active:scale-[0.98] transition ' +
        (op.perigo ? 'bg-terracotta-500 active:bg-terracotta-600' : 'bg-sage-600 active:bg-sage-700');
      document.getElementById('dialogo-cancelar').textContent = op.cancelarTexto || 'Cancelar';

      const modal = document.getElementById('modal-dialogo');
      modal.classList.remove('hidden');
      setTimeout(function () {
        if (tipo === 'quantidade') { inputQtd.focus(); inputQtd.select(); }
        else if (tipo === 'texto') { inputTexto.focus(); inputTexto.select(); }
        else ok.focus();
      }, 60);
    });
  }

  function fecharDialogo(confirmou) {
    const atual = dialogoAtual;
    if (!atual) return;
    let resultado = null;
    if (confirmou) {
      if (atual.tipo === 'quantidade') {
        const input = document.getElementById('dialogo-qtd-input');
        resultado = parseInt(input.value, 10);
        if (isNaN(resultado) || resultado <= 0) { marcarErroDialogo(input); return; }
      } else if (atual.tipo === 'texto') {
        const input = document.getElementById('dialogo-texto');
        resultado = input.value.trim();
        if (!resultado) { marcarErroDialogo(input); return; }
      } else {
        resultado = true;
      }
    }
    dialogoAtual = null;
    document.getElementById('modal-dialogo').classList.add('hidden');
    atual.resolve(resultado);
  }

  function marcarErroDialogo(input) {
    input.classList.remove('dialogo-erro');
    void input.offsetWidth; // reinicia a animação
    input.classList.add('dialogo-erro');
    input.focus();
  }

  function ajustarQtdDialogo(delta) {
    const input = document.getElementById('dialogo-qtd-input');
    input.value = Math.max(1, (parseInt(input.value, 10) || 0) + delta);
    input.classList.remove('dialogo-erro');
  }

  document.addEventListener('keydown', function (e) {
    if (!dialogoAtual) return;
    const dentro = document.getElementById('modal-dialogo').contains(e.target);
    if (e.key === 'Escape') fecharDialogo(false);
    else if (e.key === 'Enter' && dentro && e.target.id !== 'dialogo-cancelar') { e.preventDefault(); fecharDialogo(true); }
  });

  function mostrarView(nome) {
    ['login', 'familia', 'bloqueado', 'app'].forEach(function (v) {
      document.getElementById('view-' + v).classList.toggle('hidden', v !== nome);
    });
    appVisivel = nome === 'app';
  }

  // ===================== REGRAS =====================

  function ordenarPorCategoriaENome(a, b) {
    return compararTexto(a.categoria, b.categoria) || compararTexto(a.nome, b.nome);
  }

  function referenciaPreco(p) {
    if (!p.ultimoPreco) return null;
    let texto = formatMoeda(p.ultimoPreco);
    if (p.ultimaMarca) texto += ' (' + p.ultimaMarca + ')';
    if (p.localUltimaCompra) texto += ' no ' + p.localUltimaCompra;
    return { texto: texto, preco: Number(p.ultimoPreco), marca: p.ultimaMarca || '', local: p.localUltimaCompra || '' };
  }

  function qtdUltimaCompra(p) { return Number(APP.ultimaQtd[String(p.id)]) || null; }

  function resumoProduto(p) {
    return {
      id: p.id, nome: p.nome, categoria: p.categoria || 'Outros',
      estoqueAtual: Number(p.estoqueAtual) || 0,
      avulso: !!p.avulso,
      emListaManual: !!p.emListaManual,
      qtdDesejada: p.qtdDesejada ? Number(p.qtdDesejada) : null,
      referenciaPreco: referenciaPreco(p),
      codigoBarras: p.codigoBarras || '',
      qtdUltimaCompra: qtdUltimaCompra(p)
    };
  }

  function recalcular() {
    const todos = APP.produtos.map(resumoProduto);

    // Despensa: só o que existe em casa. Estoque zerado = não está na despensa.
    APP.despensa = todos.filter(function (p) { return !p.avulso && p.estoqueAtual > 0; }).sort(ordenarPorCategoriaENome);

    // Lista: só o que alguém pediu. Nada entra sozinho.
    APP.listaCompras = todos.filter(function (p) { return p.emListaManual; }).sort(ordenarPorCategoriaENome);

    // Catálogo: todos os produtos cadastrados (menos avulsos), por categoria.
    APP.categorias.sort(compararTexto);
    const agrupado = {};
    APP.categorias.forEach(function (c) { agrupado[c] = []; });
    todos.filter(function (p) { return !p.avulso; }).forEach(function (p) {
      if (!agrupado[p.categoria]) agrupado[p.categoria] = [];
      agrupado[p.categoria].push(p);
    });
    Object.keys(agrupado).forEach(function (cat) { agrupado[cat].sort(function (a, b) { return compararTexto(a.nome, b.nome); }); });
    APP.catalogo = agrupado;

    // Carrinho: qualquer produto do catálogo + os avulsos que estão na lista.
    APP.produtosCompraveis = todos.filter(function (p) { return !p.avulso || p.emListaManual; });
  }

  function produto(id) { return APP.produtos.find(function (p) { return String(p.id) === String(id); }); }

  function buscarProdutoCompravel(id) {
    if (id == null) return null;
    return APP.produtosCompraveis.find(function (p) { return String(p.id) === String(id); }) || null;
  }

  // ===================== CÓPIA NO APARELHO =====================

  function chaveCache() { return 'despensei_cache_v3:' + APP.email; }
  function chaveCarrinho() { return 'despensei_carrinho_v3:' + APP.email; }

  function salvarCache() {
    try {
      localStorage.setItem(chaveCache(), JSON.stringify({
        produtos: APP.produtos, categorias: APP.categorias, estabelecimentos: APP.estabelecimentos,
        ultimaQtd: APP.ultimaQtd, familia: APP.familia, salvoEm: Date.now()
      }));
    } catch (e) { console.error('Falha ao salvar cópia local', e); }
  }

  function lerCache() {
    try { return JSON.parse(localStorage.getItem(chaveCache()) || 'null'); } catch (e) { return null; }
  }

  function novoIdLinha() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function salvarCarrinho() {
    try { localStorage.setItem(chaveCarrinho(), JSON.stringify(APP.carrinho)); } catch (e) { /* ignora */ }
  }

  function lerCarrinho() {
    let itens;
    try { itens = JSON.parse(localStorage.getItem(chaveCarrinho()) || '[]'); } catch (e) { itens = []; }
    // Carrinhos de versões anteriores não tinham id por linha.
    return (Array.isArray(itens) ? itens : []).map(function (i) { return Object.assign({ idLinha: novoIdLinha() }, i); });
  }

  // Toda alteração local passa por aqui: recalcula, desenha e guarda.
  function mudouLocal(opcoes) {
    geracaoLocal++;
    recalcular();
    if (!opcoes || opcoes.render !== false) renderTudo();
    salvarCache();
  }

  // ===================== LOGIN / FAMÍLIA =====================

  // Preenche os códigos quando o app é aberto por um link de ativação
  // (?ativacao=CODIGO) ou de convite (?convite=CODIGO).
  function preencherCodigosDaUrl_() {
    const params = new URLSearchParams(location.search);
    const ativacao = params.get('ativacao');
    const convite = params.get('convite');
    if (ativacao) document.getElementById('familia-codigo-ativacao').value = ativacao.toUpperCase();
    if (convite) document.getElementById('familia-codigo').value = convite.toUpperCase();
  }

  function preencherDadosPessoais_() {
    const elEmail = document.getElementById('familia-email-login');
    if (elEmail) elEmail.textContent = DespenseiAuth.getEmail() || '';
    const elNome = document.getElementById('familia-nome-completo');
    if (elNome && !elNome.value) elNome.value = DespenseiAuth.getNome() || '';
  }

  async function aoLogar() {
    APP.email = DespenseiAuth.getEmail();
    DespenseiApi.usarConta(APP.email);
    APP.carrinho = lerCarrinho();

    // Abre na hora com a cópia do aparelho (inclusive sem internet) e atualiza
    // com o servidor em seguida.
    const cache = lerCache();
    if (cache && cache.familia) {
      aplicarEstado(cache);
      if (assinaturaVencidaLocal_()) {
        document.getElementById('bloqueado-familia-nome').textContent = APP.familia.nome || '';
        mostrarView('bloqueado');
      } else {
        mostrarView('app');
        renderTudo();
      }
      DespenseiApi.processarFila();
      sincronizarDoServidor();
      return;
    }

    showLoader();
    try {
      await DespenseiApi.esvaziarFila().catch(function () { /* segue mesmo assim */ });
      const dados = await DespenseiApi.rpc('bootstrap', {});
      aoReceberEstado(dados);
    } catch (err) {
      if (err.eSessaoInvalida) { DespenseiAuth.pedirNovoLogin(); return; }
      showToast('Erro ao entrar: ' + (err.message || err), 'erro');
    } finally {
      hideLoader();
    }
  }

  function assinaturaVencidaLocal_() {
    const ate = APP.familia && APP.familia.assinaturaValidaAte;
    if (!ate) return false;
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    return new Date(ate).getTime() < hoje.getTime();
  }

  // Busca o estado mais recente no servidor — só quando não há nada pendente
  // na fila (senão a tela voltaria a mostrar o que ainda não foi enviado).
  let sincronizando = false;
  async function sincronizarDoServidor() {
    if (sincronizando || DespenseiApi.pendentes() > 0 || !APP.email) return;
    sincronizando = true;
    const geracao = geracaoLocal;
    try {
      const dados = await DespenseiApi.rpc('bootstrap', {});
      if (geracao !== geracaoLocal || DespenseiApi.pendentes() > 0) return; // mexeram enquanto buscava
      aoReceberEstado(dados);
    } catch (err) {
      if (err.eSessaoInvalida) DespenseiAuth.pedirNovoLogin();
      // sem internet: segue com a cópia local
    } finally {
      sincronizando = false;
      atualizarStatusSync();
    }
  }

  function aplicarEstado(dados) {
    APP.produtos = dados.produtos || [];
    APP.categorias = (dados.categorias || []).slice();
    APP.estabelecimentos = dados.estabelecimentos || [];
    APP.ultimaQtd = dados.ultimaQtd || {};
    APP.familia = dados.familia || null;
    recalcular();
  }

  function aoReceberEstado(dados) {
    if (dados.estado === 'sem_familia') {
      try { localStorage.removeItem(chaveCache()); } catch (e) { /* ignora */ }
      mostrarView('familia');
      preencherCodigosDaUrl_();
      preencherDadosPessoais_();
      return;
    }
    if (dados.estado === 'assinatura_vencida') {
      document.getElementById('bloqueado-familia-nome').textContent = dados.nomeFamilia || '';
      mostrarView('bloqueado');
      return;
    }
    aplicarEstado(dados);
    salvarCache();
    mostrarView('app');
    renderTudo();
  }

  function lerDadosPessoais_() {
    const nomeCompleto = document.getElementById('familia-nome-completo').value.trim();
    const telefone = document.getElementById('familia-telefone-cadastro').value.trim();
    if (!nomeCompleto) { showToast('Digite seu nome completo.', 'erro'); return null; }
    return { nomeCompleto: nomeCompleto, telefone: telefone };
  }

  // Ações que precisam de internet: antes, envia o que estiver na fila (pra
  // manter a ordem das mudanças); sem sinal, avisa em vez de travar.
  async function chamarOnline(nome, params) {
    await DespenseiApi.esvaziarFila();
    return DespenseiApi.rpc(nome, params);
  }

  function tratarErro(err, prefixo) {
    if (err && err.eSessaoInvalida) { DespenseiAuth.pedirNovoLogin(); return; }
    showToast((prefixo || 'Erro: ') + ((err && err.message) || err), 'erro');
  }

  async function criarFamilia() {
    const nome = document.getElementById('familia-nome').value.trim();
    const codigoAtivacao = document.getElementById('familia-codigo-ativacao').value.trim();
    const dadosPessoais = lerDadosPessoais_();
    if (!dadosPessoais) return;
    showLoader();
    try {
      const dados = await DespenseiApi.rpc('criar_familia', {
        p_nome: nome, p_codigo_ativacao: codigoAtivacao,
        p_nome_completo: dadosPessoais.nomeCompleto, p_telefone: dadosPessoais.telefone
      });
      if (!codigoAtivacao) DespenseiApi.acordarPonteDeEmails();
      showToast(codigoAtivacao
        ? 'Família criada com sucesso!'
        : 'Família criada! Você tem 14 dias de teste grátis — o código de acesso foi enviado para o seu e-mail.');
      aoReceberEstado(dados);
    } catch (err) {
      tratarErro(err);
    } finally {
      hideLoader();
    }
  }

  async function entrarComCodigo() {
    const codigo = document.getElementById('familia-codigo').value.trim();
    if (!codigo) { showToast('Digite o código de convite.', 'erro'); return; }
    const dadosPessoais = lerDadosPessoais_();
    if (!dadosPessoais) return;
    showLoader();
    try {
      const dados = await DespenseiApi.rpc('entrar_familia_com_codigo', {
        p_codigo: codigo, p_nome_completo: dadosPessoais.nomeCompleto, p_telefone: dadosPessoais.telefone
      });
      aoReceberEstado(dados);
    } catch (err) {
      tratarErro(err);
    } finally {
      hideLoader();
    }
  }

  function renderInfoFamilia() {
    const info = APP.familia;
    if (!info) return;
    document.getElementById('header-familia-nome').textContent = info.nome;
    document.getElementById('familia-info-nome').textContent = info.nome;
    document.getElementById('familia-info-codigo').textContent = info.codigoConvite || '—';
    document.getElementById('familia-info-vagas').textContent = info.membros.length + '/' + info.limiteMembros;

    const meuEmail = APP.email;
    const meuMembro = info.membros.find(function (m) { return m.email === meuEmail; });
    const inputTel = document.getElementById('meu-telefone');
    if (meuMembro && meuMembro.telefone && document.activeElement !== inputTel) inputTel.value = meuMembro.telefone;

    document.getElementById('familia-info-membros').innerHTML = info.membros.map(function (m) {
      const podeRemover = info.souAdmin && m.email !== meuEmail;
      return `<p class="text-xs text-sand-600 flex items-center justify-between gap-2">
        <span>${m.papel === 'admin' ? '👑' : '•'} ${escapeHtml(m.email)}${m.telefone ? ' <span class="text-sage-600">📱</span>' : ''}</span>
        ${podeRemover ? `<button data-email="${escapeHtml(m.email)}" onclick="DespenseiApp.removerMembro(this.dataset.email)" class="text-terracotta-600 text-[11px] font-bold shrink-0">remover</button>` : ''}
      </p>`;
    }).join('');

    document.getElementById('familia-convite-admin').classList.toggle('hidden', !info.souAdmin);
    document.getElementById('familia-convites-pendentes').innerHTML = (info.convitesPendentes || []).map(function (email) {
      return `<p class="text-xs text-sand-400 flex items-center justify-between gap-2">
        <span>⏳ ${escapeHtml(email)} (convite pendente)</span>
        <button data-email="${escapeHtml(email)}" onclick="DespenseiApp.cancelarConvite(this.dataset.email)" class="text-terracotta-600 text-[11px] font-bold shrink-0">cancelar</button>
      </p>`;
    }).join('');

    const elEmailConfig = document.getElementById('config-email-logado');
    if (elEmailConfig) elEmailConfig.textContent = APP.email || '';

    atualizarBannerTesteGratis_();
  }

  // Faixa fixa acima do menu enquanto a família estiver no teste grátis.
  function atualizarBannerTesteGratis_() {
    const el = document.getElementById('banner-teste-gratis');
    const info = APP.familia;
    if (!el) return;
    if (!info || info.plano !== 'Teste' || !info.assinaturaValidaAte) { el.classList.add('hidden'); return; }
    const fim = new Date(info.assinaturaValidaAte); fim.setHours(0, 0, 0, 0);
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const dias = Math.round((fim.getTime() - hoje.getTime()) / 86400000);
    if (dias < 0) { el.classList.add('hidden'); return; }
    el.textContent = dias === 0
      ? '🎁 Hoje é o último dia do seu teste grátis. Adquira seu plano para continuar usando o Despensei.'
      : '🎁 ' + (dias === 1 ? 'Falta 1 dia' : 'Faltam ' + dias + ' dias') +
        ' para o término do seu teste grátis. Adquira seu plano para continuar usando o Despensei.';
    el.classList.remove('hidden');
  }

  async function acaoFamilia(nome, params, msgOk) {
    showLoader();
    try {
      APP.familia = await chamarOnline(nome, params);
      salvarCache();
      renderInfoFamilia();
      if (msgOk) showToast(msgOk);
      return true;
    } catch (err) {
      tratarErro(err);
      return false;
    } finally {
      hideLoader();
    }
  }

  async function removerMembro(email) {
    if (!await dialogo({ titulo: 'Remover membro?', mensagem: email + ' deixará de ter acesso à despensa da família.',
      okTexto: 'Remover', perigo: true, icone: '👤' })) return;
    await acaoFamilia('remover_membro', { p_email: email }, 'Membro removido.');
  }

  async function cancelarConvite(email) {
    await acaoFamilia('cancelar_convite', { p_email: email }, 'Convite cancelado.');
  }

  async function convidarMembro() {
    const input = document.getElementById('familia-convite-email');
    const email = input.value.trim();
    if (!email) { showToast('Digite o e-mail da pessoa a convidar.', 'erro'); return; }
    const ok = await acaoFamilia('convidar_membro', { p_email: email }, 'Convite enviado para ' + email + '!');
    if (ok) {
      input.value = '';
      DespenseiApi.acordarPonteDeEmails();
    }
  }

  async function salvarTelefone() {
    const telefone = document.getElementById('meu-telefone').value.trim();
    showLoader();
    try {
      const r = await chamarOnline('atualizar_telefone', { p_telefone: telefone });
      const eu = APP.familia && APP.familia.membros.find(function (m) { return m.email === APP.email; });
      if (eu) eu.telefone = r.telefone;
      salvarCache();
      showToast('Telefone salvo!');
    } catch (err) {
      tratarErro(err);
    } finally {
      hideLoader();
    }
  }

  // ===================== NAVEGAÇÃO =====================

  function switchTab(tab) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
    document.getElementById('screen-' + tab).classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    window.scrollTo(0, 0);
  }

  function atualizarBadges() {
    const badgeLista = document.getElementById('badge-lista');
    if (APP.listaCompras.length > 0) {
      badgeLista.textContent = APP.listaCompras.length;
      badgeLista.classList.remove('hidden');
    } else {
      badgeLista.classList.add('hidden');
    }
    const badgeCarrinho = document.getElementById('badge-carrinho');
    if (APP.carrinho.length > 0) {
      badgeCarrinho.textContent = APP.carrinho.length;
      badgeCarrinho.classList.remove('hidden');
    } else {
      badgeCarrinho.classList.add('hidden');
    }
  }

  function renderTudo() {
    if (!appVisivel) return;
    renderDespensa();
    renderListaCompras();
    renderSelectEstabelecimentos();
    Object.keys(seletores).forEach(renderSeletor);
    renderProdutoEscolhido();
    renderCodigoPendente();
    renderCatalogo();
    renderCategoriasLista();
    renderEstabelecimentosLista();
    renderCarrinho();
    renderInfoFamilia();
    atualizarBadges();
    atualizarStatusSync();
  }

  // Indicador discreto no cabeçalho: só aparece quando há algo fora do normal.
  function atualizarStatusSync() {
    const el = document.getElementById('sync-status');
    if (!el) return;
    const n = DespenseiApi.pendentes();
    let texto = '';
    let classe = 'bg-amber-50 text-amber-800 border-amber-200';
    if (n > 0 && !navigator.onLine) {
      texto = '📴 Sem internet · ' + n + (n === 1 ? ' alteração aguardando' : ' alterações aguardando');
    } else if (n > 0) {
      texto = '⏳ Enviando ' + n + (n === 1 ? ' alteração…' : ' alterações…');
      classe = 'bg-sage-50 text-sage-700 border-sage-200';
    } else if (!navigator.onLine) {
      texto = '📴 Sem internet · usando os dados salvos no aparelho';
    }
    el.textContent = texto;
    el.className = 'text-[11px] font-semibold rounded-lg border px-2.5 py-1 mx-4 mb-2 text-center ' + classe + (texto ? '' : ' hidden');
  }

  function tituloCategoria(cat) {
    return `<h3 class="text-xs font-extrabold text-sage-800 bg-sage-100 uppercase tracking-wide mb-2 px-3 py-1.5 rounded-lg">${icone(cat)} ${escapeHtml(cat)}</h3>`;
  }

  // ===================== SELETOR DE PRODUTOS (busca + categorias recolhíveis) =====================
  // Usado no Carrinho, na Lista e na Despensa. Abre com todas as categorias
  // recolhidas; ao digitar, mostra só os produtos que batem com a busca, com
  // as categorias deles já abertas.
  const seletores = {
    carrinho: {
      busca: '', abertas: {}, grupoLista: true, podeCriar: true,
      itens: function () { return APP.produtosCompraveis; },
      aoEscolher: function (id) { selecionarProdutoCarrinho(id); }
    },
    lista: {
      busca: '', abertas: {}, podeCriar: true, soBusca: true,
      itens: function () { return APP.produtosCompraveis.filter(function (p) { return !p.avulso; }); },
      aoEscolher: function (id) { adicionarComoDesejo(id); }
    },
    despensa: {
      busca: '', abertas: {}, podeCriar: true,
      itens: function () { return APP.produtosCompraveis.filter(function (p) { return !p.avulso; }); },
      aoEscolher: function (id) { adicionarNaDespensa(id); }
    }
  };

  function infoProdutoSeletor(p) {
    const partes = [];
    if (p.estoqueAtual > 0 && !p.avulso) partes.push('em casa: ' + p.estoqueAtual);
    if (p.emListaManual) partes.push('📋 na lista');
    if (p.referenciaPreco) partes.push(formatMoeda(p.referenciaPreco.preco));
    return partes.join(' · ');
  }

  function blocoCategoriaSeletor(idSeletor, chave, rotulo, itens, aberta) {
    return `
      <div class="rounded-xl border border-sage-200 overflow-hidden">
        <button type="button" data-cat="${escapeHtml(chave)}" onclick="DespenseiApp.alternarCategoriaSeletor('${idSeletor}', this.dataset.cat)"
          class="w-full flex items-center justify-between gap-2 px-3 py-2.5 bg-sage-100 active:bg-sage-200 text-left">
          <span class="font-extrabold text-[13px] text-sage-800 uppercase tracking-wide truncate">${rotulo}</span>
          <span class="flex items-center gap-2 shrink-0">
            <span class="text-[11px] font-bold text-sage-700 bg-white/70 rounded-full px-2 py-0.5">${itens.length}</span>
            <svg class="w-3.5 h-3.5 text-sage-700 transition-transform ${aberta ? 'rotate-180' : ''}" viewBox="0 0 12 8" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </span>
        </button>
        ${aberta ? `<div class="divide-y divide-sand-100 bg-white">
          ${itens.map(function (p) {
            const info = infoProdutoSeletor(p);
            return `<button type="button" onclick="DespenseiApp.escolherNoSeletor('${idSeletor}', '${p.id}')"
              class="w-full text-left px-3.5 py-2.5 active:bg-sage-50 flex items-center justify-between gap-2">
              <span class="text-sm text-sand-900 min-w-0">${escapeHtml(p.nome)}${p.avulso ? ' <span class="text-[10px] font-extrabold text-sand-600 bg-sand-200 rounded-full px-1.5">AVULSO</span>' : ''}</span>
              ${info ? `<span class="text-[11px] text-sand-500 shrink-0 text-right">${escapeHtml(info)}</span>` : ''}
            </button>`;
          }).join('')}
        </div>` : ''}
      </div>`;
  }

  function renderSeletor(id) {
    const s = seletores[id];
    const raiz = document.getElementById('seletor-' + id);
    if (!s || !raiz) return;
    const lista = raiz.querySelector('.seletor-lista');
    const termos = termosBusca(s.busca);
    const buscando = termos.length > 0;
    if (s.soBusca && !buscando) { lista.innerHTML = ''; return; }
    const itens = s.itens().filter(function (p) { return casaBusca(p, termos); });
    const grupos = agruparPorCategoria(itens);

    let html = '';
    if (s.grupoLista && !buscando) {
      const naLista = itens.filter(function (p) { return p.emListaManual; });
      if (naLista.length) html += blocoCategoriaSeletor(id, '__lista', '📋 Na lista de compras', naLista, !!s.abertas.__lista);
    }
    html += ordemCategorias(Object.keys(grupos)).map(function (cat) {
      return blocoCategoriaSeletor(id, cat, icone(cat) + ' ' + escapeHtml(cat), grupos[cat], buscando || !!s.abertas[cat]);
    }).join('');

    if (!itens.length) {
      html = `<p class="text-center text-sm text-sand-500 py-3">${buscando
        ? 'Nenhum produto encontrado para "<b>' + escapeHtml(s.busca.trim()) + '</b>".'
        : 'Nenhum produto cadastrado ainda.'}</p>`;
    }
    if (buscando && s.podeCriar) {
      html += `<button type="button" onclick="DespenseiApp.criarPeloSeletor('${id}')"
        class="w-full border border-dashed border-sage-400 text-sage-700 font-bold rounded-xl py-2.5 text-xs active:bg-sage-50">
        + Cadastrar "${escapeHtml(s.busca.trim())}" como novo produto
      </button>`;
    }
    lista.innerHTML = html;
  }

  function buscarNoSeletor(id, valor) {
    seletores[id].busca = valor || '';
    renderSeletor(id);
  }

  function alternarCategoriaSeletor(id, cat) {
    const s = seletores[id];
    s.abertas[cat] = !s.abertas[cat];
    renderSeletor(id);
  }

  function limparSeletor(id) {
    const s = seletores[id];
    s.busca = '';
    s.abertas = {};
    const raiz = document.getElementById('seletor-' + id);
    const input = raiz && raiz.querySelector('.seletor-busca');
    if (input) input.value = '';
    renderSeletor(id);
  }

  function escolherNoSeletor(id, idProduto) {
    limparSeletor(id);
    seletores[id].aoEscolher(idProduto);
  }

  function criarPeloSeletor(id) {
    const s = seletores[id];
    const nome = s.busca.trim();
    abrirModalNovoProduto(nome, id === 'carrinho' ? codigoBarrasPendente : '', function (novoId) {
      limparSeletor(id);
      s.aoEscolher(novoId);
    });
  }

  // ===================== DESPENSA =====================

  function renderDespensa() {
    const container = document.getElementById('despensa-lista');
    if (!APP.despensa.length) {
      container.innerHTML = `
        <div class="text-center py-12 px-4">
          <p class="text-4xl mb-2">🌿</p>
          <p class="text-sand-600 font-semibold mb-1">Nada na despensa por enquanto</p>
          <p class="text-sand-500 text-sm">Os produtos aparecem aqui quando você finaliza uma compra ou usa o botão <b>+ Já tenho em casa</b> acima.</p>
        </div>`;
      return;
    }

    const porCategoria = agruparPorCategoria(APP.despensa);
    container.innerHTML = ordemCategorias(Object.keys(porCategoria)).map(cat => `
      <div>
        ${tituloCategoria(cat)}
        <div class="space-y-2">
          ${porCategoria[cat].map(cardDespensaItem).join('')}
        </div>
      </div>
    `).join('');
  }

  function cardDespensaItem(p) {
    return `
      <div class="bg-white rounded-2xl p-3 shadow-sm border border-sand-100 flex items-center gap-3">
        <div class="flex-1 min-w-0">
          <p class="font-bold text-sm text-sand-900 truncate">${escapeHtml(p.nome)}</p>
          ${p.referenciaPreco ? `<p class="text-[11px] text-sand-500 mt-0.5 truncate">Último pago: ${escapeHtml(p.referenciaPreco.texto)}</p>` : `<p class="text-[11px] text-sand-400 mt-0.5">Sem histórico de preço</p>`}
          ${p.emListaManual ? `<p class="text-[11px] text-sage-700 font-bold mt-0.5">📋 Na lista de compras</p>` : ''}
        </div>
        <button onclick="DespenseiApp.alternarLista('${p.id}')" class="shrink-0 w-9 h-9 rounded-full ${p.emListaManual ? 'bg-sage-600 text-white' : 'bg-sand-50 text-sand-500'} active:scale-95 flex items-center justify-center" title="${p.emListaManual ? 'Tirar da lista de compras' : 'Adicionar à lista de compras'}">📋</button>
        <div class="flex items-center gap-2.5 shrink-0">
          <button onclick="DespenseiApp.mudarEstoque('${p.id}', -1)" class="stepper-btn w-11 h-11 rounded-full bg-sand-100 text-sand-700 font-extrabold text-xl active:bg-sand-200 flex items-center justify-center">–</button>
          <span class="w-7 text-center font-extrabold text-lg text-sage-700">${p.estoqueAtual}</span>
          <button onclick="DespenseiApp.mudarEstoque('${p.id}', 1)" class="stepper-btn w-11 h-11 rounded-full bg-sage-600 text-white font-extrabold text-xl active:bg-sage-700 flex items-center justify-center">+</button>
        </div>
      </div>`;
  }

  function mudarEstoque(idProduto, delta) {
    const p = produto(idProduto);
    if (!p) return;
    const antes = Number(p.estoqueAtual) || 0;
    const depois = Math.max(0, antes + delta);
    if (depois === antes) return;
    p.estoqueAtual = depois;
    p.ocultoDaLista = false;
    mudouLocal();
    DespenseiApi.enfileirar('atualizar_estoque', { p_produto_id: Number(p.id), p_delta: depois - antes }, 'Estoque de ' + p.nome);

    // Acabou: sai da despensa. Pergunta se quer comprar de novo (não é automático).
    if (antes > 0 && depois === 0 && !p.emListaManual && !p.avulso) {
      dialogo({ titulo: p.nome + ' acabou', mensagem: 'Ele saiu da despensa. Quer adicioná-lo à lista de compras?',
        icone: '📋', okTexto: 'Adicionar à lista', cancelarTexto: 'Não, obrigado' })
        .then(function (sim) { if (sim) colocarNaLista(p, qtdUltimaCompra(p)); });
    }
  }

  // "Já tenho em casa": soma estoque sem precisar passar pelo carrinho.
  async function adicionarNaDespensa(idProduto) {
    const p = produto(idProduto);
    if (!p) return;
    const atual = Number(p.estoqueAtual) || 0;
    const qtd = await dialogo({
      tipo: 'quantidade', icone: '🏠', titulo: p.nome,
      mensagem: atual > 0 ? `Você já tem ${atual} em casa. Quantas unidades a mais?` : 'Quantas unidades você tem em casa?',
      valor: 1, okTexto: 'Adicionar à despensa'
    });
    if (!qtd) return;
    mudarEstoque(p.id, qtd);
    showToast(p.nome + ': ' + (atual + qtd) + ' em casa.');
  }

  function colocarNaLista(p, qtd) {
    p.emListaManual = true;
    p.qtdDesejada = qtd || null;
    p.ocultoDaLista = false;
    mudouLocal();
    DespenseiApi.enfileirar('adicionar_item_manual_lista',
      { p_produto_id: Number(p.id), p_qtd_desejada: qtd || null }, p.nome + ' na lista');
    showToast(p.nome + ' adicionado à lista de compras!');
  }

  // Adicionar à lista, sugerindo a quantidade da última compra.
  async function adicionarComoDesejo(idProduto) {
    const p = produto(idProduto);
    if (!p) return;
    if (p.emListaManual) { showToast(p.nome + ' já está na lista de compras.'); return; }
    const sugestao = qtdUltimaCompra(p);
    const qtd = await dialogo({
      tipo: 'quantidade', icone: '📋', titulo: p.nome,
      mensagem: 'Quantas unidades você quer comprar?' + (sugestao ? ` Na última compra foram ${sugestao}.` : ''),
      valor: sugestao || 1, okTexto: 'Adicionar à lista'
    });
    if (!qtd) return;
    colocarNaLista(p, qtd);
  }

  function alternarLista(idProduto) {
    const p = produto(idProduto);
    if (!p) return;
    if (p.emListaManual) removerItemLista(idProduto);
    else adicionarComoDesejo(idProduto);
  }

  // ===================== LISTA DE COMPRAS =====================

  function renderListaCompras() {
    const container = document.getElementById('lista-compras');
    if (!APP.listaCompras.length) {
      container.innerHTML = `
        <div class="text-center py-12 px-4">
          <p class="text-4xl mb-2">✅</p>
          <p class="text-sand-600 font-semibold">Sua lista está vazia.</p>
          <p class="text-sand-500 text-sm mt-1">Use a busca acima, o botão 📋 na Despensa/Catálogo ou adicione um item avulso.</p>
        </div>`;
      return;
    }

    const porCategoria = agruparPorCategoria(APP.listaCompras);
    container.innerHTML = ordemCategorias(Object.keys(porCategoria)).map(cat => `
      <div>
        ${tituloCategoria(cat)}
        <div class="space-y-2">
          ${porCategoria[cat].map(cardListaItem).join('')}
        </div>
      </div>
    `).join('');
  }

  function cardListaItem(p) {
    return `
      <div class="bg-white rounded-2xl p-3 shadow-sm border border-sand-100 flex items-center gap-2">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5">
            <p class="font-bold text-sm text-sand-900 truncate">${escapeHtml(p.nome)}</p>
            ${p.avulso ? '<span class="shrink-0 bg-sand-200 text-sand-700 text-[10px] font-extrabold px-1.5 py-0.5 rounded-full">AVULSO</span>' : ''}
          </div>
          ${p.qtdDesejada ? `<p class="text-[11px] text-sand-700 mt-0.5">Comprar: <b>${p.qtdDesejada}</b></p>` : ''}
          ${!p.avulso && p.estoqueAtual > 0 ? `<p class="text-[11px] text-sand-500 mt-0.5">Em casa: ${p.estoqueAtual}</p>` : ''}
          ${p.referenciaPreco ? `<p class="text-[11px] text-sage-700 mt-0.5 font-semibold truncate">Último pago: ${escapeHtml(p.referenciaPreco.texto)}</p>` : ''}
        </div>
        <button onclick="DespenseiApp.levarAoCarrinho('${p.id}')" class="shrink-0 bg-sage-100 text-sage-700 font-bold rounded-xl px-3 py-2 text-xs active:scale-95 transition">+ Carrinho</button>
        <button onclick="DespenseiApp.removerItemLista('${p.id}')" class="shrink-0 w-8 h-8 rounded-full bg-terracotta-50 text-terracotta-600 font-bold active:bg-terracotta-100 flex items-center justify-center" aria-label="Remover da lista">✕</button>
      </div>`;
  }

  function removerItemLista(idProduto) {
    const p = produto(idProduto);
    if (!p) return;
    if (p.avulso) {
      APP.produtos = APP.produtos.filter(function (x) { return x !== p; });
      APP.carrinho = APP.carrinho.filter(function (i) { return String(i.idProduto) !== String(idProduto); });
      if (String(idSelecionadoCarrinho) === String(idProduto)) idSelecionadoCarrinho = null;
      salvarCarrinho();
    } else {
      p.emListaManual = false;
      p.qtdDesejada = null;
      p.ocultoDaLista = true;
    }
    mudouLocal();
    DespenseiApi.enfileirar('remover_item_manual_lista', { p_produto_id: Number(p.id) }, p.nome + ' fora da lista');
    showToast(p.nome + ' saiu da lista.');
  }

  // Da lista para o formulário do carrinho, já com o produto escolhido:
  // falta só conferir o preço e tocar em "Adicionar ao Carrinho".
  function levarAoCarrinho(idProduto) {
    if (!buscarProdutoCompravel(idProduto)) return;
    switchTab('carrinho');
    codigoBarrasPendente = null;
    selecionarProdutoCarrinho(idProduto);
  }

  // Item pontual, fora do catálogo — some da lista assim que comprado.
  async function adicionarItemAvulso() {
    const input = document.getElementById('novo-item-avulso');
    const nome = input.value.trim();
    if (!nome) { showToast('Digite o nome do item.', 'erro'); return; }

    showLoader();
    try {
      const novo = await chamarOnline('adicionar_item_avulso', { p_nome: nome });
      APP.produtos.push(novo);
      mudouLocal();
      input.value = '';
      showToast(`"${nome}" adicionado à lista!`);
    } catch (err) {
      tratarErro(err);
    } finally {
      hideLoader();
    }
  }

  // ===================== CARRINHO =====================

  function renderSelectEstabelecimentos() {
    const sel = document.getElementById('select-estabelecimento');
    const atual = sel.value;
    sel.innerHTML = '<option value="">Selecione…</option>' +
      APP.estabelecimentos.map(e => `<option value="${e.id}">${escapeHtml(e.nome)}</option>`).join('');
    if (atual) sel.value = atual;
  }

  function selecionarProdutoCarrinho(idProduto) {
    const p = buscarProdutoCompravel(idProduto);
    if (!p) return;
    idSelecionadoCarrinho = String(p.id);
    document.getElementById('input-qtd').value = p.qtdDesejada || p.qtdUltimaCompra || 1;
    if (p.referenciaPreco) {
      document.getElementById('input-preco').value = p.referenciaPreco.preco.toFixed(2);
      document.getElementById('input-marca').value = p.referenciaPreco.marca || '';
    } else {
      document.getElementById('input-preco').value = '';
      document.getElementById('input-marca').value = '';
    }
    renderProdutoEscolhido();
    renderCodigoPendente();
    atualizarIndicadorPreco();
    document.getElementById('carrinho-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderProdutoEscolhido() {
    const p = buscarProdutoCompravel(idSelecionadoCarrinho);
    if (!p) idSelecionadoCarrinho = null;
    document.getElementById('carrinho-escolhido').classList.toggle('hidden', !p);
    document.getElementById('carrinho-campos').classList.toggle('hidden', !p);
    document.getElementById('seletor-carrinho').classList.toggle('hidden', !!p);
    if (p) {
      document.getElementById('carrinho-escolhido-nome').textContent = p.nome;
      document.getElementById('carrinho-escolhido-cat').textContent = icone(p.categoria) + ' ' + p.categoria;
    }
  }

  function trocarProdutoCarrinho() {
    idSelecionadoCarrinho = null;
    document.getElementById('indicador-preco').textContent = '';
    renderProdutoEscolhido();
    renderCodigoPendente();
    const input = document.querySelector('#seletor-carrinho .seletor-busca');
    if (input) input.focus();
  }

  // Variação de preço em relação à última compra.
  function atualizarIndicadorPreco() {
    const p = buscarProdutoCompravel(idSelecionadoCarrinho);
    const el = document.getElementById('indicador-preco');
    const precoDigitado = parseFloat(document.getElementById('input-preco').value);

    if (!p || !p.referenciaPreco || isNaN(precoDigitado)) {
      el.textContent = '';
      return;
    }

    const diff = precoDigitado - p.referenciaPreco.preco;
    if (Math.abs(diff) < 0.005) {
      el.textContent = 'Mesmo preço da última compra.';
      el.className = 'text-[11px] mt-1 text-sand-400';
      return;
    }
    const subiu = diff > 0;
    el.textContent = `${subiu ? '▲' : '▼'} ${formatMoeda(Math.abs(diff))} ${subiu ? 'a mais' : 'a menos'} que da última vez (${formatMoeda(p.referenciaPreco.preco)})`;
    el.className = 'text-[11px] mt-1 font-semibold ' + (subiu ? 'text-terracotta-600' : 'text-sage-700');
  }

  function ajustarQtdForm(delta) {
    const input = document.getElementById('input-qtd');
    input.value = Math.max(1, (parseInt(input.value, 10) || 1) + delta);
  }

  // Cada toque em "Adicionar" vira um lançamento próprio no carrinho, com seu
  // preço e quantidade — nunca é somado a outro lançamento.
  function adicionarItemCarrinho() {
    const p = buscarProdutoCompravel(idSelecionadoCarrinho);
    const preco = parseFloat(String(document.getElementById('input-preco').value).replace(',', '.'));
    const qtd = parseInt(document.getElementById('input-qtd').value, 10) || 1;
    const marca = document.getElementById('input-marca').value.trim();

    if (!p) { showToast('Escolha um produto.', 'erro'); return; }
    if (isNaN(preco) || preco < 0) { showToast('Informe um preço válido.', 'erro'); return; }

    APP.carrinho.push({ idLinha: novoIdLinha(), idProduto: p.id, nome: p.nome, quantidade: qtd, precoUnitario: preco, marca: marca });

    idSelecionadoCarrinho = null;
    codigoBarrasPendente = null;
    document.getElementById('input-preco').value = '';
    document.getElementById('input-qtd').value = 1;
    document.getElementById('input-marca').value = '';
    document.getElementById('indicador-preco').textContent = '';
    renderProdutoEscolhido();
    renderCodigoPendente();

    salvarCarrinho();
    renderCarrinho();
    atualizarBadges();
    showToast(p.nome + ' adicionado!');
  }

  function removerItemCarrinho(idLinha) {
    APP.carrinho = APP.carrinho.filter(i => String(i.idLinha) !== String(idLinha));
    salvarCarrinho();
    renderCarrinho();
    atualizarBadges();
  }

  function renderCarrinho() {
    const container = document.getElementById('carrinho-itens');
    const total = APP.carrinho.reduce((s, i) => s + i.quantidade * i.precoUnitario, 0);
    document.getElementById('carrinho-total').textContent = formatMoeda(total);
    document.getElementById('btn-finalizar').disabled = APP.carrinho.length === 0;

    if (!APP.carrinho.length) {
      container.innerHTML = `<p class="text-center text-sand-400 text-sm py-6">Seu carrinho está vazio.</p>`;
      return;
    }

    container.innerHTML = APP.carrinho.map(i => `
      <div class="bg-white rounded-2xl p-3 shadow-sm border border-sand-100 flex items-center gap-3">
        <div class="flex-1 min-w-0">
          <p class="font-bold text-sm text-sand-900">${escapeHtml(i.nome)}${i.marca ? ` <span class="text-sand-400 font-normal">(${escapeHtml(i.marca)})</span>` : ''}</p>
          <p class="text-[11px] text-sand-500">${i.quantidade} × ${formatMoeda(i.precoUnitario)} = <b class="text-sage-700">${formatMoeda(i.quantidade * i.precoUnitario)}</b></p>
        </div>
        <button onclick="DespenseiApp.removerItemCarrinho('${i.idLinha}')" class="shrink-0 w-9 h-9 rounded-full bg-terracotta-50 text-terracotta-600 font-bold active:bg-terracotta-100 flex items-center justify-center" aria-label="Remover do carrinho">✕</button>
      </div>
    `).join('');
  }

  async function promptNovoEstabelecimento() {
    const nome = await dialogo({ tipo: 'texto', icone: '📍', titulo: 'Novo estabelecimento',
      placeholder: 'Ex: Supermercado Bahamas', okTexto: 'Adicionar' });
    if (!nome) return;
    await criarEstabelecimento(nome, true);
  }

  async function adicionarEstabelecimentoForm() {
    const input = document.getElementById('novo-estabelecimento-nome');
    const nome = input.value.trim();
    if (!nome) { showToast('Digite o nome do estabelecimento.', 'erro'); return; }
    if (await criarEstabelecimento(nome, false)) input.value = '';
  }

  async function criarEstabelecimento(nome, selecionar) {
    showLoader();
    try {
      const novo = await chamarOnline('adicionar_estabelecimento', { p_nome: nome });
      APP.estabelecimentos.push(novo);
      APP.estabelecimentos.sort((a, b) => compararTexto(a.nome, b.nome));
      salvarCache();
      renderSelectEstabelecimentos();
      renderEstabelecimentosLista();
      if (selecionar) document.getElementById('select-estabelecimento').value = novo.id;
      showToast('Estabelecimento adicionado!');
      return true;
    } catch (err) {
      tratarErro(err);
      return false;
    } finally {
      hideLoader();
    }
  }

  // Registra a compra na hora (estoque, último preço, lista) e manda pra fila:
  // no mercado sem sinal, a compra fica guardada e é enviada quando a internet voltar.
  function finalizarCompra() {
    const idLocal = document.getElementById('select-estabelecimento').value;
    if (!idLocal) { showToast('Selecione o estabelecimento.', 'erro'); return; }
    if (!APP.carrinho.length) { showToast('Carrinho vazio.', 'erro'); return; }

    const estab = APP.estabelecimentos.find(e => String(e.id) === String(idLocal));
    const nomeLocal = estab ? estab.nome : '';
    const itens = APP.carrinho.map(i => ({
      idProduto: Number(i.idProduto), quantidade: Number(i.quantidade) || 0,
      precoUnitario: Number(i.precoUnitario) || 0, marca: i.marca || '', tipoCompra: 'unidade'
    }));
    const valorTotal = itens.reduce((s, i) => s + i.quantidade * i.precoUnitario, 0);

    const qtdPorProduto = {};
    itens.forEach(function (it) { qtdPorProduto[it.idProduto] = (qtdPorProduto[it.idProduto] || 0) + it.quantidade; });

    itens.forEach(function (it) {
      const p = produto(it.idProduto);
      if (!p) return;
      p.estoqueAtual = (Number(p.estoqueAtual) || 0) + it.quantidade;
      p.ultimoPreco = it.precoUnitario;
      p.localUltimaCompra = nomeLocal;
      if (it.marca.trim()) p.ultimaMarca = it.marca.trim();
      p.tipoCompra = 'unidade';
      p.emListaManual = false;
      p.qtdDesejada = null;
      p.ocultoDaLista = false;
      if (p.avulso) p.ativo = false;
      APP.ultimaQtd[String(p.id)] = qtdPorProduto[it.idProduto];
    });

    APP.carrinho = [];
    salvarCarrinho();
    mudouLocal();
    DespenseiApi.enfileirar('finalizar_compra', { p_local_id: Number(idLocal), p_itens: itens },
      'Compra em ' + nomeLocal + ' (' + formatMoeda(valorTotal) + ')');
    showToast('Compra finalizada: ' + formatMoeda(valorTotal) + ' 🎉' +
      (navigator.onLine ? '' : ' Será enviada quando a internet voltar.'));
    switchTab('despensa');
  }

  // ===================== CÓDIGO DE BARRAS =====================

  // Compara só os dígitos e ignora zeros à esquerda (UPC-A de 12 dígitos e
  // EAN-13 com zero na frente são o mesmo produto).
  function chaveCodigo(c) { return String(c || '').replace(/\D/g, '').replace(/^0+/, ''); }

  function produtoPorCodigo(codigo) {
    const chave = chaveCodigo(codigo);
    if (!chave) return null;
    return APP.produtos.find(x => chaveCodigo(x.codigoBarras) === chave) || null;
  }

  function abrirScanner() {
    DespenseiBarcode.iniciar(function (codigo) {
      const p = produtoPorCodigo(codigo);
      if (p && buscarProdutoCompravel(p.id)) {
        codigoBarrasPendente = null;
        selecionarProdutoCarrinho(p.id);
        showToast(p.nome + ' reconhecido!');
      } else {
        codigoBarrasPendente = codigo;
        idSelecionadoCarrinho = null;
        renderProdutoEscolhido();
        renderCodigoPendente();
        const input = document.querySelector('#seletor-carrinho .seletor-busca');
        if (input) input.focus();
      }
    });
  }

  // Aviso de código lido que ainda não está cadastrado: o usuário escolhe o
  // produto (busca/categorias logo abaixo) e confirma o vínculo, ou cadastra
  // um produto novo já com esse código.
  function renderCodigoPendente() {
    const el = document.getElementById('carrinho-codigo-pendente');
    if (!codigoBarrasPendente) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const p = buscarProdutoCompravel(idSelecionadoCarrinho);
    const cod = escapeHtml(codigoBarrasPendente);
    el.innerHTML = p
      ? `<p class="text-xs text-sand-800 mb-2">Vincular o código <b class="tracking-wider">${cod}</b> a <b>${escapeHtml(p.nome)}</b>? Na próxima leitura ele será reconhecido sozinho.</p>
         <div class="flex gap-2">
           <button onclick="DespenseiApp.vincularCodigoPendente()" class="flex-1 bg-sage-600 text-white font-bold rounded-xl py-2 text-xs active:scale-[0.98]">🔗 Vincular</button>
           <button onclick="DespenseiApp.descartarCodigoPendente()" class="flex-1 bg-sand-100 text-sand-700 font-bold rounded-xl py-2 text-xs active:scale-[0.98]">Agora não</button>
         </div>`
      : `<p class="text-xs text-sand-800 mb-2">Código <b class="tracking-wider">${cod}</b> ainda não está cadastrado. Procure abaixo o produto a que ele pertence, ou cadastre um produto novo.</p>
         <div class="flex gap-2">
           <button onclick="DespenseiApp.novoProdutoComCodigo()" class="flex-1 bg-sage-600 text-white font-bold rounded-xl py-2 text-xs active:scale-[0.98]">+ Cadastrar novo produto</button>
           <button onclick="DespenseiApp.descartarCodigoPendente()" class="flex-1 bg-sand-100 text-sand-700 font-bold rounded-xl py-2 text-xs active:scale-[0.98]">Descartar código</button>
         </div>`;
    el.classList.remove('hidden');
  }

  function descartarCodigoPendente() {
    codigoBarrasPendente = null;
    renderCodigoPendente();
  }

  function novoProdutoComCodigo() {
    abrirModalNovoProduto('', codigoBarrasPendente, function (novoId) {
      codigoBarrasPendente = null;
      selecionarProdutoCarrinho(novoId);
    });
  }

  async function vincularCodigoPendente() {
    const p = buscarProdutoCompravel(idSelecionadoCarrinho);
    if (!p) { showToast('Escolha um produto primeiro.', 'erro'); return; }
    if (!codigoBarrasPendente) return;

    showLoader();
    try {
      await chamarOnline('vincular_codigo_barras', { p_produto_id: Number(p.id), p_codigo_barras: codigoBarrasPendente });
      const cru = produto(p.id);
      if (cru) cru.codigoBarras = codigoBarrasPendente;
      codigoBarrasPendente = null;
      mudouLocal();
      showToast('Código vinculado a ' + p.nome + '!');
    } catch (err) {
      tratarErro(err);
    } finally {
      hideLoader();
    }
  }

  function abrirScannerParaCampo(idCampo) {
    DespenseiBarcode.iniciar(function (codigo) {
      document.getElementById(idCampo).value = codigo;
    });
  }

  // ===================== CATÁLOGO =====================

  function opcoesCategorias(selecionada, excluir) {
    return APP.categorias.filter(c => c !== excluir)
      .map(c => `<option value="${escapeHtml(c)}" ${c === selecionada ? 'selected' : ''}>${icone(c)} ${escapeHtml(c)}</option>`).join('');
  }

  function renderCatalogo() {
    const termos = termosBusca(document.getElementById('filtro-catalogo').value);
    const buscando = termos.length > 0;
    const container = document.getElementById('catalogo-lista');
    const abertas = {};
    container.querySelectorAll('details[open]').forEach(d => { abertas[d.dataset.categoria] = true; });

    const html = ordemCategorias(Object.keys(APP.catalogo)).map(cat => {
      const itens = (APP.catalogo[cat] || []).filter(p => casaBusca(p, termos));
      if (!itens.length) return '';
      return `
        <details class="bg-white rounded-2xl shadow-sm border border-sage-200 overflow-hidden" data-categoria="${escapeHtml(cat)}" ${buscando || abertas[cat] ? 'open' : ''}>
          <summary class="flex items-center justify-between px-3.5 py-3 cursor-pointer bg-sage-100 active:bg-sage-200">
            <span class="font-extrabold text-[13px] text-sage-800 uppercase tracking-wide">${icone(cat)} ${escapeHtml(cat)}</span>
            <span class="flex items-center gap-2">
              <span class="text-[11px] font-bold text-sage-700 bg-white/70 rounded-full px-2 py-0.5">${itens.length}</span>
              <svg class="chev w-3.5 h-3.5 text-sage-700 transition-transform" viewBox="0 0 12 8" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            </span>
          </summary>
          <div class="divide-y divide-sand-100">
            ${itens.map(linhaCatalogoItem).join('')}
          </div>
        </details>`;
    }).join('');

    container.innerHTML = html || `
      <div class="text-center py-6">
        <p class="text-sm text-sand-500 mb-3">${buscando ? 'Nenhum produto encontrado.' : 'Nenhum produto cadastrado.'}</p>
        <button onclick="DespenseiApp.cadastrarPelaBuscaCatalogo()" class="bg-sage-600 text-white font-bold rounded-xl px-4 py-2.5 text-sm active:scale-95">+ Cadastrar novo produto</button>
      </div>`;
  }

  function linhaCatalogoItem(p) {
    const info = [];
    if (p.estoqueAtual > 0) info.push('🏠 em casa: ' + p.estoqueAtual);
    if (p.emListaManual) info.push('📋 na lista');
    if (p.codigoBarras) info.push('▮▯▮ ' + p.codigoBarras);
    return `
      <div class="flex items-center justify-between px-3.5 py-2.5 gap-2">
        <div class="min-w-0 flex-1">
          <p class="text-sm text-sand-900 ${p.estoqueAtual > 0 ? 'font-bold' : ''}">${escapeHtml(p.nome)}</p>
          ${info.length ? `<p class="text-[11px] text-sand-500 truncate">${escapeHtml(info.join(' · '))}</p>` : ''}
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button onclick="DespenseiApp.alternarLista('${p.id}')" class="w-9 h-9 rounded-full ${p.emListaManual ? 'bg-sage-600 text-white' : 'bg-sand-50'} active:scale-95 flex items-center justify-center" title="${p.emListaManual ? 'Tirar da lista de compras' : 'Adicionar à lista de compras'}">📋</button>
          <button onclick="DespenseiApp.adicionarNaDespensa('${p.id}')" class="w-9 h-9 rounded-full bg-sand-50 active:scale-95 flex items-center justify-center" title="Já tenho em casa (adicionar à despensa)">🏠</button>
          <button onclick="DespenseiApp.abrirModalEditar('${p.id}')" class="w-9 h-9 rounded-full bg-sand-50 active:scale-95 flex items-center justify-center" title="Editar ou excluir">✏️</button>
        </div>
      </div>`;
  }

  function cadastrarPelaBuscaCatalogo() {
    const busca = document.getElementById('filtro-catalogo').value.trim();
    abrirModalNovoProduto(busca, '', function () {
      document.getElementById('filtro-catalogo').value = '';
      renderCatalogo();
    });
  }

  // ----- Editar / excluir produto -----

  function abrirModalEditar(idProduto) {
    const p = produto(idProduto);
    if (!p) return;

    idProdutoEmEdicao = idProduto;
    document.getElementById('editar-produto-nome').value = p.nome;
    document.getElementById('editar-produto-codigo-barras').value = p.codigoBarras || '';
    document.getElementById('editar-produto-categoria').innerHTML = opcoesCategorias(p.categoria);
    document.getElementById('modal-editar').classList.remove('hidden');
  }

  function fecharModalEditar() {
    idProdutoEmEdicao = null;
    document.getElementById('modal-editar').classList.add('hidden');
  }

  async function salvarEdicaoProduto() {
    if (!idProdutoEmEdicao) return;
    const nome = document.getElementById('editar-produto-nome').value.trim();
    const categoria = document.getElementById('editar-produto-categoria').value;
    const codigoBarras = document.getElementById('editar-produto-codigo-barras').value.replace(/\s+/g, '');
    if (!nome) { showToast('Digite o nome do produto.', 'erro'); return; }

    showLoader();
    try {
      const atualizado = await chamarOnline('editar_produto', { p_produto_id: Number(idProdutoEmEdicao), p_nome: nome, p_categoria: categoria });
      const p = produto(idProdutoEmEdicao);
      atualizado.codigoBarras = p ? (p.codigoBarras || '') : '';
      if (codigoBarras !== atualizado.codigoBarras) {
        await DespenseiApi.rpc('vincular_codigo_barras', { p_produto_id: Number(idProdutoEmEdicao), p_codigo_barras: codigoBarras });
        atualizado.codigoBarras = codigoBarras;
      }
      if (p) Object.assign(p, { nome: atualizado.nome, categoria: atualizado.categoria, codigoBarras: atualizado.codigoBarras });
      APP.carrinho.forEach(function (i) { if (String(i.idProduto) === String(idProdutoEmEdicao)) i.nome = atualizado.nome; });
      salvarCarrinho();
      mudouLocal();
      fecharModalEditar();
      showToast('Produto atualizado!');
    } catch (err) {
      tratarErro(err, 'Erro ao salvar: ');
    } finally {
      hideLoader();
    }
  }

  async function excluirProdutoEmEdicao() {
    const p = produto(idProdutoEmEdicao);
    if (!p) return;
    if (!await dialogo({ titulo: `Excluir "${p.nome}"?`,
      mensagem: 'Ele sai do catálogo, da despensa, da lista e do carrinho. O histórico das compras já feitas continua guardado.',
      okTexto: 'Excluir', perigo: true })) return;

    showLoader();
    try {
      await chamarOnline('excluir_produto', { p_produto_id: Number(p.id) });
      APP.produtos = APP.produtos.filter(x => x !== p);
      APP.carrinho = APP.carrinho.filter(i => String(i.idProduto) !== String(p.id));
      if (String(idSelecionadoCarrinho) === String(p.id)) idSelecionadoCarrinho = null;
      salvarCarrinho();
      fecharModalEditar();
      mudouLocal();
      showToast(`"${p.nome}" excluído.`);
    } catch (err) {
      tratarErro(err, 'Erro ao excluir: ');
    } finally {
      hideLoader();
    }
  }

  // ----- Novo produto (Catálogo, busca sem resultado ou código lido) -----

  function abrirModalNovoProduto(nome, codigo, depois) {
    aoCriarProduto = depois || null;
    document.getElementById('novo-produto-nome').value = nome || '';
    document.getElementById('novo-produto-codigo').value = codigo || '';
    document.getElementById('novo-produto-categoria').innerHTML = opcoesCategorias(null);
    document.getElementById('modal-novo-produto').classList.remove('hidden');
    if (!nome) setTimeout(function () { document.getElementById('novo-produto-nome').focus(); }, 50);
  }

  function fecharModalNovoProduto() {
    aoCriarProduto = null;
    document.getElementById('modal-novo-produto').classList.add('hidden');
  }

  async function salvarNovoProduto() {
    const nome = document.getElementById('novo-produto-nome').value.trim();
    const categoria = document.getElementById('novo-produto-categoria').value;
    const codigo = document.getElementById('novo-produto-codigo').value.replace(/\s+/g, '');
    if (!nome) { showToast('Digite o nome do produto.', 'erro'); return; }
    if (!categoria) { showToast('Escolha a categoria.', 'erro'); return; }

    const parecido = APP.produtos.find(x => !x.avulso && normalizar(x.nome) === normalizar(nome));
    if (parecido && !await dialogo({ titulo: 'Produto repetido', icone: '⚠️',
      mensagem: `Já existe um produto chamado "${parecido.nome}". Cadastrar outro com o mesmo nome?`,
      okTexto: 'Cadastrar mesmo assim' })) return;

    showLoader();
    try {
      const novo = await chamarOnline('adicionar_produto_personalizado', { p_nome: nome, p_categoria: categoria, p_codigo_barras: codigo || null });
      APP.produtos.push(novo);
      const depois = aoCriarProduto;
      fecharModalNovoProduto();
      mudouLocal();
      showToast(`"${novo.nome}" cadastrado!`);
      if (depois) depois(novo.id);
    } catch (err) {
      tratarErro(err);
    } finally {
      hideLoader();
    }
  }

  // ----- Categorias -----

  function renderCategoriasLista() {
    const container = document.getElementById('categorias-lista');
    if (!APP.categorias.length) {
      container.innerHTML = `<p class="text-xs text-sand-400 py-1">Nenhuma categoria cadastrada.</p>`;
      return;
    }
    container.innerHTML = APP.categorias.map(c => {
      const qtd = (APP.catalogo[c] || []).length;
      return `
        <div class="flex items-center gap-2 bg-sand-50 rounded-lg pl-3 pr-1.5 py-1.5">
          <span class="flex-1 min-w-0 text-sm text-sand-800 truncate">${icone(c)} ${escapeHtml(c)} <span class="text-[11px] text-sand-400">(${qtd})</span></span>
          <button data-cat="${escapeHtml(c)}" onclick="DespenseiApp.renomearCategoria(this.dataset.cat)" class="shrink-0 w-8 h-8 rounded-full bg-white active:scale-95 flex items-center justify-center" title="Renomear">✏️</button>
          <button data-cat="${escapeHtml(c)}" onclick="DespenseiApp.excluirCategoria(this.dataset.cat)" class="shrink-0 w-8 h-8 rounded-full bg-white active:scale-95 flex items-center justify-center" title="Excluir">🗑️</button>
        </div>`;
    }).join('');
  }

  async function adicionarCategoria() {
    const input = document.getElementById('nova-categoria-nome');
    const nome = input.value.trim();
    if (!nome) { showToast('Digite o nome da categoria.', 'erro'); return; }

    showLoader();
    try {
      const r = await chamarOnline('adicionar_categoria', { p_nome: nome });
      APP.categorias.push(r.nome);
      mudouLocal();
      input.value = '';
      showToast(`Categoria "${r.nome}" criada!`);
    } catch (err) {
      tratarErro(err);
    } finally {
      hideLoader();
    }
  }

  async function renomearCategoria(nome) {
    const novo = await dialogo({ tipo: 'texto', icone: '✏️', titulo: 'Renomear categoria',
      mensagem: `Novo nome para "${nome}":`, valor: nome, okTexto: 'Renomear' });
    if (!novo || novo === nome) return;

    showLoader();
    try {
      const r = await chamarOnline('renomear_categoria', { p_nome_atual: nome, p_nome_novo: novo });
      APP.categorias = APP.categorias.map(c => c === nome ? r.nome : c);
      APP.produtos.forEach(p => { if (!p.avulso && p.categoria === nome) p.categoria = r.nome; });
      mudouLocal();
      showToast(`Categoria renomeada para "${r.nome}".`);
    } catch (err) {
      tratarErro(err);
    } finally {
      hideLoader();
    }
  }

  async function excluirCategoria(nome) {
    if (APP.categorias.length <= 1) { showToast('É preciso ter pelo menos uma categoria.', 'erro'); return; }
    const qtd = APP.produtos.filter(p => !p.avulso && p.categoria === nome).length;
    if (!qtd) {
      if (await dialogo({ titulo: `Excluir a categoria "${nome}"?`, mensagem: 'Ela não tem nenhum produto.',
        okTexto: 'Excluir', perigo: true })) executarExclusaoCategoria(nome, null);
      return;
    }
    categoriaParaExcluir = nome;
    document.getElementById('excluir-categoria-texto').textContent =
      `A categoria "${nome}" tem ${qtd} produto${qtd > 1 ? 's' : ''}. Para excluí-la, escolha para qual categoria ${qtd > 1 ? 'eles vão' : 'ele vai'}:`;
    document.getElementById('excluir-categoria-destino').innerHTML = opcoesCategorias(null, nome);
    document.getElementById('modal-excluir-categoria').classList.remove('hidden');
  }

  function fecharModalExcluirCategoria() {
    categoriaParaExcluir = null;
    document.getElementById('modal-excluir-categoria').classList.add('hidden');
  }

  function confirmarExcluirCategoria() {
    const destino = document.getElementById('excluir-categoria-destino').value;
    if (!categoriaParaExcluir || !destino) return;
    const nome = categoriaParaExcluir;
    fecharModalExcluirCategoria();
    executarExclusaoCategoria(nome, destino);
  }

  async function executarExclusaoCategoria(nome, destino) {
    showLoader();
    try {
      await chamarOnline('excluir_categoria', { p_nome: nome, p_mover_para: destino });
      APP.categorias = APP.categorias.filter(c => c !== nome);
      if (destino) APP.produtos.forEach(p => { if (!p.avulso && p.categoria === nome) p.categoria = destino; });
      mudouLocal();
      showToast(`Categoria "${nome}" excluída.` + (destino ? ` Produtos movidos para "${destino}".` : ''));
    } catch (err) {
      tratarErro(err);
    } finally {
      hideLoader();
    }
  }

  // ----- Estabelecimentos -----

  function renderEstabelecimentosLista() {
    const container = document.getElementById('estabelecimentos-lista');
    if (!APP.estabelecimentos.length) {
      container.innerHTML = `<p class="text-xs text-sand-400 py-1">Nenhum estabelecimento cadastrado ainda.</p>`;
      return;
    }
    container.innerHTML = APP.estabelecimentos.map(e => `
      <div class="flex items-center gap-2 text-sm text-sand-700 bg-sand-50 rounded-lg px-3 py-2">
        <span class="text-sage-600">📍</span> ${escapeHtml(e.nome)}
      </div>
    `).join('');
  }

  // ===================== SINCRONIZAÇÃO =====================

  DespenseiApi.on('mudou', atualizarStatusSync);
  DespenseiApi.on('filaVazia', function () { sincronizarDoServidor(); });
  DespenseiApi.on('sessaoInvalida', function () { DespenseiAuth.pedirNovoLogin(); });
  DespenseiApi.on('erroOperacao', function (e) {
    showToast('Não foi possível salvar "' + e.op.descricao + '": ' + (e.erro.message || e.erro), 'erro');
    // Mostra de novo o que está de fato no servidor.
    geracaoLocal++;
  });
  window.addEventListener('online', atualizarStatusSync);
  window.addEventListener('offline', atualizarStatusSync);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && appVisivel) sincronizarDoServidor();
  });

  return {
    aoLogar,
    criarFamilia,
    entrarComCodigo,
    convidarMembro,
    removerMembro,
    cancelarConvite,
    salvarTelefone,
    switchTab,
    mudarEstoque,
    adicionarNaDespensa,
    adicionarComoDesejo,
    alternarLista,
    adicionarItemAvulso,
    levarAoCarrinho,
    removerItemLista,
    buscarNoSeletor,
    alternarCategoriaSeletor,
    escolherNoSeletor,
    criarPeloSeletor,
    trocarProdutoCarrinho,
    atualizarIndicadorPreco,
    ajustarQtdForm,
    adicionarItemCarrinho,
    removerItemCarrinho,
    promptNovoEstabelecimento,
    adicionarEstabelecimentoForm,
    finalizarCompra,
    abrirScanner,
    vincularCodigoPendente,
    descartarCodigoPendente,
    novoProdutoComCodigo,
    abrirScannerParaCampo,
    renderCatalogo,
    cadastrarPelaBuscaCatalogo,
    abrirModalEditar,
    fecharModalEditar,
    salvarEdicaoProduto,
    excluirProdutoEmEdicao,
    abrirModalNovoProduto,
    fecharModalNovoProduto,
    salvarNovoProduto,
    adicionarCategoria,
    renomearCategoria,
    excluirCategoria,
    fecharModalExcluirCategoria,
    confirmarExcluirCategoria,
    dialogo,
    fecharDialogo,
    ajustarQtdDialogo
  };
})();

window.DespenseiApp = DespenseiApp;
