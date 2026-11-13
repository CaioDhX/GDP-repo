# GOAT das Promos — publicação assistida

Site estático em GitHub Pages (`gdp.douglas-code.com.br`), com Supabase e publicação no Telegram pelo n8n.

## Arquitetura

A Edge Function `publicar-promocao` aceita somente POST autenticado com `Authorization: Bearer <GDP_WEBHOOK_TOKEN>`. Compara hashes SHA-256 de tamanho fixo sem interrupção antecipada. Não usa o JWT do usuário e nunca entrega a service role ao navegador.

1. `/preview` lê uma promoção existente por UUID ou código `GP-1234`, valida o link de afiliado e os overrides e grava uma prévia de 30 minutos em `public.deal_publish_previews`. Não atualiza a promoção nem chama o n8n.
2. `/confirm` exige `confirm: true` e o UUID da prévia. A RPC bloqueia a prévia e a promoção, verifica expiração/uso e compara snapshots completos da promoção (exceto `search_vector`), loja e canal. Qualquer mudança exige nova prévia, inclusive mudanças em metadados do canal. Atualiza somente os campos propostos e passa a promoção para `ready` na mesma transação.
3. O gatilho existente `deals_to_n8n` cria `deal_dispatches` em `sending` e enfileira o POST pelo `pg_net`. Um contexto local da transação seleciona o canal aprovado e inclui `telegram` salvo na prévia. Sem esse contexto, o gatilho mantém o fluxo usual `deal.created`/`deal.ready` e o canal padrão. Falhas locais ao criar/enfileirar o envio desfazem a confirmação inteira; a prévia só é consumida após enfileirar.
4. O workflow publica e usa `n8n_report_dispatch` para mudar o envio para `sent`/`failed` e a promoção para `published`/`failed`. A resposta HTTP da confirmação indica enfileiramento, não entrega ao Telegram. Consultar `deal_dispatches` no painel para o resultado final.

Reutilizamos a transição para `ready` para preservar histórico de tentativas, callback, notificações e rastreio. Promoções já `ready`/`queued`, ou com qualquer dispatch em `sending`, recebem 409; uma promoção publicada pode ser republicada mediante nova prévia. Confirmações concorrentes da mesma prévia são serializadas, e a segunda recebe 409. Não há repetição automática de envio após timeout HTTP: uma tentativa já confirmada não pode ser confirmada novamente.

A tabela tem RLS e nenhum acesso para `anon`/`authenticated`; as RPCs são exclusivas da `service_role`. Prévias vencidas ficam disponíveis para auditoria; uma rotina de retenção pode apagá-las posteriormente.

## Correspondência exata com o Telegram

`render()` em `supabase/functions/publicar-promocao/index.ts` conserva a ordem e o conteúdo do nó **Dados da promoção**: título, preço original opcional, preço promocional, pagamento, cupom, destaque e frete grátis. Usa BRL/pt-BR, HTML escapado e quebras de linha reais. O texto é calculado **uma vez**, gravado na prévia e enviado pelo gatilho como `body.telegram.message`. O n8n usa esse valor literalmente; não recalcula o texto aprovado. Ambos os nós de publicação usam `parse_mode: HTML` explícito.

A resposta inclui `telegram.message`, `text` ou `caption`, `parse_mode`, `image_url`, `operation`, `chat_id`, `link` e `reply_markup`. O botão é **🛒 PEGAR PROMOÇÃO**. Sem imagem, o mesmo texto vira `sendMessage`; com imagem, vira legenda de `sendPhoto`. Rejeitamos conteúdo acima de 4096/1024 unidades UTF-16, respectivamente, de maneira conservadora antes de salvar.

Payloads antigos, sem `telegram`, continuam usando a formatação original do workflow, inclusive seu tratamento legado de quebras `\\n`. O texto legado completo escapa `&`, `<` e `>` (nessa ordem), preservando o resultado visual com `parse_mode: HTML`. O campo auxiliar legado `mensagem_com_link` não é usado pelos nós de envio. A prévia nova usa quebras reais e escapa HTML, garantindo que títulos/cupons com `<`, `>` ou `&` sejam texto literal.

O link exibido é `/go/?p=GP-1234&c=slug`, e não o link afiliado direto. `deal_click` registra o clique e devolve o afiliado atual no banco; futuras edições da promoção também alteram o destino dos botões antigos. O formato da mensagem e a URL da foto são fixados pela prévia, mas não os bytes de uma imagem hospedada externamente.

## Configuração e implantação manual

Nenhum comando de implantação foi executado nesta implementação.

Pré-requisitos: tabelas base `deals`, `stores`, `channels`, `deal_dispatches`; integrações de `supabase/n8n_webhook.sql`, `supabase/n8n_retorno.sql` e `supabase/notifications.sql`; canal ativo com `chat_id`; bot autorizado no canal; URL e segredo do n8n no Vault (`n8n_deal_webhook_url`, `n8n_webhook_secret`).

