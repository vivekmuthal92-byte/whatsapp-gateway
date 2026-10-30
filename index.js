const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const app = express();

const AUTH_ROOT = process.env.AUTH_DIR || "./auth_info";
const PORTAL_WEBHOOK_URL = process.env.PORTAL_WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET || "";
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || ""; // पर्यायी
const MAX_RETRIES = 3;

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e && e.message));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e && e.message));

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ||
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key, x-auth-token, x-showroom-id"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "1mb" }));

// पर्यायी: GATEWAY_API_KEY सेट केली असेल तरच चालते
app.use((req, res, next) => {
  if (!GATEWAY_API_KEY) return next();
  if (req.path === "/" || req.path === "/health") return next();
  const k = req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (k === GATEWAY_API_KEY) return next();
  return res.status(401).json({ success: false, error: "Unauthorized" });
});

// ---------- शोरूमनुसार वेगळी सत्रे ----------
const sessions = new Map();

function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{3,40}$/.test(id);
}

function getShowroomId(req) {
  return String(
    req.params.id ||
      req.headers["x-showroom-id"] ||
      req.query.showroomId ||
      (req.body && req.body.showroomId) ||
      ""
  ).trim();
}

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id, sock: null, qr: null, connected: false, connecting: false,
      retries: 0, phone: null, error: null, stopped: false,
    });
  }
  return sessions.get(id);
}

function clearAuth(id) {
  if (!validId(id)) return;
  const dir = path.join(AUTH_ROOT, id);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.error(`[${id}] clearAuth error:`, e.message);
  }
}

function statusOf(id) {
  const s = id ? sessions.get(id) : null;
  const connected = !!(s && s.connected);
  const qr = s && !connected ? s.qr : null;
  const status = connected
    ? "connected"
    : qr
    ? "qr"
    : s && s.connecting
    ? "connecting"
    : "disconnected";
  return {
    success: true,
    showroomId: id || null,
    status,
    connected,
    isConnected: connected,
    qr,
    qrCode: qr,
    phone: connected && s.phone ? s.phone : null,
    error: s && s.error ? s.error : null,
  };
}

