// Lista de promoções (public.deals). Tudo é montado com textContent, sem innerHTML.
(function () {
  var shell = window.GDP_SHELL;
  var client = shell.client;

  var q = new URLSearchParams(window.location.search).get("q") || "";
  var rows = document.getElementById("rows");
  var count = document.getElementById("list-count");
  var empty = document.getElementById("empty");
  var filter = document.getElementById("filter-status");

  var STATUS_LABEL = {
    draft: "Rascunho", ready: "Pronta", queued: "Na fila",
    published: "Publicada", expired: "Expirada", failed: "Falhou"
  };

  function brl(n) {
    return "R$ " + Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function cell(text, className) {
    var td = document.createElement("td");
    if (className) td.className = className;
    td.textContent = text;
    return td;
  }

  function render(list) {
    rows.textContent = "";
    list.forEach(function (d) {
      var tr = document.createElement("tr");
      tr.className = "row-link";
      tr.tabIndex = 0;
      var go = function () { window.location.href = "promocao.html?id=" + encodeURIComponent(d.id); };
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });

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
        shell.toast("Erro ao carregar: " + res.error.message);
        return;
      }
      var list = res.data || [];
      render(list);
      var filtered = !!(term || filter.value);
      empty.hidden = list.length > 0;
      document.querySelector(".table-wrap").hidden = list.length === 0;
      document.getElementById("empty-title").textContent = filtered ? "Nada encontrado" : "Nenhuma promoção cadastrada";
      document.getElementById("empty-text").textContent = filtered ? "Nenhuma promoção corresponde à busca ou ao filtro." : "Cadastre a primeira para ela aparecer aqui.";
      count.textContent = list.length === 1 ? "1 promoção" : list.length + " promoções";
    });
  }

  filter.addEventListener("change", load);
  shell.ready.then(load);
})();
