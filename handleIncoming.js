 const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");

// 10 अंकी भारतीय फोन नंबर स्वच्छ करणे (91 वगळणे)
function extractLast10Digits(raw) {
  const withoutDomain = String(raw || "").trim().replace(/@.*$/, "");
  const digits = withoutDomain.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

async function handleIncoming(db, showroomId, from, jid, isLid, text, name) {
  const now = new Date();
  const nowIso = now.toISOString();
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // १. फोन नंबर आणि JID Normalization
  const isLidMode = Boolean(
    isLid === true || String(jid || "").endsWith("@lid") || String(from || "").endsWith("@lid")
  );
  const normalizedPhone10 = isLidMode ? "" : extractLast10Digits(from);
  const resolvedTargetJid = isLidMode
    ? jid || from
    : jid || (normalizedPhone10 ? `91${normalizedPhone10}@s.whatsapp.net` : from);
  const canonicalCustomerId = isLidMode ? resolvedTargetJid : normalizedPhone10 || from;
  const customerName = name && name.trim() ? name.trim() : canonicalCustomerId;

  // २. विद्यमान Lead शोधणे
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
      if (
        resolvedTargetJid &&
        (dJid === resolvedTargetJid || dPhone === resolvedTargetJid || docSnap.id === resolvedTargetJid)
      ) {
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

  // ३. Lead नसेल तर नवीन Lead
  let resolvedLeadId = matchedLeadId;
  if (!resolvedLeadId) {
    resolvedLeadId = `LEAD-${showroomId}-${Date.now().toString().slice(-5)}`;
    const newLead = {
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
    };
    await leadsRef.doc(resolvedLeadId).set(newLead, { merge: true });
  }

  // ४. Conversation शोधणे / बनवणे
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
      if (resolvedTargetJid && (dJid === resolvedTargetJid || dPhone === resolvedTargetJid)) {
        matchedConvId = docSnap.id;
      }
    } else if (normalizedPhone10 && extractLast10Digits(dPhone) === normalizedPhone10) {
      matchedConvId = docSnap.id;
    }
    if (resolvedLeadId && (dLeadId === resolvedLeadId || docSnap.id === `conv_${showroomId}_${resolvedLeadId}`)) {
      matchedConvId = docSnap.id;
    }
  });

  const conversationId = matchedConvId || `conv_${showroomId}_${resolvedLeadId}`;
  const targetConvRef = convsRef.doc(conversationId);
  const convDocSnap = await targetConvRef.get();
  const existingConv = convDocSnap.exists ? convDocSnap.data() || {} : {};
  const currentUnread = Number(existingConv.unreadCount || 0);

  // ५. Conversation अपडेट
  await targetConvRef.set(
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

  // ६. येणारा मेसेज साठवणे
  const incomingMsgPayload = {
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
    type: "text",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: nowIso,
  };
  await targetConvRef.collection("messages").doc(messageId).set(incomingMsgPayload, { merge: true });

  console.log(`[Firestore Saved] Incoming: showrooms/${showroomId}/conversations/${conversationId}/messages/${messageId}`);

  // ७. AI Settings आणि Mode
  const [aiSnap, showroomSnap, vehiclesSnap] = await Promise.all([
    db.collection("showrooms").doc(showroomId).collection("aiSettings").doc("config").get(),
    db.collection("showrooms").doc(showroomId).get(),
    db.collection("showrooms").doc(showroomId).collection("vehicles").get(),
  ]);

  const aiConfig = aiSnap.exists ? aiSnap.data() : {};
  const showroomData = showroomSnap.exists ? showroomSnap.data() : {};

  const effectiveMode = String(
    aiConfig.mode || aiConfig.aiMode || showroomData.aiMode || "C_CONTROLLED_AUTOMATION"
  ).trim();
  const isAutomationPaused = Boolean(aiConfig.isAutomationPaused === true);
  const humanTakeover = Boolean(existingConv.humanTakeoverActive === true);

  const isModeC =
    (effectiveMode === "C_CONTROLLED_AUTOMATION" || effectiveMode === "auto-reply" || effectiveMode === "auto") &&
    !isAutomationPaused &&
    !humanTakeover;

  let replyText = null;

  // ८. Mode C: Gemini रिप्लाय
  if (isModeC) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.log("[Gemini] GEMINI_API_KEY missing in Render environment");
    } else {
      try {
        const vehicleLines = [];
        vehiclesSnap.forEach((vDoc) => {
          const v = vDoc.data() || {};
          const vName = v.name || v.model;
          if (vName) {
            const price = Number(v.priceINR || v.price || 0);
            const stock = Number(v.stockCount || v.stock || 0);
            vehicleLines.push(
              `- ${vName} | किंमत: ${price > 0 ? `₹${price}` : "किंमत उपलब्ध नाही"} | स्टॉक: ${
                stock > 0 ? `${stock} उपलब्ध` : "चौकशी करा"
              }`
            );
          }
        });

        const showroomName = showroomData.name || `Showroom ${showroomId}`;
        const showroomAddress = showroomData.address || showroomData.location || "पत्ता उपलब्ध नाही";
        const showroomTiming = showroomData.openingHours || "सकाळी 09:30 ते संध्याकाळी 07:30";
        const customPrompt = aiConfig.customInstructions || aiConfig.systemPrompt || "";

        const systemInstruction = `तू "${showroomName}" (Showroom ID: ${showroomId}) या शोरूमचा अधिकृत WhatsApp सहाय्यक आहेस.
कडक नियम:
1. फक्त खाली दिलेल्या याच शोरूमच्या डेटावरून उत्तर दे. दुसऱ्या कोणत्याही शोरूमचा डेटा वापरू नकोस.
2. ग्राहकाच्या भाषेत (मराठी, हिंदी किंवा इंग्रजी) अतिशय लहान, नम्र आणि स्पष्ट उत्तर दे (१ ते ३ ओळीत).
3. जर गाडीची किंमत किंवा ऑफर दिलेल्या डेटा मध्ये नसेल, तर नेमके हेच वाक्य सांग: "आमचा प्रतिनिधी लवकरच संपर्क करेल".
4. स्वतःहून कोणतीही खोटी किंमत किंवा सूट बनवू नकोस.${customPrompt ? `\n5. शोरूमची विशेष सूचना: ${customPrompt}` : ""}`;

        const prompt = `=== शोरूम माहिती ===
शोरूम: ${showroomName}
पत्ता: ${showroomAddress}
वेळ: ${showroomTiming}
उपलब्ध गाड्या:
${vehicleLines.length > 0 ? vehicleLines.join("\n") : "माहिती उपलब्ध नाही."}
=== समाप्त ===

ग्राहकाचे नाव: ${customerName}
ग्राहकाचा संदेश: "${text}"
थेट WhatsApp उत्तर लिही:`;

        const ai = new GoogleGenAI({ apiKey });
        const geminiRes = await ai.models.generateContent({
          model: aiConfig.preferredModel || process.env.GEMINI_MODEL || "gemini-3.8-flash",
          contents: prompt,
          config: { systemInstruction },
        });

        replyText = (geminiRes.text || "").trim();

        if (replyText) {
          // ९. रिप्लाय त्याच चॅटमध्ये outgoing म्हणून साठवणे
          const replyMsgId = `msg_ai_${Date.now()}`;
          const replyPayload = {
            id: replyMsgId,
            messageId: replyMsgId,
            conversationId,
            showroomId,
            direction: "outgoing",
            text: replyText,
            content: replyText,
            status: "sent",
            sender: "ai_bot",
            senderName: `${showroomName} AI`,
            from: canonicalCustomerId,
            customerPhone: canonicalCustomerId,
            customerName,
            jid: resolvedTargetJid,
            isLid: isLidMode,
            customerId: canonicalCustomerId,
            leadId: resolvedLeadId,
            type: "text",
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: new Date().toISOString(),
          };

          await targetConvRef.collection("messages").doc(replyMsgId).set(replyPayload, { merge: true });
          await targetConvRef.set(
            {
              lastMessage: replyText,
              lastMessageText: replyText,
              lastMessageAt: new Date().toISOString(),
              lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
              replyStatus: "replied",
              suggestedReply: null,
            },
            { merge: true }
          );
        }
      } catch (geminiErr) {
        console.error("[Gemini Auto-Reply Error]:", geminiErr.message);
      }
    }
  } else {
    await targetConvRef.set({ replyStatus: "pending", pendingReplyNote: "उत्तर देणे बाकी" }, { merge: true });
  }

  return { success: true, conversationId, leadId: resolvedLeadId, replyText };
}

module.exports = { handleIncoming };
