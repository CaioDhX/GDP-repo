// Lista de promoções (public.deals) com seleção e exclusão em lote.
// Tudo é montado com textContent, sem innerHTML.
(function () {
  var shell = window.GDP_SHELL;
  var client = shell.client;
  var toast = shell.toast;

  var q = new URLSearchParams(window.location.search).get("q") || "";
  var rows = document.getElementById("rows");
  var count = document.getElementById("list-count");
  var empty = document.getElementById("empty");
  var filter = document.getElementById("filter-status");
  var selectAll = document.getElementById("select-all");
  var bulk = document.getElementById("bulk");
  var bulkCount = document.getElementById("bulk-count");
  var bulkDelete = document.getElementById("bulk-delete");

  var STATUS_LABEL = {
    draft: "Rascunho", ready: "Pronta", queued: "Na fila",
    published: "Publicada", expired: "Expirada", failed: "Falhou"
  };

  var selected = new Set();   // ids marcados
  var current = [];           // promoções exibidas agora
  var checkboxes = {};        // id -> <input>

  function brl(n) {
    return "R$ " + Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function cell(text, className) {
    var td = document.createElement("td");
    if (className) td.className = className;
    td.textContent = text;
    return td;
  }

  // ---------- Seleção ----------
  function updateSelection() {
    var n = selected.size;
    bulk.hidden = n === 0;
    count.hidden = n > 0;
    bulkCount.textContent = n === 1 ? "1 selecionada" : n + " selecionadas";

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

  document.getElementById("bulk-clear").addEventListener("click", function () {
    selected.clear();
    updateSelection();
  });

  // ---------- Exclusão ----------
  bulkDelete.addEventListener("click", function () {
    var ids = Array.from(selected);
    if (!ids.length) return;

    shell.profile.then(function (profile) {
      // O banco só deixa administradores excluírem; avisamos antes de perguntar.
      if (profile.role !== "admin") {
        toast("Só administradores podem excluir promoções. O seu papel é " + (profile.role === "editor" ? "Editor" : "sem permissão de exclusão") + ".");
        return;
      }

      var first = current.filter(function (d) { return d.id === ids[0]; })[0];
      var question = ids.length === 1 && first
        ? 'Excluir a promoção "' + first.title + '" (' + first.public_code + ")? Esta ação não pode ser desfeita."
        : "Excluir " + ids.length + " promoções? Esta ação não pode ser desfeita.";
      if (!window.confirm(question)) return;

      bulkDelete.disabled = true;
      client.from("deals").delete().in("id", ids).select("id").then(function (res) {
        bulkDelete.disabled = false;
        if (res.error) {
          toast("Não foi possível excluir: " + res.error.message);
          return;
        }
        var deleted = (res.data || []).length;
        if (!deleted) toast("Nenhuma promoção foi excluída (sem permissão).");
        else if (deleted < ids.length) toast(deleted + " de " + ids.length + " promoções excluídas.");
        else toast(deleted === 1 ? "Promoção excluída." : deleted + " promoções excluídas.");
        shell.refreshCount();
        load();
      });
    });
  });

  // ---------- Tabela ----------
  function render(list) {
    rows.textContent = "";
    checkboxes = {};
    list.forEach(function (d) {
      var tr = document.createElement("tr");
      tr.className = "row-link";
      tr.tabIndex = 0;
      var go = function () { window.location.href = "promocao.html?id=" + encodeURIComponent(d.id); };
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target === tr) go(); });

      // Caixa de seleção (não abre a promoção ao clicar)
      var sel = document.createElement("td");
      sel.className = "sel";
      sel.addEventListener("click", function (e) { e.stopPropagation(); });
      var box = document.createElement("input");
      box.type = "checkbox";
      box.setAttribute("aria-label", "Selecionar " + d.title);
      box.addEventListener("change", function () { toggle(d.id, box.checked); });
      checkboxes[d.id] = box;
      sel.appendChild(box);
      tr.appendChild(sel);

      var first = document.createElement("td");
      var wrap = document.createElement("div");
      wrap.className = "cell-deal";
      var thumb = document.createElement("span");
      thumb.className = "thumb";
      if (d.image_url) {
        var img = document.createElement("img");
        img.src = d.image_url;
        img.alt = "";
        img.loading = "lazy";
        thumb.appendChild(img);
      }
      var text = document.createElement("span");
      var title = document.createElement("strong");
      title.textContent = d.title;
      var code = document.createElement("small");
      code.className = "mono";
      code.textContent = d.public_code;
      text.appendChild(title);
      text.appendChild(code);
      wrap.appendChild(thumb);
      wrap.appendChild(text);
      first.appendChild(wrap);
      tr.appendChild(first);

      tr.appendChild(cell(d.stores ? d.stores.name : "—"));
      tr.appendChild(cell(brl(d.price_promo), "num"));
      tr.appendChild(cell(d.discount_pct != null ? "-" + d.discount_pct + "%" : "—", "num"));

      var st = document.createElement("td");
      var chip = document.createElement("span");
      chip.className = "chip chip--st-" + d.status;
      chip.textContent = (STATUS_LABEL[d.status] || d.status).toUpperCase();
      st.appendChild(chip);
      tr.appendChild(st);

      tr.appendChild(cell(new Date(d.created_at).toLocaleDateString("pt-BR")));
      rows.appendChild(tr);
    });
  }

  function load() {
    count.textContent = "Carregando…";
    var query = client.from("deals")
      .select("id, public_code, title, image_url, price_promo, discount_pct, status, created_at, stores(name)")
      .order("created_at", { ascending: false })
      .limit(200);

    if (filter.value) query = query.eq("status", filter.value);

    // Remove caracteres que têm significado especial no filtro do PostgREST.
    var term = q.replace(/[,()*%\\]/g, " ").trim();
    if (term) {
      query = query.or("title.ilike.*" + term + "*,public_code.ilike.*" + term + "*,sku.ilike.*" + term + "*,coupon_code.ilike.*" + term + "*");
    }

    return query.then(function (res) {
      if (res.error) {
        count.textContent = "Não foi possível carregar as promoções.";
        toast("Erro ao carregar: " + res.error.message);
        return;
      }
      current = res.data || [];
      selected.clear();
      render(current);
      updateSelection();

      var filtered = !!(term || filter.value);
      empty.hidden = current.length > 0;
      document.querySelector(".table-wrap").hidden = current.length === 0;
      document.getElementById("empty-title").textContent = filtered ? "Nada encontrado" : "Nenhuma promoção cadastrada";
      document.getElementById("empty-text").textContent = filtered ? "Nenhuma promoção corresponde à busca ou ao filtro." : "Cadastre a primeira para ela aparecer aqui.";
      count.textContent = current.length === 1 ? "1 promoção" : current.length + " promoções";
    });
  }

  filter.addEventListener("change", load);
  shell.ready.then(load);
})();
