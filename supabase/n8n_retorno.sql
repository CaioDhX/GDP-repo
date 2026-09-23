-- Caminho de volta n8n -> painel: canal do Telegram, resultado das publicações, botão
-- "Testar Envio", contagem de membros e cliques rastreados. Já aplicado no projeto; idempotente.
-- A ida (Supabase -> n8n) está em n8n_webhook.sql.
--
-- Fluxo de uma promoção
--   1. Promoção vira "ready" -> gatilho cria deal_dispatches (state "sending") e chama o n8n.
--   2. O n8n publica no canal e chama public.n8n_report_dispatch (REST, chave anon + X-GDP-Secret):
--        sucesso -> envio "sent" (telegram_message_id) e promoção "published" (published_at = agora)
--        falha   -> envio "failed" (error) e promoção "failed" (last_error)
--   3. O botão da mensagem aponta para /go/?p=GP-1234&c=canal, que chama public.deal_click:
--      grava o clique (deal_clicks, com hash do IP) e devolve o link afiliado que está no banco.
--
-- Botão "Testar Envio" (Dashboard)
--   public.channel_test_request(canal) -> n8n (event "channel.test") -> o bot publica uma mensagem
--   silenciosa e apaga em seguida -> public.n8n_report_channel_test grava last_test_* no canal.
--
-- Contagem de membros (opcional)
--   Precisa do token do bot no Vault. Rode UMA vez no SQL Editor, colando o token no lugar indicado
--   (o token não vai para o repositório nem para o site):
--     select vault.create_secret('COLE_O_TOKEN_DO_BOT_AQUI', 'telegram_bot_token', 'Token do bot do Telegram (contagem de membros)');
--   O pg_cron roda public.channels_refresh_members() a cada 10 minutos (getChatMemberCount).
--   Sem o token, o painel mostra "—" em Membros.
--
-- Diagnóstico
--   select state, error, started_at, sent_at from public.deal_dispatches order by started_at desc limit 20;
--   select name, last_test_at, last_test_ok, last_test_error, member_count, member_count_updated_at from public.channels;

-- ---------- Canal ----------
alter table public.channels
  add column if not exists last_test_requested_at    timestamptz,
  add column if not exists last_test_at              timestamptz,
  add column if not exists last_test_ok              boolean,
  add column if not exists last_test_deleted         boolean,
  add column if not exists last_test_error           text,
  add column if not exists member_count_updated_at   timestamptz,
  add column if not exists member_count_request_id   bigint,
  add column if not exists member_count_requested_at timestamptz;

-- Sem contagem real ainda: o painel mostra "—" em vez de um 0 inventado.
alter table public.channels alter column member_count drop default;

insert into public.channels (slug, name, chat_id, username, is_active, is_default, member_count)
values ('goatpromocoes', 'GOAT DAS PROMOÇÕES - #1', '@goatpromocoes', 'goatpromocoes', true, true, null)
on conflict (slug) do nothing;

-- Só um envio "em andamento" por promoção/canal; o histórico pode ter vários "sent" (republicação).
drop index if exists public.deal_dispatches_unico_ativo;
create unique index if not exists deal_dispatches_unico_enviando
  on public.deal_dispatches (deal_id, channel_id) where state = 'sending';
create index if not exists deal_dispatches_canal_idx on public.deal_dispatches (channel_id, started_at desc);
create index if not exists deal_clicks_canal_idx on public.deal_clicks (channel_id, created_at desc);

-- Sal do hash de IP dos cliques (o IP em si nunca é gravado).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'click_ip_salt') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'click_ip_salt',
      'Sal do hash de IP dos cliques (deal_clicks.ip_hash)');
  end if;
end $$;

-- ---------- Contagem de membros ----------
-- Coleta a resposta do pedido anterior e dispara um novo getChatMemberCount (pg_net é assíncrono).
create or replace function public.channels_refresh_members()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
  r       record;
  v_resp  record;
  v_json  jsonb;
  v_req   bigint;
