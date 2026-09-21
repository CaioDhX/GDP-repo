// Comportamento comum das páginas do painel: exige login, preenche o usuário,
// controla o menu, os avisos e o contador de promoções.
(function () {
  var client = window.GDP_AUTH.client;
  var never = new Promise(function () {});

  function toLogin() { window.location.replace("index.html"); return never; }

  // ---------- Avisos ----------
  var toastEl = document.getElementById("toast");
  var toastTimer;
  function toast(text) {
    toastEl.textContent = text;
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
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      search.focus();
    }
  });

  // Itens do design que ainda não têm função.
  document.querySelectorAll("[data-demo]").forEach(function (el) {
    el.addEventListener("click", function (event) {
      event.preventDefault();
      toast("Esta função ainda não foi implementada.");
    });
  });

  window.GDP_SHELL = { client: client, ready: ready, profile: profile, toast: toast, refreshCount: refreshCount };
})();
