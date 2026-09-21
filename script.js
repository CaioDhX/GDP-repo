(function () {
  var auth = window.GDP_AUTH;
  var form = document.getElementById("login-form");
  var email = document.getElementById("email");
  var password = document.getElementById("password");
  var remember = form.querySelector('input[name="remember"]');
  var toggle = document.getElementById("toggle-password");
  var submit = form.querySelector(".btn-login");
  var note = document.getElementById("form-note");
  var forgot = document.getElementById("forgot-link");

  function showNote(text, kind) {
    note.textContent = text;
    note.className = "form-note form-note--" + (kind || "error");
    note.hidden = false;
  }

  toggle.addEventListener("click", function () {
    var show = password.type === "password";
    password.type = show ? "text" : "password";
    toggle.setAttribute("aria-pressed", String(show));
    toggle.setAttribute("aria-label", show ? "Ocultar chave de segurança" : "Mostrar chave de segurança");
  });

  // Quem já está logado vai direto para o painel.
  auth.client.auth.getSession().then(function (res) {
    if (res.data && res.data.session) window.location.replace("painel.html");
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var mail = email.value.trim();

    if (!mail || !password.value) {
      showNote("Preencha o e-mail e a chave de segurança.");
      (mail ? password : email).focus();
      return;
    }

    auth.setRemember(remember.checked);
    submit.disabled = true;
    note.hidden = true;

    auth.client.auth.signInWithPassword({ email: mail, password: password.value })
      .then(function (res) {
        if (res.error) {
          showNote(auth.friendlyError(res.error));
          submit.disabled = false;
          password.select();
          return;
        }
        window.location.replace("painel.html");
      })
      .catch(function (err) {
        showNote(auth.friendlyError(err));
        submit.disabled = false;
      });
  });

  // Sem cadastro nem redefinição automática: os acessos são criados por um administrador.
  forgot.addEventListener("click", function (event) {
    event.preventDefault();
    showNote("Para redefinir a chave de segurança, peça a um administrador do painel.", "info");
  });

  document.querySelectorAll("a[data-demo]").forEach(function (link) {
    link.addEventListener("click", function (event) { event.preventDefault(); });
  });
})();
