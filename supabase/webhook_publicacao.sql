-- Publicação assistida em duas etapas. Aplicar no SQL Editor, DEPOIS de
-- n8n_webhook.sql e n8n_retorno.sql. Idempotente; não contém segredos.
-- Importar também o workflow atualizado antes de habilitar a Edge Function.
-- Não reaplicar n8n_webhook.sql depois deste arquivo (substituiria o gatilho).

begin;

create table if not exists public.deal_publish_previews (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  channel_id uuid not null references public.channels(id),
  deal_snapshot jsonb not null,
  channel_snapshot jsonb not null,
  store_snapshot jsonb not null,
  proposed jsonb not null,
  telegram jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  used_at timestamptz,
  dispatch_id uuid references public.deal_dispatches(id)
);
alter table public.deal_publish_previews enable row level security;
revoke all on public.deal_publish_previews from public, anon, authenticated;
grant all on public.deal_publish_previews to service_role;
create index if not exists deal_publish_previews_expiry_idx on public.deal_publish_previews(expires_at);

-- As RPCs só são acessíveis à service role; token e validação ficam na Edge.
-- Compara também durante a criação para fechar a janela entre leitura e prévia.
create or replace function public.create_publish_preview(
  p_deal jsonb, p_channel jsonb, p_store jsonb, p_proposed jsonb, p_telegram jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d public.deals%rowtype;
  c public.channels%rowtype;
  s public.stores%rowtype;
  p public.deal_publish_previews%rowtype;
begin
  select * into d from public.deals where id = (p_deal->>'id')::uuid for update;
  if not found then raise exception 'Promoção inexistente' using errcode = 'P0002'; end if;
  select * into c from public.channels where id = (p_channel->>'id')::uuid for share;
  select * into s from public.stores where id = d.store_id for share;
  if (to_jsonb(d) - 'search_vector') is distinct from (p_deal - 'search_vector')
     or to_jsonb(c) is distinct from p_channel or to_jsonb(s) is distinct from p_store
     or not c.is_active or nullif(btrim(c.chat_id), '') is null
     or d.status in ('ready', 'queued')
     or exists (select 1 from public.deal_dispatches where deal_id = d.id and state = 'sending') then
    raise exception 'Promoção/canal alterado ou envio em andamento; gere nova prévia' using errcode = '40001';
  end if;
  insert into public.deal_publish_previews(deal_id, channel_id, deal_snapshot, channel_snapshot, store_snapshot, proposed, telegram)
  values(d.id, c.id, to_jsonb(d) - 'search_vector', p_channel, p_store, p_proposed, p_telegram) returning * into p;
  return jsonb_build_object('preview_id', p.id, 'expires_at', p.expires_at, 'deal_id', d.id,
    'proposed', p.proposed, 'telegram', p.telegram, 'channel', p.channel_snapshot);
end $$;

create or replace function public.confirm_publish_preview(p_preview_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p public.deal_publish_previews%rowtype;
  d public.deals%rowtype;
  c public.channels%rowtype;
  s public.stores%rowtype;
  proposed public.deals%rowtype;
  dispatch public.deal_dispatches%rowtype;
begin
  select * into p from public.deal_publish_previews where id = p_preview_id for update;
  if not found then raise exception 'Prévia inexistente' using errcode = 'P0002'; end if;
  if p.used_at is not null or p.expires_at <= clock_timestamp() then
    raise exception 'Prévia usada/expirada; gere nova prévia' using errcode = '40001';
  end if;
  select * into d from public.deals where id = p.deal_id for update;
  select * into c from public.channels where id = p.channel_id for share;
  select * into s from public.stores where id = d.store_id for share;
  if p.expires_at <= clock_timestamp() or (to_jsonb(d) - 'search_vector') is distinct from p.deal_snapshot
     or to_jsonb(c) is distinct from p.channel_snapshot or to_jsonb(s) is distinct from p.store_snapshot
     or not c.is_active or nullif(btrim(c.chat_id), '') is null
     or d.status in ('ready', 'queued')
     or exists(select 1 from public.deal_dispatches where deal_id = d.id and state = 'sending') then
    raise exception 'Promoção/loja/canal alterado ou envio em andamento; gere nova prévia' using errcode = '40001';
  end if;
  if not exists(select 1 from vault.decrypted_secrets where name = 'n8n_deal_webhook_url' and btrim(decrypted_secret) <> '') then
    raise exception 'Webhook n8n não configurado' using errcode = '40001';
  end if;
  if not exists(select 1 from vault.decrypted_secrets where name = 'n8n_webhook_secret' and btrim(decrypted_secret) <> '') then
    raise exception 'Segredo n8n não configurado' using errcode = '40001';
  end if;
  proposed := jsonb_populate_record(d, p.proposed);
  perform set_config('gdp.publish_preview', p.id::text, true);
  update public.deals set title = proposed.title, price_promo = proposed.price_promo,
    price_original = proposed.price_original, coupon_code = proposed.coupon_code,
    affiliate_url = proposed.affiliate_url, status = 'ready'
    where id = d.id;
  perform set_config('gdp.publish_preview', '', true);
  select * into dispatch from public.deal_dispatches
    where deal_id = d.id and channel_id = c.id and state = 'sending';
  if not found then raise exception 'Envio não registrado' using errcode = '40001'; end if;
  update public.deal_publish_previews set used_at = clock_timestamp(), dispatch_id = dispatch.id where id = p.id;
  return jsonb_build_object('preview_id', p.id, 'deal_id', d.id, 'dispatch_id', dispatch.id, 'state', dispatch.state);
end $$;

revoke all on function public.create_publish_preview(jsonb,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.confirm_publish_preview(uuid) from public, anon, authenticated;
grant execute on function public.create_publish_preview(jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.confirm_publish_preview(uuid) to service_role;

-- Mantém deal.created/deal.ready, dispatches, tracking e retorno existentes.
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
  v_preview public.deal_publish_previews%rowtype;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'n8n_deal_webhook_url';
  if v_url is null or btrim(v_url) = '' then
    return new;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'n8n_webhook_secret';

  -- Promoção pronta: registra o envio para o canal padrão ativo. Sem canal ativo, o n8n não publica.
  if new.status = 'ready' then
    if nullif(current_setting('gdp.publish_preview', true), '') is not null then
      select * into strict v_preview from public.deal_publish_previews
       where id = current_setting('gdp.publish_preview')::uuid and deal_id = new.id;
      select * into strict v_channel from public.channels where id = v_preview.channel_id and is_active;
    else
      select * into v_channel from public.channels where is_active order by is_default desc, created_at limit 1;
    end if;
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

  if v_preview.id is not null then
    if v_dispatch is null then
      raise exception 'Não foi possível registrar o envio' using errcode = '40001';
    end if;
    v_body := v_body || jsonb_build_object('telegram', v_preview.telegram);
  end if;

  begin
    perform net.http_post(
      url                  := btrim(v_url),
      body                 := v_body,
      headers              := jsonb_build_object('Content-Type', 'application/json', 'X-GDP-Secret', coalesce(v_secret, '')),
      timeout_milliseconds := 10000
    );
  exception when others then
    if v_preview.id is not null then
      raise; -- Confirmação deve ser atômica, inclusive no enfileiramento.
    end if;
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

commit;