1. Importe `n8n/gdp-promocao-cadastrada.json` no workflow existente, selecione suas credenciais Header Auth/Telegram e ative apenas um workflow com o caminho `gdp-deal-created`.
2. Aplique `supabase/webhook_publicacao.sql` no SQL Editor do Supabase. Alternativamente, com uma conexão de banco em variável de ambiente:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/webhook_publicacao.sql
   ```

   O arquivo é idempotente. Aplique **depois** das integrações anteriores. Reaplicar `n8n_webhook.sql` posteriormente sobrescreve a extensão do gatilho; nesse caso, reaplique `webhook_publicacao.sql`.
3. Configure o segredo próprio e faça o deploy manual:

   ```bash
   supabase secrets set GDP_WEBHOOK_TOKEN="$GDP_WEBHOOK_TOKEN" --project-ref "$PROJECT_REF"
   supabase functions deploy publicar-promocao --project-ref "$PROJECT_REF" --no-verify-jwt
   ```

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são variáveis fornecidas automaticamente pelo ambiente hospedado do Supabase. No desenvolvimento local, configure essas duas variáveis e `GDP_WEBHOOK_TOKEN` no arquivo de ambiente local da função, fora do Git. Nunca coloque o token ou a service role em `config.js`. `supabase/config.toml` desabilita `verify_jwt` somente para esta função; o token próprio continua obrigatório.

## Endpoints

Base: `https://<PROJECT_REF>.supabase.co/functions/v1/publicar-promocao`.

### Criar prévia

```bash
curl --fail-with-body "$SUPABASE_URL/functions/v1/publicar-promocao/preview" \
  -H "Authorization: Bearer $GDP_WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"deal":"GP-1234","affiliate_url":"https://amzn.to/EXEMPLO","overrides":{"price_promo":89.90,"title":"Produto em promoção","coupon_code":"CUPOM"},"channel":"goatpromocoes"}'
```

`deal` também aceita UUID. `affiliate_url` é obrigatório. `overrides` e `channel` são opcionais. Canal aceita slug ou UUID; omitido, seleciona o canal ativo padrão, depois o mais antigo. Overrides permitidos: `title` (3–120 caracteres), `price_promo` (número positivo), `price_original` (número positivo ou null) e `coupon_code` (até 100 caracteres ou null). Preços usam ponto decimal, no máximo duas casas, e o original não pode ser menor que o promocional. Campos desconhecidos são rejeitados.

URLs exigem HTTPS, sem usuário/senha/porta. Amazon aceita `amazon.com.br`, `amazon.com`, `amzn.to`; Mercado Livre aceita `mercadolivre.com.br`, `mercadolivre.com`, `meli.la`, incluindo subdomínios legítimos. Outras lojas usam o domínio fixo de `url_template` quando disponível; sem domínio fixo, só é possível validar a estrutura HTTPS. Não seguimos redirecionamentos nem verificamos a atribuição comercial do afiliado: o chamador precisa fornecer o link correto.

Exemplo de resposta 200 (UUIDs e data ilustrativos; `proposed` e snapshots do canal abreviados):

```json
{
  "preview_id": "11111111-1111-4111-8111-111111111111",
  "expires_at": "2026-11-13T15:30:00Z",
  "deal_id": "22222222-2222-4222-8222-222222222222",
  "proposed": {"affiliate_url":"https://amzn.to/EXEMPLO","title":"Produto em promoção","price_promo":89.9,"coupon_code":"CUPOM"},
  "channel": {"id":"33333333-3333-4333-8333-333333333333","slug":"goatpromocoes","chat_id":"@goatpromocoes"},
  "telegram": {
    "message":"🔥 Produto em promoção\n\n👉 Por apenas: R$ 89,90\n🎫 Cupom: CUPOM",
    "parse_mode":"HTML",
    "operation":"sendMessage",
    "image_url":null,
    "text":"🔥 Produto em promoção\n\n👉 Por apenas: R$ 89,90\n🎫 Cupom: CUPOM",
    "caption":null,
    "chat_id":"@goatpromocoes",
    "link":"https://gdp.douglas-code.com.br/go/?p=GP-1234&c=goatpromocoes",
    "reply_markup":{"inline_keyboard":[[{"text":"🛒 PEGAR PROMOÇÃO","url":"https://gdp.douglas-code.com.br/go/?p=GP-1234&c=goatpromocoes"}]]}
  }
}
```

### Confirmar publicação

Somente depois de o operador aprovar a prévia:

```bash
curl --fail-with-body "$SUPABASE_URL/functions/v1/publicar-promocao/confirm" \
  -H "Authorization: Bearer $GDP_WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"preview_id":"11111111-1111-4111-8111-111111111111","confirm":true}'
```

Resposta 200:

```json
{"preview_id":"11111111-1111-4111-8111-111111111111","deal_id":"22222222-2222-4222-8222-222222222222","dispatch_id":"44444444-4444-4444-8444-444444444444","state":"sending"}
```

Erros retornam `{"error":"descrição"}`: 401 token ausente/incorreto; 400 JSON/campos/valores inválidos; 404 promoção/prévia/rota inexistente; 409 prévia usada/expirada, snapshots alterados, envio em andamento, canal indisponível ou n8n sem configuração; 405 método incorreto; 500 falha interna. Em 409, obtenha nova prévia após corrigir a causa. Uma falha posterior no Telegram consome a prévia e fica no dispatch; uma nova tentativa requer nova prévia.

## Verificação local

```bash
deno check supabase/functions/publicar-promocao/index.ts
node tests/publicar-promocao.test.mjs
```

Os testes precisam de Node >= 22.13 e não acessam serviços externos. Cobrem formatação e consumo literal pelo workflow (foto/texto), fallback legado, validação de domínio, autenticação, confirmação explícita, separação entre preview/confirm e tradução de conflitos. Neste ambiente, Deno e servidor PostgreSQL não estavam disponíveis: os cinco testes passaram via transformação TypeScript do Node; a migração foi revisada, mas não executada. Antes de produção, em um Supabase de teste, validar aplicação duas vezes, confirmações concorrentes, uso repetido, expiração, alteração da promoção/canal/loja e callback real do n8n.
