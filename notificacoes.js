// Histórico de notificações: lista paginada da view notification_feed, com filtros e leitura.
// Requer shell.js e notify.js carregados antes. Tudo é montado via DOM, sem innerHTML.
(function () {
  var shell = window.GDP_SHELL;
  var client = shell.client;
  var U = window.GDP_NOTIFY.util;

  var PAGE_SIZE = 20;
  var MAX_MARK_ALL = 1000;
  var COLUMNS = "id, kind, title, body, meta, surface, created_at, is_read";

  function $(id) { return document.getElementById(id); }
  var listEl = $("hist"), emptyEl = $("hist-empty"), rangeEl = $("range-text");
  var moreBtn = $("load-more"), totalChip = $("total-chip"), markAllBtn = $("mark-all");
  var qEl = $("q"), kindEl = $("f-kind"), readEl = $("f-read"), periodEl = $("f-period");

  var userId = null;
  var loaded = 0;      // linhas já mostradas
  var total = 0;       // total que bate com os filtros
  var lastDay = null;  // último cabeçalho de dia desenhado
  var group = null;    // <section> do dia corrente
  var seq = 0;         // descarta respostas de consultas antigas

  // ---------- Datas ----------
  function dayKey(iso) {
    var d = new Date(iso);
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  }
  function dayLabel(iso) {
    var d = new Date(iso);
    var today = new Date();
    var yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (dayKey(iso) === dayKey(today.toISOString())) return "Hoje";
    if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Ontem";
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
  }
  function clock(iso) {
    return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  // ---------- Consulta ----------
  // Remove caracteres que têm sentido na sintaxe de filtros do PostgREST.
  function cleanTerm(text) { return text.replace(/[,()%*\\:"']/g, " ").replace(/\s+/g, " ").trim(); }

  function periodStart() {
    var hours = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30 }[periodEl.value];
    return hours ? new Date(Date.now() - hours * 36e5).toISOString() : null;
  }

  function buildQuery(withCount) {
    var query = client.from("notification_feed").select(COLUMNS, withCount ? { count: "exact" } : undefined)
      .order("created_at", { ascending: false });
    if (kindEl.value) query = query.eq("kind", kindEl.value);
    if (readEl.value === "unread") query = query.eq("is_read", false);
    if (readEl.value === "read") query = query.eq("is_read", true);
    var since = periodStart();
    if (since) query = query.gte("created_at", since);
    var term = cleanTerm(qEl.value);
    if (term) query = query.or("title.ilike.%" + term + "%,body.ilike.%" + term + "%");
    return query;
  }

  // ---------- Desenho ----------
  function rowEl(n) {
    var row = U.el("article", "nitem k-" + U.kindOf(n) + (n.is_read ? "" : " is-unread"));
    row.tabIndex = 0;
    row.appendChild(U.kindIcon(n, "nitem__ico"));

    var main = U.el("div", "nitem__main");
    var head = U.el("div", "nitem__head");
    head.appendChild(U.el("strong", null, n.title || ""));
    head.appendChild(U.el("time", "nitem__time", clock(n.created_at)));
    main.appendChild(head);
    if (n.body) main.appendChild(U.richText(U.el("p", "nitem__body"), n.body));

    var meta = n.meta || {};
    var extra = U.el("div", "nitem__extra");
    if (meta.metric) {
      var m = U.el("span", "nitem__metric");
      m.appendChild(U.icon("i-trend"));
      m.appendChild(document.createTextNode(meta.metric));
      extra.appendChild(m);
    }
    if (meta.chip) extra.appendChild(U.el("span", "nitem__chip", meta.chip));
    (meta.actions || []).forEach(function (a) { extra.appendChild(U.actionEl(a, null)); });
    if (extra.childNodes.length) main.appendChild(extra);
    row.appendChild(main);

    function open() {
      if (!n.is_read) {
        n.is_read = true;
        row.classList.remove("is-unread");
        window.GDP_NOTIFY.markRead(n.id);
      }
      var href = U.safeInternalHref(meta.href) || (meta.deal_id ? "promocao.html?id=" + encodeURIComponent(meta.deal_id) : null);
      if (href) window.location.href = href;
    }
    row.addEventListener("click", open);
    row.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target === row) open(); });
    return row;
  }

  function append(rows) {
    rows.forEach(function (n) {
      var key = dayKey(n.created_at);
      if (key !== lastDay) {
        lastDay = key;
        group = U.el("section", "hist__day");
        group.appendChild(U.el("h2", "hist__title", dayLabel(n.created_at)));
        var card = U.el("div", "card hist__card");
        group.appendChild(card);
        group.card = card;
        listEl.appendChild(group);
      }
      group.card.appendChild(rowEl(n));
    });
  }

  function summary() {
    totalChip.textContent = total + (total === 1 ? " item" : " itens");
    rangeEl.textContent = total ? "Mostrando " + loaded + " de " + total : "";
    moreBtn.hidden = loaded >= total;
    emptyEl.hidden = total > 0;
  }

  function reset() {
    listEl.textContent = "";
    loaded = 0; total = 0; lastDay = null; group = null;
  }

  // ---------- Carga ----------
  function fetchPage(first) {
    var mine = ++seq;
    moreBtn.disabled = true;
    if (first) { reset(); rangeEl.textContent = "Carregando…"; emptyEl.hidden = true; moreBtn.hidden = true; }
    return buildQuery(true).range(loaded, loaded + PAGE_SIZE - 1).then(function (res) {
      if (mine !== seq) return;
      moreBtn.disabled = false;
      if (res.error) {
        rangeEl.textContent = "Não foi possível carregar as notificações.";
        moreBtn.hidden = true;
        return;
      }
      var rows = res.data || [];
      total = typeof res.count === "number" ? res.count : loaded + rows.length;
      append(rows);
      loaded += rows.length;
      summary();
    });
  }

  function reload() { return fetchPage(true); }

  // ---------- Ações ----------
  function markAll() {
    if (!userId) return;
    markAllBtn.disabled = true;
    client.from("notification_feed").select("id").eq("is_read", false).limit(MAX_MARK_ALL).then(function (res) {
      var ids = (res.data || []).map(function (r) { return r.id; });
      if (res.error || !ids.length) { markAllBtn.disabled = false; if (!res.error) shell.toast({ kind: "info", title: "Tudo em dia", body: "Não há notificações não lidas." }); return; }
      var rows = ids.map(function (id) { return { notification_id: id, user_id: userId }; });
      return client.from("notification_reads").upsert(rows, { onConflict: "notification_id,user_id", ignoreDuplicates: true }).then(function (r2) {
        markAllBtn.disabled = false;
        if (r2.error) { shell.toast({ kind: "error", title: "Não foi possível marcar como lidas", body: "Tente novamente." }); return; }
        window.GDP_NOTIFY.reload();
        reload();
      });
    });
  }

  function clearFilters() {
    qEl.value = ""; kindEl.value = ""; readEl.value = ""; periodEl.value = "";
    reload();
  }

  // ---------- Eventos ----------
  var timer;
  qEl.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(reload, 300); });
  [kindEl, readEl, periodEl].forEach(function (s) { s.addEventListener("change", reload); });
  $("f-clear").addEventListener("click", clearFilters);
  moreBtn.addEventListener("click", function () { fetchPage(false); });
  markAllBtn.addEventListener("click", markAll);

  shell.ready.then(function (user) {
    userId = user.id;
    reload();
  });
})();
