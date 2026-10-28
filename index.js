const express = require("express");
const cors = require("cors");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || "a8f9c2d1e4b70365f8a1d2e3c4b59870";

let sock = null;
let currentQr = null;
let connectionStatus = "disconnected";

// ऑथेंटिकेशन मिडलवेअर
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "Unauthorized: Missing Token" });
  }
  const token = authHeader.split(" ")[1];
  if (token !== API_TOKEN) {
    return res.status(403).json({ success: false, error: "Forbidden: Invalid Token" });
  }
  next();
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        currentQr = await QRCode.toDataURL(qr);
        connectionStatus = "scan_qr";
      } catch (err) {
        console.error("QR Code generation error:", err);
      }
    }

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      connectionStatus = "disconnected";
      currentQr = null;
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === "open") {
      connectionStatus = "connected";
      currentQr = null;
      console.log("WhatsApp Connection Opened Successfully!");
    }
  });
}

// १. हेल्थ चेक एंडपॉईंट
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// २. सेशन स्टेटस तपासणे
app.get("/session/status", authMiddleware, (req, res) => {
  res.json({
    connected: connectionStatus === "connected",
    status: connectionStatus,
    qr: currentQr
  });
});

// ३. नवीन कनेक्शन किंवा QR कोड जनरेट करणे
app.post("/session/connect", authMiddleware, async (req, res) => {
  if (connectionStatus === "connected") {
    return res.json({ connected: true, status: "connected" });
  }
  if (!sock) {
    await connectToWhatsApp();
  }
  res.json({
    connected: connectionStatus === "connected",
    status: connectionStatus,
    qr: currentQr
  });
});

// ४. मेसेज पाठवणे (शोरूम नोटिफिकेशन्स)
app.post("/message/send", authMiddleware, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ success: false, error: "Phone and message are required" });
  }

  if (connectionStatus !== "connected" || !sock) {
    return res.status(503).json({ success: false, error: "WhatsApp is not connected" });
  }

  try {
    const formattedPhone = phone.replace(/[^0-9]/g, "");
    const jid = `${formattedPhone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, message: "Sent successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp Gateway Server listening on port ${PORT}`);
});