begin
  for r in select id, member_count_request_id, member_count_requested_at
             from public.channels where member_count_request_id is not null loop
    select status_code, content into v_resp from net._http_response where id = r.member_count_request_id;
    if found then
      begin v_json := v_resp.content::jsonb; exception when others then v_json := null; end;
      if v_resp.status_code = 200 and jsonb_typeof(v_json -> 'result') = 'number' then
        update public.channels
           set member_count = (v_json ->> 'result')::int, member_count_updated_at = now(),
               member_count_request_id = null, member_count_requested_at = null
         where id = r.id;
      else
        update public.channels set member_count_request_id = null, member_count_requested_at = null where id = r.id;
      end if;
    elsif r.member_count_requested_at < now() - interval '15 minutes' then
      update public.channels set member_count_request_id = null, member_count_requested_at = null where id = r.id;
    end if;
  end loop;

  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';
  if v_token is null or btrim(v_token) = '' then
    return;
  end if;

  for r in select id, chat_id from public.channels
            where is_active and member_count_request_id is null
              and (member_count_updated_at is null or member_count_updated_at < now() - interval '5 minutes') loop
    v_req := net.http_get(
      url                  := 'https://api.telegram.org/bot' || btrim(v_token) || '/getChatMemberCount',
      params               := jsonb_build_object('chat_id', r.chat_id),
      timeout_milliseconds := 10000
    );
    update public.channels set member_count_request_id = v_req, member_count_requested_at = now() where id = r.id;
  end loop;
end $$;

revoke execute on function public.channels_refresh_members() from public, anon, authenticated;

