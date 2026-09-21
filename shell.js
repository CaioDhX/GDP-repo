// Comportamento comum das páginas do painel: exige login, preenche o usuário,
// controla o menu, os avisos e o contador de promoções.
(function () {
  var client = window.GDP_AUTH.client;
  var never = new Promise(function () {});

  function toLogin() { window.location.replace("index.html"); return never; }

  // ---------- Avisos ----------
  // Com notify.js carregado, vira o toast estilizado (aceita texto ou { kind, title, body, actions }).
  // Sem ele, cai no aviso simples de rodapé (#toast), se a página tiver um.
  var toastEl = document.getElementById("toast");
  var toastTimer;
  function toast(opts) {
    if (window.GDP_NOTIFY) return window.GDP_NOTIFY.toast(opts);
    if (!toastEl) return;
    toastEl.textContent = typeof opts === "string" ? opts : (opts && opts.title) || "";
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3200);
  }

  // ---------- Sessão ----------
  // Resolve com o usuário logado; sem sessão, redireciona e nunca resolve.
  var ready = client.auth.getSession().then(function (res) {
    var session = res.data && res.data.session;
    if (!session) return toLogin();
    document.getElementById("user-email").textContent = session.user.email || "";
    document.body.classList.remove("gate");
    return session.user;
  }).catch(toLogin);

  client.auth.onAuthStateChange(function (event) {
    if (event === "SIGNED_OUT") toLogin();
  });

  var ROLES = { admin: "Administrador", editor: "Editor", viewer: "Visualizador" };

  // Perfil do usuário (nome e papel), lido da tabela profiles.
  var profile = ready.then(function (user) {
    return client.from("profiles").select("full_name, role").eq("id", user.id).maybeSingle().then(function (res) {
      var data = res.data || {};
      var name = data.full_name || (user.email || "").split("@")[0] || "usuário";
      document.getElementById("user-name").textContent = name;
      document.getElementById("user-initial").textContent = name.charAt(0).toUpperCase();
      document.querySelector(".user__role").textContent = ROLES[data.role] || "Sem papel definido";
      return { id: user.id, email: user.email, name: name, role: data.role || null };
    });
  });

  // Contador do menu: total real de promoções.
  function refreshCount() {
    var badge = document.getElementById("nav-count");
    if (!badge) return;
    client.from("deals").select("id", { count: "exact", head: true }).then(function (res) {
      if (typeof res.count === "number") { badge.textContent = String(res.count); badge.hidden = false; }
      else badge.hidden = true;
    });
  }
  ready.then(refreshCount);

  // ---------- Menu do usuário ----------
  var btn = document.getElementById("user-btn");
  var menu = document.getElementById("user-menu");
  function setMenu(open) {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  }
  btn.addEventListener("click", function (event) {
    event.stopPropagation();
    setMenu(menu.hidden);
  });
  document.addEventListener("click", function (event) {
    if (!menu.hidden && !menu.contains(event.target)) setMenu(false);
  });
  document.getElementById("logout").addEventListener("click", function () {
    client.auth.signOut().then(toLogin, toLogin);
  });

  // ---------- Busca (vai para a lista) ----------
  var search = document.getElementById("search");
  var params = new URLSearchParams(window.location.search);
  if (search && window.location.pathname.indexOf("promocoes.html") !== -1) search.value = params.get("q") || "";
  search.addEventListener("keydown", function (event) {
    if (event.key !== "Enter") return;
    var q = search.value.trim();
    window.location.href = "promocoes.html" + (q ? "?q=" + encodeURIComponent(q) : "");
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") setMenu(false);
  });

  // Itens do design que ainda não têm função.
  document.querySelectorAll("[data-demo]").forEach(function (el) {
    el.addEventListener("click", function (event) {
      event.preventDefault();
      toast("Esta função ainda não foi implementada.");
    });
  });

  // ---------- Exclusão de promoções ----------
  // Apaga as linhas de public.deals e, em seguida, as fotos delas no bucket deal-images.
  // Só mexe em arquivos desse bucket (fotos externas ou de outros buckets são ignoradas).
  var IMAGE_MARKER = "/storage/v1/object/public/deal-images/";

  function imagePath(url) {
    var i = (url || "").indexOf(IMAGE_MARKER);
    if (i === -1) return null;
    try { return decodeURIComponent(url.slice(i + IMAGE_MARKER.length).split("?")[0]); }
    catch (e) { return null; }
  }

  // Resolve com { deleted, imagesLeft } ou { error }.
  function deleteDeals(ids) {
    return client.from("deals").delete().in("id", ids).select("id, image_url").then(function (res) {
      if (res.error) return { error: res.error };
      var rows = res.data || [];
      var paths = rows.map(function (r) { return imagePath(r.image_url); }).filter(Boolean);
      if (!paths.length) return { deleted: rows.length, imagesLeft: 0 };
      return client.storage.from("deal-images").remove(paths).then(function (r2) {
        var removed = r2.error ? 0 : (r2.data || []).length;
        return { deleted: rows.length, imagesLeft: paths.length - removed };
      });
    });
  }

  // ---------- Menu lateral retrátil ----------
  // Desktop: alterna entre completo e só ícones (lembra a escolha). Celular: abre como gaveta.
  var SIDE_KEY = "gdp-side-collapsed";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var mobileMq = window.matchMedia("(max-width: 860px)");

  function sideStored() { try { return window.localStorage.getItem(SIDE_KEY) === "1"; } catch (e) { return false; } }
  function sideStore(v) { try { window.localStorage.setItem(SIDE_KEY, v ? "1" : "0"); } catch (e) { /* sem armazenamento */ } }

  var side = document.querySelector(".side");
  var topbar = document.querySelector(".top");
  if (side && topbar) {
    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "side-toggle";
    var bars = document.createElementNS(SVG_NS, "svg");
    bars.setAttribute("viewBox", "0 0 24 24");
    bars.setAttribute("class", "i");
    bars.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M4 7h16M4 12h16M4 17h16");
    bars.appendChild(path);
    toggle.appendChild(bars);
    topbar.insertBefore(toggle, topbar.firstChild);

    var backdrop = document.createElement("div");
    backdrop.className = "side-backdrop";
    document.body.appendChild(backdrop);

    // Tooltip com o nome de cada item quando só os ícones aparecem.
    Array.prototype.forEach.call(side.querySelectorAll(".nav a"), function (a) {
      a.setAttribute("title", a.textContent.replace(/\d+|…/g, "").trim());
    });

    function syncToggle() {
      var open = mobileMq.matches ? document.body.classList.contains("side-open") : !document.body.classList.contains("side-collapsed");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Recolher menu" : "Abrir menu");
      toggle.setAttribute("title", open ? "Recolher menu" : "Abrir menu");
    }
    document.body.classList.toggle("side-collapsed", sideStored());
    syncToggle();

    toggle.addEventListener("click", function () {
      if (mobileMq.matches) {
        document.body.classList.toggle("side-open");
      } else {
        var collapsed = document.body.classList.toggle("side-collapsed");
        sideStore(collapsed);
      }
      syncToggle();
    });
    backdrop.addEventListener("click", function () { document.body.classList.remove("side-open"); syncToggle(); });
    side.addEventListener("click", function (event) {
      if (mobileMq.matches && event.target.closest && event.target.closest("a")) document.body.classList.remove("side-open");
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && document.body.classList.contains("side-open")) { document.body.classList.remove("side-open"); syncToggle(); }
    });
    var onMq = function () { document.body.classList.remove("side-open"); syncToggle(); };
    if (mobileMq.addEventListener) mobileMq.addEventListener("change", onMq); else mobileMq.addListener(onMq);
  }

  // ---------- Caixa de confirmação ----------
  // confirm({ title, body, name, confirmLabel, cancelLabel, danger }) -> Promise<boolean>.
  // Usa o <dialog> nativo (fundo escurecido, Esc e foco tratados pelo navegador).
  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var dlg = document.createElement("dialog");
      if (typeof dlg.showModal !== "function") {
        resolve(window.confirm([opts.title, opts.name, opts.body].filter(Boolean).join("\n")));
        return;
      }
      function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
      }
      var danger = !!opts.danger;
      dlg.className = "dlg" + (danger ? " dlg--danger" : "");
      dlg.setAttribute("aria-labelledby", "dlg-title");

      var ico = el("span", "dlg__ico");
      var svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "i");
      var use = document.createElementNS(SVG_NS, "use");
      use.setAttribute("href", "assets/icons.svg?v=26#" + (danger ? "i-trash" : "i-info"));
      svg.appendChild(use);
      ico.appendChild(svg);
      dlg.appendChild(ico);

      var title = el("h2", "dlg__title", opts.title || "Confirmar");
      title.id = "dlg-title";
      dlg.appendChild(title);
      if (opts.name) dlg.appendChild(el("p", "dlg__name", opts.name));
      if (opts.body) dlg.appendChild(el("p", "dlg__body", opts.body));

      var row = el("div", "dlg__actions");
      var cancel = el("button", "dlg__btn", opts.cancelLabel || "Cancelar");
      cancel.type = "button";
      var ok = el("button", "dlg__btn dlg__btn--" + (danger ? "danger" : "primary"), opts.confirmLabel || "Confirmar");
      ok.type = "button";
      row.appendChild(cancel);
      row.appendChild(ok);
      dlg.appendChild(row);

      var done = false;
      function finish(answer) {
        if (done) return;
        done = true;
        if (dlg.open) dlg.close();
        dlg.remove();
        resolve(answer);
      }
      cancel.addEventListener("click", function () { finish(false); });
      ok.addEventListener("click", function () { finish(true); });
      // Clique no fundo escurecido cancela.
      dlg.addEventListener("click", function (event) { if (event.target === dlg) finish(false); });
      // Esc: o navegador dispara "cancel"; tratamos aqui para resolver na hora.
      dlg.addEventListener("cancel", function (event) { event.preventDefault(); finish(false); });
      dlg.addEventListener("close", function () { finish(false); });

      document.body.appendChild(dlg);
      dlg.showModal();
      // Em ações destrutivas o foco começa em "Cancelar", para um Enter sem querer não apagar nada.
      (danger ? cancel : ok).focus();
    });
  }

  window.GDP_SHELL = { client: client, ready: ready, profile: profile, toast: toast, refreshCount: refreshCount, deleteDeals: deleteDeals, confirm: confirmDialog };
})();
