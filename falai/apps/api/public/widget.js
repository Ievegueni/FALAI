/*
 * Falaí — widget de chat. Vanilla JS, sem dependências: corre no site do cliente.
 * Uso: <script src="https://API/public/chat/widget.js" data-inbox="INBOX_ID" async></script>
 */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var inboxId = script.getAttribute("data-inbox");
  var base = new URL(script.src).origin + "/public/chat/" + inboxId;
  var storeKey = "falai_chat_" + inboxId;
  var token = null;
  try { token = localStorage.getItem(storeKey); } catch (e) {}

  var seen = {};
  var stream = null;
  var loaded = false;

  var root = document.createElement("div");
  root.id = "falai-chat";
  var shadow = root.attachShadow ? root.attachShadow({ mode: "open" }) : root;
  shadow.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}" +
    ".btn{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:24px;z-index:2147483646}" +
    ".panel{position:fixed;right:20px;bottom:88px;width:340px;max-width:calc(100vw - 40px);height:460px;max-height:calc(100vh - 120px);background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.2);display:flex;flex-direction:column;overflow:hidden;z-index:2147483647}" +
    ".panel[hidden]{display:none}" +
    ".head{padding:14px 16px;color:#fff;font-weight:600;font-size:15px;display:flex;justify-content:space-between;align-items:center}" +
    ".head button{background:none;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1}" +
    ".msgs{flex:1;overflow-y:auto;padding:12px;background:#f7f7f8;display:flex;flex-direction:column;gap:8px}" +
    ".m{max-width:80%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}" +
    ".m.agent{background:#fff;color:#111;align-self:flex-start;border:1px solid #e5e7eb}" +
    ".m.visitor{color:#fff;align-self:flex-end}" +
    ".typing{font-size:12px;color:#6b7280;padding:0 12px 6px;background:#f7f7f8}" +
    "form{display:flex;border-top:1px solid #e5e7eb}" +
    "input{flex:1;border:0;padding:12px;font-size:14px;outline:none}" +
    "form button{border:0;background:none;padding:0 14px;font-weight:600;cursor:pointer}" +
    "</style>" +
    '<div class="panel" hidden role="dialog" aria-label="Chat">' +
    '<div class="head"><span class="title">Chat</span><button type="button" class="close" aria-label="Fechar">×</button></div>' +
    '<div class="msgs" aria-live="polite"></div>' +
    '<div class="typing" hidden>A escrever…</div>' +
    '<form><input type="text" placeholder="Escreva uma mensagem…" aria-label="Mensagem" maxlength="2000"><button type="submit">Enviar</button></form>' +
    "</div>" +
    '<button type="button" class="btn" aria-label="Abrir chat">💬</button>';

  var $ = function (s) { return shadow.querySelector(s); };
  var panel = $(".panel"), msgs = $(".msgs"), input = $("input"), typing = $(".typing");
  var color = "#2563eb";

  function paint() {
    $(".btn").style.background = color;
    $(".head").style.background = color;
    $("form button").style.color = color;
  }
  paint();

  function add(m) {
    if (m.id && seen[m.id]) return;
    if (m.id) seen[m.id] = true;
    var el = document.createElement("div");
    el.className = "m " + m.role;
    el.textContent = m.text;
    if (m.role === "visitor") el.style.background = color;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    if (m.role === "agent") typing.hidden = true;
  }

  function get(path) {
    return fetch(base + path).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
  }

  function connect() {
    if (!token || stream || !window.EventSource) return;
    stream = new EventSource(base + "/stream?token=" + token);
    // A cada (re)ligação, redesenha a partir do histórico: não se perde a
    // resposta que chegou enquanto o stream estava em baixo.
    stream.addEventListener("ready", function () {
      get("/history?token=" + token).then(function (h) {
        msgs.innerHTML = "";
        seen = {};
        h.data.forEach(add);
      }).catch(function () {});
    });
    stream.addEventListener("message", function (e) {
      var m = JSON.parse(e.data);
      if (m.role !== "visitor") add(m); // as do visitante já estão no ecrã
    });
  }

  function load() {
    if (loaded) return;
    loaded = true;
    get("/config").then(function (c) {
      color = c.color || color;
      $(".title").textContent = c.title || "Chat";
      paint();
      if (c.welcome && !token) add({ role: "agent", text: c.welcome });
    }).catch(function () {});
    connect();
  }

  $(".btn").addEventListener("click", function () {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { load(); input.focus(); }
  });
  $(".close").addEventListener("click", function () { panel.hidden = true; });

  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    add({ role: "visitor", text: text });
    typing.hidden = false;
    // text/plain = pedido simples, sem preflight CORS.
    fetch(base + "/message", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(token ? { token: token, text: text } : { text: text }),
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (res) {
        if (!token) {
          token = res.token;
          try { localStorage.setItem(storeKey, token); } catch (e) {}
          connect();
        }
      })
      .catch(function () {
        typing.hidden = true;
        add({ role: "agent", text: "Não foi possível enviar. Tente novamente." });
      });
  });

  function mount() { document.body.appendChild(root); }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