-- ---------- n8n -> painel: resultado da publicação ----------
-- Chamado pelo n8n via REST (/rest/v1/rpc/n8n_report_dispatch) com a chave anon.
-- Quem autoriza é o p_secret (o mesmo X-GDP-Secret que o Supabase manda ao n8n).
create or replace function public.n8n_report_dispatch(
  p_secret      text,
  p_dispatch_id uuid,
  p_ok          boolean,
  p_message_id  bigint default null,
  p_message     text   default null,
  p_error       text   default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  v_d      public.deal_dispatches%rowtype;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'n8n_webhook_secret';
  if v_secret is null or p_secret is null or p_secret <> v_secret then
    raise exception 'não autorizado' using errcode = '42501';
  end if;

  update public.deal_dispatches
     set state               = case when p_ok then 'sent'::dispatch_state else 'failed'::dispatch_state end,
         telegram_message_id = case when p_ok then p_message_id end,
         rendered_message    = left(p_message, 4096),
         error               = case when p_ok then null else left(coalesce(nullif(btrim(p_error), ''), 'Falha sem detalhe'), 1000) end,
         sent_at             = case when p_ok then now() end
   where id = p_dispatch_id
  returning * into v_d;
  if not found then
    raise exception 'envio % não encontrado', p_dispatch_id using errcode = 'P0002';
  end if;

  if p_ok then
    update public.deals set status = 'published', published_at = now(), last_error = null
     where id = v_d.deal_id and status in ('ready', 'queued', 'failed');
  else
    update public.deals set status = 'failed', last_error = v_d.error
     where id = v_d.deal_id and status in ('ready', 'queued');
  end if;

  return jsonb_build_object('ok', true, 'dispatch_id', v_d.id, 'deal_id', v_d.deal_id, 'state', v_d.state);
end $$;

revoke execute on function public.n8n_report_dispatch(text, uuid, boolean, bigint, text, text) from public, anon, authenticated;
grant execute on function public.n8n_report_dispatch(text, uuid, boolean, bigint, text, text) to anon;

-- ---------- Botão "Testar Envio" do Dashboard ----------
create or replace function public.channel_test_request(p_channel_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ch     public.channels%rowtype;
  v_url    text;
  v_secret text;
  v_now    timestamptz := now();
begin
  if not public.is_staff() then
    raise exception 'Sem permissão para testar o canal.' using errcode = '42501';
  end if;
  select * into v_ch from public.channels where id = p_channel_id;
  if not found then
    raise exception 'Canal não encontrado.' using errcode = 'P0002';
  end if;
  if v_ch.last_test_requested_at > v_now - interval '15 seconds' then
    raise exception 'Aguarde alguns segundos antes de testar de novo.' using errcode = 'P0001';
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'n8n_deal_webhook_url';
  if v_url is null or btrim(v_url) = '' then
    raise exception 'O n8n ainda não está configurado.' using errcode = 'P0001';
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'n8n_webhook_secret';

  update public.channels set last_test_requested_at = v_now where id = p_channel_id;

  perform net.http_post(
    url                  := btrim(v_url),
    body                 := jsonb_build_object(
                              'event', 'channel.test', 'sent_at', v_now, 'requested_by', auth.uid(),
                              'channel', jsonb_build_object('id', v_ch.id, 'slug', v_ch.slug, 'name', v_ch.name,
                                                            'chat_id', v_ch.chat_id, 'username', v_ch.username)),
    headers              := jsonb_build_object('Content-Type', 'application/json', 'X-GDP-Secret', coalesce(v_secret, '')),
    timeout_milliseconds := 10000
  );

  begin
    perform public.channels_refresh_members();
  exception when others then
    raise warning 'channel_test_request: membros não atualizados (%)', sqlerrm;
  end;

  return v_now;
end $$;

revoke execute on function public.channel_test_request(uuid) from public, anon, authenticated;
grant execute on function public.channel_test_request(uuid) to authenticated;

create or replace function public.n8n_report_channel_test(
  p_secret     text,
  p_channel_id uuid,
  p_ok         boolean,
  p_deleted    boolean default null,
  p_error      text    default null,
  p_chat_title text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'n8n_webhook_secret';
  if v_secret is null or p_secret is null or p_secret <> v_secret then
    raise exception 'não autorizado' using errcode = '42501';
  end if;

  update public.channels
     set last_test_at      = now(),
         last_test_ok      = coalesce(p_ok, false),
         last_test_deleted = p_deleted,
         last_test_error   = case when p_ok then null else left(coalesce(nullif(btrim(p_error), ''), 'Falha sem detalhe'), 500) end,
         name              = coalesce(nullif(btrim(left(p_chat_title, 128)), ''), name)
   where id = p_channel_id;
  if not found then
    raise exception 'canal % não encontrado', p_channel_id using errcode = 'P0002';
  end if;

  begin
    perform public.channels_refresh_members();
  exception when others then
    raise warning 'n8n_report_channel_test: membros não atualizados (%)', sqlerrm;
  end;

  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.n8n_report_channel_test(text, uuid, boolean, boolean, text, text) from public, anon, authenticated;
grant execute on function public.n8n_report_channel_test(text, uuid, boolean, boolean, text, text) to anon;

-- ---------- Cliques: /go/?p=GP-1234&c=canal registra e devolve o link afiliado ----------
-- O link vem do banco (nada de redirecionamento aberto). Toque duplo em 30 s conta uma vez.
create or replace function public.deal_click(p_code text, p_channel text default null, p_referrer text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deal    public.deals%rowtype;
  v_channel uuid;
  v_headers json;
  v_ip      text;
  v_ua      text;
  v_hash    text;
  v_salt    text;
begin
  select * into v_deal from public.deals
   where public_code = upper(btrim(coalesce(p_code, ''))) and status <> 'draft'
   limit 1;
  if not found or v_deal.affiliate_url !~* '^https?://' then
    return null;
  end if;

  if p_channel is not null and btrim(p_channel) <> '' then
    select id into v_channel from public.channels where slug = lower(btrim(p_channel));
  end if;

  begin
    v_headers := current_setting('request.headers', true)::json;
    v_ip := nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), '');
    v_ua := left(v_headers ->> 'user-agent', 300);
  exception when others then
    v_ip := null; v_ua := null;
  end;

  if v_ip is not null then
    select decrypted_secret into v_salt from vault.decrypted_secrets where name = 'click_ip_salt';
    v_hash := encode(extensions.digest(v_ip || '|' || coalesce(v_salt, ''), 'sha256'), 'hex');
  end if;

  if v_hash is null or not exists (
       select 1 from public.deal_clicks
        where deal_id = v_deal.id and ip_hash = v_hash and created_at > now() - interval '30 seconds') then
    insert into public.deal_clicks (deal_id, channel_id, ip_hash, user_agent, referrer)
    values (v_deal.id, v_channel, v_hash, v_ua, left(nullif(btrim(p_referrer), ''), 300));
  end if;

  return v_deal.affiliate_url;
end $$;

revoke execute on function public.deal_click(text, text, text) from public, anon, authenticated;
grant execute on function public.deal_click(text, text, text) to anon, authenticated;

-- ---------- Agendamento: membros a cada 10 minutos ----------
create extension if not exists pg_cron;
select cron.schedule('gdp-membros-dos-canais', '*/10 * * * *', 'select public.channels_refresh_members()');
