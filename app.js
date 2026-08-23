// ===================== DESPENSEI — LÓGICA DA NOVA INTERFACE =====================
// Porta a UI do Index.html legado (que rodava dentro do Apps Script via
// google.script.run) pro front-end estático novo, consumindo a API JSON via
// chamarApi() (web/api.js) com identidade por Google Sign-In (web/auth.js).
// Acrescenta as sugestões "plus" do blueprint: item avulso, sugestão de
// quantidade por histórico, indicador de variação de preço e leitor de
// código de barras (web/barcode.js).

const DespenseiApp = (function () {
  const APP = {
    despensa: [],
    listaCompras: [],
    estabelecimentos: [],
    catalogo: {},
    categorias: [],
    carrinho: [], // { idProduto, nome, quantidade, precoUnitario, marca }
    produtosCompraveis: [], // despensa + itens avulsos da lista (ver atualizarProdutosCompraveis)
    familia: null
  };

  let codigoBarrasPendente = null;
  let idProdutoEmEdicao = null;
  let toastTimer = null;

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
  }

  // Preenche os códigos automaticamente quando o app é aberto por um link de
  // ativação (?ativacao=CODIGO) ou de convite de família (?convite=CODIGO),
  // pra quem recebeu o link não precisar copiar/colar nada na mão.
  function preencherCodigosDaUrl_() {
    const params = new URLSearchParams(location.search);
    const ativacao = params.get('ativacao');
    const convite = params.get('convite');
    if (ativacao) document.getElementById('familia-codigo-ativacao').value = ativacao.toUpperCase();
    if (convite) document.getElementById('familia-codigo').value = convite.toUpperCase();
  }

  // Preenche e-mail (só exibição) e nome completo (editável) a partir da conta
  // Google usada no login, pra reduzir digitação no cadastro básico.
  function preencherDadosPessoais_() {
    const elEmail = document.getElementById('familia-email-login');
    if (elEmail) elEmail.textContent = DespenseiAuth.getEmail() || '';
    const elNome = document.getElementById('familia-nome-completo');
    if (elNome && !elNome.value) elNome.value = DespenseiAuth.getNome() || '';
  }

  // ===================== LOGIN / FAMÍLIA =====================

  async function aoLogar() {
    showLoader();
    try {
      const dados = await chamarApi('bootstrap', {});
      aoReceberEstado(dados);
    } catch (err) {
      showToast('Erro ao entrar: ' + (err.message || err), 'erro');
      if (err.eSessaoInvalida) DespenseiAuth.pedirNovoLogin();
    } finally {
      hideLoader();
    }
  }

  function aoReceberEstado(dados) {
    if (dados.estado === 'sem_familia') {
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
    APP.despensa = dados.despensa;
    APP.listaCompras = dados.listaCompras;
    APP.estabelecimentos = dados.estabelecimentos;
    APP.catalogo = dados.catalogo;
    APP.categorias = dados.categorias;
    atualizarProdutosCompraveis();
    mostrarView('app');
    renderTudo();
    carregarInfoFamilia();
    const elEmailConfig = document.getElementById('config-email-logado');
    if (elEmailConfig) elEmailConfig.textContent = DespenseiAuth.getEmail() || '';
  }

  function lerDadosPessoais_() {
    const nomeCompleto = document.getElementById('familia-nome-completo').value.trim();
    const telefone = document.getElementById('familia-telefone-cadastro').value.trim();
    if (!nomeCompleto) { showToast('Digite seu nome completo.', 'erro'); return null; }
    return { nomeCompleto: nomeCompleto, telefone: telefone };
  }

  async function criarFamilia() {
    const nome = document.getElementById('familia-nome').value.trim();
    const codigoAtivacao = document.getElementById('familia-codigo-ativacao').value.trim();
    const dadosPessoais = lerDadosPessoais_();
    if (!dadosPessoais) return;
    showLoader();
    try {
      const dados = await chamarApi('criarFamilia', {
        nome: nome, codigoAtivacao: codigoAtivacao,
        nomeCompleto: dadosPessoais.nomeCompleto, telefone: dadosPessoais.telefone
      });
      showToast(codigoAtivacao
        ? 'Família criada com sucesso!'
        : 'Família criada! Você tem 14 dias de teste grátis — o código de acesso foi enviado para o seu e-mail.');
      aoReceberEstado(dados);
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
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
      const dados = await chamarApi('entrarFamiliaComCodigo', {
        codigo: codigo, nomeCompleto: dadosPessoais.nomeCompleto, telefone: dadosPessoais.telefone
      });
      aoReceberEstado(dados);
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
    } finally {
      hideLoader();
    }
  }

  async function carregarInfoFamilia() {
    try {
      const info = await chamarApi('getInfoFamilia', {});
      APP.familia = info;
      document.getElementById('header-familia-nome').textContent = info.nome;
      document.getElementById('familia-info-nome').textContent = info.nome;
      document.getElementById('familia-info-codigo').textContent = info.codigoConvite;
      document.getElementById('familia-info-vagas').textContent = info.membros.length + '/' + info.limiteMembros;

      const meuEmail = DespenseiAuth.getEmail();
      const meuMembro = info.membros.find(function (m) { return m.email === meuEmail; });
      if (meuMembro && meuMembro.telefone) document.getElementById('meu-telefone').value = meuMembro.telefone;

      document.getElementById('familia-info-membros').innerHTML = info.membros.map(function (m) {
        const podeRemover = info.souAdmin && m.email !== meuEmail;
        return `<p class="text-xs text-sand-600 flex items-center justify-between gap-2">
          <span>${m.papel === 'admin' ? '👑' : '•'} ${escapeHtml(m.email)}${m.telefone ? ' <span class="text-sage-600">📱</span>' : ''}</span>
          ${podeRemover ? `<button onclick="DespenseiApp.removerMembro('${escapeHtml(m.email)}')" class="text-terracotta-600 text-[11px] font-bold shrink-0">remover</button>` : ''}
        </p>`;
      }).join('');

      document.getElementById('familia-convite-admin').classList.toggle('hidden', !info.souAdmin);
      document.getElementById('familia-convites-pendentes').innerHTML = (info.convitesPendentes || []).map(function (email) {
        return `<p class="text-xs text-sand-400 flex items-center justify-between gap-2">
          <span>⏳ ${escapeHtml(email)} (convite pendente)</span>
          <button onclick="DespenseiApp.cancelarConvite('${escapeHtml(email)}')" class="text-terracotta-600 text-[11px] font-bold shrink-0">cancelar</button>
        </p>`;
      }).join('');
    } catch (err) {
      // tela de família não é crítica pro resto do app — não bloqueia em caso de erro
    }
  }

  async function removerMembro(email) {
    if (!confirm('Remover ' + email + ' da família?')) return;
    showLoader();
    try {
      await chamarApi('removerMembro', { emailAlvo: email });
      showToast('Membro removido.');
      await carregarInfoFamilia();
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
    } finally {
      hideLoader();
    }
  }

  async function cancelarConvite(email) {
    showLoader();
    try {
      await chamarApi('cancelarConvite', { emailConvidado: email });
      showToast('Convite cancelado.');
      await carregarInfoFamilia();
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
    } finally {
      hideLoader();
    }
  }

  async function convidarMembro() {
    const input = document.getElementById('familia-convite-email');
    const email = input.value.trim();
    if (!email) { showToast('Digite o e-mail da pessoa a convidar.', 'erro'); return; }
    showLoader();
    try {
      await chamarApi('convidarMembro', { emailConvidado: email });
      input.value = '';
      showToast('Convite enviado para ' + email + '!');
      await carregarInfoFamilia();
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
    } finally {
      hideLoader();
    }
  }

  async function salvarTelefone() {
    const telefone = document.getElementById('meu-telefone').value.trim();
    showLoader();
    try {
      await chamarApi('atualizarTelefone', { telefone: telefone });
      showToast('Telefone salvo!');
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
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
    renderDespensa();
    renderListaCompras();
    renderSelectEstabelecimentos();
    renderSelectProdutos();
    renderCatalogo();
    renderSelectCategorias();
    renderEstabelecimentosLista();
    renderCarrinho();
    atualizarBadges();
  }

  // Combina despensa (produtos normais ativos) + itens avulsos da lista (que não
  // entram na despensa, ver Codigo.gs) — sugestão "plus": item avulso precisa
  // poder ser escolhido no Carrinho igual a qualquer outro produto.
  function atualizarProdutosCompraveis() {
    const idsDespensa = {};
    APP.despensa.forEach(function (p) { idsDespensa[p.id] = true; });
    const avulsosDaLista = APP.listaCompras.filter(function (p) { return p.avulso && !idsDespensa[p.id]; });
    APP.produtosCompraveis = APP.despensa.concat(avulsosDaLista);
  }

  function buscarProdutoCompravel(id) {
    return APP.produtosCompraveis.find(function (p) { return String(p.id) === String(id); });
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
        <h3 class="text-xs font-extrabold text-sand-500 uppercase tracking-wide mb-2 px-1">${ICONE_CATEGORIA[cat] || '📦'} ${cat}</h3>
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
          ${p.referenciaPreco ? `<p class="text-[11px] text-sand-500 mt-0.5 truncate">Último pago: ${p.referenciaPreco.texto}</p>` : `<p class="text-[11px] text-sand-400 mt-0.5">Sem histórico de preço</p>`}
        </div>
        <button onclick="DespenseiApp.adicionarComoDesejo('${p.id}')" class="shrink-0 w-9 h-9 rounded-full bg-sand-50 text-sand-500 active:bg-sand-100 flex items-center justify-center" title="Adicionar à lista mesmo com estoque">📋</button>
        <div class="flex items-center gap-2.5 shrink-0">
          <button onclick="DespenseiApp.mudarEstoque('${p.id}', -1)" class="stepper-btn w-11 h-11 rounded-full bg-sand-100 text-sand-700 font-extrabold text-xl active:bg-sand-200 flex items-center justify-center">–</button>
          <span class="w-7 text-center font-extrabold text-lg ${baixo ? 'text-terracotta-600' : 'text-sage-700'}">${p.estoqueAtual}</span>
          <button onclick="DespenseiApp.mudarEstoque('${p.id}', 1)" class="stepper-btn w-11 h-11 rounded-full bg-sage-600 text-white font-extrabold text-xl active:bg-sage-700 flex items-center justify-center">+</button>
        </div>
      </div>`;
  }

  async function mudarEstoque(idProduto, delta) {
    const item = APP.despensa.find(p => String(p.id) === String(idProduto));
    if (!item) return;
    const anterior = item.estoqueAtual;
    item.estoqueAtual = Math.max(0, anterior + delta);
    item.baixoEstoque = item.estoqueAtual <= 0;
    renderDespensa();

    try {
      await chamarApi('atualizarEstoque', { idProduto: idProduto, delta: delta });
      APP.listaCompras = await chamarApi('getListaCompras', {});
      atualizarProdutosCompraveis();
      renderListaCompras();
      atualizarBadges();
    } catch (err) {
      item.estoqueAtual = anterior;
      renderDespensa();
      showToast('Não foi possível atualizar: ' + (err.message || err), 'erro');
    }
  }

  // Sugestão "plus": adicionar à lista mesmo com estoque, sugerindo a quantidade
  // da última compra desse produto (qtdUltimaCompra vem do backend).
  async function adicionarComoDesejo(idProduto) {
    const produto = APP.despensa.find(p => String(p.id) === String(idProduto));
    if (!produto) return;
    const sugestao = produto.qtdUltimaCompra || '';
    const valor = window.prompt(
      `Quantidade desejada de "${produto.nome}"${sugestao ? ' (última vez você comprou ' + sugestao + ')' : ''}:`,
      sugestao || '1'
    );
    if (valor === null) return;
    const qtd = parseInt(valor, 10);

    showLoader();
    try {
      await chamarApi('adicionarItemManualLista', { idProduto: idProduto, qtdDesejada: isNaN(qtd) ? '' : qtd });
      APP.listaCompras = await chamarApi('getListaCompras', {});
      atualizarProdutosCompraveis();
      renderListaCompras();
      atualizarBadges();
      showToast(produto.nome + ' adicionado à lista de compras!');
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
    } finally {
      hideLoader();
    }
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
        <h3 class="text-xs font-extrabold text-sand-500 uppercase tracking-wide mb-2 px-1">${ICONE_CATEGORIA[cat] || '📦'} ${cat}</h3>
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
          ${p.referenciaPreco ? `<p class="text-[11px] text-sage-700 mt-0.5 font-semibold truncate">Último pago: ${p.referenciaPreco.texto}</p>` : `<p class="text-[11px] text-sand-400 mt-0.5">Sem histórico de preço</p>`}
          ${p.qtdUltimaCompra ? `<p class="text-[11px] text-sand-500 mt-0.5">Última vez você comprou: <b>${p.qtdUltimaCompra}</b></p>` : ''}
        </div>
        <button onclick="DespenseiApp.adicionarRapidoAoCarrinho('${p.id}')" class="shrink-0 bg-sage-100 text-sage-700 font-bold rounded-xl px-3 py-2 text-xs active:scale-95 transition">+ Carrinho</button>
        <button onclick="DespenseiApp.removerItemLista('${p.id}')" class="shrink-0 w-8 h-8 rounded-full bg-terracotta-50 text-terracotta-600 font-bold active:bg-terracotta-100 flex items-center justify-center" aria-label="Remover da lista">✕</button>
      </div>`;
  }

  async function removerItemLista(idProduto) {
    showLoader();
    try {
      const resultado = await chamarApi('removerItemManualLista', { idProduto: idProduto });
      APP.listaCompras = resultado.listaCompras;
      atualizarProdutosCompraveis();
      renderListaCompras();
      renderSelectProdutos();
      atualizarBadges();
      showToast('Removido da lista.');
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
    } finally {
      hideLoader();
    }
  }

  function adicionarRapidoAoCarrinho(idProduto) {
    const produto = buscarProdutoCompravel(idProduto);
    if (!produto) return;

    const existente = APP.carrinho.find(i => String(i.idProduto) === String(idProduto));
    if (existente) {
      existente.quantidade += 1;
    } else {
      APP.carrinho.push({
        idProduto: produto.id,
        nome: produto.nome,
        quantidade: produto.qtdUltimaCompra || 1,
        precoUnitario: produto.referenciaPreco ? produto.referenciaPreco.preco : 0,
        marca: produto.referenciaPreco ? produto.referenciaPreco.marca : ''
      });
    }
    renderCarrinho();
    atualizarBadges();
    showToast(produto.nome + ' adicionado ao carrinho');
    switchTab('carrinho');
  }

  // Sugestão "plus": item pontual, sem categoria travada — some da lista assim
  // que comprado (ver finalizarCompra em Codigo.gs), não vira cadastro permanente.
  async function adicionarItemAvulso() {
    const input = document.getElementById('novo-item-avulso');
    const nome = input.value.trim();
    if (!nome) { showToast('Digite o nome do item.', 'erro'); return; }

    showLoader();
    try {
      await chamarApi('adicionarItemAvulso', { nome: nome });
      APP.listaCompras = await chamarApi('getListaCompras', {});
      atualizarProdutosCompraveis();
      renderListaCompras();
      renderSelectProdutos();
      atualizarBadges();
      input.value = '';
      showToast(`"${nome}" adicionado à lista!`);
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
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
    const porCategoria = agruparPorCategoria(APP.produtosCompraveis);
    sel.innerHTML = '<option value="">Selecione um item…</option>' +
      Object.keys(porCategoria).sort().map(cat => `
        <optgroup label="${ICONE_CATEGORIA[cat] || ''} ${cat}">
          ${porCategoria[cat].map(p => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('')}
        </optgroup>
      `).join('');
  }

  function aoSelecionarProduto() {
    const id = document.getElementById('select-produto').value;
    const produto = buscarProdutoCompravel(id);
    document.getElementById('input-qtd').value = (produto && produto.qtdUltimaCompra) || 1;
    if (produto && produto.referenciaPreco) {
      document.getElementById('input-preco').value = produto.referenciaPreco.preco.toFixed(2);
      document.getElementById('input-marca').value = produto.referenciaPreco.marca || '';
    } else {
      document.getElementById('input-preco').value = '';
      document.getElementById('input-marca').value = '';
    }
    document.getElementById('btn-vincular-codigo').classList.add('hidden');
    atualizarIndicadorPreco();
  }

  // Sugestão "plus": indicador de variação de preço em relação à última compra.
  function atualizarIndicadorPreco() {
    const idProduto = document.getElementById('select-produto').value;
    const produto = buscarProdutoCompravel(idProduto);
    const el = document.getElementById('indicador-preco');
    const precoDigitado = parseFloat(document.getElementById('input-preco').value);

    if (!produto || !produto.referenciaPreco || isNaN(precoDigitado)) {
      el.textContent = '';
      return;
    }

    const diff = precoDigitado - produto.referenciaPreco.preco;
    if (Math.abs(diff) < 0.005) {
      el.textContent = 'Mesmo preço da última compra.';
      el.className = 'text-[11px] mt-1 text-sand-400';
      return;
    }
    const subiu = diff > 0;
    el.textContent = `${subiu ? '▲' : '▼'} ${formatMoeda(Math.abs(diff))} ${subiu ? 'a mais' : 'a menos'} que da última vez (${formatMoeda(produto.referenciaPreco.preco)})`;
    el.className = 'text-[11px] mt-1 font-semibold ' + (subiu ? 'text-terracotta-600' : 'text-sage-700');
  }

  function ajustarQtdForm(delta) {
    const input = document.getElementById('input-qtd');
    const novo = Math.max(1, (parseInt(input.value, 10) || 1) + delta);
    input.value = novo;
  }

  function adicionarItemCarrinho() {
    const idProduto = document.getElementById('select-produto').value;
    const produto = buscarProdutoCompravel(idProduto);
    const preco = parseFloat(document.getElementById('input-preco').value);
    const qtd = parseInt(document.getElementById('input-qtd').value, 10) || 1;
    const marca = document.getElementById('input-marca').value.trim();

    if (!produto) { showToast('Selecione um produto.', 'erro'); return; }
    if (isNaN(preco) || preco < 0) { showToast('Informe um preço válido.', 'erro'); return; }

    const existente = APP.carrinho.find(i => String(i.idProduto) === String(idProduto));
    if (existente) {
      existente.quantidade += qtd;
      existente.precoUnitario = preco;
      existente.marca = marca;
    } else {
      APP.carrinho.push({ idProduto: produto.id, nome: produto.nome, quantidade: qtd, precoUnitario: preco, marca: marca });
    }

    document.getElementById('select-produto').value = '';
    document.getElementById('input-preco').value = '';
    document.getElementById('input-qtd').value = 1;
    document.getElementById('input-marca').value = '';
    document.getElementById('indicador-preco').textContent = '';
    document.getElementById('btn-vincular-codigo').classList.add('hidden');
    codigoBarrasPendente = null;

    renderCarrinho();
    atualizarBadges();
    showToast(produto.nome + ' adicionado!');
  }

  function removerItemCarrinho(idProduto) {
    APP.carrinho = APP.carrinho.filter(i => String(i.idProduto) !== String(idProduto));
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
    await criarEstabelecimento(nome, false);
    input.value = '';
  }

  async function criarEstabelecimento(nome, selecionar) {
    showLoader();
    try {
      const novo = await chamarApi('adicionarEstabelecimento', { nome: nome });
      APP.estabelecimentos.push(novo);
      renderSelectEstabelecimentos();
      renderEstabelecimentosLista();
      if (selecionar) document.getElementById('select-estabelecimento').value = novo.id;
      showToast('Estabelecimento adicionado!');
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
    } finally {
      hideLoader();
    }
  }

  async function finalizarCompra() {
    const idLocal = document.getElementById('select-estabelecimento').value;
    if (!idLocal) { showToast('Selecione o estabelecimento.', 'erro'); return; }
    if (!APP.carrinho.length) { showToast('Carrinho vazio.', 'erro'); return; }

    showLoader();
    try {
      const itensPayload = APP.carrinho.map(i => ({
        idProduto: i.idProduto, quantidade: i.quantidade, precoUnitario: i.precoUnitario, marca: i.marca
      }));
      const resultado = await chamarApi('finalizarCompra', { idLocal: idLocal, itens: itensPayload });
      APP.despensa = resultado.despensa;
      APP.listaCompras = resultado.listaCompras;
      APP.carrinho = [];
      atualizarProdutosCompraveis();
      renderDespensa();
      renderListaCompras();
      renderSelectProdutos();
      renderCarrinho();
      atualizarBadges();
      showToast('Compra finalizada: ' + formatMoeda(resultado.valorTotal) + ' 🎉');
      switchTab('despensa');
    } catch (err) {
      showToast('Erro ao finalizar: ' + (err.message || err), 'erro');
    } finally {
      hideLoader();
    }
  }

  // ===================== CÓDIGO DE BARRAS (sugestão "plus", carrinho) =====================

  function abrirScanner() {
    DespenseiBarcode.iniciar(async function (codigo) {
      showLoader();
      try {
        const produto = await chamarApi('buscarProdutoPorCodigoBarras', { codigoBarras: codigo });
        if (produto) {
          document.getElementById('select-produto').value = produto.id;
          aoSelecionarProduto();
          showToast(produto.nome + ' reconhecido!');
        } else {
          codigoBarrasPendente = codigo;
          document.getElementById('btn-vincular-codigo').classList.remove('hidden');
          showToast('Código não reconhecido. Selecione o produto e toque em "Vincular código".', 'erro');
        }
      } catch (err) {
        showToast('Erro ao buscar produto: ' + (err.message || err), 'erro');
      } finally {
        hideLoader();
      }
    });
  }

  async function vincularCodigoPendente() {
    const idProduto = document.getElementById('select-produto').value;
    if (!idProduto) { showToast('Selecione um produto primeiro.', 'erro'); return; }
    if (!codigoBarrasPendente) return;

    showLoader();
    try {
      await chamarApi('vincularCodigoBarras', { idProduto: idProduto, codigoBarras: codigoBarrasPendente });
      showToast('Código vinculado!');
      codigoBarrasPendente = null;
      document.getElementById('btn-vincular-codigo').classList.add('hidden');
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
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
    sel.innerHTML = APP.categorias.map(c => `<option value="${c}">${ICONE_CATEGORIA[c] || ''} ${c}</option>`).join('');
  }

  function renderCatalogo() {
    const filtro = (document.getElementById('filtro-catalogo').value || '').toLowerCase().trim();
    const container = document.getElementById('catalogo-lista');

    container.innerHTML = APP.categorias.map(cat => {
      const itens = (APP.catalogo[cat] || []).filter(p => !filtro || p.nome.toLowerCase().includes(filtro));
      if (!itens.length) return '';
      const ativos = itens.filter(p => p.ativo).length;
      return `
        <details class="bg-white rounded-2xl shadow-sm border border-sand-100 overflow-hidden" data-categoria="${cat}" ${filtro ? 'open' : ''}>
          <summary class="flex items-center justify-between px-3.5 py-3 cursor-pointer active:bg-sand-50">
            <span class="font-extrabold text-sm text-sand-800">${ICONE_CATEGORIA[cat] || '📦'} ${cat}</span>
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
            <input type="checkbox" class="sr-only peer" ${p.ativo ? 'checked' : ''} onchange="DespenseiApp.toggleProdutoAtivo('${p.id}', this.checked, this)">
            <div class="w-10 h-[22px] bg-sand-200 rounded-full peer-checked:bg-sage-600 transition-colors relative
              after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-[18px] after:h-[18px] after:rounded-full after:shadow after:transition-transform peer-checked:after:translate-x-[18px]"></div>
          </label>
        </div>
      </div>`;
  }

  async function toggleProdutoAtivo(idProduto, ativo, checkboxEl) {
    try {
      await chamarApi('alternarProdutoAtivo', { idProduto: idProduto, ativo: ativo });

      let categoriaAlterada = null;
      Object.keys(APP.catalogo).forEach(cat => {
        const item = APP.catalogo[cat].find(p => String(p.id) === String(idProduto));
        if (item) { item.ativo = ativo; categoriaAlterada = cat; }
      });

      APP.despensa = await chamarApi('getDespensaItens', {});
      APP.listaCompras = await chamarApi('getListaCompras', {});
      atualizarProdutosCompraveis();
      renderDespensa();
      renderListaCompras();
      renderSelectProdutos();
      atualizarBadges();

      if (categoriaAlterada) {
        const details = document.querySelector(`details[data-categoria="${CSS.escape(categoriaAlterada)}"]`);
        const badge = details && details.querySelector('.cat-badge');
        if (badge) {
          const itens = APP.catalogo[categoriaAlterada] || [];
          const ativos = itens.filter(p => p.ativo).length;
          badge.textContent = `${ativos}/${itens.length}`;
        }
      }
    } catch (err) {
      showToast('Erro ao atualizar: ' + (err.message || err), 'erro');
      if (checkboxEl) checkboxEl.checked = !ativo;
    }
  }

  function abrirModalEditar(idProduto) {
    let produto = null;
    Object.keys(APP.catalogo).forEach(cat => {
      const item = APP.catalogo[cat].find(p => String(p.id) === String(idProduto));
      if (item) produto = item;
    });
    if (!produto) return;

    idProdutoEmEdicao = idProduto;
    document.getElementById('editar-produto-nome').value = produto.nome;
    document.getElementById('editar-produto-codigo-barras').value = produto.codigoBarras || '';

    const sel = document.getElementById('editar-produto-categoria');
    sel.innerHTML = APP.categorias.map(c => `<option value="${c}">${ICONE_CATEGORIA[c] || ''} ${c}</option>`).join('');
    sel.value = produto.categoria;

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
      await chamarApi('editarProduto', { idProduto: idProdutoEmEdicao, nome: nome, categoria: categoria });
      if (codigoBarras) {
        await chamarApi('vincularCodigoBarras', { idProduto: idProdutoEmEdicao, codigoBarras: codigoBarras });
      }

      let ativoAtual = true;
      Object.keys(APP.catalogo).forEach(cat => {
        const idx = APP.catalogo[cat].findIndex(p => String(p.id) === String(idProdutoEmEdicao));
        if (idx !== -1) {
          ativoAtual = APP.catalogo[cat][idx].ativo;
          APP.catalogo[cat].splice(idx, 1);
        }
      });
      if (!APP.catalogo[categoria]) APP.catalogo[categoria] = [];
      APP.catalogo[categoria].push({ id: idProdutoEmEdicao, nome: nome, categoria: categoria, ativo: ativoAtual, codigoBarras: codigoBarras });
      APP.catalogo[categoria].sort((a, b) => a.nome.localeCompare(b.nome));

      APP.despensa = await chamarApi('getDespensaItens', {});
      APP.listaCompras = await chamarApi('getListaCompras', {});
      atualizarProdutosCompraveis();
      renderDespensa();
      renderListaCompras();
      renderSelectProdutos();
      renderCatalogo();
      atualizarBadges();

      fecharModalEditar();
      showToast('Produto atualizado!');
    } catch (err) {
      showToast('Erro ao salvar: ' + (err.message || err), 'erro');
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
      const novo = await chamarApi('adicionarProdutoPersonalizado', { nome: nome, categoria: categoria });
      if (!APP.catalogo[categoria]) APP.catalogo[categoria] = [];
      APP.catalogo[categoria].push(novo);
      APP.catalogo[categoria].sort((a, b) => a.nome.localeCompare(b.nome));
      APP.despensa = await chamarApi('getDespensaItens', {});
      atualizarProdutosCompraveis();
      renderDespensa();
      renderSelectProdutos();
      renderCatalogo();
      nomeInput.value = '';
      showToast('Produto adicionado ao catálogo!');
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
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
      await chamarApi('adicionarCategoria', { nome: nome });
      APP.categorias.push(nome);
      APP.categorias.sort((a, b) => a.localeCompare(b));
      if (!APP.catalogo[nome]) APP.catalogo[nome] = [];
      renderSelectCategorias();
      renderCatalogo();
      input.value = '';
      showToast(`Categoria "${nome}" criada!`);
    } catch (err) {
      showToast('Erro: ' + (err.message || err), 'erro');
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
