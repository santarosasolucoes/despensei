// ===================== CONFIGURAÇÃO DO DESPENSEI =====================
// Conexão com o Supabase (projeto "despensei", organização Santarosa Apps).
// A chave publicável é pública por natureza: quem controla o acesso aos dados
// são as funções do banco (supabase/schema.sql), que conferem o usuário logado.
const DESPENSEI_CONFIG = {
  SUPABASE_URL: 'https://jtdsjwkyrwwlxucvngou.supabase.co',
  SUPABASE_KEY: 'sb_publishable_IDMz-JCEG2UckdFaBPPEMw_IJHNyOPP',

  // OAuth Client ID do Google (o mesmo de antes) — login com a conta Google.
  GOOGLE_CLIENT_ID: '429667579829-p5shhj2gh4tpj07qbgk0pqd8ha3gl9v0.apps.googleusercontent.com',

  // Ponte no Apps Script (mesma URL /exec de antes): envia os e-mails da fila
  // (teste grátis, convite) e recebe o webhook do Mercado Pago.
  PONTE_URL: 'https://script.google.com/macros/s/AKfycbyymP9fz14iAYSh9kVoXbr39myA8keM_pMv3ud3m9mxWwGRvdDMxkekkzHUVUNx4bCtLw/exec',

  // Mude a cada publicação (junto com CACHE_NAME em sw.js).
  VERSAO: '3.0.0'
};