async function forwardIncoming(id, m) {
  try {
    if (!m.message || m.key.fromMe) return;
    const jid = m.key.remoteJid || "";
    if (jid.endsWith("@g.us") || jid === "status@broadcast") return;
    const text =
      m.message.conversation ||
      (m.message.extendedTextMessage && m.message.extendedTextMessage.text) ||
      (m.message.imageMessage && m.message.imageMessage.caption) ||
      "";
    if (!text) return;
    if (!PORTAL_WEBHOOK_URL || !WEBHOOK_SECRET) {
      console.log(`[${id}] Webhook env missing (PORTAL_WEBHOOK_URL / WHATSAPP_WEBHOOK_SECRET)`);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(PORTAL_WEBHOOK_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${WEBHOOK_SECRET}` },
      body: JSON.stringify({
        showroomId: id, // हे सत्राच्या नावावरून ठरतं, मेसेजमधून नाही
        from: jid.split("@")[0],
        jid,
        isLid: jid.endsWith("@lid"),
        text,
        name: m.pushName || "",
        messageId: m.key.id,
        timestamp: Number(m.messageTimestamp) || Math.floor(Date.now() / 1000),
      }),
    });
    clearTimeout(t);
    console.log(`[${id}] Incoming forwarded, status:`, resp.status);
  } catch (e) {
    console.error(`[${id}] forward error:`, e.message);
  }
}

async function startWhatsApp(id) {
  if (!validId(id)) return;
  const s = getSession(id);
  if (s.connecting || s.connected) return;
  s.connecting = true;
  s.stopped = false;
  s.error = null;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_ROOT, id));
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (e) {
      version = undefined;
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: pino({ level: "silent" }),
      browser: ["Vihaan Automation", "Chrome", "1.0.0"],
    });
    s.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      if (s.sock !== sock) return; // जुना socket दुर्लक्षित
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        s.qr = await QRCode.toDataURL(qr);
        s.connected = false;
      }

      if (connection === "open") {
        s.connected = true;
        s.connecting = false;
        s.qr = null;
        s.retries = 0;
        s.error = null;
        s.phone = sock.user && sock.user.id ? sock.user.id.split(":")[0].split("@")[0] : null;
        console.log(`[${id}] WhatsApp Connected Successfully!`);
      }

      if (connection === "close") {
        s.connected = false;
        s.connecting = false;
        s.qr = null;
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode
          : undefined;
        console.log(`[${id}] WA connection closed. statusCode:`, code);
        if (s.stopped) return;

        if (code === DisconnectReason.loggedOut) {
          clearAuth(id);
          s.error = "logged_out";
          return;
        }
        if (s.retries < MAX_RETRIES) {
          s.retries += 1;
          setTimeout(() => startWhatsApp(id), 3000 * s.retries);
        } else {
          s.error = "connect_failed_" + (code || "unknown");
          console.log(`[${id}] Retries exhausted:`, s.error);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) await forwardIncoming(id, m);
    });
  } catch (err) {
    console.error(`[${id}] WhatsApp Error:`, err.message);
    s.connecting = false;
    s.error = err.message;
  }
}

async function disconnectSession(id) {
  const s = getSession(id);
  s.stopped = true;
  try { if (s.sock) await s.sock.logout(); } catch (e) {}
  try { if (s.sock && s.sock.end) s.sock.end(undefined); } catch (e) {}
  s.sock = null;
  s.connected = false;
  s.connecting = false;
  s.qr = null;
  s.phone = null;
  s.retries = 0;
  s.error = null;
  clearAuth(id);
}

// ---------- रूट्स ----------
app.get("/", (req, res) => res.send("WhatsApp Gateway Server is Live!"));
app.get("/health", (req, res) => {
  let connected = 0;
  sessions.forEach((s) => { if (s.connected) connected++; });
  res.json({ ok: true, sessions: sessions.size, connected });
});

const handleStatus = (req, res) => {
  const id = getShowroomId(req);
  res.json(statusOf(validId(id) ? id : null));
};
app.get("/session/status", handleStatus);
app.get("/session/status/:id", handleStatus);
app.get("/status", handleStatus);
app.get("/status/:id", handleStatus);

const handleConnect = async (req, res) => {
  const id = getShowroomId(req);
  if (!validId(id)) {
    return res.status(200).json({ success: false, error: "Valid showroomId required" });
  }
  const s = getSession(id);
  if (!s.connected && !s.qr && !s.connecting) {
    s.retries = 0;
    await startWhatsApp(id);
    await new Promise((r) => setTimeout(r, 2500));
  }
  res.json(statusOf(id));
};
app.all("/session/connect", handleConnect);
app.all("/session/connect/:id", handleConnect);
app.all("/connect", handleConnect);
app.all("/connect/:id", handleConnect);

const handleDisconnect = async (req, res) => {
  const id = getShowroomId(req);
  if (!validId(id)) {
    return res.status(200).json({ success: false, error: "Valid showroomId required" });
  }
  console.log(`[${id}] DISCONNECT called:`, req.method, req.originalUrl);
  await disconnectSession(id);
  res.json({ success: true, showroomId: id, status: "disconnected", connected: false });
};
app.all("/session/disconnect", handleDisconnect);
app.all("/session/disconnect/:id", handleDisconnect);

const handleSendMessage = async (req, res) => {
  try {
    const id = getShowroomId(req);
    if (!validId(id)) {
      return res.status(200).json({ success: false, error: "Valid showroomId required" });
    }
    const s = sessions.get(id);
    if (!s || !s.connected || !s.sock) {
      return res.status(200).json({
        success: false,
        error: "WhatsApp session is NOT CONNECTED. Reconnect your WhatsApp session before transmitting messages.",
      });
    }
    const { phone, number, to, jid: bodyJid, message, text, imageUrl, caption } = req.body || {};
    const msgText = message || text || caption || "";

    let jid = bodyJid;
    if (!jid) {
      const rawNumber = phone || number || to;
      if (!rawNumber) {
        return res.status(200).json({ success: false, error: "Phone number (or jid) is required" });
      }
      let clean = String(rawNumber).replace(/\D/g, "");
      if (clean.length === 10) clean = "91" + clean;
      jid = `${clean}@s.whatsapp.net`;
    }

    if (imageUrl) {
      await s.sock.sendMessage(jid, { image: { url: imageUrl }, caption: msgText });
    } else {
      if (!msgText) {
        return res.status(200).json({ success: false, error: "Message is required" });
      }
      await s.sock.sendMessage(jid, { text: msgText });
    }
    res.json({ success: true, message: "Message sent successfully" });
  } catch (err) {
    res.status(200).json({ success: false, error: err.message });
  }
};
app.post("/send-message", handleSendMessage);
app.post("/session/send", handleSendMessage);
app.post("/session/send/:id", handleSendMessage);
app.post("/api/send", handleSendMessage);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`WhatsApp Gateway Server listening on port ${PORT}`);
  // restart वर विद्यमान सत्रे पुन्हा सुरू कर (फाइल टिकली असेल तर)
  try {
    if (fs.existsSync(AUTH_ROOT)) {
      const dirs = fs.readdirSync(AUTH_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && validId(d.name))
        .map((d) => d.name);
      dirs.forEach((id, i) => setTimeout(() => startWhatsApp(id), 2000 * (i + 1)));
    }
  } catch (e) {
    console.error("restore error:", e.message);
  }
});
