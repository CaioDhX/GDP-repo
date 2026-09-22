// Configurações da conta: verificação em duas etapas (MFA por TOTP), via Supabase Auth.
// Suporta um único fator TOTP por conta, para manter o login (script.js) simples.
(function () {
  var shell = window.GDP_SHELL;
  var client = shell.client;
  var toast = shell.toast;

  function $(id) { return document.getElementById(id); }

  var statusEl = $("mfa-status"), enableBtn = $("mfa-enable"), disableBtn = $("mfa-disable");
  var enrollBox = $("mfa-enroll"), qrImg = $("mfa-qr"), secretInput = $("mfa-secret");
  var verifyInput = $("mfa-verify"), verifyErr = $("mfa-verify-err");
  var confirmBtn = $("mfa-enroll-confirm"), cancelBtn = $("mfa-enroll-cancel");

  var pendingFactorId = null; // fator criado mas ainda não confirmado (aparece com "Cancelar")

  function mfaError(error) {
    var msg = ((error && error.message) || "").toLowerCase();
    if (msg.indexOf("invalid") !== -1 || msg.indexOf("incorrect") !== -1) return "Código incorreto. Confira o app e tente de novo.";
    if (msg.indexOf("expired") !== -1) return "O código expirou. Digite o código atual do app.";
    if ((error && error.status === 429) || msg.indexOf("rate limit") !== -1) return "Muitas tentativas. Aguarde um pouco e tente de novo.";
    return (error && error.message) || "Não foi possível concluir agora.";
  }

  function hideEnroll() {
    enrollBox.hidden = true;
    verifyInput.value = "";
    verifyErr.textContent = "";
    pendingFactorId = null;
  }

  // ---------- Estado atual ----------
  function refresh() {
    return client.auth.mfa.listFactors().then(function (res) {
      if (res.error) {
        statusEl.textContent = "Não foi possível carregar (" + res.error.message + ").";
        return;
      }
      var totp = (res.data.totp || []);
      var active = totp.length > 0;
      statusEl.textContent = active
        ? "Ativada. A cada login, além da chave, é pedido um código do app autenticador."
        : "Desativada. Só a chave de segurança é exigida para entrar.";
      enableBtn.hidden = active;
      disableBtn.hidden = !active;
      if (active) hideEnroll();
      return active ? totp[0] : null;
    });
  }

  // ---------- Ativar ----------
  enableBtn.addEventListener("click", function () {
    enableBtn.disabled = true;
    client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Autenticador" }).then(function (res) {
      enableBtn.disabled = false;
      if (res.error) { toast({ kind: "error", title: "Não foi possível iniciar a ativação", body: mfaError(res.error) }); return; }
      pendingFactorId = res.data.id;
      qrImg.src = res.data.totp.qr_code;
      secretInput.value = res.data.totp.secret;
      verifyInput.value = "";
      verifyErr.textContent = "";
      enrollBox.hidden = false;
      verifyInput.focus();
    });
  });

  $("mfa-secret-copy").addEventListener("click", function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(secretInput.value).then(
        function () { toast({ kind: "success", title: "Copiado", body: "Código manual copiado." }); },
        function () { toast({ kind: "error", title: "Não foi possível copiar", body: "Copie manualmente." }); }
      );
    }
  });

  cancelBtn.addEventListener("click", function () {
    var id = pendingFactorId;
    hideEnroll();
    if (id) client.auth.mfa.unenroll({ factorId: id }); // limpeza silenciosa: fator nunca chegou a ser confirmado
  });

  confirmBtn.addEventListener("click", function () {
    var code = verifyInput.value.trim();
    verifyErr.textContent = "";
    if (!/^\d{6}$/.test(code)) { verifyErr.textContent = "Digite o código de 6 dígitos do app."; verifyInput.focus(); return; }
    if (!pendingFactorId) return;

    confirmBtn.disabled = true;
    client.auth.mfa.challengeAndVerify({ factorId: pendingFactorId, code: code }).then(function (res) {
      confirmBtn.disabled = false;
      if (res.error) {
        verifyErr.textContent = mfaError(res.error);
        verifyInput.select();
        return;
      }
      hideEnroll();
      toast({ kind: "success", title: "Verificação em duas etapas ativada", body: "A partir de agora, o login pede o código também." });
      refresh();
    });
  });

  // ---------- Desativar ----------
  disableBtn.addEventListener("click", function () {
    refresh().then(function (factor) {
      if (!factor) return;
      shell.confirm({
        title: "Desativar a verificação em duas etapas?",
        body: "O login volta a exigir só a chave de segurança. Você pode ativar de novo quando quiser.",
        confirmLabel: "Desativar",
        danger: true
      }).then(function (ok) {
        if (!ok) return;
        disableBtn.disabled = true;
        client.auth.mfa.unenroll({ factorId: factor.id }).then(function (res) {
          disableBtn.disabled = false;
          if (res.error) { toast({ kind: "error", title: "Não foi possível desativar", body: mfaError(res.error) }); return; }
          toast({ kind: "success", title: "Verificação em duas etapas desativada" });
          refresh();
        });
      });
    });
  });

  shell.ready.then(refresh);
})();
