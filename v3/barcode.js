// ===================== LEITOR DE CÓDIGO DE BARRAS (câmera) =====================
// Usa o BarcodeDetector nativo do navegador quando disponível (Chrome/Android);
// se não tiver (ex: Safari/iOS), cai pra biblioteca ZXing carregada via CDN no
// index.html. Se nenhum dos dois estiver disponível, avisa e deixa o usuário
// digitar o código manualmente em vez de travar a tela.

const DespenseiBarcode = (function () {
  let stream = null;
  let scanning = false;
  let onDetectCallback = null;
  let zxingReader = null;

  function suportaDeteccaoNativa() {
    return 'BarcodeDetector' in window;
  }

  async function iniciar(onDetect) {
    onDetectCallback = onDetect;
    const modal = document.getElementById('modal-scanner');
    const video = document.getElementById('scanner-video');
    const status = document.getElementById('scanner-status');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Este navegador não permite acesso à câmera. Digite o código de barras manualmente.');
      return;
    }

    modal.classList.remove('hidden');
    status.textContent = 'Abrindo câmera…';

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (err) {
      status.textContent = 'Não foi possível acessar a câmera: ' + (err.message || err);
      return;
    }

    video.srcObject = stream;
    await video.play();
    scanning = true;

    if (suportaDeteccaoNativa()) {
      status.textContent = 'Aponte a câmera para o código de barras…';
      detectarComBarcodeDetectorNativo_(video);
    } else if (window.ZXingBrowser) {
      status.textContent = 'Aponte a câmera para o código de barras…';
      detectarComZXing_(video);
    } else {
      status.textContent = 'Este navegador não suporta leitura automática. Feche e digite o código manualmente.';
    }
  }

  async function detectarComBarcodeDetectorNativo_(video) {
    const detector = new BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code']
    });

    while (scanning) {
      try {
        const codigos = await detector.detect(video);
        if (codigos.length) {
          finalizar_(codigos[0].rawValue);
          return;
        }
      } catch (err) {
        // frame sem leitura válida — tenta de novo no próximo ciclo
      }
      await esperar_(300);
    }
  }

  function detectarComZXing_(video) {
    zxingReader = new ZXingBrowser.BrowserMultiFormatReader();
    zxingReader.decodeFromVideoElement(video, function (resultado) {
      if (resultado && scanning) finalizar_(resultado.getText());
    });
  }

  function esperar_(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function finalizar_(codigo) {
    const foiEncontrado = scanning;
    parar();
    if (foiEncontrado && onDetectCallback) onDetectCallback(codigo);
  }

  function parar() {
    scanning = false;
    document.getElementById('modal-scanner').classList.add('hidden');
    if (zxingReader) {
      try { zxingReader.reset(); } catch (err) { /* já parado */ }
      zxingReader = null;
    }
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
  }

  return { iniciar, parar };
})();

window.DespenseiBarcode = DespenseiBarcode;
