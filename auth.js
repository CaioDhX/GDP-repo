// Cliente Supabase compartilhado pelas páginas. Requer supabase-js e config.js carregados antes.
(function () {
  var cfg = window.GDP_CONFIG;
  var KEY = "gdp-auth-token";

  function read(store, key) {
    try { return store.getItem(key); } catch (e) { return null; }
  }
  function write(store, key, value) {
    try { store.setItem(key, value); } catch (e) { /* armazenamento indisponível */ }
  }
  function drop(store, key) {
    try { store.removeItem(key); } catch (e) { /* idem */ }
  }

  // "Manter conectado" ligado -> localStorage (sobrevive ao fechar o navegador).
  // Desligado -> sessionStorage (some ao fechar a aba).
  var remember = read(window.sessionStorage, KEY) === null;

  var storage = {
    getItem: function (key) {
      var v = read(window.localStorage, key);
      return v !== null ? v : read(window.sessionStorage, key);
    },
    setItem: function (key, value) {
      write(remember ? window.localStorage : window.sessionStorage, key, value);
      drop(remember ? window.sessionStorage : window.localStorage, key);
    },
    removeItem: function (key) {
      drop(window.localStorage, key);
      drop(window.sessionStorage, key);
    }
  };

  var client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      storageKey: KEY,
      storage: storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  });

  function friendlyError(error) {
    var msg = ((error && error.message) || "").toLowerCase();
    if (msg.indexOf("invalid login") !== -1) return "E-mail ou chave de segurança incorretos.";
    if (msg.indexOf("email not confirmed") !== -1) return "Este e-mail ainda não foi confirmado. Fale com o administrador.";
    if ((error && error.status === 429) || msg.indexOf("rate limit") !== -1) return "Muitas tentativas. Aguarde um pouco e tente de novo.";
    if (msg.indexOf("failed to fetch") !== -1 || msg.indexOf("network") !== -1) return "Sem conexão com o servidor. Verifique sua internet.";
    return "Não foi possível entrar agora. Tente novamente.";
  }

  window.GDP_AUTH = {
    client: client,
    friendlyError: friendlyError,
    setRemember: function (value) { remember = !!value; }
  };
})();
