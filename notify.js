// Central de notificações do painel: toasts flutuantes, banners informativos e o
// dropdown do sino. As notificações persistidas vivem em public.notifications e chegam
// em tempo real pelo Supabase Realtime; as locais (feedback de ação) só aparecem como toast.
// Requer shell.js carregado antes. Tudo é montado via DOM, sem innerHTML.
(function () {
  var shell = window.GDP_SHELL;
  var client = shell.client;

  var ICONS_URL = "assets/icons.svg?v=29";
  var TOAST_MS = 6000;
  var FEED_LIMIT = 20;
  var DISMISS_KEY = "gdp-banner-dismiss:";

  // Aparência de cada tipo. `icon` é o símbolo padrão em assets/icons.svg.
  var KINDS = {
    success:  { icon: "i-check-circle" },
    error:    { icon: "i-alert" },
    warning:  { icon: "i-warn" },
    info:     { icon: "i-info" },
    telegram: { icon: "i-plane", fill: true },
    security: { icon: "i-shield", fill: true },
    brand:    { icon: "i-flame" }
  };

  // ---------- Utilidades ----------
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function icon(id, fill) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "i" + (fill ? " i--fill" : ""));
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", ICONS_URL + "#" + id);
    svg.appendChild(use);
    return svg;
  }
  function isHttp(url) { return /^https?:\/\//i.test(url || ""); }

  // Os links e ícones das notificações vêm do banco (meta jsonb), então nunca são confiáveis.
  // Só passam http(s) e caminhos relativos simples (ex.: promocao.html?id=…); qualquer outro
  // esquema (javascript:, data:, //host…) é descartado.
  function safeHref(url) {
    if (typeof url !== "string") return null;
    url = url.trim();
    if (isHttp(url)) return url;
    if (/^[a-z0-9_\-.\/]+(\?[^\s:]*)?(#\S*)?$/i.test(url) && url.indexOf("//") !== 0) return url;
    return null;
  }
  // Navegação automática (clique na notificação): só dentro do próprio painel.
  function safeInternalHref(url) {
    var h = safeHref(url);
    return h && !isHttp(h) ? h : null;
  }
  var ACTION_STYLES = ["link", "pill", "muted", "primary", "outline", "ghost"];
  function safeStyle(style) { return ACTION_STYLES.indexOf(style) !== -1 ? style : "link"; }
  function safeIconId(id) { return typeof id === "string" && /^[a-z0-9-]+$/i.test(id) ? id : null; }
  function kindOf(n) { return KINDS[n.kind] ? n.kind : "info"; }

  // "há 2m", "há 5h", "ontem"…
  function ago(iso) {
    var diff = Math.max(0, Date.now() - new Date(iso).getTime());
    var m = Math.round(diff / 6e4);
    if (m < 1) return "Agora";
    if (m < 60) return "Há " + m + " min";
    var h = Math.round(m / 60);
    if (h < 24) return "Há " + h + (h === 1 ? " hora" : " horas");
    var d = Math.round(h / 24);
    return d === 1 ? "Ontem" : "Há " + d + " dias";
  }

  // Texto com trechos em **negrito** vira uma sequência de nós (nada é interpretado como HTML).
  function richText(parent, text) {
    String(text || "").split(/(\*\*[^*]+\*\*)/g).forEach(function (part) {
      if (!part) return;
      if (part.slice(0, 2) === "**" && part.slice(-2) === "**") parent.appendChild(el("strong", null, part.slice(2, -2)));
      else parent.appendChild(document.createTextNode(part));
    });
    return parent;
  }

  function kindIcon(n, className) {
    var k = KINDS[kindOf(n)];
    var wrap = el("span", className + " k-" + kindOf(n));
    var custom = safeIconId(n.icon);
    wrap.appendChild(icon(custom || k.icon, custom ? false : k.fill));
    return wrap;
  }

  // Ação: { label, href?, onClick?, style? } — style: link | pill | muted | primary | outline | ghost.
  function actionEl(a, close) {
    var node;
    var href = a.href ? safeHref(a.href) : null;
    var style = safeStyle(a.style);
    if (href) {
      node = el("a", "ntf__act ntf__act--" + style, a.label);
      node.href = href;
      if (isHttp(href)) { node.target = "_blank"; node.rel = "noopener noreferrer"; }
    } else {
      node = el("button", "ntf__act ntf__act--" + style, a.label);
      node.type = "button";
    }
    if (safeIconId(a.icon)) node.appendChild(icon(a.icon));
    node.addEventListener("click", function (event) {
      event.stopPropagation();
      if (typeof a.onClick === "function") a.onClick(event);
      if (a.closes !== false && close) close();
    });
    return node;
  }

  function actionsRow(list, className, close) {
    if (!list || !list.length) return null;
    var row = el("div", className);
    list.forEach(function (a) { row.appendChild(actionEl(a, close)); });
    return row;
  }

  // ---------- 1. Toasts (canto superior direito) ----------
  var stack = el("div", "toasts");
  stack.setAttribute("aria-live", "polite");
  document.body.appendChild(stack);

  // Aceita string (mensagem simples) ou { kind, title, body, time, actions, duration, icon }.
  function toast(opts) {
    if (typeof opts === "string") opts = { kind: "info", title: opts };
    var n = opts || {};
    var card = el("article", "ntf ntf--toast k-" + kindOf(n));
    card.setAttribute("role", n.kind === "error" ? "alert" : "status");

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      card.classList.add("is-leaving");
      setTimeout(function () { card.remove(); }, 220);
    }

    card.appendChild(kindIcon(n, "ntf__ico"));

    var main = el("div", "ntf__main");
    var head = el("div", "ntf__head");
    head.appendChild(el("strong", "ntf__title", n.title || ""));
    head.appendChild(el("span", "ntf__time", n.time || "Agora"));
    var x = el("button", "ntf__close");
    x.type = "button"; x.setAttribute("aria-label", "Fechar"); x.appendChild(icon("i-x"));
    x.addEventListener("click", close);
    head.appendChild(x);
    main.appendChild(head);
    if (n.body) main.appendChild(richText(el("p", "ntf__body"), n.body));
    var acts = actionsRow(n.actions, "ntf__actions", close);
    if (acts) main.appendChild(acts);
    card.appendChild(main);

    stack.appendChild(card);
    while (stack.children.length > 4) stack.firstChild.remove();

    var timer = setTimeout(close, n.duration || TOAST_MS);
    card.addEventListener("mouseenter", function () { clearTimeout(timer); });
    card.addEventListener("mouseleave", function () { timer = setTimeout(close, 2500); });
    return close;
  }

  // ---------- 2. Banners (topo do conteúdo) ----------
  var bannerHost = null;
  function bannersHost() {
    if (bannerHost) return bannerHost;
    var content = document.querySelector(".content");
    if (!content) return null;
    bannerHost = el("div", "banners");
    content.insertBefore(bannerHost, content.firstChild);
    return bannerHost;
  }

  function dismissedUntil(id) {
    try { return Number(window.localStorage.getItem(DISMISS_KEY + id)) || 0; } catch (e) { return 0; }
  }
  function dismiss(id, hours) {
    try { window.localStorage.setItem(DISMISS_KEY + id, String(Date.now() + hours * 36e5)); } catch (e) { /* sem armazenamento */ }
  }

  // { id, kind, title, body, tag, actions, dismissHours, closable, icon }
  // Variantes visuais: warning (âmbar), brand (vermelho), security (escuro), info, success, error.
  function banner(n) {
    var host = bannersHost();
    if (!host || !n) return null;
    if (n.id && dismissedUntil(n.id) > Date.now()) return null;
    var old = n.id && host.querySelector('[data-banner="' + n.id + '"]');
    if (old) old.remove();

    var card = el("section", "ntf ntf--banner k-" + kindOf(n));
    if (n.id) card.setAttribute("data-banner", n.id);
    card.setAttribute("aria-label", n.title || "Aviso");
    function close() {
      if (n.id && n.dismissHours) dismiss(n.id, n.dismissHours);
      if (n.persisted) markRead(n.id);
      card.remove();
    }

    card.appendChild(kindIcon(n, "ntf__ico ntf__ico--sq"));
    var main = el("div", "ntf__main");
    var head = el("div", "ntf__head");
    head.appendChild(el("strong", "ntf__title", n.title || ""));
    if (n.tag) head.appendChild(el("span", "ntf__tag", n.tag));
    main.appendChild(head);
    if (n.body) main.appendChild(richText(el("p", "ntf__body"), n.body));
    card.appendChild(main);

    var acts = actionsRow(n.actions, "ntf__actions ntf__actions--banner", close);
    if (acts) card.appendChild(acts);
    if (n.closable) {
      var x = el("button", "ntf__close");
      x.type = "button"; x.setAttribute("aria-label", "Fechar"); x.appendChild(icon("i-x"));
      x.addEventListener("click", close);
      card.appendChild(x);
    }
    host.appendChild(card);
    return close;
  }

  // ---------- 3. Central (dropdown do sino) ----------
  var bell = document.querySelector(".bell");
  var items = [];      // feed em memória, mais recente primeiro
  var userId = null;
  var menu, listEl, badgeEl, countEl, emptyEl;

  function unread() { return items.filter(function (n) { return !n.is_read; }).length; }

  function buildMenu() {
    menu = el("div", "notif");
    menu.id = "notif-menu";
    menu.hidden = true;
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Notificações recentes");

    var head = el("header", "notif__head");
    var title = el("strong", null, "Notificações Recentes");
    countEl = el("span", "notif__count", "0");
    countEl.hidden = true;
    title.appendChild(countEl);
    head.appendChild(title);
    var all = el("button", "notif__all", "Marcar todas como lidas");
    all.type = "button";
    all.addEventListener("click", markAllRead);
    head.appendChild(all);
    menu.appendChild(head);

    listEl = el("div", "notif__list");
    menu.appendChild(listEl);

    emptyEl = el("p", "notif__empty", "Nenhuma notificação por aqui ainda.");
    emptyEl.hidden = true;
    menu.appendChild(emptyEl);

    var foot = el("a", "notif__foot", "Acessar Histórico Completo de Notificações");
    foot.href = "notificacoes.html";
    menu.appendChild(foot);

    bell.parentNode.insertBefore(menu, bell.nextSibling);
    bell.setAttribute("aria-haspopup", "true");
    bell.setAttribute("aria-expanded", "false");
    bell.setAttribute("aria-controls", "notif-menu");
    badgeEl = el("span", "bell__badge", "0");
    badgeEl.hidden = true;
    bell.appendChild(badgeEl);

    bell.addEventListener("click", function (event) {
      event.stopPropagation();
      setOpen(menu.hidden);
    });
    document.addEventListener("click", function (event) {
      if (!menu.hidden && !menu.contains(event.target)) setOpen(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") setOpen(false);
    });
  }

  function setOpen(open) {
    menu.hidden = !open;
    stack.classList.toggle("is-muted", open);
    bell.setAttribute("aria-expanded", String(open));
  }

  function renderItem(n) {
    var row = el("article", "nitem k-" + kindOf(n) + (n.is_read ? "" : " is-unread"));
    row.tabIndex = 0;
    row.appendChild(kindIcon(n, "nitem__ico"));

    var main = el("div", "nitem__main");
    var head = el("div", "nitem__head");
    head.appendChild(el("strong", null, n.title || ""));
    head.appendChild(el("time", "nitem__time", ago(n.created_at)));
    main.appendChild(head);
    if (n.body) main.appendChild(richText(el("p", "nitem__body"), n.body));

    var meta = n.meta || {};
    var extra = el("div", "nitem__extra");
    if (meta.metric) {
      var m = el("span", "nitem__metric");
      m.appendChild(icon("i-trend"));
      m.appendChild(document.createTextNode(meta.metric));
      extra.appendChild(m);
    }
    if (meta.chip) extra.appendChild(el("span", "nitem__chip", meta.chip));
    (meta.actions || []).forEach(function (a) { extra.appendChild(actionEl(a, null)); });
    if (extra.childNodes.length) main.appendChild(extra);
    row.appendChild(main);

    function open() {
      markRead(n.id);
      var href = safeInternalHref(meta.href) || (meta.deal_id ? "promocao.html?id=" + encodeURIComponent(meta.deal_id) : null);
      if (href) window.location.href = href;
    }
    row.addEventListener("click", open);
    row.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target === row) open(); });
    return row;
  }

  function render() {
    if (!menu) return;
    listEl.textContent = "";
    items.forEach(function (n) { listEl.appendChild(renderItem(n)); });
    emptyEl.hidden = items.length > 0;
    var u = unread();
    countEl.textContent = String(u);
    countEl.hidden = u === 0;
    badgeEl.textContent = u > 9 ? "9+" : String(u);
    badgeEl.hidden = u === 0;
    bell.classList.toggle("has-unread", u > 0);
    document.title = document.title.replace(/^\(\d+\+?\)\s*/, "");
    if (u) document.title = "(" + (u > 9 ? "9+" : u) + ") " + document.title;
  }

  function add(row) {
    if (items.some(function (n) { return n.id === row.id; })) return;
    items.unshift(row);
    if (items.length > FEED_LIMIT) items.length = FEED_LIMIT;
    render();
  }

  function markRead(id) {
    if (!userId) return;
    var n = items.filter(function (x) { return x.id === id; })[0];
    if (n && n.is_read) return;
    if (n) { n.is_read = true; render(); }
    client.from("notification_reads").upsert({ notification_id: id, user_id: userId }, { onConflict: "notification_id,user_id", ignoreDuplicates: true }).then(function () {});
  }

  function markAllRead() {
    var pending = items.filter(function (n) { return !n.is_read; });
    if (!pending.length || !userId) return;
    pending.forEach(function (n) { n.is_read = true; });
    render();
    var rows = pending.map(function (n) { return { notification_id: n.id, user_id: userId }; });
    client.from("notification_reads").upsert(rows, { onConflict: "notification_id,user_id", ignoreDuplicates: true }).then(function () {});
  }

  // Converte uma linha de public.notifications no formato aceito por toast()/banner().
  function fromRow(row) {
    var meta = row.meta || {};
    return {
      id: row.id,
      persisted: true,
      kind: row.kind,
      icon: meta.icon,
      title: row.title,
      body: row.body,
      tag: meta.tag,
      actions: (meta.actions || []).slice(0, 2),
      dismissHours: meta.dismiss_hours,
      closable: meta.closable !== false
    };
  }

  // Lê o feed (view notification_feed: notificações do usuário + globais, com is_read).
  function load() {
    return client.from("notification_feed").select("id, kind, title, body, meta, surface, created_at, is_read")
      .order("created_at", { ascending: false }).limit(FEED_LIMIT)
      .then(function (res) {
        if (res.error) return;   // tabela ainda não criada: a central fica vazia, sem quebrar o painel
        items = res.data || [];
        render();
        items.forEach(function (n) {
          if (n.surface === "banner" && !n.is_read) banner(fromRow(n));
        });
      });
  }

  // Tempo real: cada INSERT em public.notifications vira toast (ou banner) e entra na lista.
  function subscribe() {
    client.channel("gdp-notifications")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, function (payload) {
        var row = payload.new;
        if (!row || (row.user_id && row.user_id !== userId)) return;
        row.is_read = false;
        add(row);
        var n = fromRow(row);
        if (row.surface === "banner") banner(n);
        else if (row.surface !== "list") toast(n);
      })
      .subscribe();
  }

  // Cria uma notificação persistida (chega em tempo real para todos os painéis abertos).
  // { kind, title, body, meta, surface: "toast" | "banner" | "list", user_id }
  function publish(n) {
    return client.from("notifications").insert({
      kind: KINDS[n.kind] ? n.kind : "info",
      title: n.title,
      body: n.body || null,
      meta: n.meta || {},
      surface: n.surface || "toast",
      user_id: n.user_id || null
    }).then(function (res) { return res.error ? { error: res.error } : { ok: true }; });
  }

  if (bell) {
    buildMenu();
    shell.ready.then(function (user) {
      userId = user.id;
      load();
      subscribe();
    });
  }

  window.GDP_NOTIFY = {
    toast: toast, banner: banner, publish: publish, markRead: markRead, markAllRead: markAllRead, reload: load,
    // Usado pela página de histórico (notificacoes.js).
    util: { el: el, icon: icon, richText: richText, kindIcon: kindIcon, actionEl: actionEl, kindOf: kindOf, safeInternalHref: safeInternalHref }
  };
})();
