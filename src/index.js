var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// --- Limits & Constants ---
var LIMITS = {
  MAX_MESSAGE_LENGTH: 2000,
  MAX_NAME_LENGTH: 24,
  MAX_AVATAR_LENGTH: 16,
  MAX_HISTORY: 100,
  MAX_STORAGE_BYTES: 100 * 1024,
  MAX_SESSIONS: 1000,
  DAILY_MESSAGE_LIMIT: 100000,
  MESSAGE_COOLDOWN_MS: 500,
  IDENTITY_COOLDOWN_MS: 1000,
  TYPING_COOLDOWN_MS: 1000,
  PING_COOLDOWN_MS: 10000,
  RETRACT_WINDOW_MS: 120000,
  MAX_FRAME_LENGTH: 16384
};

// 控制字元（保留 Tab、換行）與不可見的雙向文字/零寬字元，避免身分偽裝與日誌注入
var CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
var INVISIBLE_CHARS_PATTERN = /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

function normalizeText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS_PATTERN, "")
    .replace(INVISIBLE_CHARS_PATTERN, "")
    .slice(0, maxLength);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// --- Backend: Durable Object for the Chat Room ---
var ChatRoom = class {
  constructor(state, env) {
    this.state = state;
    this.sessions = [];
  }

  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("Expected websocket", { status: 400 });
    }
    if (this.sessions.length >= LIMITS.MAX_SESSIONS) {
      return new Response("Too many concurrent connections", { status: 503 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    await this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleSession(ws) {
    ws.accept();

    // 身分識別碼由伺服器端產生，絕不信任客戶端傳入的 id
    const session = {
      ws,
      quit: false,
      id: crypto.randomUUID(),
      name: "",
      avatar: "",
      isIdentified: false,
      lastMessageAt: 0,
      lastTypingAt: 0,
      lastIdentityAt: 0,
      lastPingAt: 0
    };
    this.sessions.push(session);

    // 先註冊事件監聽器再進行任何 await，避免連線建立後送達的訊息被遺漏
    ws.addEventListener("message", async (msg) => {
      try {
        if (session.quit) return;

        if (typeof msg.data === "string" && msg.data.length > LIMITS.MAX_FRAME_LENGTH) {
          this.sendError(session, "訊息內容過長，請縮短後再送出。");
          return;
        }

        let data;
        try {
          data = JSON.parse(msg.data);
        } catch (e) {
          this.sendError(session, "無法解析訊息格式。");
          return;
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) return;

        if (data.type === "identity") {
          await this.handleIdentity(session, data);
          return;
        }

        if (!session.isIdentified) {
          this.sendError(session, "請先設定身分再傳送訊息！");
          return;
        }

        if (data.type === "typing") {
          const now = Date.now();
          if (now - session.lastTypingAt < LIMITS.TYPING_COOLDOWN_MS) return;
          session.lastTypingAt = now;
          this.broadcast({ type: "typing", name: session.name, id: session.id }, session.id);
          return;
        }

        if (data.type === "ping") {
          const now = Date.now();
          if (now - session.lastPingAt < LIMITS.PING_COOLDOWN_MS) return;
          session.lastPingAt = now;
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (data.type === "retract") {
          await this.handleRetract(session, data);
          return;
        }

        if (data.type === "chat") {
          await this.handleChat(session, data);
          return;
        }
      } catch (e) {
        console.error("handle message failed:", e && e.message);
      }
    });

    const closeOrErrorHandler = __name(() => {
      if (!session.quit) {
        session.quit = true;
        this.sessions = this.sessions.filter((s) => s !== session);
        if (session.isIdentified) {
          this.broadcast({ type: "info", message: session.name + " 離開了。" });
          this.updateAndBroadcastStatus();
        }
      }
    }, "closeOrErrorHandler");

    ws.addEventListener("close", closeOrErrorHandler);
    ws.addEventListener("error", closeOrErrorHandler);

    await this.updateAndBroadcastStatus();
  }

  async handleIdentity(session, data) {
    const now = Date.now();
    if (session.isIdentified && now - session.lastIdentityAt < LIMITS.IDENTITY_COOLDOWN_MS) {
      this.sendError(session, "更新暱稱過於頻繁，請稍候再試。");
      return;
    }
    session.lastIdentityAt = now;

    const name = normalizeText(data.name, LIMITS.MAX_NAME_LENGTH).trim() || this.generateName();
    const avatar = normalizeText(data.avatar, LIMITS.MAX_AVATAR_LENGTH).trim() || "🤖";
    const isNewcomer = !session.isIdentified;

    session.name = name;
    session.avatar = avatar;
    session.isIdentified = true;

    session.ws.send(JSON.stringify({ type: "identity", id: session.id, name: session.name, avatar: session.avatar }));

    // 只有完成身分設定的連線才可以讀取歷史訊息
    const history = (await this.state.storage.get("messages")) || [];
    session.ws.send(JSON.stringify({ type: "history", messages: history }));
    session.ws.send(JSON.stringify({ type: "info", message: "歡迎你，" + session.name + "！" }));

    if (isNewcomer) {
      this.broadcast({ type: "info", message: session.name + " 加入了聊天。" });
    }
    await this.updateAndBroadcastStatus();
  }

  async handleRetract(session, data) {
    const messageId = typeof data.messageId === "string" ? data.messageId : "";
    if (!messageId || messageId.length > 64) return;

    // 以交易讀寫歷史，避免與同時送出的訊息互相覆蓋
    const result = await this.state.storage.transaction(async (txn) => {
      const currentHistory = (await txn.get("messages")) || [];
      const messageIndex = currentHistory.findIndex((m) => m.messageId === messageId);
      if (messageIndex === -1) return "missing";
      if (currentHistory[messageIndex].id !== session.id) return "denied";
      if (Date.now() - currentHistory[messageIndex].timestamp >= LIMITS.RETRACT_WINDOW_MS) return "expired";

      currentHistory[messageIndex].text = "此訊息已被撤回";
      currentHistory[messageIndex].isRetracted = true;
      await txn.put("messages", currentHistory);
      return "ok";
    });

    if (result === "denied") {
      this.sendError(session, "無法撤回此訊息（權限不足）。");
      return;
    }
    if (result === "expired") {
      this.sendError(session, "無法撤回此訊息（已逾時）。");
      return;
    }
    if (result === "ok") {
      this.broadcast({ type: "retract", messageId: messageId });
    }
  }

  async handleChat(session, data) {
    if (typeof data.text !== "string") {
      this.sendError(session, "訊息格式不正確。");
      return;
    }

    const now = Date.now();
    if (now - session.lastMessageAt < LIMITS.MESSAGE_COOLDOWN_MS) {
      this.sendError(session, "你說話太快了！");
      return;
    }

    const text = normalizeText(data.text, LIMITS.MAX_MESSAGE_LENGTH);
    if (!text.trim()) return;
    session.lastMessageAt = now;

    const message = {
      messageId: crypto.randomUUID(),
      id: session.id,
      name: session.name,
      avatar: session.avatar,
      text: text,
      timestamp: now,
      isRetracted: false
    };

    // 以交易方式一次完成「配額檢查 + 訊息寫入 + 計數」，避免競態造成配額或訊息遺失
    const stored = await this.state.storage.transaction(async (txn) => {
      const today = todayKey();
      const lastWriteDate = (await txn.get("lastWriteDate")) || today;
      let dailyWrites = (await txn.get("dailyWrites")) || 0;
      if (today !== lastWriteDate) {
        dailyWrites = 0;
        await txn.put("lastWriteDate", today);
      }
      if (dailyWrites >= LIMITS.DAILY_MESSAGE_LIMIT) return false;

      const history = (await txn.get("messages")) || [];
      history.push(message);
      while (history.length > LIMITS.MAX_HISTORY) {
        history.shift();
      }
      // 以 3 倍字元數估算位元組數（CJK 最壞情況），避免單一鍵值超出儲存限制
      while (history.length > 1 && JSON.stringify(history).length * 3 > LIMITS.MAX_STORAGE_BYTES) {
        history.shift();
      }
      await txn.put("messages", history);
      await txn.put("dailyWrites", dailyWrites + 1);
      return true;
    });

    if (!stored) {
      this.sendError(session, "今天的話題已聊完，明天再來吧！");
      return;
    }

    this.broadcast({ type: "message", ...message });
    await this.updateAndBroadcastStatus();
  }

  sendError(session, message) {
    try {
      session.ws.send(JSON.stringify({ type: "error", message: message }));
    } catch (err) {
      session.quit = true;
    }
  }

  broadcast(message, excludeId = null) {
    const preparedMessage = JSON.stringify(message);
    this.sessions = this.sessions.filter((session) => {
      if (session.id === excludeId) return true;
      if (!session.isIdentified && message.type !== "status") return true;
      try {
        session.ws.send(preparedMessage);
        return true;
      } catch (err) {
        session.quit = true;
        return false;
      }
    });
  }

  async updateAndBroadcastStatus() {
    const today = todayKey();
    const lastWriteDate = (await this.state.storage.get("lastWriteDate")) || today;
    let dailyWrites = (await this.state.storage.get("dailyWrites")) || 0;
    if (today !== lastWriteDate) {
      dailyWrites = 0;
    }
    const remaining = LIMITS.DAILY_MESSAGE_LIMIT - dailyWrites;
    const onlineCount = this.sessions.filter((s) => s.isIdentified).length;
    const statusMessage = JSON.stringify({
      type: "status",
      online: onlineCount,
      remaining: remaining > 0 ? remaining : 0
    });
    this.sessions.forEach((session) => {
      try {
        if (!session.quit) session.ws.send(statusMessage);
      } catch (err) {
        session.quit = true;
      }
    });
    this.sessions = this.sessions.filter((s) => !s.quit);
  }

  generateName() {
    const adjectives = ["神秘的", "快樂的", "沉思的", "勇敢的", "聰明的", "好奇的"];
    const nouns = ["訪客", "旅人", "思想家", "探險家", "夢想家", "觀察者"];
    const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
    const randomNum = Math.floor(Math.random() * 9000) + 1000;
    return randomAdj + randomNoun + "_" + randomNum;
  }
};
__name(ChatRoom, "ChatRoom");

var src_default = {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const isWebSocket = (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";

      if (isWebSocket) {
        // 阻擋跨站 WebSocket 劫持（僅允許同源來源）
        const origin = request.headers.get("Origin");
        if (origin) {
          let originHost = "";
          try {
            originHost = new URL(origin).host;
          } catch (e) {
            return new Response("Forbidden", { status: 403, headers: baseHeaders() });
          }
          if (originHost && originHost !== url.host) {
            return new Response("Forbidden", { status: 403, headers: baseHeaders() });
          }
        }
        const id = env.CHAT_ROOM.idFromName("global-chat-room");
        const stub = env.CHAT_ROOM.get(id);
        return stub.fetch(request);
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: Object.assign(baseHeaders(), { Allow: "GET, HEAD" })
        });
      }

      if (/\.[a-z0-9]+$/i.test(url.pathname)) {
        return new Response("Not Found", { status: 404, headers: baseHeaders() });
      }

      const nonce = crypto.randomUUID().replace(/-/g, "");
      const headers = Object.assign(baseHeaders(), {
        "Content-Security-Policy": contentSecurityPolicy(nonce)
      });

      return new Response(request.method === "HEAD" ? null : renderHTML(nonce), {
        status: 200,
        headers: headers
      });
    } catch (e) {
      console.error("worker request failed:", e && e.message);
      return new Response("Internal Server Error", { status: 500, headers: baseHeaders() });
    }
  }
};

function baseHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=(), browsing-topics=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cache-Control": "no-cache"
  };
}

function contentSecurityPolicy(nonce) {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "script-src 'self' 'nonce-" + nonce + "' https://cdn.jsdelivr.net",
    "style-src 'self' 'nonce-" + nonce + "'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "manifest-src 'self'",
    "upgrade-insecure-requests"
  ].join("; ");
}

var renderHTML = (nonce) => `
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="referrer" content="no-referrer">
    <title>秘密聊天室</title>
    <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/marked@18.1.1/lib/marked.umd.js" integrity="sha384-rATToyt6602Jnq8c7w8HZwmyOUgPL7mzxX01FBWoV48ns/EgkakGozpES+PnaYOI" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
    <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/dompurify@3.4.17/dist/purify.min.js" integrity="sha384-P0JNneQf81HOl9VwNXK76cQ9VMD6Nfsnepxb0cCOg8+UzEdzgPHAPV4wVQrvYQSx" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
    <style nonce="${nonce}">
        :root { --theme-color: #007bff; --bg-color: #f0f2f5; --panel-bg: #fff; --text-color: #333; --border-color: #ddd; --retracted-color: #999; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; background-color: var(--bg-color); display: flex; height: 100vh; overflow: hidden; }

        .app-container { display: flex; width: 100%; height: 100%; transition: transform 0.3s ease-in-out; }
        .main-content { flex-grow: 1; display: flex; flex-direction: column; width: 100%; height: 100%; position: relative; z-index: 1; background-color: var(--bg-color); }

        .chat-header { padding: 10px 20px; border-bottom: 1px solid var(--border-color); font-size: 12px; color: #666; text-align: center; position: relative; flex-shrink: 0; background-color: var(--panel-bg); display: flex; justify-content: center; align-items: center; }
        .header-buttons { position: absolute; right: 15px; top: 50%; transform: translateY(-50%); display: flex; gap: 10px; }
        .toggle-button { background: none; border: 1px solid var(--border-color); border-radius: 50%; width: 30px; height: 30px; cursor: pointer; font-size: 18px; line-height: 28px; z-index: 10; display: flex; align-items: center; justify-content: center; }

        .messages { flex-grow: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; }
        .message { display: flex; margin-bottom: 15px; max-width: 80%; position: relative; }
        .message .avatar { font-size: 24px; width: 40px; height: 40px; line-height: 40px; text-align: center; border-radius: 50%; background-color: #e9e9eb; margin-right: 10px; flex-shrink: 0; user-select: none; }
        .message .content { display: flex; flex-direction: column; }
        .message .meta { font-size: 12px; color: #888; margin-bottom: 5px; }
        .message .text { background-color: #e9e9eb; padding: 10px 15px; border-radius: 18px; word-wrap: break-word; }
        .message .text p { margin: 0; }
        .message.mine { align-self: flex-end; flex-direction: row-reverse; }
        .message.mine .avatar { margin-right: 0; margin-left: 10px; }
        .message.mine .text { background-color: var(--theme-color); color: white; }
        .message.mine .meta { text-align: right; }
        .message.info, .message.error { align-self: center; text-align: center; color: #aaa; font-size: 12px; max-width: 100%; }
        .message.error { color: #ff4d4f; font-weight: bold; }
        .message.retracted .text { color: var(--retracted-color); font-style: italic; }

        .message .retract-btn { display: none; position: absolute; top: 50%; transform: translateY(-50%); left: -30px; cursor: pointer; font-size: 14px; color: #aaa; }
        .message.mine:hover .retract-btn { display: block; }
        .message.mine .retract-btn { left: auto; right: -30px; }

        .text.collapsible { max-height: 100px; overflow: hidden; position: relative; cursor: pointer; }
        .text.collapsible::after { content: '... 點擊展開'; position: absolute; bottom: 0; right: 0; width: 100%; text-align: right; background: linear-gradient(to right, transparent, #e9e9eb 50%); padding-right: 15px; padding-left: 30px; box-sizing: border-box; color: #555; font-size: 12px; font-weight: bold; }
        .message.mine .text.collapsible::after { background: linear-gradient(to right, transparent, var(--theme-color) 50%); color: white; }
        .text.expanded { max-height: none; cursor: default; }
        .text.expanded::after { display: none; }

        .input-area { display: flex; flex-direction: column; padding: 15px; border-top: 1px solid var(--border-color); flex-shrink: 0; background-color: var(--panel-bg); }
        .input-row { display: flex; width: 100%; align-items: center; position: relative; }
        #message-input { flex-grow: 1; border: 1px solid #ccc; border-radius: 20px; padding: 10px 15px; font-size: 16px; outline: none; resize: none; max-height: 150px; overflow-y: auto; }
        .input-actions { display: flex; align-items: center; margin-left: 10px; }
        #emoji-toggle { font-size: 24px; cursor: pointer; background: none; border: none; padding: 0 5px; }
        #send-button { background-color: var(--theme-color); color: white; border: none; border-radius: 20px; padding: 10px 20px; cursor: pointer; font-size: 16px; }
        .typing-indicator { height: 20px; font-size: 12px; color: #888; padding: 5px 0 0; }

        .emoji-picker { position: absolute; bottom: 55px; right: 0; background: var(--panel-bg); border: 1px solid var(--border-color); border-radius: 8px; box-shadow: 0 -4px 12px rgba(0,0,0,0.1); display: grid; grid-template-columns: repeat(8, 1fr); gap: 5px; padding: 10px; z-index: 10; display: none; }
        .emoji-picker.visible { display: grid; }
        .emoji-picker span { cursor: pointer; font-size: 22px; text-align: center; padding: 5px; border-radius: 4px; }
        .emoji-picker span:hover { background-color: #f0f0f0; }

        .side-panel { position: fixed; top: 0; right: 0; width: 300px; height: 100%; background-color: #f8f9fa; z-index: 20; display: flex; flex-direction: column; box-shadow: -5px 0 15px rgba(0,0,0,0.1); transition: transform 0.3s ease-in-out; transform: translateX(100%); padding: 0; box-sizing: border-box; }
        .app-container.settings-open .side-panel { transform: translateX(0); }
        .side-panel h3 { background-color: #e9ecef; color: #333; margin: 0; padding: 15px; text-align: center; font-size: 16px; flex-shrink: 0; }
        .settings-content { padding: 20px; overflow-y: auto; flex-grow: 1; }
        .setting-item { margin-bottom: 20px; }
        .setting-item label { display: block; margin-bottom: 5px; font-weight: bold; font-size: 14px; }
        .setting-item input[type="text"], .setting-item input[type="number"] { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
        .setting-item .switch { position: relative; display: inline-block; width: 50px; height: 24px; }
        .setting-item .switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 24px; }
        .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
        input:checked + .slider { background-color: var(--theme-color); }
        input:checked + .slider:before { transform: translateX(26px); }

        .avatar-selector { display: grid; grid-template-columns: repeat(auto-fill, minmax(40px, 1fr)); gap: 10px; }
        .avatar-option { font-size: 24px; text-align: center; padding: 5px; border-radius: 50%; cursor: pointer; transition: background-color 0.2s; }
        .avatar-option.selected { background-color: var(--theme-color); color: white; }
        #save-settings { background-color: var(--theme-color); color: white; border: none; border-radius: 4px; padding: 10px; width: 100%; cursor: pointer; font-size: 16px; margin-top: auto; }
        #clear-messages { background-color: #6c757d; color: white; border: none; border-radius: 4px; padding: 10px; width: 100%; cursor: pointer; font-size: 16px; margin-top: 10px; }
        .settings-footer { padding: 20px; border-top: 1px solid var(--border-color); }

        @media (max-width: 768px) {
            .message { max-width: 90%; }
            .chat-header { padding: 10px 15px; }
            .side-panel { width: 280px; }
            .app-container.settings-open .main-content { transform: translateX(-280px); }
        }
    </style>
</head>
<body>
    <div class="app-container" id="app-container">
        <div class="main-content">
            <div class="chat-header">
                <span id="status">正在連線...</span>
                <div class="header-buttons">
                    <button id="toggle-settings" class="toggle-button" title="設定" type="button">⚙️</button>
                </div>
            </div>
            <div class="messages" id="messages"></div>
            <div class="input-area">
                <div class="typing-indicator" id="typing-indicator"></div>
                <div class="input-row">
                   <textarea id="message-input" placeholder="輸入訊息..." autocomplete="off" maxlength="2000" rows="1"></textarea>
                   <div class="input-actions">
                       <button id="emoji-toggle" title="表情" type="button">😀</button>
                       <button id="send-button" title="傳送" type="button">傳送</button>
                   </div>
                   <div class="emoji-picker" id="emoji-picker"></div>
                </div>
            </div>
        </div>
        <div class="side-panel settings-panel">
            <h3>個人與顯示設定</h3>
            <div class="settings-content">
                <div class="setting-item">
                    <label for="name-input">暱稱</label>
                    <input type="text" id="name-input" placeholder="設定你的暱稱" maxlength="24" autocomplete="nickname">
                </div>
                <div class="setting-item">
                    <label>頭像</label>
                    <div class="avatar-selector" id="avatar-selector"></div>
                </div>
                <hr>
                <div class="setting-item">
                    <label for="render-html-toggle">渲染富文本 (HTML/Markdown)</label>
                    <label class="switch">
                        <input type="checkbox" id="render-html-toggle">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="setting-item">
                    <label for="history-limit-input">載入歷史訊息數量</label>
                    <input type="number" id="history-limit-input" min="1" max="100" value="50">
                </div>
                <div class="setting-item">
                    <button id="clear-messages" type="button">清空目前聊天記錄</button>
                </div>
            </div>
            <div class="settings-footer">
                <button id="save-settings" type="button">儲存並加入聊天</button>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
    (function() {
        // --- UI Elements ---
        const ui = {
            appContainer: document.getElementById('app-container'),
            messagesDiv: document.getElementById('messages'),
            statusSpan: document.getElementById('status'),
            input: document.getElementById('message-input'),
            sendButton: document.getElementById('send-button'),
            nameInput: document.getElementById('name-input'),
            avatarSelector: document.getElementById('avatar-selector'),
            saveButton: document.getElementById('save-settings'),
            toggleSettingsButton: document.getElementById('toggle-settings'),
            emojiToggleButton: document.getElementById('emoji-toggle'),
            emojiPicker: document.getElementById('emoji-picker'),
            typingIndicator: document.getElementById('typing-indicator'),
            renderHtmlToggle: document.getElementById('render-html-toggle'),
            historyLimitInput: document.getElementById('history-limit-input'),
            clearMessagesButton: document.getElementById('clear-messages'),
        };

        // --- State ---
        let socket;
        let myIdentity = { id: '', name: '', avatar: '' };
        let clientSettings = { renderHtml: false, historyLimit: 50 };
        const avatars = ['😀', '😎', '🤖', '👻', '👽', '🧑‍🚀', '🦄', '🐼', '🦊', '🧙'];
        const emojis = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '🔥', '💯', '🤔', '😊', '🥳', '🤯', '🤣', '🙌', '✨'];
        const MAX_HISTORY_LIMIT = 100;
        const HEARTBEAT_INTERVAL_MS = 25000;
        let typingTimeout;
        let heartbeatTimer = null;
        const typingUsers = new Map();
        let reconnectAttempts = 0;
        let fullHistory = [];
        let richTextUnavailableNotified = false;
        let pageUnloaded = false;

        // --- Utilities ---
        function escapeHtml(unsafe) {
            if (typeof unsafe !== 'string') return '';
            return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        }

        function readStorage(key) {
            try {
                return localStorage.getItem(key);
            } catch (e) {
                return null;
            }
        }

        function writeStorage(key, value) {
            try {
                localStorage.setItem(key, value);
            } catch (e) {
                // 隱私模式或瀏覽器限制時忽略
            }
        }

        function clampHistoryLimit(value) {
            const parsed = parseInt(value, 10);
            if (!Number.isFinite(parsed)) return 50;
            return Math.min(MAX_HISTORY_LIMIT, Math.max(1, parsed));
        }

        // --- Initialization ---
        function initialize() {
            loadIdentity();
            loadClientSettings();
            populateAvatars();
            populateEmojis();
            connect();
            setupEventListeners();
            autoResizeTextarea();
        }

        function setupEventListeners() {
            ui.sendButton.addEventListener('click', sendMessage);
            ui.input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                } else {
                    sendTyping();
                }
            });
            ui.saveButton.addEventListener('click', saveAndIdentify);
            ui.toggleSettingsButton.addEventListener('click', () => ui.appContainer.classList.toggle('settings-open'));
            ui.emojiToggleButton.addEventListener('click', (e) => {
                e.stopPropagation();
                ui.emojiPicker.classList.toggle('visible');
            });
            document.addEventListener('click', (e) => {
                if (ui.emojiPicker && !ui.emojiPicker.contains(e.target) && e.target !== ui.emojiToggleButton) {
                    ui.emojiPicker.classList.remove('visible');
                }
            });
            ui.clearMessagesButton.addEventListener('click', () => {
                ui.messagesDiv.innerHTML = '';
                addSystemMessage('畫面已清空', 'info');
            });
            ui.messagesDiv.addEventListener('click', handleMessageClick);
            window.addEventListener('pagehide', () => {
                pageUnloaded = true;
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                if (socket) {
                    socket.onclose = null;
                    socket.close();
                }
            });
        }

        // --- Settings & Identity ---
        function loadIdentity() {
            myIdentity.id = readStorage('chat_id') || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
            writeStorage('chat_id', myIdentity.id);
            myIdentity.name = readStorage('chat_name') || '';
            myIdentity.avatar = readStorage('chat_avatar') || avatars[0];
            ui.nameInput.value = myIdentity.name;
        }

        function loadClientSettings() {
            let savedSettings = null;
            try {
                const raw = readStorage('chat_client_settings');
                savedSettings = raw ? JSON.parse(raw) : null;
            } catch (e) {
                savedSettings = null;
            }
            if (savedSettings && typeof savedSettings === 'object') {
                clientSettings.renderHtml = savedSettings.renderHtml === true;
                clientSettings.historyLimit = clampHistoryLimit(savedSettings.historyLimit);
            }
            ui.renderHtmlToggle.checked = clientSettings.renderHtml;
            ui.historyLimitInput.value = clientSettings.historyLimit;
        }

        function saveClientSettings() {
            const oldSettings = { ...clientSettings };
            clientSettings.renderHtml = ui.renderHtmlToggle.checked;
            clientSettings.historyLimit = clampHistoryLimit(ui.historyLimitInput.value);
            writeStorage('chat_client_settings', JSON.stringify(clientSettings));

            // 如果設定有變，重新渲染訊息
            if (oldSettings.renderHtml !== clientSettings.renderHtml || oldSettings.historyLimit !== clientSettings.historyLimit) {
                renderHistory();
            }
        }

        function populateAvatars() {
            ui.avatarSelector.innerHTML = '';
            avatars.forEach(avatar => {
                const option = document.createElement('div');
                option.classList.add('avatar-option');
                option.textContent = avatar;
                if (avatar === myIdentity.avatar) option.classList.add('selected');
                option.addEventListener('click', (e) => {
                    const previous = ui.avatarSelector.querySelector('.selected');
                    if (previous) previous.classList.remove('selected');
                    e.currentTarget.classList.add('selected');
                });
                ui.avatarSelector.appendChild(option);
            });
            if (!ui.avatarSelector.querySelector('.selected') && avatars.length > 0) {
                ui.avatarSelector.firstElementChild.classList.add('selected');
            }
        }

        function populateEmojis() {
            emojis.forEach(emoji => {
                const span = document.createElement('span');
                span.textContent = emoji;
                span.addEventListener('click', () => {
                    ui.input.value += emoji;
                    ui.input.focus();
                    autoResizeTextarea();
                });
                ui.emojiPicker.appendChild(span);
            });
        }

        function saveAndIdentify() {
            const name = ui.nameInput.value.trim();
            if (!name) {
                addSystemMessage('請先設定暱稱！', 'error');
                return;
            }
            const selected = ui.avatarSelector.querySelector('.selected');
            myIdentity.name = name.slice(0, 24);
            myIdentity.avatar = selected ? selected.textContent : avatars[0];
            writeStorage('chat_name', myIdentity.name);
            writeStorage('chat_avatar', myIdentity.avatar);

            saveClientSettings();

            if (socket && socket.readyState === WebSocket.OPEN) {
                sendIdentity();
            }
            ui.appContainer.classList.remove('settings-open');
            addSystemMessage('設定已儲存。', 'info');
        }

        // --- WebSocket Logic ---
        function connect() {
            if (pageUnloaded) return;
            const protocol = window.location.protocol === "https:" ? "wss" : "ws";
            const wsUrl = protocol + '://' + window.location.host + '/';
            socket = new WebSocket(wsUrl);
            socket.onopen = onSocketOpen;
            socket.onmessage = onSocketMessage;
            socket.onclose = onSocketClose;
            socket.onerror = onSocketError;
        }

        function onSocketOpen() {
            reconnectAttempts = 0;
            sendIdentity();
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(() => {
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'ping' }));
                }
            }, HEARTBEAT_INTERVAL_MS);
        }

        function sendIdentity() {
            if (socket && socket.readyState === WebSocket.OPEN && myIdentity.name) {
                socket.send(JSON.stringify({ type: 'identity', name: myIdentity.name, avatar: myIdentity.avatar }));
            }
        }

        function onSocketMessage(event) {
            try {
                const data = JSON.parse(event.data);
                switch (data.type) {
                    case 'info':
                    case 'error':
                        addSystemMessage(data.message, data.type);
                        break;
                    case 'status':
                        updateStatus(data.online, data.remaining);
                        break;
                    case 'history':
                        fullHistory = Array.isArray(data.messages) ? data.messages : [];
                        renderHistory();
                        break;
                    case 'message':
                        fullHistory.push(data);
                        while (fullHistory.length > MAX_HISTORY_LIMIT) fullHistory.shift();
                        addMessage(data);
                        break;
                    case 'identity':
                        myIdentity = { id: data.id, name: data.name, avatar: data.avatar };
                        break;
                    case 'typing':
                        if (data.id !== myIdentity.id) {
                            updateTypingIndicator(data.name, true);
                        }
                        break;
                    case 'pong':
                        reconnectAttempts = 0;
                        break;
                    case 'retract': {
                        const msgIndex = fullHistory.findIndex(m => m.messageId === data.messageId);
                        if (msgIndex > -1) {
                            fullHistory[msgIndex].text = "此訊息已被撤回";
                            fullHistory[msgIndex].isRetracted = true;
                        }
                        retractMessageOnScreen(data.messageId);
                        break;
                    }
                }
                scrollToBottom();
            } catch (e) {
                console.error('解析訊息時發生錯誤:', e);
            }
        }

        function onSocketClose() {
            if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
            if (pageUnloaded) return;
            reconnectAttempts++;
            const delay = Math.min(30000, (Math.pow(2, reconnectAttempts) * 1000));
            const jitter = delay * 0.2 * Math.random();
            const reconnectDelay = delay + jitter;
            addSystemMessage('連線已中斷，將在 ' + Math.round(reconnectDelay / 1000) + ' 秒後嘗試重新連線...', 'error');
            setTimeout(connect, reconnectDelay);
        }

        function onSocketError(error) {
            console.error('WebSocket 錯誤:', error);
            addSystemMessage('連線發生錯誤。', 'error');
        }

        // --- UI Rendering & Actions ---
        function renderRichText(raw) {
            if (typeof window.marked === 'undefined' || typeof window.DOMPurify === 'undefined') {
                if (!richTextUnavailableNotified) {
                    richTextUnavailableNotified = true;
                    addSystemMessage('富文本元件載入失敗，已改用純文字顯示。', 'error');
                }
                return null;
            }
            try {
                const html = window.marked.parse(raw, { breaks: true });
                return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
            } catch (e) {
                console.error('渲染富文本時發生錯誤:', e);
                return null;
            }
        }

        function renderHistory() {
            ui.messagesDiv.innerHTML = '';
            const limitedHistory = fullHistory.slice(-clientSettings.historyLimit);
            limitedHistory.forEach(msg => addMessage(msg));
        }

        function findMessageElement(messageId) {
            const nodes = ui.messagesDiv.querySelectorAll('[data-message-id]');
            for (const node of nodes) {
                if (node.dataset.messageId === messageId) return node;
            }
            return null;
        }

        function addMessage(msg) {
            if (!msg || typeof msg !== 'object') return;
            const isMine = msg.id === myIdentity.id;
            const msgEl = document.createElement('div');
            msgEl.className = 'message ' + (isMine ? 'mine' : 'theirs');
            msgEl.dataset.messageId = typeof msg.messageId === 'string' ? msg.messageId : '';

            const text = typeof msg.text === 'string' ? msg.text : '';
            let textContent;
            if (msg.isRetracted) {
                msgEl.classList.add('retracted');
                textContent = escapeHtml(text);
            } else if (clientSettings.renderHtml) {
                const rich = renderRichText(text);
                textContent = rich !== null ? rich : escapeHtml(text).replace(/\n/g, '<br>');
            } else {
                textContent = escapeHtml(text).replace(/\n/g, '<br>');
            }

            const textDiv = document.createElement('div');
            textDiv.className = 'text';
            textDiv.innerHTML = textContent;

            if (!msg.isRetracted && text.length > 200) {
                textDiv.classList.add('collapsible');
            }

            const canRetract = isMine && !msg.isRetracted && (Date.now() - msg.timestamp < 120000);

            const metaEl = document.createElement('div');
            metaEl.className = 'meta';
            metaEl.textContent = (typeof msg.name === 'string' ? msg.name : '') + ' - ' + new Date(msg.timestamp).toLocaleTimeString();

            const avatarEl = document.createElement('div');
            avatarEl.className = 'avatar';
            avatarEl.textContent = typeof msg.avatar === 'string' ? msg.avatar : '';

            const contentDiv = document.createElement('div');
            contentDiv.className = 'content';
            contentDiv.appendChild(metaEl);
            contentDiv.appendChild(textDiv);

            msgEl.appendChild(avatarEl);
            msgEl.appendChild(contentDiv);

            if (canRetract) {
                const retractBtn = document.createElement('span');
                retractBtn.className = 'retract-btn';
                retractBtn.title = '撤回';
                retractBtn.textContent = '↶';
                msgEl.appendChild(retractBtn);
            }

            ui.messagesDiv.appendChild(msgEl);
        }

        function retractMessageOnScreen(messageId) {
            const msgEl = findMessageElement(messageId);
            if (msgEl) {
                const textEl = msgEl.querySelector('.text');
                if (textEl) {
                    textEl.textContent = '此訊息已被撤回';
                    textEl.className = 'text';
                }
                msgEl.classList.add('retracted');
                const retractBtn = msgEl.querySelector('.retract-btn');
                if (retractBtn) retractBtn.remove();
            }
        }

        function addSystemMessage(text, type) {
            const msgEl = document.createElement('div');
            msgEl.className = 'message ' + type;
            msgEl.textContent = escapeHtml(text);
            ui.messagesDiv.appendChild(msgEl);
        }

        function updateStatus(online, remaining) {
            const onlineCount = Number.isFinite(Number(online)) ? Number(online) : 0;
            const remainingCount = Number.isFinite(Number(remaining)) ? Math.max(0, Number(remaining)) : 0;
            ui.statusSpan.textContent = '在線: ' + onlineCount + ' 人 | 今日剩餘訊息: ' + remainingCount.toLocaleString();
        }

        function sendMessage() {
            const text = ui.input.value.trim();
            if (socket && socket.readyState === WebSocket.OPEN && text !== '') {
                if (!myIdentity.name) {
                    addSystemMessage('請先在設定中設定暱稱！', 'error');
                    ui.appContainer.classList.add('settings-open');
                    return;
                }
                socket.send(JSON.stringify({ type: 'chat', text: text }));
                ui.input.value = '';
                autoResizeTextarea();
            }
        }

        function sendTyping() {
            if (socket && socket.readyState === WebSocket.OPEN && !typingTimeout) {
                socket.send(JSON.stringify({ type: 'typing' }));
                typingTimeout = setTimeout(() => { typingTimeout = null; }, 2000);
            }
        }

        function updateTypingIndicator(name, isTyping) {
            const safeName = typeof name === 'string' ? name.slice(0, 24) : '';
            if (!safeName) return;
            if (isTyping) {
                typingUsers.set(safeName, Date.now());
            } else {
                typingUsers.delete(safeName);
            }

            const now = Date.now();
            for (const [userName, lastTyped] of typingUsers.entries()) {
                if (now - lastTyped > 3000) {
                    typingUsers.delete(userName);
                }
            }

            const names = Array.from(typingUsers.keys());
            if (names.length === 0) {
                ui.typingIndicator.textContent = '';
            } else if (names.length === 1) {
                ui.typingIndicator.textContent = names[0] + ' 正在輸入...';
            } else if (names.length === 2) {
                ui.typingIndicator.textContent = names.join(' 與 ') + ' 正在輸入...';
            } else {
                ui.typingIndicator.textContent = '多人正在輸入...';
            }
        }

        function handleMessageClick(event) {
            const textEl = event.target.closest('.text.collapsible');
            if (textEl) {
                textEl.classList.remove('collapsible');
                textEl.classList.add('expanded');
                return;
            }
            const retractBtn = event.target.closest('.retract-btn');
            if (retractBtn) {
                const messageEl = retractBtn.closest('.message');
                const messageId = messageEl ? messageEl.dataset.messageId : '';
                if (!messageId) return;
                if (confirm('確定要撤回這則訊息嗎？')) {
                    socket.send(JSON.stringify({ type: 'retract', messageId: messageId }));
                }
            }
        }

        function scrollToBottom() {
            // Only scroll if user is near the bottom
            const shouldScroll = ui.messagesDiv.scrollTop + ui.messagesDiv.clientHeight >= ui.messagesDiv.scrollHeight - 100;
            if(shouldScroll) {
                ui.messagesDiv.scrollTop = ui.messagesDiv.scrollHeight;
            }
        }

        function autoResizeTextarea() {
            ui.input.style.height = 'auto';
            const scrollHeight = ui.input.scrollHeight;
            ui.input.style.height = scrollHeight + 'px';
        }
        ui.input.addEventListener('input', autoResizeTextarea);

        // --- Start the application ---
        document.addEventListener('DOMContentLoaded', initialize);
    })();
    </script>
</body>
</html>
`;
export {
  ChatRoom,
  src_default as default
};
