// Central de Afiliados: lê e grava as lojas parceiras (public.stores) e gera links de teste.
// Quem pode alterar é decidido pelo banco (RLS: só administradores). Tudo é montado via DOM, sem innerHTML.
(function () {
  var shell = window.GDP_SHELL;
  var client = shell.client;
  var toast = shell.toast;

  var COLUMNS = "id, slug, name, commission_rate, affiliate_tag, logo_url, badge_color, is_active, sort_order, program_name, url_template";
  var NEW = "__new";
  var VARIABLES = ["SKU", "TAG", "ORIGIN_URL", "URL"];

  function $(id) { return document.getElementById(id); }

  var state = { stores: [], role: null, editing: null };

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
    use.setAttribute("href", "assets/icons.svg?v=34#" + id);
    svg.appendChild(use);
    return svg;
  }
  function isHttp(text) {
    try { var u = new URL(text); return u.protocol === "http:" || u.protocol === "https:"; }
    catch (e) { return false; }
  }
  function storeById(id) {
    for (var i = 0; i < state.stores.length; i++) if (state.stores[i].id === id) return state.stores[i];
    return null;
  }
  function slugify(text) {
    var s = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return s || "loja";
  }
  function uniqueSlug(base) {
    var taken = {};
    state.stores.forEach(function (s) { taken[s.slug] = true; });
    if (!taken[base]) return base;
    var i = 2;
    while (taken[base + "-" + i]) i++;
    return base + "-" + i;
  }
  function parsePct(text) {
    var s = String(text || "").trim().replace("%", "").replace(",", ".");
    if (!s) return null;
    if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
    return Math.round(Number(s) * 100) / 100;
  }
  function fmtPct(n) { return Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + "%"; }
  function colorOf(store) { return /^#[0-9a-f]{6}$/i.test((store && store.badge_color) || "") ? store.badge_color : "#6b7083"; }

  // Domínio da estrutura da URL (ex.: www.amazon.com.br/dp/{SKU} -> amazon.com.br).
  function templateHost(template) {
    try { return new URL(template.replace(/\{[A-Z_]+\}/g, "x")).hostname.replace(/^www\./, ""); }
    catch (e) { return null; }
  }

  function copyText(text, okMessage) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast({ kind: "success", title: "Copiado", body: okMessage }); },
        function () { toast({ kind: "error", title: "Não foi possível copiar", body: "Copie manualmente." }); }
      );
    } else {
      toast({ kind: "error", title: "Não foi possível copiar", body: "Copie manualmente." });
    }
  }

  function isAdmin() { return state.role === "admin"; }
  function needAdmin() {
    toast({ kind: "error", title: "Sem permissão", body: "Só administradores podem alterar lojas e afiliados." });
  }

  // ---------- Logo ----------
  function paintLogo(box, store) {
    box.textContent = "";
    if (store && /^https?:\/\//i.test(store.logo_url || "")) {
      var img = el("img");
      img.src = store.logo_url; img.alt = ""; img.loading = "lazy";
      box.style.background = "#fff";
      box.appendChild(img);
    } else {
      box.style.background = colorOf(store);
      box.appendChild(document.createTextNode(store ? store.name.charAt(0).toUpperCase() : "+"));
    }
  }

  // ---------- Indicadores ----------
  function names(list) {
    var shown = list.slice(0, 4).map(function (s) { return s.name; }).join(", ");
    return list.length > 4 ? shown + " e mais " + (list.length - 4) : shown;
  }

  function renderStats() {
    var all = state.stores;
    var connected = all.filter(function (s) { return s.affiliate_tag; });
    var pending = all.filter(function (s) { return s.is_active && !s.affiliate_tag; });
    var rated = all.filter(function (s) { return s.commission_rate != null; });

    $("total-chip").textContent = all.length === 1 ? "1 loja" : all.length + " lojas";
    $("st-connected").textContent = connected.length;
    $("st-connected-sub").textContent = connected.length ? names(connected) : all.length ? "Nenhuma loja com tag ainda" : "Nenhuma loja cadastrada";
    $("st-pending").textContent = pending.length;
    $("st-pending-sub").textContent = pending.length ? names(pending) : all.length ? "Tudo configurado" : "Lojas ativas sem tag";
    $("st-commission").textContent = rated.length
      ? fmtPct(rated.reduce(function (sum, s) { return sum + Number(s.commission_rate); }, 0) / rated.length)
      : "—";
    $("stores-sub").textContent = all.length
      ? connected.length + " de " + all.length + (all.length === 1 ? " loja com tag configurada" : " lojas com tag configurada")
      : "Nenhuma loja cadastrada ainda";
  }

  function loadClicks() {
    var now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    client.from("deal_clicks").select("id", { count: "exact", head: true }).gte("created_at", start).then(function (res) {
      $("st-clicks").textContent = (typeof res.count === "number" ? res.count : 0).toLocaleString("pt-BR");
    });
  }

  // ---------- Tabela ----------
  function actionBtn(iconId, label, onClick) {
    var b = el("button", "act");
    b.type = "button"; b.title = label; b.setAttribute("aria-label", label);
    b.appendChild(icon(iconId));
    b.addEventListener("click", onClick);
    return b;
  }

  function renderRows() {
    var rows = $("store-rows");
    rows.textContent = "";
    $("stores-wrap").hidden = !state.stores.length;
    $("stores-empty").hidden = !!state.stores.length;

    state.stores.forEach(function (s) {
      var tr = el("tr");

      var tdStore = el("td");
      var box = el("div", "af-store");
      var logo = el("span", "af-logo");
      paintLogo(logo, s);
      var txt = el("span");
      txt.appendChild(el("strong", null, s.name));
      txt.appendChild(el("small", null, s.program_name || "Programa não informado"));
      box.appendChild(logo);
      box.appendChild(txt);
      tdStore.appendChild(box);
      tr.appendChild(tdStore);

      var tdTag = el("td");
      if (s.affiliate_tag) {
        var chip = el("span", "tag-chip");
        chip.appendChild(el("span", "mono", s.affiliate_tag));
        chip.appendChild(actionBtn("i-copy", "Copiar tag", function () { copyText(s.affiliate_tag, "Tag de " + s.name + " copiada."); }));
        tdTag.appendChild(chip);
      } else {
        tdTag.appendChild(el("span", "muted", "Não configurada"));
      }
      tr.appendChild(tdTag);

      var tdKind = el("td", "af-kind");
      var host = s.url_template ? templateHost(s.url_template) : null;
      var byParams = !!s.url_template && /^\{URL\}/.test(s.url_template);
      tdKind.appendChild(el("span", host ? "mono" : "muted", host || (byParams ? "Parâmetros no link do produto" : "Estrutura não definida")));
      tdKind.appendChild(el("small", null, s.commission_rate != null ? "Comissão " + fmtPct(s.commission_rate) : "Comissão não informada"));
      tr.appendChild(tdKind);

      var tdStatus = el("td");
      var status = !s.is_active ? ["Inativa", "pill--off"] : !s.affiliate_tag ? ["Sem tag", "pill--warn"] : ["Ativa", "pill--on"];
      tdStatus.appendChild(el("span", "pill " + status[1], status[0]));
      tr.appendChild(tdStatus);

      var tdAct = el("td", "ctr acts");
      tdAct.appendChild(actionBtn("i-link", "Gerar link de teste", function () { pickGenerator(s.id); }));
      tdAct.appendChild(actionBtn("i-power", s.is_active ? "Desativar loja" : "Ativar loja", function () { toggleActive(s); }));
      tdAct.appendChild(actionBtn("i-pencil", "Editar loja", function () { pickForm(s.id); }));
      tr.appendChild(tdAct);

      rows.appendChild(tr);
    });
  }

  function toggleActive(store) {
    if (!isAdmin()) { needAdmin(); return; }
    var next = !store.is_active;
    var proceed = next ? Promise.resolve(true) : shell.confirm({
      title: "Desativar " + store.name + "?",
      body: "A loja deixa de aparecer na escolha de loja das novas promoções. As promoções que já existem não mudam.",
      confirmLabel: "Desativar",
      cancelLabel: "Cancelar"
    });
    proceed.then(function (ok) {
      if (!ok) return;
      client.from("stores").update({ is_active: next }).eq("id", store.id).select("id").then(function (res) {
        if (res.error || !(res.data || []).length) {
          toast({ kind: "error", title: "Não foi possível alterar", body: res.error ? res.error.message : "O banco recusou a alteração (sem permissão)." });
          return;
        }
        toast({ kind: "success", title: next ? "Loja ativada" : "Loja desativada", body: store.name });
        loadStores(state.editing);
      });
    });
  }

  // ---------- Formulário ----------
  function setErr(name, message) {
    var node = document.querySelector('.f-err[data-for="' + name + '"]');
    if (node) node.textContent = message || "";
  }
  function clearErrs() {
    document.querySelectorAll("#af-form .f-err").forEach(function (n) { n.textContent = ""; });
  }

  function fillForm(store) {
    state.editing = store ? store.id : null;
    $("a-store").value = store ? store.id : NEW;
    $("a-new").hidden = !!store;
    $("a-name").value = "";
    $("a-color").value = "#6b7083";
    $("a-tag").value = (store && store.affiliate_tag) || "";
    $("a-commission").value = store && store.commission_rate != null ? String(Number(store.commission_rate)).replace(".", ",") : "";
    $("a-program").value = (store && store.program_name) || "";
    $("a-template").value = (store && store.url_template) || "";
    $("a-active").checked = store ? store.is_active : true;
    paintLogo($("a-logo"), store);
    clearErrs();
  }

  function pickForm(id) {
    fillForm(id === NEW ? null : storeById(id));
    $("form-card").scrollIntoView({ behavior: "smooth", block: "start" });
    (id === NEW ? $("a-name") : $("a-tag")).focus({ preventScroll: true });
  }

  function validateTemplate(template) {
    if (!template) return "";
    if (template.length > 500) return "A estrutura passa de 500 caracteres.";
    var found = template.match(/\{[^}]*\}/g) || [];
    for (var i = 0; i < found.length; i++) {
      if (VARIABLES.indexOf(found[i].slice(1, -1)) === -1) return "Variável desconhecida: " + found[i] + ". Use {SKU}, {TAG}, {ORIGIN_URL} ou {URL}.";
    }
    if (template.indexOf("{TAG}") === -1) return "A estrutura precisa conter {TAG}.";
    // {URL} = link do produto sem o que vem depois do "?"; só faz sentido no começo.
    if (template.indexOf("{URL}") > 0) return "Use {URL} só no começo da estrutura. No meio do link, use {ORIGIN_URL}.";
    if (template.split("{URL}").length > 2) return "Use {URL} apenas uma vez.";
    var probe = template.replace(/^\{URL\}/, "https://x.com/p").replace(/\{[A-Z_]+\}/g, "x");
    if (!isHttp(probe)) return "A estrutura precisa começar com http://, https:// ou {URL}.";
    return "";
  }

  function saveError(e) {
    var msg = (e && e.message) || "";
    if (e && e.code === "23505") return "Já existe uma loja com esse nome.";
    if (e && (e.code === "42501" || e.code === "PGRST116" || /row-level security/i.test(msg))) return "O banco recusou a alteração (só administradores podem alterar lojas).";
    if (e && e.code === "23514") return "O banco recusou um dos valores: " + msg;
    return "Não foi possível salvar: " + msg;
  }

  $("af-form").addEventListener("submit", function (event) {
    event.preventDefault();
    if (!isAdmin()) { needAdmin(); return; }
    clearErrs();

    var isNew = !state.editing;
    var errs = {};
    var name = $("a-name").value.trim();
    if (isNew && (name.length < 2 || name.length > 60)) errs.name = "Informe o nome da loja (2 a 60 caracteres).";

    var tag = $("a-tag").value.trim();
    if (!tag) errs.tag = "Informe a tag de afiliado.";
    else if (/\s/.test(tag)) errs.tag = "A tag não pode ter espaços.";

    var pct = parsePct($("a-commission").value);
    if (pct !== null && (isNaN(pct) || pct < 0 || pct > 100)) errs.commission = "Use um número de 0 a 100 (ex.: 7,5).";

    var template = $("a-template").value.trim();
    var templateErr = validateTemplate(template);
    if (templateErr) errs.template = templateErr;

    var keys = Object.keys(errs);
    if (keys.length) {
      keys.forEach(function (k) { setErr(k, errs[k]); });
      toast({ kind: "warning", title: "Corrija os campos", body: "Alguns campos precisam de atenção." });
      return;
    }

    var payload = {
      affiliate_tag: tag,
      commission_rate: pct,
      program_name: $("a-program").value.trim() || null,
      url_template: template || null,
      is_active: $("a-active").checked
    };

    var saveBtn = $("a-save");
    saveBtn.disabled = true;
    var request;
    if (isNew) {
      payload.name = name;
      payload.slug = uniqueSlug(slugify(name));
      payload.badge_color = $("a-color").value;
      payload.sort_order = state.stores.reduce(function (max, s) { return Math.max(max, s.sort_order || 0); }, 0) + 1;
      request = client.from("stores").insert(payload).select(COLUMNS).single();
    } else {
      request = client.from("stores").update(payload).eq("id", state.editing).select(COLUMNS).single();
    }

    request.then(function (res) {
      saveBtn.disabled = false;
      if (res.error) { toast({ kind: "error", title: "Não foi possível salvar", body: saveError(res.error) }); return; }
      toast({ kind: "success", title: isNew ? "Loja conectada" : "Configuração salva", body: res.data.name });
      loadStores(res.data.id);
    });
  });

  $("a-store").addEventListener("change", function () { pickForm($("a-store").value); });
  $("a-reset").addEventListener("click", function () { fillForm(state.editing ? storeById(state.editing) : null); });
  $("connect-btn").addEventListener("click", function () { if (!isAdmin()) { needAdmin(); return; } pickForm(NEW); });

  document.querySelectorAll(".var").forEach(function (b) {
    b.addEventListener("click", function () {
      var input = $("a-template");
      var text = b.getAttribute("data-var");
      var start = input.selectionStart == null ? input.value.length : input.selectionStart;
      var end = input.selectionEnd == null ? start : input.selectionEnd;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      input.focus();
      input.setSelectionRange(start + text.length, start + text.length);
      setErr("template", "");
    });
  });

  // Some a mensagem de erro do campo ao editar.
  ["a-name", "a-tag", "a-commission", "a-template"].forEach(function (id) {
    $(id).addEventListener("input", function () {
      var key = { "a-name": "name", "a-tag": "tag", "a-commission": "commission", "a-template": "template" }[id];
      setErr(key, "");
    });
  });

  // ---------- Gerador de link ----------
  function pickGenerator(id) {
    $("g-store").value = id;
    $("gen-card").scrollIntoView({ behavior: "smooth", block: "start" });
    $("g-url").focus({ preventScroll: true });
  }

  function detectStore(host) {
    var flat = host.replace(/\./g, "");
    var bare = host.replace(/^www\./, "");
    var hit = null;
    state.stores.forEach(function (s) {
      if (hit) return;
      var token = s.slug.replace(/-/g, "");
      var th = s.url_template ? templateHost(s.url_template) : null;
      if ((token.length >= 3 && flat.indexOf(token) !== -1) || (th && (bare === th || bare.slice(-(th.length + 1)) === "." + th))) hit = s;
    });
    return hit;
  }

  function extractSku(url) {
    var path = url.pathname;
    var m = path.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i) || path.match(/\b(MLB-?\d{6,})\b/i) || path.match(/\/(?:produto|product|item|p)\/([^\/?#]+)/i);
    if (m) return m[1];
    var last = path.split("/").filter(Boolean).pop();
    return last || null;
  }

  // Enquanto a loja está sendo editada no formulário, o gerador usa o que está digitado ali
  // (mesmo sem "Salvar" ainda), para poder testar antes de gravar. Sem edição em curso, usa
  // o que já está salvo no banco. "draft" indica qual dos dois foi usado.
  function effectiveConfig(store) {
    if (state.editing === store.id) {
      var tag = $("a-tag").value.trim();
      var template = $("a-template").value.trim();
      if (tag && template && !validateTemplate(template)) return { tag: tag, template: template, draft: true };
    }
    if (store.affiliate_tag && store.url_template) return { tag: store.affiliate_tag, template: store.url_template, draft: false };
    return null;
  }

  $("gen-form").addEventListener("submit", function (event) {
    event.preventDefault();
    setErr("gen", "");
    $("g-out").hidden = true;

    var raw = $("g-url").value.trim();
    var url;
    try { url = new URL(raw); } catch (e) { url = null; }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) { setErr("gen", "Cole o link completo do produto, começando com http:// ou https://."); return; }

    var store = $("g-store").value ? storeById($("g-store").value) : detectStore(url.hostname);
    if (!store) { setErr("gen", "Não reconheci a loja por essa URL. Escolha a loja na lista."); return; }
    var cfg = effectiveConfig(store);
    if (!cfg) { setErr("gen", "Informe a tag e a estrutura da URL de " + store.name + " no formulário acima (não precisa salvar para testar)."); return; }

    var usesSku = cfg.template.indexOf("{SKU}") !== -1;
    var sku = extractSku(url);
    if (usesSku && !sku) { setErr("gen", "Não consegui identificar o SKU nessa URL."); return; }

    // {URL}: o próprio link do produto, sem query nem #, seguido dos parâmetros da estrutura.
    // O caminho (path) é exatamente o da URL colada — se ela já vier "limpa" (a página oficial
    // do produto, sem parâmetros de busca), o link gerado também sai curto.
    var productUrl = url.origin + url.pathname;

    // Funções no replace: evitam que "$&" e afins dentro do valor sejam interpretados.
    var link = cfg.template
      .replace(/^\{URL\}/, function () { return productUrl; })
      .replace(/\{SKU\}/g, function () { return encodeURIComponent(sku); })
      .replace(/\{TAG\}/g, function () { return encodeURIComponent(cfg.tag); })
      .replace(/\{ORIGIN_URL\}/g, function () { return encodeURIComponent(raw); });

    $("g-tag").textContent = cfg.tag + (cfg.draft ? " (ainda não salva)" : "");
    $("g-link").value = link;
    $("g-sku").textContent = usesSku ? "SKU usado: " + sku : store.name;
    var open = $("g-open");
    if (isHttp(link)) open.href = link; else open.removeAttribute("href");
    $("g-out").hidden = false;
  });

  $("g-copy").addEventListener("click", function () { copyText($("g-link").value, "Link de afiliado copiado."); });
  $("g-link").addEventListener("focus", function () { this.select(); });

  // ---------- Carga ----------
  function fillSelects() {
    var pick = $("a-store");
    pick.textContent = "";
    state.stores.forEach(function (s) {
      var o = el("option", null, s.name + (s.is_active ? "" : " (inativa)"));
      o.value = s.id;
      pick.appendChild(o);
    });
    var add = el("option", null, "+ Nova loja…");
    add.value = NEW;
    pick.appendChild(add);

    var gen = $("g-store");
    var keep = gen.value;
    gen.textContent = "";
    var auto = el("option", null, "Detectar pela URL");
    auto.value = "";
    gen.appendChild(auto);
    state.stores.forEach(function (s) {
      var o = el("option", null, s.name);
      o.value = s.id;
      gen.appendChild(o);
    });
    gen.value = keep && storeById(keep) ? keep : "";
  }

  function loadStores(selectId) {
    return client.from("stores").select(COLUMNS).order("sort_order").then(function (res) {
      if (res.error) {
        $("stores-sub").textContent = "Não foi possível carregar as lojas.";
        toast({ kind: "error", title: "Erro ao carregar as lojas", body: res.error.message });
        return;
      }
      state.stores = res.data || [];
      fillSelects();
      renderStats();
      renderRows();
      var target = selectId && storeById(selectId) ? storeById(selectId) : state.stores[0] || null;
      fillForm(target);
    });
  }

  function applyRole() {
    var admin = isAdmin();
    $("af-fields").disabled = !admin;
    $("a-save").disabled = !admin;
    $("connect-btn").disabled = !admin;
    $("af-note").hidden = admin;
    $("role-chip").hidden = admin;
  }

  shell.ready.then(function () {
    shell.profile.then(function (p) { state.role = p.role; applyRole(); });
    loadClicks();
    return loadStores(null);
  });
})();
