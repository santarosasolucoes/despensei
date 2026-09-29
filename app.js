// ===================== DESPENSEI — LÓGICA DA INTERFACE =====================
// Versão 3 (Supabase, offline primeiro). O app guarda no aparelho os produtos
// da família e monta sozinho a Despensa, a Lista de Compras e o Catálogo a
// partir deles — as mesmas regras que o Codigo.gs aplicava no servidor. Toda
// mudança do dia a dia (estoque, lista, finalizar compra) aparece na hora e
// vai pra fila de envio (web/api.js), funcionando mesmo sem internet.

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
    carrinho: [] // { idProduto, nome, quantidade, precoUnitario, marca }
  };

  let codigoBarrasPendente = null;
  let idProdutoEmEdicao = null;
  let toastTimer = null;
  let geracaoLocal = 0; // muda a cada alteração local (evita sobrescrever com dado velho do servidor)
  let appVisivel = false;

  const ICONE_CATEGORIA = {
    'Cereais/Grãos': '🌾', 'Açougue': '🥩', 'Laticínios': '🧀', 'Bebidas': '🥤',
    'Higiene': '🧴', 'Limpeza': '🧽', 'Hortifruti': '🥬', 'Enlatados/Conservas': '🥫', 'Padaria': '🍞',
    'Descartáveis': '🧻', 'Pet': '🐾', 'Farmácia': '💊', 'Avulso': '📌'
  };

  function formatMoeda(v) { return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ','); }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
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
    el.className = 'toast fixed bottom-24 left-1/2 z-50 px-4 py-2.5 rounded-xl shadow-lg text-sm font-bold text-white max-w-[85%] text-center ' +
      (tipo === 'erro' ? 'bg-terracotta-600' : 'bg-sage-700');
    el.style.transform = 'translateX(-50%)';
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2600);
  }

  function mostrarView(nome) {
    ['login', 'familia', 'bloqueado', 'app'].forEach(function (v) {
      document.getElementById('view-' + v).classList.toggle('hidden', v !== nome);
    });
    appVisivel = nome === 'app';
  }

  // ===================== REGRAS (mesmas do Codigo.gs) =====================

  function ordenarPorCategoriaENome(a, b) {
    return String(a.categoria || '').localeCompare(String(b.categoria || '')) || String(a.nome || '').localeCompare(String(b.nome || ''));
  }

  function referenciaPreco(p) {
    if (!p.ultimoPreco) return null;
    let texto = formatMoeda(p.ultimoPreco);
    if (p.ultimaMarca) texto += ' (' + p.ultimaMarca + ')';
    if (p.localUltimaCompra) texto += ' no ' + p.localUltimaCompra;
    return { texto: texto, preco: Number(p.ultimoPreco), marca: p.ultimaMarca || '', local: p.localUltimaCompra || '' };
  }

  function qtdUltimaCompra(p) { return Number(APP.ultimaQtd[String(p.id)]) || null; }

  function recalcular() {
    // Despensa: ativos, sem os avulsos (avulso não vira cadastro permanente).
    APP.despensa = APP.produtos.filter(function (p) { return p.ativo && !p.avulso; }).map(function (p) {
      const estoqueAtual = Number(p.estoqueAtual) || 0;
      return {
        id: p.id, nome: p.nome, categoria: p.categoria,
        estoqueAtual: estoqueAtual, estoqueMinimo: Number(p.estoqueMinimo) || 0,
        baixoEstoque: estoqueAtual <= 0,
        referenciaPreco: referenciaPreco(p), codigoBarras: p.codigoBarras || '',
        tipoCompra: p.tipoCompra || 'unidade', ultimoPeso: p.ultimoPeso ? Number(p.ultimoPeso) : null,
        emListaManual: !!p.emListaManual, qtdDesejada: p.qtdDesejada ? Number(p.qtdDesejada) : null,
        qtdUltimaCompra: qtdUltimaCompra(p)
      };
    }).sort(ordenarPorCategoriaENome);

    // Lista: ativos, não ocultados, com estoque zerado ou pedidos na mão.
    APP.listaCompras = APP.produtos.filter(function (p) {
      if (!p.ativo || p.ocultoDaLista) return false;
      return (Number(p.estoqueAtual) || 0) <= 0 || p.emListaManual;
    }).map(function (p) {
      return {
        id: p.id, nome: p.nome, categoria: p.categoria,
        estoqueAtual: Number(p.estoqueAtual) || 0, estoqueMinimo: Number(p.estoqueMinimo) || 0,
        emListaManual: !!p.emListaManual, qtdDesejada: p.qtdDesejada ? Number(p.qtdDesejada) : null,
        referenciaPreco: referenciaPreco(p), avulso: !!p.avulso, qtdUltimaCompra: qtdUltimaCompra(p)
      };
    }).sort(ordenarPorCategoriaENome);

    // Catálogo: tudo menos avulsos, agrupado pelas categorias da família.
    APP.categorias.sort(function (a, b) { return a.localeCompare(b); });
    const agrupado = {};
    APP.categorias.forEach(function (c) { agrupado[c] = []; });
    APP.produtos.filter(function (p) { return !p.avulso; }).forEach(function (p) {
      const cat = p.categoria || 'Outros';
      if (!agrupado[cat]) agrupado[cat] = [];
      agrupado[cat].push({ id: p.id, nome: p.nome, categoria: cat, ativo: !!p.ativo, codigoBarras: p.codigoBarras || '' });
    });
    Object.keys(agrupado).forEach(function (cat) { agrupado[cat].sort(function (a, b) { return String(a.nome).localeCompare(String(b.nome)); }); });
    APP.catalogo = agrupado;

    // Carrinho: despensa + avulsos da lista.
    const idsDespensa = {};
    APP.despensa.forEach(function (p) { idsDespensa[p.id] = true; });
    APP.produtosCompraveis = APP.despensa.concat(APP.listaCompras.filter(function (p) { return p.avulso && !idsDespensa[p.id]; }));
  }

  function produto(id) { return APP.produtos.find(function (p) { return String(p.id) === String(id); }); }

  function buscarProdutoCompravel(id) {
    return APP.produtosCompraveis.find(function (p) { return String(p.id) === String(id); });
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

  function salvarCarrinho() {
    try { localStorage.setItem(chaveCarrinho(), JSON.stringify(APP.carrinho)); } catch (e) { /* ignora */ }
  }

  function lerCarrinho() {
    try { return JSON.parse(localStorage.getItem(chaveCarrinho()) || '[]'); } catch (e) { return []; }
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
    if (!confirm('Remover ' + email + ' da família?')) return;
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
    renderSelectProdutos();
    renderCatalogo();
    renderSelectCategorias();
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

  // ===================== DESPENSA =====================

  function renderDespensa() {
    const container = document.getElementById('despensa-lista');
    if (!APP.despensa.length) {
      container.innerHTML = `
        <div class="text-center py-16 px-4">
          <p class="text-4xl mb-2">🌿</p>
          <p class="text-sand-600 font-semibold mb-1">Sua despensa está vazia por aqui</p>
          <p class="text-sand-500 text-sm">Vá em <b>Catálogo</b> e ative os produtos que você costuma comprar.</p>
        </div>`;
      return;
    }

    const porCategoria = agruparPorCategoria(APP.despensa);
    container.innerHTML = Object.keys(porCategoria).sort().map(cat => `
      <div>
        <h3 class="text-xs font-extrabold text-sand-500 uppercase tracking-wide mb-2 px-1">${ICONE_CATEGORIA[cat] || '📦'} ${escapeHtml(cat)}</h3>
        <div class="space-y-2">
          ${porCategoria[cat].map(cardDespensaItem).join('')}
        </div>
      </div>
    `).join('');
  }

  function cardDespensaItem(p) {
    const baixo = p.baixoEstoque;
    return `
      <div class="bg-white rounded-2xl p-3 shadow-sm border ${baixo ? 'border-terracotta-300' : 'border-sand-100'} flex items-center gap-3">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5">
            <p class="font-bold text-sm text-sand-900 truncate">${escapeHtml(p.nome)}</p>
            ${baixo ? '<span class="shrink-0 bg-terracotta-100 text-terracotta-600 text-[10px] font-extrabold px-1.5 py-0.5 rounded-full">REPOR</span>' : ''}
          </div>
          ${p.referenciaPreco ? `<p class="text-[11px] text-sand-500 mt-0.5 truncate">Último pago: ${escapeHtml(p.referenciaPreco.texto)}</p>` : `<p class="text-[11px] text-sand-400 mt-0.5">Sem histórico de preço</p>`}
        </div>
        <button onclick="DespenseiApp.adicionarComoDesejo('${p.id}')" class="shrink-0 w-9 h-9 rounded-full bg-sand-50 text-sand-500 active:bg-sand-100 flex items-center justify-center" title="Adicionar à lista mesmo com estoque">📋</button>
        <div class="flex items-center gap-2.5 shrink-0">
          <button onclick="DespenseiApp.mudarEstoque('${p.id}', -1)" class="stepper-btn w-11 h-11 rounded-full bg-sand-100 text-sand-700 font-extrabold text-xl active:bg-sand-200 flex items-center justify-center">–</button>
          <span class="w-7 text-center font-extrabold text-lg ${baixo ? 'text-terracotta-600' : 'text-sage-700'}">${p.estoqueAtual}</span>
          <button onclick="DespenseiApp.mudarEstoque('${p.id}', 1)" class="stepper-btn w-11 h-11 rounded-full bg-sage-600 text-white font-extrabold text-xl active:bg-sage-700 flex items-center justify-center">+</button>
        </div>
      </div>`;
  }

  function mudarEstoque(idProduto, delta) {
    const p = produto(idProduto);
    if (!p) return;
    p.estoqueAtual = Math.max(0, (Number(p.estoqueAtual) || 0) + delta);
    p.ocultoDaLista = false;
    mudouLocal();
    DespenseiApi.enfileirar('atualizar_estoque', { p_produto_id: Number(p.id), p_delta: delta }, 'Estoque de ' + p.nome);
  }

  // Adicionar à lista mesmo com estoque, sugerindo a quantidade da última compra.
  function adicionarComoDesejo(idProduto) {
    const p = produto(idProduto);
    if (!p) return;
    const sugestao = qtdUltimaCompra(p) || '';
    const valor = window.prompt(
      `Quantidade desejada de "${p.nome}"${sugestao ? ' (última vez você comprou ' + sugestao + ')' : ''}:`,
      sugestao || '1'
    );
    if (valor === null) return;
    const qtd = parseInt(valor, 10);
    p.emListaManual = true;
    p.qtdDesejada = isNaN(qtd) || qtd === 0 ? null : qtd;
    p.ocultoDaLista = false;
    mudouLocal();
    DespenseiApi.enfileirar('adicionar_item_manual_lista',
      { p_produto_id: Number(p.id), p_qtd_desejada: isNaN(qtd) ? null : qtd }, p.nome + ' na lista');
    showToast(p.nome + ' adicionado à lista de compras!');
  }

  // ===================== LISTA DE COMPRAS =====================

  function renderListaCompras() {
    const container = document.getElementById('lista-compras');
    if (!APP.listaCompras.length) {
      container.innerHTML = `
        <div class="text-center py-16 px-4">
          <p class="text-4xl mb-2">✅</p>
          <p class="text-sand-600 font-semibold">Nada em falta por enquanto!</p>
        </div>`;
      return;
    }

    const porCategoria = agruparPorCategoria(APP.listaCompras);
    container.innerHTML = Object.keys(porCategoria).sort().map(cat => `
      <div>
        <h3 class="text-xs font-extrabold text-sand-500 uppercase tracking-wide mb-2 px-1">${ICONE_CATEGORIA[cat] || '📦'} ${escapeHtml(cat)}</h3>
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
          ${!p.avulso ? `<p class="text-[11px] text-sand-500 mt-0.5">Estoque: ${p.estoqueAtual}/${p.estoqueMinimo}</p>` : ''}
          ${p.referenciaPreco ? `<p class="text-[11px] text-sage-700 mt-0.5 font-semibold truncate">Último pago: ${escapeHtml(p.referenciaPreco.texto)}</p>` : `<p class="text-[11px] text-sand-400 mt-0.5">Sem histórico de preço</p>`}
          ${p.qtdUltimaCompra ? `<p class="text-[11px] text-sand-500 mt-0.5">Última vez você comprou: <b>${p.qtdUltimaCompra}</b></p>` : ''}
        </div>
        <button onclick="DespenseiApp.adicionarRapidoAoCarrinho('${p.id}')" class="shrink-0 bg-sage-100 text-sage-700 font-bold rounded-xl px-3 py-2 text-xs active:scale-95 transition">+ Carrinho</button>
        <button onclick="DespenseiApp.removerItemLista('${p.id}')" class="shrink-0 w-8 h-8 rounded-full bg-terracotta-50 text-terracotta-600 font-bold active:bg-terracotta-100 flex items-center justify-center" aria-label="Remover da lista">✕</button>
      </div>`;
  }

  function removerItemLista(idProduto) {
    const p = produto(idProduto);
    if (!p) return;
    if (p.avulso) {
      APP.produtos = APP.produtos.filter(function (x) { return x !== p; });
      APP.carrinho = APP.carrinho.filter(function (i) { return String(i.idProduto) !== String(idProduto); });
      salvarCarrinho();
    } else {
      p.emListaManual = false;
      p.qtdDesejada = null;
      p.ocultoDaLista = true;
    }
    mudouLocal();
    DespenseiApi.enfileirar('remover_item_manual_lista', { p_produto_id: Number(p.id) }, p.nome + ' fora da lista');
    showToast('Removido da lista.');
  }

  function adicionarRapidoAoCarrinho(idProduto) {
    const p = buscarProdutoCompravel(idProduto);
    if (!p) return;

    const existente = APP.carrinho.find(i => String(i.idProduto) === String(idProduto));
    if (existente) {
      existente.quantidade += 1;
    } else {
      APP.carrinho.push({
        idProduto: p.id,
        nome: p.nome,
        quantidade: p.qtdUltimaCompra || 1,
        precoUnitario: p.referenciaPreco ? p.referenciaPreco.preco : 0,
        marca: p.referenciaPreco ? p.referenciaPreco.marca : ''
      });
    }
    salvarCarrinho();
    renderCarrinho();
    atualizarBadges();
    showToast(p.nome + ' adicionado ao carrinho');
    switchTab('carrinho');
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

  function renderSelectProdutos() {
    const sel = document.getElementById('select-produto');
    const atual = sel.value;
    const porCategoria = agruparPorCategoria(APP.produtosCompraveis);
    sel.innerHTML = '<option value="">Selecione um item…</option>' +
      Object.keys(porCategoria).sort().map(cat => `
        <optgroup label="${ICONE_CATEGORIA[cat] || ''} ${escapeHtml(cat)}">
          ${porCategoria[cat].map(p => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('')}
        </optgroup>
      `).join('');
    if (atual) sel.value = atual;
  }

  function aoSelecionarProduto() {
    const id = document.getElementById('select-produto').value;
    const p = buscarProdutoCompravel(id);
    document.getElementById('input-qtd').value = (p && p.qtdUltimaCompra) || 1;
    if (p && p.referenciaPreco) {
      document.getElementById('input-preco').value = p.referenciaPreco.preco.toFixed(2);
      document.getElementById('input-marca').value = p.referenciaPreco.marca || '';
    } else {
      document.getElementById('input-preco').value = '';
      document.getElementById('input-marca').value = '';
    }
    document.getElementById('btn-vincular-codigo').classList.add('hidden');
    atualizarIndicadorPreco();
  }

  // Variação de preço em relação à última compra.
  function atualizarIndicadorPreco() {
    const idProduto = document.getElementById('select-produto').value;
    const p = buscarProdutoCompravel(idProduto);
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

  function adicionarItemCarrinho() {
    const idProduto = document.getElementById('select-produto').value;
    const p = buscarProdutoCompravel(idProduto);
    const preco = parseFloat(document.getElementById('input-preco').value);
    const qtd = parseInt(document.getElementById('input-qtd').value, 10) || 1;
    const marca = document.getElementById('input-marca').value.trim();

    if (!p) { showToast('Selecione um produto.', 'erro'); return; }
    if (isNaN(preco) || preco < 0) { showToast('Informe um preço válido.', 'erro'); return; }

    const existente = APP.carrinho.find(i => String(i.idProduto) === String(idProduto));
    if (existente) {
      existente.quantidade += qtd;
      existente.precoUnitario = preco;
      existente.marca = marca;
    } else {
      APP.carrinho.push({ idProduto: p.id, nome: p.nome, quantidade: qtd, precoUnitario: preco, marca: marca });
    }

    document.getElementById('select-produto').value = '';
    document.getElementById('input-preco').value = '';
    document.getElementById('input-qtd').value = 1;
    document.getElementById('input-marca').value = '';
    document.getElementById('indicador-preco').textContent = '';
    document.getElementById('btn-vincular-codigo').classList.add('hidden');
    codigoBarrasPendente = null;

    salvarCarrinho();
    renderCarrinho();
    atualizarBadges();
    showToast(p.nome + ' adicionado!');
  }

  function removerItemCarrinho(idProduto) {
    APP.carrinho = APP.carrinho.filter(i => String(i.idProduto) !== String(idProduto));
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
          <p class="font-bold text-sm text-sand-900 truncate">${escapeHtml(i.nome)}${i.marca ? ` <span class="text-sand-400 font-normal">(${escapeHtml(i.marca)})</span>` : ''}</p>
          <p class="text-[11px] text-sand-500">${i.quantidade} × ${formatMoeda(i.precoUnitario)} = <b class="text-sage-700">${formatMoeda(i.quantidade * i.precoUnitario)}</b></p>
        </div>
        <button onclick="DespenseiApp.removerItemCarrinho('${i.idProduto}')" class="shrink-0 w-9 h-9 rounded-full bg-terracotta-50 text-terracotta-600 font-bold active:bg-terracotta-100 flex items-center justify-center">✕</button>
      </div>
    `).join('');
  }

  async function promptNovoEstabelecimento() {
    const nome = window.prompt('Nome do novo estabelecimento:');
    if (!nome || !nome.trim()) return;
    await criarEstabelecimento(nome.trim(), true);
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
      APP.estabelecimentos.sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
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
      APP.ultimaQtd[String(p.id)] = it.quantidade;
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

  function abrirScanner() {
    DespenseiBarcode.iniciar(function (codigo) {
      codigo = String(codigo || '').trim();
      const p = APP.produtos.find(x => String(x.codigoBarras || '').trim() === codigo);
      if (p && buscarProdutoCompravel(p.id)) {
        document.getElementById('select-produto').value = p.id;
        aoSelecionarProduto();
        showToast(p.nome + ' reconhecido!');
      } else if (p) {
        showToast(p.nome + ' reconhecido, mas não está ativo na sua despensa. Ative-o no Catálogo.', 'erro');
      } else {
        codigoBarrasPendente = codigo;
        document.getElementById('btn-vincular-codigo').classList.remove('hidden');
        showToast('Código não reconhecido. Selecione o produto e toque em "Vincular código".', 'erro');
      }
    });
  }

  async function vincularCodigoPendente() {
    const idProduto = document.getElementById('select-produto').value;
    if (!idProduto) { showToast('Selecione um produto primeiro.', 'erro'); return; }
    if (!codigoBarrasPendente) return;

    showLoader();
    try {
      await chamarOnline('vincular_codigo_barras', { p_produto_id: Number(idProduto), p_codigo_barras: codigoBarrasPendente });
      const p = produto(idProduto);
      if (p) p.codigoBarras = codigoBarrasPendente;
      mudouLocal({ render: false });
      showToast('Código vinculado!');
      codigoBarrasPendente = null;
      document.getElementById('btn-vincular-codigo').classList.add('hidden');
    } catch (err) {
      tratarErro(err);
    } finally {
      hideLoader();
    }
  }

  function abrirScannerParaEdicao() {
    DespenseiBarcode.iniciar(function (codigo) {
      document.getElementById('editar-produto-codigo-barras').value = codigo;
    });
  }

  // ===================== CATÁLOGO / CONFIGURAÇÕES =====================

  function renderSelectCategorias() {
    const sel = document.getElementById('novo-produto-categoria');
    const atual = sel.value;
    sel.innerHTML = APP.categorias.map(c => `<option value="${escapeHtml(c)}">${ICONE_CATEGORIA[c] || ''} ${escapeHtml(c)}</option>`).join('');
    if (atual) sel.value = atual;
  }

  function renderCatalogo() {
    const filtro = (document.getElementById('filtro-catalogo').value || '').toLowerCase().trim();
    const container = document.getElementById('catalogo-lista');
    const abertas = {};
    container.querySelectorAll('details[open]').forEach(d => { abertas[d.dataset.categoria] = true; });

    container.innerHTML = APP.categorias.map(cat => {
      const itens = (APP.catalogo[cat] || []).filter(p => !filtro || String(p.nome).toLowerCase().includes(filtro));
      if (!itens.length) return '';
      const ativos = itens.filter(p => p.ativo).length;
      return `
        <details class="bg-white rounded-2xl shadow-sm border border-sand-100 overflow-hidden" data-categoria="${escapeHtml(cat)}" ${filtro || abertas[cat] ? 'open' : ''}>
          <summary class="flex items-center justify-between px-3.5 py-3 cursor-pointer active:bg-sand-50">
            <span class="font-extrabold text-sm text-sand-800">${ICONE_CATEGORIA[cat] || '📦'} ${escapeHtml(cat)}</span>
            <span class="flex items-center gap-2">
              <span class="cat-badge text-[11px] text-sand-400 font-semibold">${ativos}/${itens.length}</span>
              <svg class="chev w-3.5 h-3.5 text-sand-400 transition-transform" viewBox="0 0 12 8" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            </span>
          </summary>
          <div class="border-t border-sand-100 divide-y divide-sand-50">
            ${itens.map(linhaCatalogoItem).join('')}
          </div>
        </details>`;
    }).join('');
  }

  function linhaCatalogoItem(p) {
    return `
      <div class="flex items-center justify-between px-3.5 py-2.5 gap-2">
        <span class="text-sm text-sand-800 ${p.ativo ? 'font-semibold' : ''} truncate pr-1">${escapeHtml(p.nome)}</span>
        <div class="flex items-center gap-3 shrink-0">
          <button onclick="DespenseiApp.abrirModalEditar('${p.id}')" class="text-sand-400 active:text-sage-600 p-1 -m-1" aria-label="Editar produto">✏️</button>
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" class="sr-only peer" ${p.ativo ? 'checked' : ''} onchange="DespenseiApp.toggleProdutoAtivo('${p.id}', this.checked)">
            <div class="w-10 h-[22px] bg-sand-200 rounded-full peer-checked:bg-sage-600 transition-colors relative
              after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-[18px] after:h-[18px] after:rounded-full after:shadow after:transition-transform peer-checked:after:translate-x-[18px]"></div>
          </label>
        </div>
      </div>`;
  }

  function toggleProdutoAtivo(idProduto, ativo) {
    const p = produto(idProduto);
    if (!p) return;
    p.ativo = !!ativo;
    geracaoLocal++;
    recalcular();
    salvarCache();
    // Não redesenha o catálogo inteiro (o usuário está no meio dele): só o contador da categoria.
    renderDespensa();
    renderListaCompras();
    renderSelectProdutos();
    atualizarBadges();
    const cat = p.categoria || 'Outros';
    const details = document.querySelector(`details[data-categoria="${CSS.escape(cat)}"]`);
    const badge = details && details.querySelector('.cat-badge');
    if (badge) {
      const itens = APP.catalogo[cat] || [];
      badge.textContent = `${itens.filter(x => x.ativo).length}/${itens.length}`;
    }
    DespenseiApi.enfileirar('alternar_produto_ativo', { p_produto_id: Number(p.id), p_ativo: !!ativo }, p.nome + (ativo ? ' ativado' : ' desativado'));
  }

  function abrirModalEditar(idProduto) {
    const p = produto(idProduto);
    if (!p) return;

    idProdutoEmEdicao = idProduto;
    document.getElementById('editar-produto-nome').value = p.nome;
    document.getElementById('editar-produto-codigo-barras').value = p.codigoBarras || '';

    const sel = document.getElementById('editar-produto-categoria');
    sel.innerHTML = APP.categorias.map(c => `<option value="${escapeHtml(c)}">${ICONE_CATEGORIA[c] || ''} ${escapeHtml(c)}</option>`).join('');
    sel.value = p.categoria;

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
    const codigoBarras = document.getElementById('editar-produto-codigo-barras').value.trim();
    if (!nome) { showToast('Digite o nome do produto.', 'erro'); return; }

    showLoader();
    try {
      const atualizado = await chamarOnline('editar_produto', { p_produto_id: Number(idProdutoEmEdicao), p_nome: nome, p_categoria: categoria });
      const p = produto(idProdutoEmEdicao);
      if (codigoBarras && codigoBarras !== (p && p.codigoBarras)) {
        await DespenseiApi.rpc('vincular_codigo_barras', { p_produto_id: Number(idProdutoEmEdicao), p_codigo_barras: codigoBarras });
        atualizado.codigoBarras = codigoBarras;
      }
      if (p) Object.assign(p, { nome: atualizado.nome, categoria: atualizado.categoria, codigoBarras: atualizado.codigoBarras });
      mudouLocal();
      fecharModalEditar();
      showToast('Produto atualizado!');
    } catch (err) {
      tratarErro(err, 'Erro ao salvar: ');
    } finally {
      hideLoader();
    }
  }

  async function adicionarProdutoPersonalizado() {
    const nomeInput = document.getElementById('novo-produto-nome');
    const nome = nomeInput.value.trim();
    const categoria = document.getElementById('novo-produto-categoria').value;
    if (!nome) { showToast('Digite o nome do produto.', 'erro'); return; }

    showLoader();
    try {
      const novo = await chamarOnline('adicionar_produto_personalizado', { p_nome: nome, p_categoria: categoria });
      APP.produtos.push(novo);
      mudouLocal();
      nomeInput.value = '';
      showToast('Produto adicionado ao catálogo!');
    } catch (err) {
      tratarErro(err);
    } finally {
      hideLoader();
    }
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
    adicionarComoDesejo,
    adicionarItemAvulso,
    adicionarRapidoAoCarrinho,
    removerItemLista,
    aoSelecionarProduto,
    atualizarIndicadorPreco,
    ajustarQtdForm,
    adicionarItemCarrinho,
    removerItemCarrinho,
    promptNovoEstabelecimento,
    adicionarEstabelecimentoForm,
    finalizarCompra,
    abrirScanner,
    vincularCodigoPendente,
    abrirScannerParaEdicao,
    renderCatalogo,
    toggleProdutoAtivo,
    abrirModalEditar,
    fecharModalEditar,
    salvarEdicaoProduto,
    adicionarProdutoPersonalizado,
    adicionarCategoria
  };
})();

window.DespenseiApp = DespenseiApp;
