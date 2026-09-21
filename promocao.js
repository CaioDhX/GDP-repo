// Cadastro e edição de promoções. Grava na tabela public.deals do Supabase;
// quem pode inserir/editar/excluir é decidido pelas regras (RLS) do banco.
(function () {
  var shell = window.GDP_SHELL;
  var client = shell.client;
  var toast = shell.toast;

  var params = new URLSearchParams(window.location.search);
  var dealId = params.get("id");
  var isEdit = !!dealId;

  function $(id) { return document.getElementById(id); }

  var F = {
    title: $("f-title"), store: $("f-store"), category: $("f-category"),
    original: $("f-price-original"), promo: $("f-price-promo"),
    coupon: $("f-coupon"), cart: $("f-coupon-cart"), shipping: $("f-shipping"),
    affiliate: $("f-affiliate"), highlight: $("f-highlight"), payment: $("f-payment"),
    description: $("f-description"), sku: $("f-sku"), expires: $("f-expires"),
    status: $("f-status"), image: $("f-image")
  };

  var STATUS_LABEL = {
    draft: "Rascunho", ready: "Pronta", queued: "Na fila",
    published: "Publicada", expired: "Expirada", failed: "Falhou"
  };
  var EDITABLE_STATUS = ["draft", "ready"]; // os demais são definidos pelo bot de publicação
  var MAX_IMAGE = 5 * 1024 * 1024;
  var IMAGE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

  var state = {
    user: null, profile: null, stores: [],
    imageUrl: null,      // URL já salva no banco
    file: null,          // arquivo escolhido, ainda não enviado
    previewUrl: null,    // o que está sendo exibido (URL salva ou blob local)
    status: "draft"
  };

  // ---------- Utilidades ----------
  function nullable(value) {
    var v = String(value || "").trim();
    return v ? v : null;
  }

  function isHttp(text) {
    try {
      var u = new URL(text);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (e) { return false; }
  }

  // Aceita "1.299,90", "1299,90", "1299.90" e "1.299" (milhar).
  function parseMoney(text) {
    var s = String(text || "").replace(/R\$|\s/g, "");
    if (!s) return null;
    if (s.indexOf(",") !== -1) s = s.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
    return Math.round(Number(s) * 100) / 100;
  }
  function validMoney(n) { return n !== null && !isNaN(n) && n > 0; }
  function fmtNum(n) { return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtBRL(n) { return "R$ " + fmtNum(n); }

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }).replace(", ", " às ");
  }
  function toLocalInput(iso) {
    var d = new Date(iso);
    function p(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function textColorFor(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#fff";
    var n = parseInt(m[1], 16);
    var lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? "#1a1d2e" : "#fff";
  }

  function storeById(id) {
    for (var i = 0; i < state.stores.length; i++) if (state.stores[i].id === id) return state.stores[i];
    return null;
  }

  // ---------- Erros de campo ----------
  function setErr(name, message) {
    var el = document.querySelector('.f-err[data-for="' + name + '"]');
    if (el) el.textContent = message || "";
  }
  function clearErrs() {
    document.querySelectorAll(".f-err").forEach(function (el) { el.textContent = ""; });
  }

  function validate() {
    var errs = {};
    var title = F.title.value.trim();
    if (title.length < 3 || title.length > 120) errs.title = "O título deve ter entre 3 e 120 caracteres.";
    if (!F.store.value) errs.store_id = "Escolha a loja.";

    var promo = parseMoney(F.promo.value);
    var orig = parseMoney(F.original.value);
    if (!validMoney(promo)) errs.price_promo = "Informe o preço promocional (ex.: 899,90).";
    if (F.original.value.trim()) {
      if (!validMoney(orig)) errs.price_original = "Preço inválido.";
      else if (validMoney(promo) && orig < promo) errs.price_original = "O preço original deve ser maior ou igual ao promocional.";
    }
    if (!isHttp(F.affiliate.value.trim())) errs.affiliate_url = "Informe o link completo, começando com http:// ou https://.";
    return errs;
  }

  // ---------- Foto ----------
  function showPhoto(url) {
    state.previewUrl = url;
    var has = !!url;
    $("photo-img").hidden = !has;
    $("photo-empty").hidden = has;
    $("photo-remove").hidden = !has;
    if (has) $("photo-img").src = url;
    renderPreview();
  }

  F.image.addEventListener("change", function () {
    setErr("image", "");
    var file = F.image.files && F.image.files[0];
    if (!file) return;
    if (!IMAGE_EXT[file.type]) { setErr("image", "Use uma imagem JPG, PNG ou WebP."); F.image.value = ""; return; }
    if (file.size > MAX_IMAGE) { setErr("image", "A imagem passa de 5 MB."); F.image.value = ""; return; }
    if (state.previewUrl && state.previewUrl.indexOf("blob:") === 0) URL.revokeObjectURL(state.previewUrl);
    state.file = file;
    showPhoto(URL.createObjectURL(file));
  });

  $("photo-remove").addEventListener("click", function () {
    if (state.previewUrl && state.previewUrl.indexOf("blob:") === 0) URL.revokeObjectURL(state.previewUrl);
    state.file = null;
    state.imageUrl = null;
    F.image.value = "";
    showPhoto(null);
  });

  function uploadImage(file) {
    var id = window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    var path = state.user.id + "/" + id + "." + IMAGE_EXT[file.type];
    return client.storage.from("deal-images").upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false })
      .then(function (res) {
        if (res.error) throw res.error;
        return client.storage.from("deal-images").getPublicUrl(path).data.publicUrl;
      });
  }

  // ---------- Prévia do Telegram ----------
  function renderPreview() {
    var title = F.title.value.trim();
    $("pv-title").textContent = "🔥 " + (title || "Título da promoção");

    var orig = parseMoney(F.original.value);
    var promo = parseMoney(F.promo.value);
    var hasOrig = validMoney(orig), hasPromo = validMoney(promo);

    $("pv-old-row").hidden = !hasOrig;
    if (hasOrig) $("pv-old").textContent = fmtBRL(orig);
    $("pv-price").textContent = "Por apenas: " + (hasPromo ? fmtBRL(promo) : "R$ —") + "!";

    var note = F.payment.value.trim();
    $("pv-note").hidden = !note;
    $("pv-note").textContent = note ? "(" + note + ")" : "";

    var code = F.coupon.value.trim();
    $("pv-coupon-row").hidden = !code;
    $("pv-coupon").textContent = code;
    $("pv-coupon-hint").textContent = F.cart.checked ? "Aplicar no carrinho" : "Toque p/ copiar";

    var hl = F.highlight.value.trim();
    $("pv-highlight").hidden = !hl;
    $("pv-highlight").textContent = hl ? "⚡ " + hl : "";

    var ship = F.shipping.value;
    $("pv-ship-row").hidden = ship === "unknown";
    $("pv-ship").textContent = ship === "free" ? "📦 Frete Grátis" : ship === "paid" ? "📦 Frete pago" : "";

    // Desconto e economia (o banco também calcula, aqui é só para conferir antes de salvar).
    var off = $("photo-off"), pills = $("calc-pills");
    if (hasOrig && hasPromo && orig > promo) {
      var pct = Math.round((1 - promo / orig) * 100);
      off.textContent = "-" + pct + "%";
      off.hidden = false;
      $("calc-save").lastElementChild.textContent = "Economia de " + fmtBRL(Math.round((orig - promo) * 100) / 100) + " (" + pct + "%)";
      pills.hidden = false;
    } else {
      off.hidden = true;
      pills.hidden = true;
    }

    var store = storeById(F.store.value);
    var tag = $("pv-store");
    tag.hidden = !store;
    if (store) {
      tag.textContent = store.name.toUpperCase();
      var color = /^#[0-9a-f]{6}$/i.test(store.badge_color || "") ? store.badge_color : "#f26a1b";
      tag.style.background = color;
      tag.style.color = textColorFor(color);
    }

    var img = $("pv-img");
    var url = state.previewUrl;
    img.hidden = !url;
    $("pv-ph").hidden = !!url;
    if (url && img.getAttribute("src") !== url) img.src = url;

    var link = $("test-link");
    var aff = F.affiliate.value.trim();
    link.href = isHttp(aff) ? aff : "#";
  }

  $("test-link").addEventListener("click", function (event) {
    if (!isHttp(F.affiliate.value.trim())) {
      event.preventDefault();
      toast("Informe um link válido para testar.");
    }
  });

  // ---------- Listas (lojas e categorias) ----------
  function loadLookups(currentStoreId) {
    var stores = client.from("stores").select("id, name, badge_color, logo_url, is_active").order("sort_order").then(function (res) {
      if (res.error) throw res.error;
      state.stores = res.data || [];
      F.store.textContent = "";
      var first = document.createElement("option");
      first.value = ""; first.textContent = "Selecione a loja";
      F.store.appendChild(first);
      state.stores.forEach(function (s) {
        if (!s.is_active && s.id !== currentStoreId) return;
        var o = document.createElement("option");
        o.value = s.id; o.textContent = s.name + (s.is_active ? "" : " (inativa)");
        F.store.appendChild(o);
      });
    });

    var cats = client.from("categories").select("id, name, emoji").order("sort_order").then(function (res) {
      var list = (res && res.data) || [];
      if (!list.length) { F.category.closest(".box").hidden = true; return; }
      list.forEach(function (c) {
        var o = document.createElement("option");
        o.value = c.id; o.textContent = (c.emoji ? c.emoji + " " : "") + c.name;
        F.category.appendChild(o);
      });
    });

    return Promise.all([stores, cats]);
  }

  // ---------- Carregar promoção existente ----------
  function applyHeader(d) {
    $("page-title").textContent = d.title;
    $("eyebrow-current").textContent = "DETALHES #" + d.public_code;
    $("crumb-current").textContent = "Detalhes #" + d.public_code;
    $("sys-id").textContent = d.public_code;
    document.title = d.title + " — GOAT Promo";

    var chip = $("status-chip");
    chip.hidden = false;
    chip.textContent = (STATUS_LABEL[d.status] || d.status).toUpperCase();
    chip.className = "chip chip--st-" + d.status;

    var store = storeById(d.store_id);
    var sc = $("store-chip");
    sc.hidden = !store;
    if (store) sc.textContent = store.name.toUpperCase();

    $("meta-info").hidden = false;
    $("meta-created").textContent = fmtDateTime(d.created_at);
    $("meta-author").textContent = "por " + ((d.creator && d.creator.full_name) || "usuário removido");
    $("meta-published").textContent = d.published_at ? "Publicada em " + fmtDateTime(d.published_at) : "Ainda não publicada";
    $("meta-updated").textContent = "Atualizada em " + fmtDateTime(d.updated_at);
  }

  function fillForm(d) {
    F.title.value = d.title || "";
    F.store.value = d.store_id;
    F.category.value = d.category_id || "";
    F.original.value = d.price_original != null ? fmtNum(Number(d.price_original)) : "";
    F.promo.value = d.price_promo != null ? fmtNum(Number(d.price_promo)) : "";
    F.coupon.value = d.coupon_code || "";
    F.cart.checked = !!d.coupon_at_cart;
    F.shipping.value = d.shipping || "unknown";
    F.affiliate.value = d.affiliate_url || "";
    F.highlight.value = d.highlight || "";
    F.payment.value = d.payment_note || "";
    F.description.value = d.description || "";
    F.sku.value = d.sku || "";
    F.expires.value = d.expires_at ? toLocalInput(d.expires_at) : "";

    state.status = d.status;
    if (EDITABLE_STATUS.indexOf(d.status) !== -1) {
      F.status.value = d.status;
    } else {
      var o = document.createElement("option");
      o.value = d.status;
      o.textContent = STATUS_LABEL[d.status] || d.status;
      F.status.appendChild(o);
      F.status.value = d.status;
      F.status.disabled = true;
      $("status-hint").textContent = "Esta situação é controlada pelo bot de publicação.";
    }

    state.imageUrl = d.image_url || null;
    showPhoto(state.imageUrl);
  }

  function loadDeal() {
    return client.from("deals")
      .select("*, creator:profiles!deals_created_by_fkey(full_name)")
      .eq("id", dealId).maybeSingle()
      .then(function (res) {
        if (res.error && res.error.code !== "22P02") throw res.error;
        var d = res.data;
        if (!d) {
          $("deal-form").hidden = true;
          $("not-found").hidden = false;
          return null;
        }
        return loadLookups(d.store_id).then(function () {
          fillForm(d);
          applyHeader(d);
          return d;
        });
      });
  }

  // ---------- Salvar ----------
  function dbError(e) {
    var msg = (e && e.message) || "";
    if ((e && e.code === "42501") || /row-level security/i.test(msg)) return "Seu usuário não tem permissão para salvar (é preciso ser editor ou administrador).";
    if (/maximum allowed size|too large/i.test(msg)) return "A imagem passa do limite de 5 MB.";
    if (/mime type/i.test(msg)) return "Formato de imagem não permitido.";
    return "Não foi possível salvar: " + msg;
  }

  function buildPayload(imageUrl) {
    var orig = parseMoney(F.original.value);
    var coupon = F.coupon.value.trim();
    var payload = {
      title: F.title.value.trim(),
      store_id: F.store.value,
      category_id: F.category.value || null,
      price_original: validMoney(orig) ? orig : null,
      price_promo: parseMoney(F.promo.value),
      payment_note: nullable(F.payment.value),
      coupon_code: coupon || null,
      coupon_at_cart: coupon ? F.cart.checked : false,
      affiliate_url: F.affiliate.value.trim(),
      shipping: F.shipping.value,
      highlight: nullable(F.highlight.value),
      description: nullable(F.description.value),
      sku: nullable(F.sku.value),
      image_url: imageUrl,
      expires_at: F.expires.value ? new Date(F.expires.value).toISOString() : null,
      updated_by: state.user.id
    };
    // Situações definidas pelo bot (na fila, publicada...) não são alteradas por aqui.
    if (!isEdit || EDITABLE_STATUS.indexOf(state.status) !== -1) payload.status = F.status.value;
    return payload;
  }

  var saveBtn = $("save-btn");
  function setSaving(on) {
    saveBtn.disabled = on;
    saveBtn.lastElementChild.textContent = on ? "Salvando…" : "Salvar promoção";
  }

  $("deal-form").addEventListener("submit", function (event) {
    event.preventDefault();
    clearErrs();
    var errs = validate();
    var names = Object.keys(errs);
    if (names.length) {
      names.forEach(function (n) { setErr(n, errs[n]); });
      var first = document.querySelector('.f-err[data-for="' + names[0] + '"]');
      if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
      toast("Corrija os campos destacados.");
      return;
    }

    setSaving(true);
    var upload = state.file ? uploadImage(state.file) : Promise.resolve(state.imageUrl);

    upload.then(function (imageUrl) {
      var payload = buildPayload(imageUrl);
      if (isEdit) {
        return client.from("deals").update(payload).eq("id", dealId)
          .select("*, creator:profiles!deals_created_by_fkey(full_name)").single()
          .then(function (res) {
            if (res.error) throw res.error;
            state.file = null;
            state.imageUrl = res.data.image_url;
            applyHeader(res.data);
            toast("Promoção atualizada.");
          });
      }
      payload.created_by = state.user.id;
      return client.from("deals").insert(payload).select("id").single().then(function (res) {
        if (res.error) throw res.error;
        window.location.replace("promocao.html?id=" + encodeURIComponent(res.data.id) + "&salvo=1");
      });
    }).catch(function (err) {
      toast(dbError(err));
    }).then(function () {
      setSaving(false);
    });
  });

  // ---------- Excluir (só administrador, o banco também exige) ----------
  $("delete-btn").addEventListener("click", function () {
    var code = $("sys-id").textContent;
    if (!window.confirm("Excluir a promoção " + code + "? Esta ação não pode ser desfeita.")) return;
    client.from("deals").delete().eq("id", dealId).select("id").then(function (res) {
      if (res.error) { toast("Não foi possível excluir: " + res.error.message); return; }
      if (!res.data || !res.data.length) { toast("Sem permissão para excluir esta promoção."); return; }
      window.location.replace("promocoes.html");
    });
  });

  // ---------- Formatação ao sair do campo de preço ----------
  [F.original, F.promo].forEach(function (input) {
    input.addEventListener("blur", function () {
      var n = parseMoney(input.value);
      if (validMoney(n)) input.value = fmtNum(n);
    });
  });

  // Ao mexer num campo, some a mensagem de erro dele.
  function clearFieldErr(el) {
    var wrap = el.closest(".f, .box, .aff");
    var msg = wrap && wrap.querySelector(".f-err");
    if (msg) msg.textContent = "";
  }

  Object.keys(F).forEach(function (key) {
    if (key === "image") return;
    var handler = function () { clearFieldErr(F[key]); renderPreview(); };
    F[key].addEventListener("input", handler);
    F[key].addEventListener("change", handler);
  });

  // ---------- Início ----------
  (function init() {
    var now = new Date();
    $("pv-date").textContent = now.toLocaleDateString("pt-BR", { day: "numeric", month: "long" });
    $("pv-time").textContent = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

    if (isEdit) {
      document.querySelector('[data-nav="lista"]').setAttribute("aria-current", "page");
      document.querySelector('[data-nav="nova"]').removeAttribute("aria-current");
      $("page-title").textContent = "Carregando…";
    }

    Promise.all([shell.ready, shell.profile]).then(function (r) {
      state.user = r[0];
      state.profile = r[1];
      if (!isEdit) return loadLookups();
      return loadDeal();
    }).then(function (deal) {
      renderPreview();
      if (isEdit && deal && state.profile.role === "admin") $("delete-btn").hidden = false;
      if (params.get("salvo") === "1") {
        toast("Promoção cadastrada com sucesso.");
        window.history.replaceState(null, "", "promocao.html?id=" + encodeURIComponent(dealId));
      }
    }).catch(function (err) {
      toast("Erro ao carregar: " + ((err && err.message) || "tente novamente"));
    });
  })();
})();
