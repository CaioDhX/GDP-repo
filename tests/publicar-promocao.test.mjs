// Node >= 22.13: testes locais sem Supabase, Telegram ou segredos reais.
import {stripTypeScriptTypes} from 'node:module';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
const env = {GDP_WEBHOOK_TOKEN: 'token-apenas-de-teste', SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service-apenas-de-teste'};
globalThis.Deno = {env: {get: key => env[key]}};
const source = await readFile(new URL('../supabase/functions/publicar-promocao/index.ts', import.meta.url), 'utf8');
const {handler, render, validateAffiliate} = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source, {mode: 'transform'})).toString('base64'));
const workflow = JSON.parse(await readFile(new URL('../n8n/gdp-promocao-cadastrada.json', import.meta.url), 'utf8'));
const assignments = workflow.nodes.find(n => n.name === 'Dados da promoção').parameters.assignments.assignments;
const expression = assignments.find(a => a.name === 'mensagem').value;
const evaluate = body => Function('$json', `return (${expression.slice(3, -2)});`)({body});
const deal = {id: '00000000-0000-4000-8000-000000000001', public_code: 'GP-1234', store_id: '00000000-0000-4000-8000-000000000002', title: 'Produto <A> & B', price_promo: 89.9, price_original: 100, coupon_code: 'CUPOM', payment_note: 'Pix', shipping: 'free', highlight: 'Últimas unidades', status: 'draft', image_url: null};
const store = {id: deal.store_id, slug: 'amazon', url_template: 'https://amazon.com.br/dp/{SKU}'};
const channel = {id: '00000000-0000-4000-8000-000000000003', slug: 'goatpromocoes', chat_id: '@goatpromocoes'};
const request = (route, body, token = env.GDP_WEBHOOK_TOKEN) => new Request(`https://example.invalid/publicar-promocao/${route}`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}, body: JSON.stringify(body)});

test('formatação salva é usada literalmente pelo workflow, com e sem foto', () => {
  const message = render(deal);
  assert.ok(message.startsWith('🔥 Produto &lt;A&gt; &amp; B\n\n📌 De: R$'));
  assert.ok(message.endsWith('\n📦 Frete grátis'));
  for (const image_url of [null, 'https://example.com/photo.jpg']) {
    assert.equal(evaluate({deal: {...deal, image_url}, telegram: {message}}), message);
  }
  for (const name of ['Telegram: com foto', 'Telegram: só texto']) {
    const node = workflow.nodes.find(n => n.name === name);
    assert.equal(node.parameters.additionalFields.parse_mode, 'HTML');
  }
});
test('fallback legado escapa HTML em todo o texto e preserva o resultado visual', () => {
  const legacyDeal = {
    ...deal,
    title: 'Produto <A> & B &lt;',
    payment_note: 'Pix & <cartão>',
    coupon_code: 'CUPOM<&>',
    highlight: 'Últimas <unidades> & ofertas',
  };
  const original = '🔥 Produto <A> & B &lt;\n\n'
    + '📌 De: ' + Number(100).toLocaleString('pt-BR', {style: 'currency', currency: 'BRL'}) + '\n'
    + '👉 Por apenas: ' + Number(89.9).toLocaleString('pt-BR', {style: 'currency', currency: 'BRL'})
    + ' (Pix & <cartão>)\n🎫 Cupom: CUPOM<&>'
    + '\n⚡ Últimas <unidades> & ofertas\n📦 Frete grátis';
  const escaped = original.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const image_url of [null, 'https://example.com/photo.jpg']) {
    const message = evaluate({deal: {...legacyDeal, image_url}});
    assert.equal(message, escaped);
    assert.equal(message.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), original);
  }
  const minimal = evaluate({deal: {...legacyDeal, price_original: null, payment_note: null, coupon_code: null, highlight: null, shipping: null}});
  assert.equal(minimal, '🔥 Produto &lt;A&gt; &amp; B &amp;lt;\n\n👉 Por apenas: '
    + Number(89.9).toLocaleString('pt-BR', {style: 'currency', currency: 'BRL'}));
  const approved = '<b>Texto aprovado</b> &amp; &lt;literal&gt;';
  assert.equal(evaluate({deal: legacyDeal, telegram: {message: approved}}), approved);
});
test('domínios e HTTPS: rejeita confusão de domínio e credenciais', () => {
  for (const url of ['http://amazon.com.br/p', 'https://amazon.com.br.evil.com/p', 'https://evilamazon.com.br/p', 'https://user@amazon.com.br/p']) {
    assert.throws(() => validateAffiliate(url, store));
  }
  for (const url of ['https://www.amazon.com.br/p', 'https://amzn.to/teste']) validateAffiliate(url, store);
  validateAffiliate('https://meli.la/teste', {slug: 'mercado-livre'});
});
test('autorização e confirmação explícita antes de qualquer acesso ao banco', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw Error('Não deveria acessar banco'); };
  try {
    assert.equal((await handler(request('preview', {}, 'invalido'))).status, 401);
    assert.equal((await handler(request('confirm', {preview_id: deal.id, confirm: 'true'}))).status, 400);
    assert.equal((await handler(request('preview', {deal: 'inválido'}))).status, 400);
  } finally { globalThis.fetch = previous; }
});
test('preview só lê dados e cria prévia; confirm chama apenas RPC atômica', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    let result;
    if (url.includes('/deals?')) result = [deal];
    else if (url.includes('/stores?')) result = [store];
    else if (url.includes('/channels?')) result = [channel];
    else if (url.endsWith('/rpc/create_publish_preview')) {
      const data = JSON.parse(init.body);
      assert.equal(data.p_telegram.message, render({...deal, ...data.p_proposed}));
      assert.equal(data.p_proposed.affiliate_url, 'https://amzn.to/teste');
      assert.equal(data.p_telegram.link, 'https://gdp.douglas-code.com.br/go/?p=GP-1234&c=goatpromocoes');
      result = {preview_id: deal.id, telegram: data.p_telegram};
    } else if (url.endsWith('/rpc/confirm_publish_preview')) result = {dispatch_id: deal.id, state: 'sending'};
    else throw Error('Operação inesperada');
    return Response.json(result);
  };
  try {
    const res = await handler(request('preview', {deal: 'GP-1234', affiliate_url: 'https://amzn.to/teste', overrides: {price_promo: 79.9}}));
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map(c => c[1].method), ['GET', 'GET', 'GET', 'POST']);
    calls.length = 0;
    assert.equal((await handler(request('confirm', {preview_id: deal.id, confirm: true}))).status, 200);
    assert.equal(calls.length, 1);
    assert.ok(calls[0][0].endsWith('/rpc/confirm_publish_preview'));
  } finally { globalThis.fetch = previous; }
});
test('RPC traduz conflitos de uso/expiração/alteração e ausência para HTTP', async () => {
  const previous = globalThis.fetch;
  try {
    for (const [code, status] of [['40001', 409], ['P0002', 404]]) {
      globalThis.fetch = async () => Response.json({code, message: 'Gere nova prévia'}, {status: 400});
      assert.equal((await handler(request('confirm', {preview_id: deal.id, confirm: true}))).status, status);
    }
  } finally { globalThis.fetch = previous; }
});
