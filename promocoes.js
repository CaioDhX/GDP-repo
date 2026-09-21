// Lista de promoções (public.deals): indicadores, filtros, paginação, seleção em lote e exportação.
// Tudo é montado com textContent/DOM, sem innerHTML.
(function () {
  var shell = window.GDP_SHELL;
  var client = shell.client;
  var toast = shell.toast;

  var PAGE_SIZE = 10;
  var EXPORT_LIMIT = 5000;

  var STATUS_LABEL = {
    draft: "Rascunho", ready: "Pronta", queued: "Na fila",
    published: "Publicada", expired: "Expirada", failed: "Falhou"
  };
  var PERIOD_LABEL = { "24h": "Últimas 24h", "7d": "Últimos 7 dias", "30d": "Últimos 30 dias" };
  var PERIOD_MS = { "24h": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5 };

  var LIST_COLUMNS =
    "id, public_code, title, image_url, sku, coupon_code, payment_note, shipping, affiliate_url, " +
    "price_original, price_promo, discount_pct, status, created_at, " +
    "stores(name, badge_color, logo_url), creator:profiles!deals_created_by_fkey(full_name)";

  function $(id) { return document.getElementById(id); }

  var params = new URLSearchParams(window.location.search);
  var state = { page: 1, total: 0, q: params.get("q") || "", store: "", status: "", period: "", sort: "recent" };
  var stores = [];
  var selected = new Set();
  var current = [];
  var checkboxes = {};

  var rows = $("rows"), empty = $("empty"), selectAll = $("select-all");
  var bulk = $("bulk"), bulkCount = $("bulk-count");

  // ---------- Utilidades ----------
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
    use.setAttribute("href", "assets/icons.svg#" + id);
    svg.appendChild(use);
    return svg;
  }
  function brl(n) {
    return "R$ " + Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function isHttp(url) { return /^https?:\/\//i.test(url || ""); }

  // Remove caracteres com significado especial no filtro do PostgREST.
  function searchTerm() { return state.q.replace(/[,()*%\\]/g, " ").trim(); }

  // ---------- Consulta ----------
  function applyFilters(query) {
    if (state.store) query = query.eq("store_id", state.store);
    if (state.status) query = query.eq("status", state.status);
    if (state.period) query = query.gte("created_at", new Date(Date.now() - PERIOD_MS[state.period]).toISOString());
    var term = searchTerm();
    if (term) {
      query = query.or("title.ilike.*" + term + "*,public_code.ilike.*" + term + "*,sku.ilike.*" + term + "*,coupon_code.ilike.*" + term + "*");
    }
    return query;
  }

  function applySort(query) {
    switch (state.sort) {
      case "old": return query.order("created_at", { ascending: true });
      case "discount": return query.order("discount_pct", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
      case "price": return query.order("price_promo", { ascending: true });
      default: return query.order("created_at", { ascending: false });
    }
  }

  // ---------- Indicadores ----------
  function countOf(query) {
    return query.then(function (res) { return typeof res.count === "number" ? res.count : 0; });
  }

  function loadStats() {
    var head = { count: "exact", head: true };
    var now = new Date();
    var startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    Promise.all([
      countOf(client.from("deals").select("id", head)),
      countOf(client.from("deals").select("id", head).eq("status", "published").or("expires_at.is.null,expires_at.gt." + now.toISOString())),
      countOf(client.from("deals").select("id", head).eq("status", "ready")),
      countOf(client.from("deals").select("id", head).eq("status", "draft")),
      countOf(client.from("deal_clicks").select("id", head).gte("created_at", startOfDay))
    ]).then(function (n) {
      $("total-chip").textContent = n[0] === 1 ? "1 item" : n[0] + " itens";
      $("st-active").textContent = n[1];
      $("st-ready").textContent = n[2];
      $("st-draft").textContent = n[3];
      $("st-clicks").textContent = n[4].toLocaleString("pt-BR");
    });
  }

  // ---------- Seleção ----------
  function updateSelection() {
    var n = selected.size;
    bulk.hidden = n === 0;
    bulkCount.textContent = n === 1 ? "1 oferta selecionada" : n + " ofertas selecionadas";

    selectAll.checked = current.length > 0 && n === current.length;
    selectAll.indeterminate = n > 0 && n < current.length;

    current.forEach(function (d) {
      var box = checkboxes[d.id];
      if (!box) return;
      box.checked = selected.has(d.id);
      box.closest("tr").classList.toggle("row-sel", box.checked);
    });
  }

  function toggle(id, on) {
    if (on) selected.add(id); else selected.delete(id);
    updateSelection();
  }

  selectAll.addEventListener("change", function () {
    selected.clear();
    if (selectAll.checked) current.forEach(function (d) { selected.add(d.id); });
    updateSelection();
  });
  $("bulk-clear").addEventListener("click", function () { selected.clear(); updateSelection(); });

  // ---------- Ações: excluir e marcar como pronta ----------
  function afterChange() {
    shell.refreshCount();
    load();
  }

  function confirmAndDelete(ids) {
    if (!ids.length) return;
    shell.profile.then(function (profile) {
      // O banco só deixa administradores excluírem; avisamos antes de perguntar.
      if (profile.role !== "admin") {
        toast("Só administradores podem excluir promoções. O seu papel é " + (profile.role === "editor" ? "Editor" : "sem permissão de exclusão") + ".");
        return;
      }
      var one = current.filter(function (d) { return d.id === ids[0]; })[0];
      var question = ids.length === 1 && one
        ? 'Excluir a promoção "' + one.title + '" (' + one.public_code + ")? Esta ação não pode ser desfeita."
        : "Excluir " + ids.length + " promoções? Esta ação não pode ser desfeita.";
      if (!window.confirm(question)) return;

      $("bulk-delete").disabled = true;
      shell.deleteDeals(ids).then(function (res) {
        $("bulk-delete").disabled = false;
        if (res.error) { toast("Não foi possível excluir: " + res.error.message); return; }
        var deleted = res.deleted, text;
        if (!deleted) text = "Nenhuma promoção foi excluída (sem permissão).";
        else if (deleted < ids.length) text = deleted + " de " + ids.length + " promoções excluídas.";
        else text = deleted === 1 ? "Promoção excluída." : deleted + " promoções excluídas.";
        if (res.imagesLeft) text += " Mas " + (res.imagesLeft === 1 ? "uma foto não foi removida" : res.imagesLeft + " fotos não foram removidas") + " do armazenamento.";
        toast(text);
        afterChange();
      });
    });
  }

  $("bulk-delete").addEventListener("click", function () { confirmAndDelete(Array.from(selected)); });

  // Só rascunhos podem virar "pronta"; as demais situações são do bot de publicação.
  $("bulk-ready").addEventListener("click", function () {
    var ids = Array.from(selected);
    if (!ids.length) return;
    shell.profile.then(function (profile) {
      $("bulk-ready").disabled = true;
      client.from("deals").update({ status: "ready", updated_by: profile.id })
        .in("id", ids).eq("status", "draft").select("id").then(function (res) {
          $("bulk-ready").disabled = false;
          if (res.error) { toast("Não foi possível atualizar: " + res.error.message); return; }
          var n = (res.data || []).length;
          if (!n) toast("Só rascunhos podem ser marcados como prontos.");
          else toast(n === 1 ? "1 promoção marcada como pronta." : n + " promoções marcadas como prontas.");
          afterChange();
        });
    });
  });

  // ---------- Tabela ----------
  function storePill(store) {
    var pill = el("span", "store");
    var color = /^#[0-9a-f]{6}$/i.test((store && store.badge_color) || "") ? store.badge_color : "#6b7083";
    pill.style.setProperty("--c", color);
    if (store && isHttp(store.logo_url)) {
      var img = el("img");
      img.src = store.logo_url; img.alt = ""; img.width = 14; img.height = 14; img.loading = "lazy";
      pill.appendChild(img);
    }
    pill.appendChild(document.createTextNode(store ? store.name : "—"));
    return pill;
  }

  function actionBtn(iconId, label, className) {
    var b = el("button", "act" + (className ? " " + className : ""));
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.appendChild(icon(iconId));
    b.addEventListener("click", function (e) { e.stopPropagation(); });
    return b;
  }

  function renderRows(list) {
    rows.textContent = "";
    checkboxes = {};
    list.forEach(function (d) {
      var go = function () { window.location.href = "promocao.html?id=" + encodeURIComponent(d.id); };
      var tr = el("tr", "row-link");
      tr.tabIndex = 0;
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target === tr) go(); });

      // seleção
      var tdSel = el("td", "sel");
      tdSel.addEventListener("click", function (e) { e.stopPropagation(); });
      var box = el("input");
      box.type = "checkbox";
      box.setAttribute("aria-label", "Selecionar " + d.title);
      box.addEventListener("change", function () { toggle(d.id, box.checked); });
      checkboxes[d.id] = box;
      tdSel.appendChild(box);
      tr.appendChild(tdSel);

      // mídia
      var tdMedia = el("td");
      var thumb = el("span", "thumb");
      if (isHttp(d.image_url)) {
        var img = el("img");
        img.src = d.image_url; img.alt = ""; img.loading = "lazy";
        thumb.appendChild(img);
      }
      tdMedia.appendChild(thumb);
      tr.appendChild(tdMedia);

      // produto
      var tdProd = el("td", "cell-prod");
      tdProd.appendChild(el("strong", null, d.title));
      var meta = [];
      if (d.sku) meta.push("SKU: " + d.sku);
      if (d.coupon_code) meta.push("Cupom: " + d.coupon_code);
      meta.push("ID: " + d.public_code);
      tdProd.appendChild(el("small", null, meta.join(" • ")));
      tr.appendChild(tdProd);

      // loja
      var tdStore = el("td");
      tdStore.appendChild(storePill(d.stores));
      tr.appendChild(tdStore);

      // preços
      var tdOrig = el("td", "num");
      if (d.price_original != null) tdOrig.appendChild(el("s", "price-old", brl(d.price_original)));
      else tdOrig.textContent = "—";
      tr.appendChild(tdOrig);

      var tdPrice = el("td", "num");
      tdPrice.appendChild(el("strong", "price-now", brl(d.price_promo)));
      var note = d.payment_note || (d.coupon_code ? "com cupom" : d.shipping === "free" ? "frete grátis" : "");
      if (note) tdPrice.appendChild(el("small", "price-note", note));
      tr.appendChild(tdPrice);

      // desconto
      var tdOff = el("td", "ctr");
      if (d.discount_pct != null && d.discount_pct > 0) tdOff.appendChild(el("span", "off-pill", d.discount_pct + "% OFF"));
      else tdOff.textContent = "—";
      tr.appendChild(tdOff);

      // status
      var tdStatus = el("td");
      tdStatus.appendChild(el("span", "chip chip--dot chip--st-" + d.status, (STATUS_LABEL[d.status] || d.status).toUpperCase()));
      tr.appendChild(tdStatus);

      // criado em
      var tdDate = el("td", "cell-date");
      var when = new Date(d.created_at);
      tdDate.appendChild(el("span", null, when.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " às " + when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })));
      tdDate.appendChild(el("small", null, "por " + ((d.creator && d.creator.full_name) || "—")));
      tr.appendChild(tdDate);

      // ações
      var tdAct = el("td", "ctr acts");
      if (isHttp(d.affiliate_url)) {
        var open = el("a", "act");
        open.href = d.affiliate_url; open.target = "_blank"; open.rel = "noopener noreferrer";
        open.title = "Abrir link de afiliado"; open.setAttribute("aria-label", "Abrir link de afiliado");
        open.appendChild(icon("i-ext"));
        open.addEventListener("click", function (e) { e.stopPropagation(); });
        tdAct.appendChild(open);
      }
      var edit = actionBtn("i-pencil", "Editar");
      edit.addEventListener("click", go);
      tdAct.appendChild(edit);
      var del = actionBtn("i-trash", "Excluir", "act--del");
      del.addEventListener("click", function () { confirmAndDelete([d.id]); });
      tdAct.appendChild(del);
      tr.appendChild(tdAct);

      rows.appendChild(tr);
    });
  }

  // ---------- Filtros ativos ----------
  function renderChips() {
    var box = $("chips");
    box.textContent = "";
    box.appendChild(el("span", "chips__label", "Filtros ativos:"));

    var chips = [];
    if (state.period) chips.push(["Período: " + PERIOD_LABEL[state.period], function () { state.period = ""; $("f-period").value = ""; }]);
    if (state.store) {
      var s = stores.filter(function (x) { return x.id === state.store; })[0];
      chips.push(["Loja: " + (s ? s.name : "—"), function () { state.store = ""; $("f-store").value = ""; }]);
    }
    if (state.status) chips.push(["Status: " + STATUS_LABEL[state.status], function () { state.status = ""; $("f-status").value = ""; }]);
    if (state.q.trim()) chips.push(["Busca: " + state.q.trim(), function () { state.q = ""; $("q").value = ""; }]);

    if (!chips.length) { box.appendChild(el("span", "chips__none", "nenhum")); return; }
    chips.forEach(function (c) {
      var chip = el("span", "fchip", c[0]);
      var x = el("button");
      x.type = "button"; x.setAttribute("aria-label", "Remover filtro"); x.appendChild(icon("i-x"));
      x.addEventListener("click", function () { c[1](); state.page = 1; load(); });
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  // ---------- Paginação ----------
  function renderPager(count) {
    var totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    var from = (state.page - 1) * PAGE_SIZE;
    $("range-text").textContent = state.total
      ? "Exibindo " + (from + 1) + "–" + (from + count) + " de " + state.total + " resultados"
      : "";

    var box = $("pages");
    box.textContent = "";
    if (totalPages <= 1) return;

    function btn(label, page, opts) {
      opts = opts || {};
      var b = el("button", "pg");
      b.type = "button";
      if (opts.icon) { b.appendChild(icon(opts.icon)); b.setAttribute("aria-label", opts.aria); }
      else b.textContent = label;
      if (opts.disabled) b.disabled = true;
      if (page === state.page && !opts.icon) b.setAttribute("aria-current", "page");
      b.addEventListener("click", function () { state.page = page; load(); });
      return b;
    }

    box.appendChild(btn("", state.page - 1, { icon: "i-left", aria: "Página anterior", disabled: state.page === 1 }));
    var wanted = {};
    [1, totalPages, state.page - 1, state.page, state.page + 1].forEach(function (p) { if (p >= 1 && p <= totalPages) wanted[p] = true; });
    var last = 0;
    Object.keys(wanted).map(Number).sort(function (a, b) { return a - b; }).forEach(function (p) {
      if (last && p - last > 1) box.appendChild(el("span", "pg-gap", "…"));
      box.appendChild(btn(String(p), p));
      last = p;
    });
    box.appendChild(btn("", state.page + 1, { icon: "i-right", aria: "Próxima página", disabled: state.page === totalPages }));
  }

  // ---------- Carregar ----------
  function load() {
    renderChips();
    $("range-text").textContent = "Carregando…";

    var from = (state.page - 1) * PAGE_SIZE;
    var query = applySort(applyFilters(client.from("deals").select(LIST_COLUMNS, { count: "exact" }))).range(from, from + PAGE_SIZE - 1);

    return query.then(function (res) {
      if (res.error) {
        $("range-text").textContent = "Não foi possível carregar as promoções.";
        toast("Erro ao carregar: " + res.error.message);
        return;
      }
      state.total = res.count || 0;

      // Apagou tudo da última página: volta uma.
      if (!(res.data || []).length && state.total > 0 && state.page > 1) {
        state.page = Math.ceil(state.total / PAGE_SIZE);
        return load();
      }

      current = res.data || [];
      selected.clear();
      renderRows(current);
      updateSelection();
      renderPager(current.length);
      loadStats();

      var filtered = !!(searchTerm() || state.store || state.status || state.period);
      empty.hidden = current.length > 0;
      document.querySelector(".table-wrap").hidden = current.length === 0;
      $("empty-title").textContent = filtered ? "Nada encontrado" : "Nenhuma promoção cadastrada";
      $("empty-text").textContent = filtered ? "Nenhuma promoção corresponde à busca ou aos filtros." : "Cadastre a primeira para ela aparecer aqui.";
    });
  }

  // ---------- Controles ----------
  var debounce;
  $("q").addEventListener("input", function () {
    clearTimeout(debounce);
    debounce = setTimeout(function () { state.q = $("q").value; state.page = 1; load(); }, 300);
  });
  [["f-store", "store"], ["f-status", "status"], ["f-period", "period"], ["f-sort", "sort"]].forEach(function (pair) {
    $(pair[0]).addEventListener("change", function () { state[pair[1]] = $(pair[0]).value; state.page = 1; load(); });
  });
  $("f-clear").addEventListener("click", function () {
    state.q = ""; state.store = ""; state.status = ""; state.period = ""; state.sort = "recent"; state.page = 1;
    $("q").value = ""; $("f-store").value = ""; $("f-status").value = ""; $("f-period").value = ""; $("f-sort").value = "recent";
    load();
  });

  // ---------- Exportar (CSV) ----------
  function csvCell(value) {
    var text = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;   // evita fórmulas ao abrir no Excel
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function num(n) { return n == null ? "" : String(n).replace(".", ","); }

  $("export-btn").addEventListener("click", function () {
    var btn = $("export-btn");
    btn.disabled = true;
    applySort(applyFilters(client.from("deals").select(LIST_COLUMNS))).limit(EXPORT_LIMIT).then(function (res) {
      btn.disabled = false;
      if (res.error) { toast("Não foi possível exportar: " + res.error.message); return; }
      var data = res.data || [];
      if (!data.length) { toast("Não há promoções para exportar com esses filtros."); return; }

      var head = ["Código", "Título", "Loja", "SKU", "Cupom", "Preço original", "Preço oferta", "Desconto (%)", "Situação", "Criada em", "Criada por", "Link de afiliado"];
      var lines = [head.map(csvCell).join(";")];
      data.forEach(function (d) {
        lines.push([
          d.public_code, d.title, d.stores ? d.stores.name : "", d.sku, d.coupon_code,
          num(d.price_original), num(d.price_promo), d.discount_pct,
          STATUS_LABEL[d.status] || d.status, new Date(d.created_at).toLocaleString("pt-BR"),
          d.creator ? d.creator.full_name : "", d.affiliate_url
        ].map(csvCell).join(";"));
      });

      var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      var link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "promocoes-" + new Date().toISOString().slice(0, 10) + ".csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
      toast(data.length === EXPORT_LIMIT ? "Exportadas as primeiras " + EXPORT_LIMIT + " promoções." : data.length + (data.length === 1 ? " promoção exportada." : " promoções exportadas."));
    });
  });

  // ---------- Início ----------
  $("q").value = state.q;
  shell.ready.then(function () {
    client.from("stores").select("id, name").order("sort_order").then(function (res) {
      stores = res.data || [];
      stores.forEach(function (s) {
        var o = el("option", null, s.name);
        o.value = s.id;
        $("f-store").appendChild(o);
      });
    });
    load();
  });
})();
