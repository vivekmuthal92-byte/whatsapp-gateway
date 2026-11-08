const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");

// ---------- सेटिंग्ज (Render Environment मधून बदलता येतात) ----------
const MAX_AI_REPLIES_PER_DAY = Number(process.env.MAX_AI_REPLIES_PER_DAY || 40);
const ATTEMPT_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 7000);
const HANDOFF_REPLY = process.env.HANDOFF_REPLY || "ठीक आहे, आमचा प्रतिनिधी लवकरच तुम्हाला संपर्क करेल.";
// ग्राहकाला माणसाशी बोलायचं असल्याचे शब्द
const HUMAN_RE = /(\bcall\b|कॉल|फोन करा|फोन कर|\bmanager\b|मॅनेजर|मालक|\bowner\b|तक्रार|complaint|\bhuman\b|माणसाशी|बोलायचं|बोलायचे|बोलायचंय|speak to|talk to)/i;

const dailyCounts = new Map();
function overDailyCap(convId) {
  const day = new Date().toISOString().slice(0, 10);
  const e = dailyCounts.get(convId);
  if (!e || e.day !== day) {
    dailyCounts.set(convId, { day, count: 0 });
    return false;
  }
  return e.count >= MAX_AI_REPLIES_PER_DAY;
}
function bumpDaily(convId) {
  const e = dailyCounts.get(convId);
  if (e) e.count += 1;
}

