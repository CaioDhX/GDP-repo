// Sem dependências externas. REST/RPC autenticados exclusivamente com service role.
type Row = Record<string, unknown>;
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fail = (message: string): never => { throw new HttpError(400, message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const html = (v: unknown) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function render(deal: Row) {
  const money = (v: unknown) => Number(v).toLocaleString('pt-BR', {style: 'currency', currency: 'BRL'});
  // Mesmo conteúdo/ordem do nó Dados da promoção; HTML escapado e quebras reais.
  return '🔥 ' + html(deal.title) + '\n\n' +
    (deal.price_original != null ? '📌 De: ' + money(deal.price_original) + '\n' : '') +
    '👉 Por apenas: ' + money(deal.price_promo) +
    (deal.payment_note ? ' (' + html(deal.payment_note) + ')' : '') +
    (deal.coupon_code ? '\n🎫 Cupom: ' + html(deal.coupon_code) : '') +
    (deal.highlight ? '\n⚡ ' + html(deal.highlight) : '') +
    (deal.shipping === 'free' ? '\n📦 Frete grátis' : '');
}
function https(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2000 || value !== value.trim()) fail('URL inválida');
  let url: URL;
  try { url = new URL(value as string); } catch { return fail('URL inválida'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !url.hostname.includes('.') || /^(localhost|127\.|0\.|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) fail('Use URL HTTPS pública, sem credenciais/porta');
  return url;
}
export function validateAffiliate(value: unknown, store: Row) {
  const url = https(value);
  const slug = String(store.slug).replaceAll('-', '').toLowerCase();
  let domains: string[] = [];
  if (slug.includes('mercadolivre')) domains = ['mercadolivre.com.br', 'mercadolivre.com', 'meli.la'];
  else if (slug.includes('amazon')) domains = ['amazon.com.br', 'amazon.com', 'amzn.to'];
  else if (typeof store.url_template === 'string' && store.url_template.startsWith('https://')) {
    try { domains = [new URL(store.url_template).hostname]; } catch { /* template sem domínio fixo */ }
  }
  if (domains.length && !domains.some(d => url.hostname === d || url.hostname.endsWith('.' + d))) fail('Domínio incompatível com a loja');
}
// Hashes de tamanho fixo: nenhum retorno antecipado dependente do conteúdo do token.
async function authorized(header: string | null, secret: string) {
  const candidate = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = await Promise.all([digest(candidate), digest(secret)]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0 && candidate.length > 0 && secret.length > 0;
}
export async function handler(req: Request) {
  const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'},
  });
  try {
    const secret = Deno.env.get('GDP_WEBHOOK_TOKEN') ?? '';
    if (!await authorized(req.headers.get('Authorization'), secret)) throw new HttpError(401, 'Não autorizado');
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST');
    const text = await req.text();
    if (text.length > 16384) fail('Corpo muito grande');
    let body: Row;
    try { const parsed = JSON.parse(text); if (!object(parsed)) fail('Objeto JSON obrigatório'); body = parsed; }
    catch { return response(400, {error: 'Objeto JSON válido obrigatório'}); }
    const action = new URL(req.url).pathname.split('/').filter(Boolean).pop();
    const base = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!base || !key) throw new Error('Ambiente incompleto');
    async function db(path: string, data?: Row) {
      const res = await fetch(`${base}/rest/v1/${path}`, {method: data ? 'POST' : 'GET',
        headers: {apikey: key!, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
        body: data ? JSON.stringify(data) : undefined});
      const result = await res.json();
      if (!res.ok) {
        if (result.code === '40001') throw new HttpError(409, result.message);
        if (result.code === 'P0002') throw new HttpError(404, result.message);
        if (/^(22|23)/.test(result.code ?? '')) throw new HttpError(400, 'Valores recusados pelo banco');
        throw new Error('Falha no banco');
      }
      return result;
    }
    if (action === 'confirm') {
      if (Object.keys(body).some(k => !['preview_id', 'confirm'].includes(k)) || body.confirm !== true ||
          typeof body.preview_id !== 'string' || !uuid.test(body.preview_id)) fail('Informe preview_id UUID e confirm: true');
      return response(200, await db('rpc/confirm_publish_preview', {p_preview_id: body.preview_id}));
    }
    if (action !== 'preview') throw new HttpError(404, 'Rota inexistente');
    if (Object.keys(body).some(k => !['deal', 'affiliate_url', 'overrides', 'channel'].includes(k))) fail('Campo desconhecido');
    if (typeof body.deal !== 'string' || !(uuid.test(body.deal) || /^GP-\d{1,9}$/i.test(body.deal))) fail('Informe deal UUID ou GP-1234');
    const deals = await db(`deals?${uuid.test(body.deal) ? 'id' : 'public_code'}=eq.${encodeURIComponent(body.deal.toUpperCase())}&select=*`);
    if (!deals.length) throw new HttpError(404, 'Promoção inexistente');
    const deal: Row = deals[0];
    if (['ready', 'queued'].includes(String(deal.status))) throw new HttpError(409, 'Promoção já pronta/em fila');
    const stores = await db(`stores?id=eq.${deal.store_id}&select=*`);
    const store: Row = stores[0];
    if (!store) fail('Loja inexistente');
    validateAffiliate(body.affiliate_url, store);
    const overrides = body.overrides ?? {};
    if (!object(overrides) || Object.keys(overrides).some(k => !['title', 'price_promo', 'price_original', 'coupon_code'].includes(k))) fail('Overrides inválidos');
    const proposed: Row = {...overrides, affiliate_url: body.affiliate_url};
    const next = {...deal, ...proposed};
    if (typeof next.title !== 'string' || next.title.trim().length < 3 || next.title.length > 120) fail('Título: 3 a 120 caracteres');
    for (const field of ['price_promo', 'price_original']) {
      const value = next[field];
      if (field === 'price_original' && value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 999999999 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) fail('Preços devem ser números positivos com até 2 casas decimais');
    }
    if (next.price_original != null && Number(next.price_original) < Number(next.price_promo)) fail('Preço original menor que promocional');
    if (next.coupon_code != null && (typeof next.coupon_code !== 'string' || next.coupon_code.length > 100)) fail('Cupom inválido');
    if (next.image_url) https(next.image_url);
    if (body.channel !== undefined && (typeof body.channel !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.channel))) fail('Canal inválido');
    const channels = await db('channels?is_active=eq.true&select=*&order=is_default.desc,created_at.asc,id.asc&limit=1' +
      (body.channel ? `&${uuid.test(String(body.channel)) ? 'id' : 'slug'}=eq.${encodeURIComponent(String(body.channel))}` : ''));
    const channel: Row = channels[0];
    if (!channel || !channel.chat_id) throw new HttpError(409, 'Sem canal ativo');
    if (!deal.public_code) fail('Promoção sem código público');
    const link = `https://gdp.douglas-code.com.br/go/?p=${encodeURIComponent(String(deal.public_code))}&c=${encodeURIComponent(String(channel.slug))}`;
    const message = render(next);
    if (message.length > (next.image_url ? 1024 : 4096)) fail('Mensagem excede limite do Telegram');
    const telegram = {message, parse_mode: 'HTML', image_url: next.image_url || null,
      operation: next.image_url ? 'sendPhoto' : 'sendMessage',
      text: next.image_url ? null : message, caption: next.image_url ? message : null,
      link, chat_id: channel.chat_id,
      reply_markup: {inline_keyboard: [[{text: '🛒 PEGAR PROMOÇÃO', url: link}]]}};
    return response(200, await db('rpc/create_publish_preview', {p_deal: deal, p_channel: channel,
      p_store: store, p_proposed: proposed, p_telegram: telegram}));
  } catch (err) {
    if (err instanceof HttpError) return response(err.status, {error: err.message});
    return response(500, {error: 'Falha interna ao preparar/enfileirar publicação'});
  }
}

if (import.meta.main) Deno.serve(handler);
