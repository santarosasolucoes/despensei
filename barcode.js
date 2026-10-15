// ===================== LEITOR DE CÓDIGO DE BARRAS (câmera) =====================
// Usa o BarcodeDetector nativo do navegador quando ele existe E suporta os
// formatos de produto (Chrome/Android); senão, a biblioteca ZXing carregada no
// index.html (iPhone e Androids sem suporte nativo).
//
// Para não aceitar número errado (v3.1):
//  - só lê formatos de produto de supermercado: EAN-13, EAN-8, UPC-A, UPC-E;
//  - confere o dígito verificador do código (número inventado é descartado);
//  - só aceita depois de ler o MESMO número em 2 quadros diferentes da câmera.
// E sempre dá pra digitar o código à mão, no campo embaixo da câmera.

const DespenseiBarcode = (function () {
  const FORMATOS_PRODUTO = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
  const LEITURAS_IGUAIS = 2;

  let stream = null;
  let scanning = false;
  let onDetectCallback = null;
  let zxingControls = null;
  let contagem = {};
  let lanternaLigada = false;

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

  // ----- câmera -----

  async function formatosNativosSuportados() {
    if (!('BarcodeDetector' in window)) return [];
    try {
      const suportados = await BarcodeDetector.getSupportedFormats();
      return FORMATOS_PRODUTO.filter(function (f) { return suportados.indexOf(f) >= 0; });
    } catch (e) {
      return [];
    }
  }

  async function iniciar(onDetect) {
    onDetectCallback = onDetect;
    contagem = {};
    const modal = document.getElementById('modal-scanner');
    const video = document.getElementById('scanner-video');
    const status = document.getElementById('scanner-status');
    const digitado = document.getElementById('scanner-digitado');
    const btnLanterna = document.getElementById('scanner-lanterna');

    digitado.value = '';
    btnLanterna.classList.add('hidden');
    lanternaLigada = false;
    modal.classList.remove('hidden');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status.textContent = 'Este navegador não permite usar a câmera. Digite o código abaixo.';
      digitado.focus();
      return;
    }

    status.textContent = 'Abrindo câmera…';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
    } catch (err) {
      status.textContent = 'Não foi possível abrir a câmera (' + (err.message || err) + '). Digite o código abaixo.';
      return;
    }

    const trilha = stream.getVideoTracks()[0];
    try {
      const cap = trilha.getCapabilities ? trilha.getCapabilities() : {};
      if (cap.focusMode && cap.focusMode.indexOf('continuous') >= 0) {
        await trilha.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
      if (cap.torch) btnLanterna.classList.remove('hidden');
    } catch (e) { /* câmera sem esses ajustes — segue normal */ }

    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* autoplay já cuida */ }
    scanning = true;

    const formatos = await formatosNativosSuportados();
    if (!scanning) return; // fechou enquanto abria
    if (formatos.length) {
      status.textContent = 'Aproxime o código de barras do retângulo e segure firme…';
      detectarComBarcodeDetectorNativo_(video, formatos);
    } else if (window.ZXingBrowser) {
      status.textContent = 'Aproxime o código de barras do retângulo e segure firme…';
      detectarComZXing_(video);
    } else {
      status.textContent = 'Leitura automática indisponível neste aparelho. Digite o código abaixo.';
    }
  }

  // Conta as leituras válidas; só aceita quando o mesmo número aparece de novo.
  function registrarLeitura_(codigo) {
    codigo = String(codigo || '').trim();
    if (!codigoValido(codigo)) return;
    contagem[codigo] = (contagem[codigo] || 0) + 1;
    if (contagem[codigo] >= LEITURAS_IGUAIS) finalizar_(codigo);
  }

  async function detectarComBarcodeDetectorNativo_(video, formatos) {
    const detector = new BarcodeDetector({ formats: formatos });
    while (scanning) {
      try {
        if (video.readyState >= 2) {
          const codigos = await detector.detect(video);
          codigos.forEach(function (c) { if (scanning) registrarLeitura_(c.rawValue); });
        }
      } catch (err) {
        // quadro sem leitura válida — tenta de novo no próximo ciclo
      }
      await esperar_(120);
    }
  }

  function detectarComZXing_(video) {
    const Leitor = ZXingBrowser.BrowserMultiFormatOneDReader || ZXingBrowser.BrowserMultiFormatReader;
    const leitor = new Leitor();
    Promise.resolve(leitor.decodeFromVideoElement(video, function (resultado) {
      if (resultado && scanning) registrarLeitura_(resultado.getText());
    })).then(function (controles) {
      zxingControls = controles;
      if (!scanning && controles) controles.stop();
    }).catch(function () {
      if (scanning) document.getElementById('scanner-status').textContent = 'Não foi possível iniciar a leitura. Digite o código abaixo.';
    });
  }

  async function alternarLanterna() {
    if (!stream) return;
    const trilha = stream.getVideoTracks()[0];
    try {
      lanternaLigada = !lanternaLigada;
      await trilha.applyConstraints({ advanced: [{ torch: lanternaLigada }] });
    } catch (e) { lanternaLigada = false; }
  }

  // Código digitado à mão (ou quando a câmera não consegue ler).
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

  function esperar_(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function finalizar_(codigo, digitado) {
    const valido = scanning || digitado;
    parar();
    if (!valido || !onDetectCallback) return;
    if (!digitado && navigator.vibrate) { try { navigator.vibrate(120); } catch (e) { /* ignora */ } }
    onDetectCallback(codigo);
  }

  function parar() {
    scanning = false;
    document.getElementById('modal-scanner').classList.add('hidden');
    if (zxingControls) {
      try { zxingControls.stop(); } catch (err) { /* já parado */ }
      zxingControls = null;
    }
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    const video = document.getElementById('scanner-video');
    if (video) video.srcObject = null;
  }

  return { iniciar, parar, usarDigitado, alternarLanterna, codigoValido };
})();

window.DespenseiBarcode = DespenseiBarcode;
