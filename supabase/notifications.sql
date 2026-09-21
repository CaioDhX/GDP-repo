-- Central de notificações do painel (usada por notify.js).
-- Rode no SQL Editor do Supabase. Idempotente: pode rodar de novo sem quebrar.
--
--   notifications        -> uma linha por notificação (global quando user_id é nulo)
--   notification_reads   -> quem já leu o quê (uma linha por usuário x notificação)
--   notification_feed    -> view lida pelo painel: notificações visíveis + is_read do usuário atual
--
-- Como emitir uma notificação:
--   * de dentro do painel:  GDP_NOTIFY.publish({ kind, title, body, meta, surface, user_id })
--   * do bot / backend:     insert em public.notifications com a service_role
--   * automaticamente:      triggers em public.deals (abaixo)
--
-- kind:    success | error | warning | info | telegram | security | brand
-- surface: toast (padrão: aparece flutuante + entra na lista) | banner (fixa no topo até ler) | list (só na lista)
-- meta (jsonb, tudo opcional):
--   { "deal_id": uuid, "href": "promocao.html?id=…", "tag": "AÇÃO REQUERIDA", "icon": "i-bolt",
--     "metric": "+34% vs média", "chip": "ID Relatório: #SHP-9921", "dismiss_hours": 24,
--     "actions": [{ "label": "Ver métricas", "href": "…", "style": "link|pill|muted|primary|outline|ghost" }] }
--   Trechos entre **asteriscos** no body aparecem em negrito.

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  kind        text not null default 'info'
              check (kind in ('success', 'error', 'warning', 'info', 'telegram', 'security', 'brand')),
  surface     text not null default 'toast' check (surface in ('toast', 'banner', 'list')),
  title       text not null check (length(title) between 1 and 120),
  body        text check (length(body) <= 600),
  meta        jsonb not null default '{}'::jsonb,
  user_id     uuid references auth.users (id) on delete cascade,   -- nulo = para todos
  created_by  uuid references auth.users (id) on delete set null
);
create index if not exists notifications_created_at_idx on public.notifications (created_at desc);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

create table if not exists public.notification_reads (
  notification_id uuid not null references public.notifications (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_id)
);

alter table public.notifications enable row level security;
alter table public.notification_reads enable row level security;

-- Leitura: as globais e as minhas.
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id is null or user_id = auth.uid());

-- Qualquer usuário logado do painel pode emitir (o bot usa a service_role e ignora RLS).
drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications
  for insert to authenticated
  with check (created_by is null or created_by = auth.uid());

-- Só administradores apagam notificações.
drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists notification_reads_all on public.notification_reads;
create policy notification_reads_all on public.notification_reads
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Preenche created_by automaticamente quando o insert vem do painel.
create or replace function public.notifications_set_creator()
returns trigger language plpgsql as $$
begin
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists notifications_set_creator on public.notifications;
create trigger notifications_set_creator
  before insert on public.notifications
  for each row execute function public.notifications_set_creator();

-- Feed lido pelo painel (respeita a RLS de quem consulta).
create or replace view public.notification_feed
with (security_invoker = true) as
  select n.id, n.created_at, n.kind, n.surface, n.title, n.body, n.meta, n.user_id,
         exists (select 1 from public.notification_reads r
                  where r.notification_id = n.id and r.user_id = auth.uid()) as is_read
    from public.notifications n;
grant select on public.notification_feed to authenticated;

-- Tempo real: o painel escuta INSERTs em public.notifications.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- Limpeza: guarda só os últimos 90 dias (agende com pg_cron se quiser: select public.notifications_prune()).
create or replace function public.notifications_prune()
returns void language sql security definer set search_path = public as $$
  delete from public.notifications where created_at < now() - interval '90 days';
$$;

-- ---------------------------------------------------------------------------
-- Eventos automáticos a partir de public.deals
-- ---------------------------------------------------------------------------
create or replace function public.deals_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_kind    text;
  v_title   text;
  v_body    text;
  v_store   text;
  v_author  text;
  v_meta    jsonb;
begin
  select s.name into v_store from public.stores s where s.id = new.store_id;
  v_meta := jsonb_build_object('deal_id', new.id, 'href', 'promocao.html?id=' || new.id::text);

  if tg_op = 'INSERT' then
    select p.full_name into v_author from public.profiles p where p.id = new.created_by;
    v_kind  := 'success';
    v_title := 'Nova promoção cadastrada';
    v_body  := '**' || new.title || '** (' || coalesce(v_store, 'sem loja') || ') foi cadastrada por ' || coalesce(v_author, 'um usuário') || '.';
    v_meta  := v_meta || jsonb_build_object('actions', jsonb_build_array(
                 jsonb_build_object('label', 'Abrir promoção', 'href', 'promocao.html?id=' || new.id::text, 'style', 'link')));

  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'published' then
      v_kind  := 'telegram';
      v_title := 'Oferta Disparada com Sucesso!';
      v_body  := '**' || new.title || '** foi publicada no Telegram e o link afiliado foi gerado.';
      v_meta  := v_meta || jsonb_build_object('actions', jsonb_build_array(
                   jsonb_build_object('label', 'Visualizar post', 'href', 'promocao.html?id=' || new.id::text, 'style', 'link')));
    elsif new.status = 'failed' then
      v_kind  := 'error';
      v_title := 'Falha ao publicar oferta';
      v_body  := 'O bot não conseguiu publicar **' || new.title || '**. Revise o link e tente novamente.';
      v_meta  := v_meta || jsonb_build_object('actions', jsonb_build_array(
                   jsonb_build_object('label', 'Revisar oferta', 'href', 'promocao.html?id=' || new.id::text, 'style', 'pill')));
    elsif new.status = 'expired' then
      v_kind  := 'warning';
      v_title := 'Oferta expirada';
      v_body  := '**' || new.title || '** saiu do ar por ter passado da validade.';
    elsif new.status = 'ready' then
      v_kind  := 'info';
      v_title := 'Promoção pronta para disparo';
      v_body  := '**' || new.title || '** entrou na fila do bot.';
    else
      return new;
    end if;
  else
    return new;
  end if;

  insert into public.notifications (kind, surface, title, body, meta, created_by)
  values (v_kind, case when new.status = 'ready' then 'list' else 'toast' end, v_title, v_body, v_meta, auth.uid());
  return new;
end $$;

drop trigger if exists deals_notify_insert on public.deals;
create trigger deals_notify_insert
  after insert on public.deals
  for each row execute function public.deals_notify();

drop trigger if exists deals_notify_status on public.deals;
create trigger deals_notify_status
  after update of status on public.deals
  for each row execute function public.deals_notify();
