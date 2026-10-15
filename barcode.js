// ===================== LEITOR DE CÓDIGO DE BARRAS (câmera) =====================
// Duas formas de ler:
//  1) Ao vivo, pela câmera dentro do app: BarcodeDetector nativo (Android, se
//     suportar os formatos de produto) ou a biblioteca ZXing (iPhone e demais),
//     lendo a imagem inteira e também só o retângulo-guia ampliado.
//  2) Por foto (📸): abre a câmera normal do celular — que foca de perto como a
//     do app do banco — e o código é lido na foto tirada.
//
// Foco (v3.1.3): o navegador costuma entregar a lente ultra-angular, que não
// foca de perto. Por isso o app escolhe a lente principal, aplica zoom de 2×
// quando o aparelho permite (lê-se a uns 20–30 cm, onde há foco), pede foco ao
// tocar na imagem e deixa trocar de lente (🔄); a escolha fica guardada.
//
// Para não aceitar número errado:
//  - só formatos de produto: EAN-13, EAN-8, UPC-A, UPC-E;
//  - dígito verificador conferido (número inventado é descartado);
//  - ao vivo, só aceita depois de ler o MESMO número 2 vezes.
// E sempre dá pra digitar o código à mão.

const DespenseiBarcode = (function () {
  const FORMATOS_PRODUTO = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
  const LEITURAS_IGUAIS = 2;
  const CHAVE_CAMERA = 'despensei_camera_v1';

  let stream = null;
  let scanning = false;
  let onDetectCallback = null;
  let contagem = {};
  let lanternaLigada = false;
  let camerasTraseiras = [];
  let leitorZXing = null;

  // ----- validação do código -----

  function somaGtinValida(cod) {
    const d = cod.split('').map(Number);
    const dv = d.pop();
    let soma = 0;
    for (let i = d.length - 1, peso = 3; i >= 0; i--, peso = peso === 3 ? 1 : 3) soma += d[i] * peso;
    return (10 - (soma % 10)) % 10 === dv;
  }

  // UPC-E (8 dígitos) tem o dígito verificador calculado sobre o UPC-A expandido.
  function expandirUpcE(c) {
    const d = c.slice(1, 7);
    const ult = d[5];
    let meio;
    if (ult === '0' || ult === '1' || ult === '2') meio = d.slice(0, 2) + ult + '0000' + d.slice(2, 5);
    else if (ult === '3') meio = d.slice(0, 3) + '00000' + d.slice(3, 5);
    else if (ult === '4') meio = d.slice(0, 4) + '00000' + d[4];
    else meio = d.slice(0, 5) + '0000' + ult;
    return c[0] + meio + c[7];
  }

  function codigoValido(cod) {
    cod = String(cod || '');
    if (!/^\d+$/.test(cod)) return false;
    if (cod.length === 8) return somaGtinValida(cod) || ((cod[0] === '0' || cod[0] === '1') && somaGtinValida(expandirUpcE(cod)));
    if (cod.length === 12 || cod.length === 13 || cod.length === 14) return somaGtinValida(cod);
    return false;
  }

  // ----- motores de leitura -----

  async function formatosNativosSuportados() {
    if (!('BarcodeDetector' in window)) return [];
    try {
      const suportados = await BarcodeDetector.getSupportedFormats();
      return FORMATOS_PRODUTO.filter(function (f) { return suportados.indexOf(f) >= 0; });
    } catch (e) {
      return [];
    }
  }

  // ZXing só com formatos de produto e no modo "tentar com mais esforço".
  // (Números das listas internas da ZXing: POSSIBLE_FORMATS=2, TRY_HARDER=3;
  //  EAN_8=6, EAN_13=7, UPC_A=14, UPC_E=15.)
  function obterLeitorZXing() {
    if (leitorZXing || !window.ZXingBrowser) return leitorZXing;
    const dicas = new Map([[2, [6, 7, 14, 15]], [3, true]]);
    const Leitor = ZXingBrowser.BrowserMultiFormatOneDReader || ZXingBrowser.BrowserMultiFormatReader;
    try { leitorZXing = new Leitor(dicas); } catch (e) { leitorZXing = new Leitor(); }
    return leitorZXing;
  }

  function lerComZXing(canvas) {
    const leitor = obterLeitorZXing();
    if (!leitor) return null;
    try { return leitor.decodeFromCanvas(canvas).getText(); } catch (e) { return null; }
  }

  async function lerComNativo(detector, fonte) {
    try {
      const codigos = await detector.detect(fonte);
      return codigos.map(function (c) { return c.rawValue; });
    } catch (e) {
      return [];
    }
  }

  // ----- câmera -----

  function guardarCamera(id) { try { localStorage.setItem(CHAVE_CAMERA, id || ''); } catch (e) { /* ignora */ } }
  function cameraGuardada() { try { return localStorage.getItem(CHAVE_CAMERA) || ''; } catch (e) { return ''; } }

  // Lentes traseiras. A principal costuma ser a primeira da lista no Android
  // ("camera2 0, facing back"); ultra-angular, tele e macro ficam por último.
  async function listarCamerasTraseiras() {
    let todas = [];
    try { todas = (await navigator.mediaDevices.enumerateDevices()).filter(function (d) { return d.kind === 'videoinput'; }); } catch (e) { return []; }
    const frontal = /front|frontal|user|selfie|facetime/i;
    const secundaria = /ultra|wide|grande|tele|macro|depth|profund/i;
    const traseiras = todas.filter(function (d) { return !frontal.test(d.label || ''); });
    return traseiras.sort(function (a, b) {
      return (secundaria.test(a.label) ? 1 : 0) - (secundaria.test(b.label) ? 1 : 0);
    });
  }

  async function abrirStream(deviceId) {
    const video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = { ideal: 'environment' };
    return navigator.mediaDevices.getUserMedia({ audio: false, video: video });
  }

  async function ajustarTrilha(trilha) {
    const btnLanterna = document.getElementById('scanner-lanterna');
    let cap = {};
    try { cap = trilha.getCapabilities ? trilha.getCapabilities() : {}; } catch (e) { cap = {}; }
    const avancado = [];
    if (cap.focusMode && cap.focusMode.indexOf('continuous') >= 0) avancado.push({ focusMode: 'continuous' });
    // Zoom: lê-se de mais longe, onde a lente consegue focar.
    if (cap.zoom && cap.zoom.max >= 1.5) avancado.push({ zoom: Math.min(cap.zoom.max, 2) });
    for (let i = 0; i < avancado.length; i++) {
      try { await trilha.applyConstraints({ advanced: [avancado[i]] }); } catch (e) { /* aparelho não aceitou — segue */ }
    }
    btnLanterna.classList.toggle('hidden', !cap.torch);
  }

  async function iniciar(onDetect) {
    onDetectCallback = onDetect;
    contagem = {};
    lanternaLigada = false;
    const modal = document.getElementById('modal-scanner');
    const status = document.getElementById('scanner-status');
    document.getElementById('scanner-digitado').value = '';
    document.getElementById('scanner-lanterna').classList.add('hidden');
    document.getElementById('scanner-trocar').classList.add('hidden');
    document.getElementById('scanner-aovivo').classList.add('hidden');
    modal.classList.remove('hidden');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status.textContent = 'Este navegador não deixa usar a câmera aqui. Use "Tirar foto do código" ou digite o código abaixo.';
      return;
    }
    await ligarCamera(cameraGuardada());
  }

  async function ligarCamera(deviceId) {
    const video = document.getElementById('scanner-video');
    const status = document.getElementById('scanner-status');
    pararCamera_();
    status.textContent = 'Abrindo câmera…';

    try {
      stream = await abrirStream(deviceId);
    } catch (err) {
      if (deviceId) { guardarCamera(''); return ligarCamera(''); } // câmera guardada sumiu
      status.textContent = 'Não foi possível abrir a câmera. Use "Tirar foto do código" ou digite o código abaixo.';
      return;
    }

    // Na primeira vez (sem escolha guardada), troca para a lente principal se
    // o navegador tiver entregado outra.
    camerasTraseiras = await listarCamerasTraseiras();
    const trilha = stream.getVideoTracks()[0];
    const atual = (trilha.getSettings && trilha.getSettings().deviceId) || '';
    if (!deviceId && camerasTraseiras.length > 1 && camerasTraseiras[0].deviceId && atual !== camerasTraseiras[0].deviceId) {
      return ligarCamera(camerasTraseiras[0].deviceId);
    }
    document.getElementById('scanner-trocar').classList.toggle('hidden', camerasTraseiras.length < 2);

    await ajustarTrilha(trilha);
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* autoplay já cuida */ }
    scanning = true;
    status.textContent = 'Encaixe o código no retângulo, a uns 20 cm. Desfocado? Afaste um pouco ou toque na imagem.';
    loopLeitura_(video);
  }

  // Alterna entre a imagem inteira e o retângulo-guia ampliado (ajuda quando o
  // código está pequeno na imagem).
  async function loopLeitura_(video) {
    const formatos = await formatosNativosSuportados();
    const detector = formatos.length ? new BarcodeDetector({ formats: formatos }) : null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const minhaStream = stream;
    let quadro = 0;

    if (!detector && !obterLeitorZXing()) {
      document.getElementById('scanner-status').textContent = 'Leitura ao vivo indisponível neste aparelho. Use "Tirar foto do código" ou digite.';
      return;
    }

    while (scanning && stream === minhaStream) {
      if (video.readyState >= 2 && video.videoWidth) {
        quadro++;
        const usarRecorte = quadro % 2 === 0 || !detector;
        let codigos = [];
        if (usarRecorte) {
          recortarGuia_(video, canvas, ctx);
          if (detector) codigos = await lerComNativo(detector, canvas);
          if (!codigos.length) { const z = lerComZXing(canvas); if (z) codigos = [z]; }
        } else {
          codigos = await lerComNativo(detector, video);
        }
        codigos.forEach(function (c) { if (scanning) registrarLeitura_(c); });
      }
      await esperar_(90);
    }
  }

  // Copia para o canvas só a área do retângulo-guia (com folga), em tamanho bom
  // para leitura.
  function recortarGuia_(video, canvas, ctx) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const rv = video.getBoundingClientRect();
    const rg = document.getElementById('scanner-guia').getBoundingClientRect();
    const escala = Math.max(rv.width / vw, rv.height / vh); // object-fit: cover
    const ox = (rv.width - vw * escala) / 2, oy = (rv.height - vh * escala) / 2;
    const folgaX = rg.width * 0.15, folgaY = rg.height * 0.6;
    let x = (rg.left - rv.left - folgaX - ox) / escala;
    let y = (rg.top - rv.top - folgaY - oy) / escala;
    let w = (rg.width + 2 * folgaX) / escala;
    let h = (rg.height + 2 * folgaY) / escala;
    x = Math.max(0, x); y = Math.max(0, y);
    w = Math.min(vw - x, w); h = Math.min(vh - y, h);
    const alvoW = Math.min(1600, Math.max(800, w));
    canvas.width = Math.round(alvoW);
    canvas.height = Math.round(h * (alvoW / w));
    ctx.drawImage(video, x, y, w, h, 0, 0, canvas.width, canvas.height);
  }

  // Conta as leituras válidas; só aceita quando o mesmo número aparece de novo.
  function registrarLeitura_(codigo) {
    codigo = String(codigo || '').trim();
    if (!codigoValido(codigo)) return;
    contagem[codigo] = (contagem[codigo] || 0) + 1;
    if (contagem[codigo] >= LEITURAS_IGUAIS) finalizar_(codigo);
  }

  // ----- botões do leitor -----

  async function alternarLanterna() {
    if (!stream) return;
    const trilha = stream.getVideoTracks()[0];
    try {
      lanternaLigada = !lanternaLigada;
      await trilha.applyConstraints({ advanced: [{ torch: lanternaLigada }] });
    } catch (e) { lanternaLigada = false; }
  }

  async function trocarCamera() {
    if (camerasTraseiras.length < 2 || !stream) return;
    const atual = (stream.getVideoTracks()[0].getSettings() || {}).deviceId;
    const i = camerasTraseiras.findIndex(function (c) { return c.deviceId === atual; });
    const proxima = camerasTraseiras[(i + 1) % camerasTraseiras.length];
    guardarCamera(proxima.deviceId);
    contagem = {};
    await ligarCamera(proxima.deviceId);
    document.getElementById('scanner-status').textContent =
      'Lente ' + ((camerasTraseiras.indexOf(proxima)) + 1) + ' de ' + camerasTraseiras.length + '. Se continuar desfocado, toque em 🔄 de novo.';
  }

  // Toque na imagem: pede para a câmera focar de novo.
  async function focar() {
    if (!stream) return;
    const trilha = stream.getVideoTracks()[0];
    let cap = {};
    try { cap = trilha.getCapabilities ? trilha.getCapabilities() : {}; } catch (e) { return; }
    if (!cap.focusMode) return;
    try {
      if (cap.focusMode.indexOf('single-shot') >= 0) await trilha.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
      if (cap.focusMode.indexOf('continuous') >= 0) setTimeout(function () {
        trilha.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () { /* ignora */ });
      }, 1200);
    } catch (e) { /* ignora */ }
  }

  // ----- leitura por foto (câmera normal do celular) -----

  function tirarFoto() {
    pararCamera_(); // libera a câmera para o app de câmera do celular
    document.getElementById('scanner-status').textContent = 'Câmera ao vivo pausada. Toque em "Ler ao vivo" para voltar a ela.';
    document.getElementById('scanner-aovivo').classList.remove('hidden');
    const input = document.getElementById('scanner-foto');
    input.value = '';
    input.click();
  }

  function retomar() {
    document.getElementById('scanner-aovivo').classList.add('hidden');
    contagem = {};
    ligarCamera(cameraGuardada());
  }

  async function aoEscolherFoto(input) {
    const arquivo = input.files && input.files[0];
    const status = document.getElementById('scanner-status');
    if (!arquivo) return;
    status.textContent = 'Lendo o código na foto…';
    await esperar_(30);
    const codigo = await lerCodigoDaFoto(arquivo);
    if (codigo) { finalizar_(codigo, true); return; }
    status.textContent = 'Não consegui ler o código nessa foto. Tente de novo mais perto, com o código reto e bem iluminado, ou digite os números abaixo.';
  }

  async function carregarImagem(arquivo) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(arquivo, { imageOrientation: 'from-image' }); } catch (e) { /* tenta pelo <img> */ }
    }
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = URL.createObjectURL(arquivo);
    });
  }

  // Tenta em vários tamanhos e também girada (código em pé na foto).
  async function lerCodigoDaFoto(arquivo) {
    let img;
    try { img = await carregarImagem(arquivo); } catch (e) { return null; }
    const largura = img.width, altura = img.height;
    const formatos = await formatosNativosSuportados();
    const detector = formatos.length ? new BarcodeDetector({ formats: formatos }) : null;

    if (detector) {
      const achados = (await lerComNativo(detector, img)).filter(codigoValido);
      if (achados.length) return achados[0];
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tamanhos = [1600, 1000, 2400];
    for (let g = 0; g < 2; g++) {
      for (let t = 0; t < tamanhos.length; t++) {
        const escala = Math.min(1, tamanhos[t] / Math.max(largura, altura));
        const w = Math.round(largura * escala), h = Math.round(altura * escala);
        if (g === 0) { canvas.width = w; canvas.height = h; ctx.drawImage(img, 0, 0, w, h); }
        else {
          canvas.width = h; canvas.height = w;
          ctx.save(); ctx.translate(h, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(img, 0, 0, w, h); ctx.restore();
        }
        if (detector) {
          const achados = (await lerComNativo(detector, canvas)).filter(codigoValido);
          if (achados.length) return achados[0];
        }
        const z = lerComZXing(canvas);
        if (z && codigoValido(z)) return z;
        await esperar_(0);
      }
    }
    return null;
  }

  // ----- digitação -----

  async function usarDigitado() {
    const campo = document.getElementById('scanner-digitado');
    const codigo = campo.value.replace(/\D/g, '');
    if (!codigo) { campo.focus(); return; }
    if (!codigoValido(codigo) && !await DespenseiApp.dialogo({
      titulo: 'Confira o código', icone: '⚠️',
      mensagem: 'O código ' + codigo + ' não parece um código de barras de produto (o último dígito não confere). Confira os números digitados.',
      okTexto: 'Usar mesmo assim', cancelarTexto: 'Corrigir'
    })) {
      campo.focus();
      return;
    }
    finalizar_(codigo, true);
  }

  // ----- encerramento -----

  function esperar_(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function finalizar_(codigo, semCamera) {
    const valido = scanning || semCamera;
    parar();
    if (!valido || !onDetectCallback) return;
    if (navigator.vibrate) { try { navigator.vibrate(120); } catch (e) { /* ignora */ } }
    onDetectCallback(codigo);
  }

  function pararCamera_() {
    scanning = false;
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    const video = document.getElementById('scanner-video');
    if (video) video.srcObject = null;
  }

  function parar() {
    pararCamera_();
    document.getElementById('modal-scanner').classList.add('hidden');
  }

  return { iniciar, parar, usarDigitado, alternarLanterna, trocarCamera, focar, tirarFoto, retomar, aoEscolherFoto, codigoValido, lerCodigoDaFoto };
})();

window.DespenseiBarcode = DespenseiBarcode;
