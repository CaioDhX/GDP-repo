(function () {
  var client = window.GDP_AUTH.client;

  function toLogin() { window.location.replace("index.html"); }

  // A página só aparece com sessão válida.
  client.auth.getSession().then(function (res) {
    var session = res.data && res.data.session;
    if (!session) return toLogin();
    fillUser(session.user);
    document.body.classList.remove("gate");
  }).catch(toLogin);

  // Sessão encerrada em outra aba ou expirada.
  client.auth.onAuthStateChange(function (event) {
    if (event === "SIGNED_OUT") toLogin();
  });

  function fillUser(user) {
    var email = user.email || "";
    var name = email.split("@")[0] || "usuário";
    document.getElementById("user-name").textContent = name;
    document.getElementById("user-initial").textContent = name.charAt(0).toUpperCase();
    document.getElementById("user-email").textContent = email;
  }

  // Menu do usuário
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
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") setMenu(false);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      document.getElementById("search").focus();
    }
  });
  document.getElementById("logout").addEventListener("click", function () {
    client.auth.signOut().then(toLogin, toLogin);
  });

  // Aviso curto para ações que ainda não estão ligadas ao banco.
  var toast = document.getElementById("toast");
  var toastTimer;
  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2600);
  }

  document.querySelectorAll("[data-demo]").forEach(function (el) {
    el.addEventListener("click", function (event) {
      event.preventDefault();
      showToast("Esta ação ainda não está conectada ao banco de dados.");
    });
  });

  document.getElementById("search").addEventListener("keydown", function (event) {
    if (event.key === "Enter") showToast("A busca ainda não está conectada ao banco de dados.");
  });

  // Copiar cupom
  var copyBtn = document.getElementById("copy-coupon");
  copyBtn.addEventListener("click", function () {
    var code = copyBtn.getAttribute("data-code");
    var done = function () {
      copyBtn.textContent = "Copiado!";
      setTimeout(function () { copyBtn.textContent = "Copiar"; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done, function () { showToast("Não foi possível copiar."); });
    } else {
      showToast("Não foi possível copiar.");
    }
  });
})();