// 10 अंकी भारतीय फोन नंबर स्वच्छ करणे (91 वगळणे)
function extractLast10Digits(raw) {
  const withoutDomain = String(raw || "").trim().replace(/@.*$/, "");
  const digits = withoutDomain.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

// ===================================================================
// भाग १: येणारा मेसेज साठवणे (लगेच, AI शिवाय)
// ===================================================================
async function saveIncoming(db, showroomId, from, jid, isLid, text, name, opts) {
  const kind = (opts && opts.type) || "text";
  const nowIso = new Date().toISOString();
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const isLidMode = Boolean(
    isLid === true || String(jid || "").endsWith("@lid") || String(from || "").endsWith("@lid")
  );
  const normalizedPhone10 = isLidMode ? "" : extractLast10Digits(from);
  const resolvedTargetJid = isLidMode
    ? jid || from
    : jid || (normalizedPhone10 ? `91${normalizedPhone10}@s.whatsapp.net` : from);
  const canonicalCustomerId = isLidMode ? resolvedTargetJid : normalizedPhone10 || from;
  const customerName = name && name.trim() ? name.trim() : canonicalCustomerId;

  // विद्यमान Lead शोधणे
  const leadsRef = db.collection("showrooms").doc(showroomId).collection("leads");
  const leadsSnap = await leadsRef.get();
  let matchedLeadId = null;
  let matchedLeadData = null;
  leadsSnap.forEach((docSnap) => {
    if (matchedLeadId) return;
    const d = docSnap.data() || {};
    const dJid = String(d.jid || "").trim();
    const dPhone = String(d.phone || d.customerPhone || "").trim();
    if (isLidMode) {
      if (resolvedTargetJid && (dJid === resolvedTargetJid || dPhone === resolvedTargetJid || docSnap.id === resolvedTargetJid)) {
        matchedLeadId = docSnap.id;
        matchedLeadData = d;
      }
    } else {
      const dPhone10 = extractLast10Digits(dPhone);
      if (normalizedPhone10 && dPhone10 && dPhone10 === normalizedPhone10) {
        matchedLeadId = docSnap.id;
        matchedLeadData = d;
      }
    }
  });

  // Lead नसेल तर नवीन Lead
  let resolvedLeadId = matchedLeadId;
  if (!resolvedLeadId) {
    resolvedLeadId = `LEAD-${showroomId}-${Date.now().toString().slice(-5)}`;
    await leadsRef.doc(resolvedLeadId).set(
      {
        leadId: resolvedLeadId,
        showroomId,
        name: customerName,
        phone: canonicalCustomerId,
        customerPhone: canonicalCustomerId,
        customerId: canonicalCustomerId,
        jid: resolvedTargetJid,
        isLid: isLidMode,
        email: "",
        aadhaarPan: "NOT_PROVIDED",
        budgetINR: "₹1,00,000",
        interest: "WhatsApp Inquiry",
        preferredCategory: "two_wheeler",
        interestedModels: ["WhatsApp Inquiry"],
        leadSource: "WhatsApp",
        assignedStaff: "Sales Advisor",
        assignedAdvisor: "Sales Advisor",
        followUpDate: new Date(Date.now() + 86400000).toISOString(),
        notes: `Auto-created from incoming WhatsApp message: "${text}"`,
        stage: "New Lead",
        purchaseStatus: "Undecided",
        status: "New Lead",
        quotationIds: [],
        exchange: null,
        documents: [],
        schedules: [],
        activities: [
          {
            id: `ACT-${Date.now()}`,
            timestamp: nowIso,
            type: "note",
            description: `Incoming WhatsApp message: "${text}"`,
            authorRole: "sales",
            authorName: customerName,
          },
        ],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      { merge: true }
    );
  }

  // Conversation शोधणे / बनवणे
  const convsRef = db.collection("showrooms").doc(showroomId).collection("conversations");
  const convsSnap = await convsRef.get();
  let matchedConvId = null;
  convsSnap.forEach((docSnap) => {
    if (matchedConvId) return;
    const d = docSnap.data() || {};
    const dPhone = String(d.customerPhone || d.from || "").trim();
    const dJid = String(d.jid || "").trim();
    const dLeadId = String(d.leadId || "").trim();
    if (isLidMode) {
      if (resolvedTargetJid && (dJid === resolvedTargetJid || dPhone === resolvedTargetJid)) matchedConvId = docSnap.id;
    } else if (normalizedPhone10 && extractLast10Digits(dPhone) === normalizedPhone10) {
      matchedConvId = docSnap.id;
    }
    if (resolvedLeadId && (dLeadId === resolvedLeadId || docSnap.id === `conv_${showroomId}_${resolvedLeadId}`)) {
      matchedConvId = docSnap.id;
    }
  });

  const conversationId = matchedConvId || `conv_${showroomId}_${resolvedLeadId}`;
  const convRef = convsRef.doc(conversationId);
  const convDocSnap = await convRef.get();
  const existingConv = convDocSnap.exists ? convDocSnap.data() || {} : {};
  const currentUnread = Number(existingConv.unreadCount || 0);

  await convRef.set(
    {
      id: conversationId,
      showroomId,
      from: canonicalCustomerId,
      jid: resolvedTargetJid,
      isLid: isLidMode,
      customerId: canonicalCustomerId,
      leadId: resolvedLeadId,
      leadStage: (matchedLeadData && matchedLeadData.stage) || "New Lead",
      customerName,
      customerPhone: canonicalCustomerId,
      status: "open",
      unreadCount: currentUnread + 1,
      lastMessage: text,
      lastMessageText: text,
      lastMessageAt: nowIso,
      lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: nowIso,
      createdAt: existingConv.createdAt || nowIso,
    },
    { merge: true }
  );

  await convRef.collection("messages").doc(messageId).set(
    {
      id: messageId,
      messageId,
      conversationId,
      showroomId,
      direction: "incoming",
      text,
      content: text,
      status: "delivered",
      sender: "customer",
      senderName: customerName,
      from: canonicalCustomerId,
      customerPhone: canonicalCustomerId,
      customerName,
      jid: resolvedTargetJid,
      isLid: isLidMode,
      customerId: canonicalCustomerId,
      leadId: resolvedLeadId,
      type: kind,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: nowIso,
    },
    { merge: true }
  );

  console.log(`[Firestore Saved] Incoming: showrooms/${showroomId}/conversations/${conversationId}/messages/${messageId}`);

  return {
    showroomId,
    conversationId,
    convRef,
    leadId: resolvedLeadId,
    messageId,
    customerName,
    canonicalCustomerId,
    resolvedTargetJid,
    isLidMode,
  };
}

// जाणारा मेसेज साठवणे (AI किंवा तयार संदेश)
async function storeOutgoing(ctx, text, sender, senderName) {
  const id = `msg_ai_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  await ctx.convRef.collection("messages").doc(id).set(
    {
      id,
      messageId: id,
      conversationId: ctx.conversationId,
      showroomId: ctx.showroomId,
      direction: "outgoing",
      text,
      content: text,
      status: "sent",
      sender,
      senderName,
      from: ctx.canonicalCustomerId,
      customerPhone: ctx.canonicalCustomerId,
      customerName: ctx.customerName,
      jid: ctx.resolvedTargetJid,
      isLid: ctx.isLidMode,
      customerId: ctx.canonicalCustomerId,
      leadId: ctx.leadId,
      type: "text",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: new Date().toISOString(),
    },
    { merge: true }
  );
  await ctx.convRef.set(
    {
      lastMessage: text,
      lastMessageText: text,
      lastMessageAt: new Date().toISOString(),
      lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      replyStatus: "replied",
      suggestedReply: null,
    },
    { merge: true }
  );
}

// ===================================================================
// ग्राहकाची माहिती (नाव, मॉडेल, बजेट) संभाषणातून लीडमध्ये भरणे
// ===================================================================
async function captureLead(db, ctx, ai, model, historyText, combinedText) {
  try {
    const prompt = `खालील WhatsApp संभाषणातून फक्त ग्राहकाने स्पष्टपणे सांगितलेली माहिती काढ. अंदाज लावू नकोस. नमस्कार किंवा Hi म्हणजे नाव नाही. माहिती नसेल तर रिकामी स्ट्रिंग "" दे.
फक्त JSON दे: {"name":"","interestedModel":"","budget":""}

${historyText ? historyText + "\n" : ""}ग्राहक: ${combinedText}`;
    const res = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
    const raw = String(res.text || "").replace(/```json|```/g, "").trim();
    const x = JSON.parse(raw);
    const name = String(x.name || "").trim();
    const mdl = String(x.interestedModel || "").trim();
    const budget = String(x.budget || "").trim();
    if (!name && !mdl && !budget) return;

    const leadRef = db.collection("showrooms").doc(ctx.showroomId).collection("leads").doc(ctx.leadId);
    const cur = ((await leadRef.get()).data()) || {};
    const upd = {};
    let nameUpdated = false;
    if (name && (!cur.name || cur.name === cur.phone || cur.name === ctx.canonicalCustomerId || cur.nameFromChat)) {
      upd.name = name;
      upd.nameFromChat = true;
      nameUpdated = true;
    }
    if (mdl) {
      if (!cur.interest || cur.interest === "WhatsApp Inquiry" || cur.interestFromChat) {
        upd.interest = mdl;
        upd.interestFromChat = true;
      }
      upd.interestedModels = admin.firestore.FieldValue.arrayUnion(mdl);
    }
    if (budget && (!cur.budgetINR || cur.budgetINR === "₹1,00,000" || cur.budgetFromChat)) {
      upd.budgetINR = budget;
      upd.budgetFromChat = true;
    }
    if (Object.keys(upd).length === 0) return;
    upd.updatedAt = new Date().toISOString();
    await leadRef.set(upd, { merge: true });
    if (nameUpdated) await ctx.convRef.set({ customerName: name }, { merge: true });
    console.log(`[LeadCapture] ${ctx.leadId}:`, JSON.stringify({ name, model: mdl, budget }));
  } catch (e) {
    console.error("[LeadCapture]", e.message);
  }
}

// ===================================================================
// भाग २: AI रिप्लाय (बॅचमधील सर्व मेसेज एकत्र वाचून एकच उत्तर)
// ===================================================================
async function generateReply(db, ctx, combinedText, excludeIds, sendReply, onThinking) {
  const T0 = Date.now();
  const showroomId = ctx.showroomId;
  const exclude = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);

  const aiPromise = Promise.all([
    db.collection("showrooms").doc(showroomId).collection("aiSettings").doc("config").get(),
    db.collection("showrooms").doc(showroomId).get(),
    db.collection("showrooms").doc(showroomId).collection("vehicles").get(),
    ctx.convRef.get(),
  ]);
  aiPromise.catch(() => {});
  const [aiSnap, showroomSnap, vehiclesSnap, convNowSnap] = await aiPromise;

  const aiConfig = aiSnap.exists ? aiSnap.data() : {};
  const showroomData = showroomSnap.exists ? showroomSnap.data() : {};
  const convNow = convNowSnap.exists ? convNowSnap.data() || {} : {};

  const effectiveMode = String(aiConfig.mode || aiConfig.aiMode || showroomData.aiMode || "C_CONTROLLED_AUTOMATION").trim();
  const isAutomationPaused = Boolean(aiConfig.isAutomationPaused === true);
  const humanTakeover = Boolean(convNow.humanTakeoverActive === true);
  const isModeC =
    (effectiveMode === "C_CONTROLLED_AUTOMATION" || effectiveMode === "auto-reply" || effectiveMode === "auto") &&
    !isAutomationPaused &&
    !humanTakeover;

  let replyText = null;
  let replySent = false;
  const deliver = async (txt) => {
    if (sendReply) {
      try {
        await sendReply(txt);
        replySent = true;
      } catch (e) {
        console.error("[sendReply]", e.message);
      }
    }
  };

  if (!isModeC) {
    await ctx.convRef.set({ replyStatus: "pending", pendingReplyNote: "उत्तर देणे बाकी" }, { merge: true });
    return { success: true, conversationId: ctx.conversationId, leadId: ctx.leadId, replyText: null, replySent: false };
  }

  // रोजची मर्यादा
  if (overDailyCap(ctx.conversationId)) {
    console.log(`[AI] daily cap reached for ${ctx.conversationId}`);
    await ctx.convRef.set({ needsHuman: true, needsHumanAt: new Date().toISOString() }, { merge: true });
    return { success: true, conversationId: ctx.conversationId, leadId: ctx.leadId, replyText: null, replySent: false };
  }

  // माणसाशी बोलायचंय?
  if (HUMAN_RE.test(combinedText)) {
    replyText = HANDOFF_REPLY;
    await deliver(replyText);
    await storeOutgoing(ctx, replyText, "ai_bot", "Auto-reply");
    await ctx.convRef.set({ needsHuman: true, needsHumanAt: new Date().toISOString() }, { merge: true });
    bumpDaily(ctx.conversationId);
    console.log(`[timing] handoff total=${Date.now() - T0}ms`);
    return { success: true, conversationId: ctx.conversationId, leadId: ctx.leadId, replyText, replySent };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("[Gemini] GEMINI_API_KEY missing in Render environment");
    return { success: true, conversationId: ctx.conversationId, leadId: ctx.leadId, replyText: null, replySent: false };
  }

  if (typeof onThinking === "function") Promise.resolve(onThinking()).catch(() => {});

  try {
    const vehicleLines = [];
    vehiclesSnap.forEach((vDoc) => {
      const v = vDoc.data() || {};
      const vName = v.name || v.model;
      if (vName) {
        const price = Number(v.priceINR || v.price || 0);
        const stock = Number(v.stockCount || v.stock || 0);
        vehicleLines.push(
          `- ${vName} | किंमत: ${price > 0 ? `₹${price}` : "किंमत उपलब्ध नाही"} | स्टॉक: ${stock > 0 ? `${stock} उपलब्ध` : "चौकशी करा"}`
        );
      }
    });

    const showroomName = showroomData.name || `Showroom ${showroomId}`;
    const showroomAddress = showroomData.address || showroomData.location || "पत्ता उपलब्ध नाही";
    const showroomTiming = showroomData.openingHours || "";
    const mapsLink = showroomData.googleMapsLink || showroomData.mapsLink || showroomData.mapUrl || showroomData.locationUrl || "";
    const customPrompt = aiConfig.customInstructions || aiConfig.systemPrompt || "";

    // आधीचे संभाषण (संदर्भासाठी)
    let historyText = "";
    let hadAssistantBefore = false;
    try {
      const hSnap = await ctx.convRef.collection("messages").orderBy("timestamp", "desc").limit(14).get();
      const rows = [];
      hSnap.forEach((h) => {
        const d = h.data() || {};
        if (exclude.has(d.messageId) || exclude.has(d.id)) return;
        const t = String(d.text || d.content || "").trim();
        if (t && rows.length < 8) rows.push((d.direction === "incoming" ? "ग्राहक: " : "सहाय्यक: ") + t);
        if (t && d.direction !== "incoming") hadAssistantBefore = true;
      });
      historyText = rows.reverse().join("\n");
    } catch (hErr) {
      console.error("[History]", hErr.message);
    }

    const firstReplyNote = hadAssistantBefore
      ? "यापूर्वी उत्तरे दिलेली आहेत, म्हणून नमस्कार किंवा शोरूमची ओळख अजिबात देऊ नकोस. थेट उत्तर दे."
      : "हे संभाषणाचे पहिले उत्तर आहे, म्हणून थोडक्यात एकदा नमस्कार कर.";

    const systemInstruction = `तू "${showroomName}" या शोरूमचा अधिकृत WhatsApp सहाय्यक आहेस.
कडक नियम:
1. फक्त खाली दिलेल्या याच शोरूमच्या डेटावरून उत्तर दे. दुसऱ्या कोणत्याही शोरूमचा डेटा वापरू नकोस.
2. ग्राहकाच्या भाषेत अतिशय लहान, नम्र आणि स्पष्ट उत्तर दे (१ ते ३ ओळीत).
3. जर गाडीची किंमत किंवा ऑफर दिलेल्या डेटा मध्ये नसेल, तर नेमके हेच वाक्य सांग: "आमचा प्रतिनिधी लवकरच संपर्क करेल".
4. स्वतःहून कोणतीही खोटी किंमत किंवा सूट बनवू नकोस.
5. शोरूमची वेळ, पत्ता किंवा गूगल मॅप लिंक दिलेली नसेल तर ती कधीही स्वतः बनवू नकोस. तेव्हा नेमके हेच वाक्य सांग: "आमचा प्रतिनिधी लवकरच संपर्क करेल".
6. ग्राहकाने लोकेशन किंवा पत्ता मागितला आणि गूगल मॅप लिंक दिलेली असेल तर ती लिंक थेट पाठव.
7. आधीचे संभाषण दिलेले असेल तर त्याचा संदर्भ वापर आणि तोच प्रश्न पुन्हा विचारू नकोस. ${firstReplyNote}
8. आम्ही २४ तास उत्तर देतो. शोरूमची वेळ, पत्ता किंवा Showroom ID ग्राहकाने विचारल्याशिवाय कधीही सांगू नकोस.
9. ग्राहक ज्या लिपीत लिहितो (देवनागरी किंवा रोमन अक्षरांत मराठी, हिंदी, इंग्रजी) त्याच भाषेत आणि त्याच लिपीत उत्तर दे.
10. शक्य असेल तेव्हा उत्तराच्या शेवटी एक छोटा पुढचा प्रश्न विचार (उदा. कोणते मॉडेल हवे, बजेट किती, टेस्ट ड्राइव्ह बुक करू का). एका वेळी फक्त एकच प्रश्न.
11. उत्तर लहान ठेव (१ ते ३ ओळी). इमोजी फार वापरू नकोस.
12. ग्राहकाचा संदेश [फोटो], [व्हॉइस मेसेज], [व्हिडिओ], [दस्तऐवज] किंवा [लोकेशन] असा असेल तर सांग की तुला तो पाहता येत नाही, पण प्रतिनिधी पाहून कळवेल, आणि ग्राहकाला काय हवे ते मजकुरात लिहायला सांग.
13. ग्राहकाने एकापेक्षा जास्त संदेश पाठवले असतील तर सर्वांचे मिळून एकच उत्तर दे.${customPrompt ? `\n14. शोरूमची विशेष सूचना: ${customPrompt}` : ""}`;

    const prompt = `=== शोरूम माहिती ===
शोरूम: ${showroomName}
पत्ता: ${showroomAddress}
वेळ: ${showroomTiming || "उपलब्ध नाही"}
गूगल मॅप लिंक: ${mapsLink || "उपलब्ध नाही"}
उपलब्ध गाड्या:
${vehicleLines.length > 0 ? vehicleLines.join("\n") : "माहिती उपलब्ध नाही."}
=== समाप्त ===

${historyText ? "=== आधीचे संभाषण ===\n" + historyText + "\n=== समाप्त ===\n\n" : ""}ग्राहकाचे नाव: ${ctx.customerName}
ग्राहकाचे नवीन संदेश:
${combinedText}
थेट WhatsApp उत्तर लिही:`;

    const ai = new GoogleGenAI({ apiKey });
    const primaryModel = aiConfig.preferredModel || process.env.GEMINI_MODEL || "gemini-3.8-flash";
    const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || "";
    const isBusy = (e) => /503|429|500|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|timeout/i.test(String((e && e.message) || e));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const withTimeout = (promise) =>
      Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Gemini timeout after ${ATTEMPT_TIMEOUT_MS}ms (503 high demand)`)), ATTEMPT_TIMEOUT_MS)),
      ]);

    const tries =
      fallbackModel && fallbackModel !== primaryModel ? [primaryModel, fallbackModel, primaryModel] : [primaryModel, primaryModel];
    let lastErr = null;
    let geminiRes = null;
    for (let i = 0; i < tries.length; i++) {
      try {
        geminiRes = await withTimeout(ai.models.generateContent({ model: tries[i], contents: prompt, config: { systemInstruction } }));
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.error(`[Gemini] attempt ${i + 1} (${tries[i]}) failed:`, String(err.message || err).slice(0, 160));
        if (!isBusy(err)) break;
        await sleep(300);
      }
    }
    if (lastErr) throw lastErr;

    replyText = (geminiRes.text || "").trim();
    const geminiMs = Date.now() - T0;

    if (replyText) {
      await deliver(replyText);
      await storeOutgoing(ctx, replyText, "ai_bot", `${showroomName} AI`);
      bumpDaily(ctx.conversationId);

      if (/प्रतिनिधी लवकरच संपर्क करेल/.test(replyText)) {
        await ctx.convRef.set({ needsHuman: true, needsHumanAt: new Date().toISOString() }, { merge: true });
      }

      // ग्राहकाची माहिती आपोआप लीडमध्ये (उत्तर गेल्यानंतर, उशीर न लावता)
      if (process.env.LEAD_CAPTURE !== "off" && !/^\[.*\]$/.test(combinedText.trim())) {
        const extractModel = process.env.GEMINI_EXTRACT_MODEL || fallbackModel || primaryModel;
        captureLead(db, ctx, ai, extractModel, historyText, combinedText);
      }
    }
    console.log(`[timing] showroom=${showroomId} gemini-done=${geminiMs}ms total=${Date.now() - T0}ms`);
  } catch (geminiErr) {
    console.error("[Gemini Auto-Reply Error]:", geminiErr.message);
    if (process.env.GEMINI_FAILURE_REPLY !== "off") {
      replyText = process.env.GEMINI_FAILURE_REPLY || "आमचा प्रतिनिधी लवकरच संपर्क करेल";
      await deliver(replyText);
      try {
        await storeOutgoing(ctx, replyText, "ai_bot", "Auto-reply");
        await ctx.convRef.set({ needsHuman: true, needsHumanAt: new Date().toISOString() }, { merge: true });
      } catch (e) {
        console.error("[storeOutgoing]", e.message);
      }
    }
  }

  return { success: true, conversationId: ctx.conversationId, leadId: ctx.leadId, replyText, replySent };
}

// जुन्या पद्धतीसाठी (एक मेसेज = एक उत्तर)
async function handleIncoming(db, showroomId, from, jid, isLid, text, name, sendReply, onThinking) {
  const ctx = await saveIncoming(db, showroomId, from, jid, isLid, text, name, { type: "text" });
  return generateReply(db, ctx, text, new Set([ctx.messageId]), sendReply, onThinking);
}

module.exports = { handleIncoming, saveIncoming, generateReply };
