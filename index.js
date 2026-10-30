 const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  proto,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const app = express();

const AUTH_ROOT = process.env.AUTH_DIR || "./auth_info";
const PORTAL_WEBHOOK_URL = process.env.PORTAL_WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET || "";
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || ""; // पर्यायी
const MAX_RETRIES = 3;

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e && e.message));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e && e.message));

// ---------- Firebase (सत्रे Firestore मध्ये साठवली जातात) ----------
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
