// Dashboard: indicadores reais (public.deals/channels/deal_clicks/deal_dispatches),
// canal do Telegram (mostra estado vazio até existir um canal cadastrado) e as
// promoções mais recentes, com busca, paginação e ações. Sem números inventados:
// tudo começa em 0 e cresce conforme o uso real do painel.
(function () {
  var shell = window.GDP_SHELL;
  var client = shell.client;
  var toast = shell.toast;

  var PAGE_SIZE = 6;

  var STATUS_LABEL = {
    draft: "Rascunho", ready: "Pronta", queued: "Na fila",
    published: "Publicada", expired: "Expirada", failed: "Falhou"
  };

  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function icon(id) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "i");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "assets/icons.svg?v=37#" + id);
    svg.appendChild(use);
    return svg;
  }
  function brl(n) { return "R$ " + Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function isHttp(url) { return /^https?:\/\//i.test(url || ""); }

  // ---------- Período ----------
  var period = { kind: "today", from: null, to: null };

  function periodRange() {
    var now = new Date();
    if (period.kind === "today") return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()), to: null, label: "hoje" };
    if (period.kind === "7d") return { from: new Date(Date.now() - 7 * 864e5), to: null, label: "nos últimos 7 dias" };
    if (period.kind === "month") return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: null, label: "este mês" };
    if (period.kind === "custom" && period.from) {
      var to = period.to ? new Date(period.to + "T23:59:59") : null;
      return { from: new Date(period.from + "T00:00:00"), to: to, label: "no período selecionado" };
    }
    return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()), to: null, label: "hoje" };
  }

  document.querySelectorAll(".period__btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var kind = btn.getAttribute("data-period");
      $("period-custom").hidden = kind !== "custom";
      if (kind === "custom") { $("period-from").focus(); return; } // só aplica ao clicar "Aplicar"
      document.querySelectorAll(".period__btn").forEach(function (b) { b.setAttribute("aria-pressed", String(b === btn)); });
      period.kind = kind;
      loadStats();
    });
  });
  $("period-apply").addEventListener("click", function () {
    if (!$("period-from").value) { toast({ kind: "warning", title: "Escolha a data inicial" }); return; }
    period.kind = "custom";
    period.from = $("period-from").value;
    period.to = $("period-to").value || null;
    document.querySelectorAll(".period__btn").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-period") === "custom")); });
    loadStats();
  });

  // ---------- "Atualizado há..." ----------
  var lastRefresh = null;
  function relTime(date) {
    var s = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (s < 10) return "agora";
    if (s < 60) return "há " + s + " segundos";
    var m = Math.round(s / 60);
    if (m < 60) return "há " + m + (m === 1 ? " minuto" : " minutos");
    var h = Math.round(m / 60);
    return "há " + h + (h === 1 ? " hora" : " horas");
  }
  function touchUpdated() { lastRefresh = new Date(); $("updated-at").textContent = "Atualizado " + relTime(lastRefresh); }
  setInterval(function () { if (lastRefresh) $("updated-at").textContent = "Atualizado " + relTime(lastRefresh); }, 15000);

  // ---------- Indicadores ----------
  function countOf(query) { return query.then(function (res) { return typeof res.count === "number" ? res.count : 0; }); }

  function loadStats() {
    var head = { count: "exact", head: true };
    var range = periodRange();
    var now = new Date();

    var created = client.from("deals").select("id", head).gte("created_at", range.from.toISOString());
    if (range.to) created = created.lte("created_at", range.to.toISOString());

    var published = client.from("deals").select("id", head).eq("status", "published").not("published_at", "is", null).gte("published_at", range.from.toISOString());
    if (range.to) published = published.lte("published_at", range.to.toISOString());

    Promise.all([
      countOf(created),
      countOf(client.from("deals").select("id", head).eq("status", "published").or("expires_at.is.null,expires_at.gt." + now.toISOString())),
      countOf(published),
      countOf(client.from("deals").select("id", head).eq("status", "ready"))
    ]).then(function (n) {
      $("st-created").textContent = n[0];
      $("st-created-sub").textContent = range.label;
      $("st-active").textContent = n[1];
      $("st-published").textContent = n[2];
      $("st-published-sub").textContent = range.label;
      $("st-pending").textContent = n[3];
      touchUpdated();
    });

    loadChannel(range);
  }

  // ---------- Canal do Telegram ----------
  function loadChannel(range) {
    client.from("channels").select("id, name, username, member_count, is_active")
      .order("is_default", { ascending: false }).limit(1).maybeSingle()
      .then(function (res) {
        var ch = res.data;
        if (!ch) {
          $("tg-name").textContent = "Nenhum canal conectado";
          $("tg-status").textContent = "Cadastre um canal para ver os dados aqui";
          $("tg-status").className = "dash-tg__status";
          $("tg-metrics").hidden = true;
          $("tg-open").href = "#";
          return;
        }
        $("tg-name").textContent = ch.name + (ch.username ? " (@" + ch.username + ")" : "");
        $("tg-status").textContent = ch.is_active ? "Ativo" : "Inativo";
        $("tg-status").className = "dash-tg__status" + (ch.is_active ? " on" : "");
        $("tg-metrics").hidden = false;
        $("tg-members").textContent = ch.member_count != null ? Number(ch.member_count).toLocaleString("pt-BR") : "—";
        $("tg-open").href = ch.username ? "https://t.me/" + ch.username : "#";

        var clicks = client.from("deal_clicks").select("id", { count: "exact", head: true }).eq("channel_id", ch.id).gte("created_at", range.from.toISOString());
        if (range.to) clicks = clicks.lte("created_at", range.to.toISOString());
        var disp = client.from("deal_dispatches").select("id", { count: "exact", head: true }).eq("channel_id", ch.id).gte("started_at", range.from.toISOString());
        if (range.to) disp = disp.lte("started_at", range.to.toISOString());

        Promise.all([countOf(clicks), countOf(disp)]).then(function (n) {
          $("tg-clicks").textContent = n[0].toLocaleString("pt-BR");
          $("tg-deals").textContent = n[1].toLocaleString("pt-BR");
        });
      });
  }

  $("tg-test").addEventListener("click", function () {
    toast({ kind: "info", title: "Ainda não implementado", body: "O envio de teste depende do bot do Telegram, que ainda não está conectado." });
  });
  $("tg-open").addEventListener("click", function (event) {
    if ($("tg-open").getAttribute("href") === "#") {
      event.preventDefault();
      toast({ kind: "info", title: "Nenhum canal conectado", body: "Cadastre um canal do Telegram para poder abri-lo." });
    }
  });

  // ---------- Promoções recentes ----------
  var listState = { page: 1, total: 0, q: "" };
  var current = [];

  function storeChip(store) {
    var pill = el("span", "store");
    var color = /^#[0-9a-f]{6}$/i.test((store && store.badge_color) || "") ? store.badge_color : "#6b7083";
    pill.style.setProperty("--c", color);
    pill.appendChild(document.createTextNode(store ? store.name : "—"));
    return pill;
  }
  function actionBtn(iconId, label, className) {
    var b = el("button", "act" + (className ? " " + className : ""));
    b.type = "button"; b.title = label; b.setAttribute("aria-label", label);
    b.appendChild(icon(iconId));
    return b;
  }

  function goEdit(id) { window.location.href = "promocao.html?id=" + encodeURIComponent(id); }

  function duplicate(d) {
    shell.profile.then(function (profile) {
      var title = d.title.length > 110 ? d.title.slice(0, 110) : d.title;
      title = title + " (cópia)";
      if (title.length > 120) title = title.slice(0, 120);
      var payload = {
        title: title, description: d.description, image_url: d.image_url,
        store_id: d.store_id, category_id: d.category_id,
        price_original: d.price_original, price_promo: d.price_promo,
        payment_note: d.payment_note, coupon_code: d.coupon_code, coupon_at_cart: d.coupon_at_cart,
        affiliate_url: d.affiliate_url, shipping: d.shipping, highlight: d.highlight, sku: d.sku,
        status: "draft", created_by: profile.id, updated_by: profile.id
      };
      client.from("deals").insert(payload).select("id").single().then(function (res) {
        if (res.error) { toast({ kind: "error", title: "Não foi possível duplicar", body: res.error.message }); return; }
        toast({ kind: "success", title: "Promoção duplicada", body: "Abrindo a cópia em rascunho…" });
        goEdit(res.data.id);
      });
    });
  }

  function removeDeal(d) {
    shell.profile.then(function (profile) {
      if (profile.role !== "admin") { toast({ kind: "error", title: "Sem permissão", body: "Só administradores podem excluir promoções." }); return; }
      shell.confirm({
        title: "Excluir promoção?", name: d.title + " (" + d.public_code + ")",
        body: "Esta ação não pode ser desfeita.", confirmLabel: "Excluir", danger: true
      }).then(function (ok) {
        if (!ok) return;
        shell.deleteDeals([d.id]).then(function (res) {
          if (res.error) { toast({ kind: "error", title: "Não foi possível excluir", body: res.error.message }); return; }
          if (!res.deleted) { toast({ kind: "error", title: "Nada foi excluído", body: "Sem permissão no banco." }); return; }
          toast({ kind: "success", title: "Promoção excluída" });
          shell.refreshCount();
          loadRecent();
        });
      });
    });
  }

  function renderRows(list) {
    var rows = $("rows");
    rows.textContent = "";
    list.forEach(function (d) {
      var tr = el("tr", "row-link");
      tr.tabIndex = 0;
      tr.addEventListener("click", function () { goEdit(d.id); });
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target === tr) goEdit(d.id); });

      var tdProd = el("td");
      var wrap = el("div", "cell-deal");
      var thumb = el("span", "thumb");
      if (isHttp(d.image_url)) { var img = el("img"); img.src = d.image_url; img.alt = ""; img.loading = "lazy"; thumb.appendChild(img); }
      var text = el("span");
      text.appendChild(el("strong", null, d.title));
      var meta = [];
      if (d.sku) meta.push("SKU: " + d.sku);
      meta.push(d.public_code);
      text.appendChild(el("small", null, meta.join(" • ")));
      wrap.appendChild(thumb); wrap.appendChild(text);
      tdProd.appendChild(wrap);
      tr.appendChild(tdProd);

      var tdStore = el("td"); tdStore.appendChild(storeChip(d.stores)); tr.appendChild(tdStore);

      var tdPrice = el("td", "num");
      if (d.price_original != null) tdPrice.appendChild(el("s", "price-old", brl(d.price_original)));
      tdPrice.appendChild(el("strong", "price-now", brl(d.price_promo)));
      tr.appendChild(tdPrice);

      var tdOff = el("td", "ctr");
      if (d.discount_pct != null && d.discount_pct > 0) tdOff.appendChild(el("span", "off-pill", d.discount_pct + "% OFF"));
      else tdOff.textContent = "—";
      tr.appendChild(tdOff);

      var tdStatus = el("td");
      tdStatus.appendChild(el("span", "chip chip--dot chip--st-" + d.status, (STATUS_LABEL[d.status] || d.status).toUpperCase()));
      tr.appendChild(tdStatus);

      var tdDate = el("td", "cell-date");
      var when = new Date(d.created_at);
      tdDate.appendChild(el("span", null, when.toLocaleDateString("pt-BR") + " " + when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })));
      tr.appendChild(tdDate);

      var tdAct = el("td", "ctr acts");
      var view = actionBtn("i-eye", "Ver / editar"); view.addEventListener("click", function (e) { e.stopPropagation(); goEdit(d.id); });
      var edit = actionBtn("i-pencil", "Editar"); edit.addEventListener("click", function (e) { e.stopPropagation(); goEdit(d.id); });
      var dup = actionBtn("i-copy", "Duplicar"); dup.addEventListener("click", function (e) { e.stopPropagation(); duplicate(d); });
      var del = actionBtn("i-trash", "Excluir", "act--del"); del.addEventListener("click", function (e) { e.stopPropagation(); removeDeal(d); });
      [view, edit, dup, del].forEach(function (b) { tdAct.appendChild(b); });
      tr.appendChild(tdAct);

      rows.appendChild(tr);
    });
  }

  function renderPager(count) {
    var totalPages = Math.max(1, Math.ceil(listState.total / PAGE_SIZE));
    var from = (listState.page - 1) * PAGE_SIZE;
    $("range-text").textContent = listState.total ? "Mostrando " + (from + 1) + " a " + (from + count) + " de " + listState.total : "";

    var box = $("pages"); box.textContent = "";
    if (totalPages <= 1) return;
    function btn(label, page, opts) {
      opts = opts || {};
      var b = el("button", "pg");
      b.type = "button";
      if (opts.icon) { b.appendChild(icon(opts.icon)); b.setAttribute("aria-label", opts.aria); } else b.textContent = label;
      if (opts.disabled) b.disabled = true;
      if (page === listState.page && !opts.icon) b.setAttribute("aria-current", "page");
      b.addEventListener("click", function () { listState.page = page; loadRecent(); });
      return b;
    }
    box.appendChild(btn("", listState.page - 1, { icon: "i-left", aria: "Página anterior", disabled: listState.page === 1 }));
    var wanted = {};
    [1, totalPages, listState.page - 1, listState.page, listState.page + 1].forEach(function (p) { if (p >= 1 && p <= totalPages) wanted[p] = true; });
    var last = 0;
    Object.keys(wanted).map(Number).sort(function (a, b) { return a - b; }).forEach(function (p) {
      if (last && p - last > 1) box.appendChild(el("span", "pg-gap", "…"));
      box.appendChild(btn(String(p), p));
      last = p;
    });
    box.appendChild(btn("", listState.page + 1, { icon: "i-right", aria: "Próxima página", disabled: listState.page === totalPages }));
  }

  function loadRecent() {
    $("range-text").textContent = "Carregando…";
    var from = (listState.page - 1) * PAGE_SIZE;
    var query = client.from("deals")
      .select("id, public_code, title, image_url, sku, store_id, category_id, price_original, price_promo, discount_pct, payment_note, coupon_code, coupon_at_cart, affiliate_url, shipping, highlight, description, status, created_at, stores(name, badge_color)", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    var term = listState.q.replace(/[,()*%\\]/g, " ").trim();
    if (term) query = query.or("title.ilike.*" + term + "*,public_code.ilike.*" + term + "*,sku.ilike.*" + term + "*");

    query.then(function (res) {
      if (res.error) { $("range-text").textContent = "Não foi possível carregar."; toast({ kind: "error", title: "Erro ao carregar promoções", body: res.error.message }); return; }
      listState.total = res.count || 0;
      if (!(res.data || []).length && listState.total > 0 && listState.page > 1) { listState.page = Math.ceil(listState.total / PAGE_SIZE); return loadRecent(); }
      current = res.data || [];
      renderRows(current);
      renderPager(current.length);
      var filtered = !!term;
      $("empty").hidden = current.length > 0;
      $("rows-wrap").hidden = current.length === 0;
      $("empty-title").textContent = filtered ? "Nada encontrado" : "Nenhuma promoção cadastrada";
      $("empty-text").textContent = filtered ? "Nenhuma promoção corresponde à busca." : "Cadastre a primeira para ela aparecer aqui.";
    });
  }

  var qTimer;
  $("q").addEventListener("input", function () {
    clearTimeout(qTimer);
    qTimer = setTimeout(function () { listState.q = $("q").value; listState.page = 1; loadRecent(); }, 300);
  });
  $("refresh-btn").addEventListener("click", function () { loadStats(); loadRecent(); });

  // ---------- Início ----------
  shell.ready.then(function () {
    loadStats();
    loadRecent();
  });
})();
