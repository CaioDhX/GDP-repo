-- Integração Supabase -> n8n: o banco faz um POST no webhook do n8n quando uma promoção
-- é cadastrada (event "deal.created") ou quando passa a "Pronta" (event "deal.ready").
-- O workflow só publica promoções com status "ready". Já aplicado no projeto; idempotente.
-- O caminho de volta (n8n -> painel) está em n8n_retorno.sql.
--
-- Como funciona
--   * pg_net envia de forma assíncrona: a gravação da promoção nunca espera nem falha por causa do n8n.
--   * URL e segredo ficam no Vault do Supabase (fora do código e deste repositório):
--       n8n_deal_webhook_url  -> URL de PRODUÇÃO do webhook no n8n
--       n8n_webhook_secret    -> valor enviado no cabeçalho X-GDP-Secret (gerado automaticamente)
--   * Sem a URL cadastrada, o gatilho não envia nada.
--   * Promoção "ready": o gatilho escolhe o canal padrão ativo (public.channels), cria o envio
--     em public.deal_dispatches (state "sending") e manda o canal e o id do envio ao n8n.
--     Sem canal ativo não há envio, e o n8n não publica.
--
-- Corpo enviado (JSON):
--   { "event": "deal.created" | "deal.ready", "sent_at": "...", "panel_url": "https://gdp.douglas-code.com.br/promocao.html?id=...",
--     "dispatch_id": "uuid" | null,
--     "channel": { "id", "slug", "name", "chat_id", "username" } | null,
--     "tracking_url": "https://gdp.douglas-code.com.br/go/?p=GP-1234&c=slug" | null,   -- conta o clique e redireciona
--     "deal":  { ...todas as colunas de public.deals, exceto search_vector... },
--     "store": { "id", "name", "slug", "affiliate_tag", "url_template" } }
--
-- Cadastrar a URL (uma vez, no SQL Editor do Supabase):
--   select vault.create_secret('https://SEU-N8N/webhook/gdp-deal-created', 'n8n_deal_webhook_url', 'Webhook do n8n');
-- Trocar a URL depois:
--   select vault.update_secret((select id from vault.secrets where name = 'n8n_deal_webhook_url'), 'https://NOVA-URL');
-- Ver o segredo para colar na credencial "Header Auth" do n8n:
--   select decrypted_secret from vault.decrypted_secrets where name = 'n8n_webhook_secret';
-- Ver as últimas respostas do n8n (o pg_net guarda por algumas horas):
--   select created, status_code, timed_out, error_msg, left(content, 200) from net._http_response order by created desc limit 20;

create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'n8n_webhook_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'n8n_webhook_secret',
      'Enviado no cabeçalho X-GDP-Secret para o n8n validar a origem do webhook'
    );
  end if;
end $$;

create or replace function public.deals_to_n8n()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url      text;
  v_secret   text;
  v_body     jsonb;
  v_channel  public.channels%rowtype;
  v_dispatch uuid;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'n8n_deal_webhook_url';
  if v_url is null or btrim(v_url) = '' then
    return new;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'n8n_webhook_secret';

  -- Promoção pronta: registra o envio para o canal padrão ativo. Sem canal ativo, o n8n não publica.
  if new.status = 'ready' then
    select * into v_channel from public.channels where is_active order by is_default desc, created_at limit 1;
    if v_channel.id is not null then
      begin
        update public.deal_dispatches
           set state = 'failed', error = 'Sem retorno do n8n; substituído por uma nova tentativa'
         where deal_id = new.id and channel_id = v_channel.id and state = 'sending';
        insert into public.deal_dispatches (deal_id, channel_id, state, attempt)
        values (new.id, v_channel.id, 'sending',
                (select coalesce(max(attempt), 0) + 1 from public.deal_dispatches
                  where deal_id = new.id and channel_id = v_channel.id))
        returning id into v_dispatch;
      exception when others then
        raise warning 'deals_to_n8n: envio não registrado (%)', sqlerrm;
        v_dispatch := null;
      end;
    end if;
  end if;

  v_body := jsonb_build_object(
    'event',        case when tg_op = 'INSERT' then 'deal.created' else 'deal.ready' end,
    'sent_at',      now(),
    'panel_url',    'https://gdp.douglas-code.com.br/promocao.html?id=' || new.id::text,
    'dispatch_id',  v_dispatch,
    'channel',      case when v_dispatch is null then null else jsonb_build_object(
                      'id', v_channel.id, 'slug', v_channel.slug, 'name', v_channel.name,
                      'chat_id', v_channel.chat_id, 'username', v_channel.username) end,
    'tracking_url', case when v_dispatch is null then null else
                      'https://gdp.douglas-code.com.br/go/?p=' || new.public_code || '&c=' || v_channel.slug end,
    'deal',         to_jsonb(new) - 'search_vector',
    'store',        (select jsonb_build_object(
                       'id', s.id, 'name', s.name, 'slug', s.slug,
                       'affiliate_tag', s.affiliate_tag, 'url_template', s.url_template)
                     from public.stores s where s.id = new.store_id)
  );

  begin
    perform net.http_post(
      url                  := btrim(v_url),
      body                 := v_body,
      headers              := jsonb_build_object('Content-Type', 'application/json', 'X-GDP-Secret', coalesce(v_secret, '')),
      timeout_milliseconds := 10000
    );
  exception when others then
    -- O cadastro da promoção não pode falhar por causa do webhook.
    raise warning 'deals_to_n8n: envio não enfileirado (%)', sqlerrm;
    if v_dispatch is not null then
      update public.deal_dispatches set state = 'failed', error = left('Webhook do n8n não enfileirado: ' || sqlerrm, 500)
       where id = v_dispatch;
    end if;
  end;

  return new;
end $$;

revoke execute on function public.deals_to_n8n() from public, anon, authenticated;

drop trigger if exists deals_to_n8n_insert on public.deals;
create trigger deals_to_n8n_insert
  after insert on public.deals
  for each row execute function public.deals_to_n8n();

-- Só na passagem para "ready": editar uma promoção que já está pronta não reenvia.
drop trigger if exists deals_to_n8n_ready on public.deals;
create trigger deals_to_n8n_ready
  after update of status on public.deals
  for each row
  when (old.status is distinct from new.status and new.status = 'ready')
  execute function public.deals_to_n8n();
