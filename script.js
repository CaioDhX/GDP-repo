(function () {
  var auth = window.GDP_AUTH;
  var client = auth.client;
  var form = document.getElementById("login-form");

  var stepPassword = document.getElementById("step-password");
  var stepMfa = document.getElementById("step-mfa");
  var email = document.getElementById("email");
  var password = document.getElementById("password");
  var remember = form.querySelector('input[name="remember"]');
  var toggle = document.getElementById("toggle-password");
  var submitPassword = document.getElementById("submit-password");
  var mfaCode = document.getElementById("mfa-code");
  var submitMfa = document.getElementById("submit-mfa");
  var mfaCancel = document.getElementById("mfa-cancel");
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

  // ---------- Passo 2: verificação em duas etapas (se a conta tiver) ----------
  function showMfaStep() {
    stepPassword.hidden = true;
    stepMfa.hidden = false;
    note.hidden = true;
    mfaCode.value = "";
    mfaCode.focus();
  }
  function showPasswordStep() {
    stepMfa.hidden = true;
    stepPassword.hidden = false;
    note.hidden = true;
    submitPassword.disabled = false;
    password.value = "";
    mfaCancel.textContent = "Usar outra conta";
  }

  // Decide se a sessão atual já basta (sem MFA, ou MFA cumprido) ou se falta o código.
  // needsMore(session) -> Promise<boolean>
  function needsMoreAuth() {
    return client.auth.mfa.getAuthenticatorAssuranceLevel().then(function (res) {
      if (res.error) return true; // não deu para confirmar: por segurança, pede o código.
      var lv = res.data;
      return !!(lv && lv.nextLevel === "aal2" && lv.currentLevel !== "aal2");
    });
  }

  function mfaFriendlyError(error) {
    var msg = ((error && error.message) || "").toLowerCase();
    if (msg.indexOf("invalid") !== -1 || msg.indexOf("incorrect") !== -1) return "Código incorreto. Confira o app autenticador e tente de novo.";
    if (msg.indexOf("expired") !== -1) return "O código expirou. Digite o código atual do app.";
    if ((error && error.status === 429) || msg.indexOf("rate limit") !== -1) return "Muitas tentativas. Aguarde um pouco e tente de novo.";
    return "Não foi possível verificar o código agora. Tente novamente.";
  }

  // Quem já está logado (e já cumpriu o MFA, se tiver) vai direto para a lista de promoções.
  // Se a sessão existe mas ainda falta o código, mostra o passo 2 em vez de reentrar a senha.
  client.auth.getSession().then(function (res) {
    var session = res.data && res.data.session;
    if (!session) return;
    return needsMoreAuth().then(function (needs) {
      if (needs) showMfaStep();
      else window.location.replace("promocoes.html");
    });
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!stepMfa.hidden) { submitMfaCode(); return; }

    var mail = email.value.trim();
    if (!mail || !password.value) {
      showNote("Preencha o e-mail e a chave de segurança.");
      (mail ? password : email).focus();
      return;
    }

    auth.setRemember(remember.checked);
    submitPassword.disabled = true;
    note.hidden = true;

    client.auth.signInWithPassword({ email: mail, password: password.value })
      .then(function (res) {
        if (res.error) {
          showNote(auth.friendlyError(res.error));
          submitPassword.disabled = false;
          password.select();
          return;
        }
        return needsMoreAuth().then(function (needs) {
          if (needs) showMfaStep();
          else window.location.replace("promocoes.html");
        });
      })
      .catch(function (err) {
        showNote(auth.friendlyError(err));
        submitPassword.disabled = false;
      });
  });

  function submitMfaCode() {
    var code = mfaCode.value.trim();
    if (!/^\d{6}$/.test(code)) {
      showNote("Digite o código de 6 dígitos do app autenticador.");
      mfaCode.focus();
      return;
    }
    submitMfa.disabled = true;
    note.hidden = true;

    client.auth.mfa.listFactors()
      .then(function (res) {
        if (res.error) throw res.error;
        var totp = (res.data && res.data.totp) || [];
        if (!totp.length) throw new Error("Nenhum fator de verificação encontrado.");
        return client.auth.mfa.challengeAndVerify({ factorId: totp[0].id, code: code });
      })
      .then(function (res) {
        if (res.error) {
          showNote(mfaFriendlyError(res.error));
          submitMfa.disabled = false;
          mfaCode.select();
          return;
        }
        window.location.replace("promocoes.html");
      })
      .catch(function (err) {
        showNote(mfaFriendlyError(err));
        submitMfa.disabled = false;
      });
  }

  // Voltar ao passo 1 (ex.: entrou na conta errada). Encerra a sessão parcial.
  mfaCancel.addEventListener("click", function (event) {
    event.preventDefault();
    mfaCancel.textContent = "Saindo…";
    client.auth.signOut().then(showPasswordStep, showPasswordStep);
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
