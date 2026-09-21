(function () {
  var form = document.getElementById("login-form");
  var password = document.getElementById("password");
  var toggle = document.getElementById("toggle-password");
  var note = document.getElementById("form-note");

  toggle.addEventListener("click", function () {
    var show = password.type === "password";
    password.type = show ? "text" : "password";
    toggle.setAttribute("aria-pressed", String(show));
    toggle.setAttribute("aria-label", show ? "Ocultar chave de segurança" : "Mostrar chave de segurança");
  });

  // Página estática: nenhum dado é enviado a lugar algum.
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    note.textContent = "Demonstração: esta página ainda não está conectada a um servidor de autenticação. Nada foi enviado.";
    note.hidden = false;
  });

  document.querySelectorAll("a[data-demo]").forEach(function (link) {
    link.addEventListener("click", function (event) { event.preventDefault(); });
  });
})();
