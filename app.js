/* =========================================================
   AI PERSONAL — logica aplicației (v3, reparată)
   - Speech-to-Text + Text-to-Speech (Web Speech API, gratuit, în browser)
   - Stările roboțelului: idle / listening / thinking / speaking
   - Plimbare aleatorie pe ecran la 15–20 secunde
   - fetch() către Google Gemini Flash sau Groq (ambele au plan gratuit)
   - Cheia API NU stă în cod: se salvează în localStorage ("ai_key")
   ========================================================= */

"use strict";

/* ---------------- CONFIGURARE ---------------- */

const STORAGE = {
  key: "ai_key",           // cheia API
  provider: "ai_provider", // "auto" | "gemini" | "groq"
  voice: "ai_voice",       // numele vocii alese
};

const SYSTEM_PROMPT =
  "Ești un animal de companie robotizat, extrem de inteligent, dar puțin sarcastic și glumeț. " +
  "Răspunzi mereu în limba română, folosești expresii amuzante și încerci să fii cât mai de ajutor, " +
  "dar păstrându-ți personalitatea jucăușă. Răspunsurile tale trebuie să fie scurte și concise " +
  "(maximum 2-3 propoziții), potrivite pentru o conversație vocală fluidă.";

// Dacă un model e retras, se încearcă automat următorul din listă.
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash"];
const GROQ_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

const NO_KEY_MESSAGE = "Te rog adaugă cheia API din setări!";
const LANG = "ro-RO";
const MAX_HISTORY = 10;            // câte replici ține minte (context)
const LISTEN_TIMEOUT_MS = 15000;   // siguranță: microfonul nu rămâne blocat
const API_TIMEOUT_MS = 25000;
const WANDER_MIN_MS = 15000;
const WANDER_MAX_MS = 20000;

/* ---------------- ELEMENTE DOM ---------------- */

const $ = (id) => document.getElementById(id);
const pet = $("pet");
const petMouth = pet.querySelector(".pet-mouth");
const petEyes = pet.querySelectorAll(".pet-eye");
const stage = $("stage");
const micBtn = $("micBtn");
const statusEl = $("status");
const userTextEl = $("userText");
const aiTextEl = $("aiText");
const canvas = $("waveform");
const ctx = canvas.getContext("2d");

const settingsBtn = $("settingsBtn");
const settingsModal = $("settingsModal");
const settingsForm = $("settingsForm");
const apiKeyInput = $("apiKeyInput");
const toggleKeyBtn = $("toggleKeyBtn");
const providerSelect = $("providerSelect");
const testApiBtn = $("testApiBtn");
const clearKeyBtn = $("clearKeyBtn");
const apiTestResult = $("apiTestResult");
const voiceSelect = $("voiceSelect");
const testVoiceBtn = $("testVoiceBtn");
const micHelp = $("micHelp");
const micHelpReason = $("micHelpReason");

/* =========================================================
   localStorage (cu protecție pentru modul privat)
   ========================================================= */

function lsGet(name) {
  try { return localStorage.getItem(name) || ""; } catch { return ""; }
}
function lsSet(name, value) {
  try {
    if (value) localStorage.setItem(name, value);
    else localStorage.removeItem(name);
  } catch { /* stocare blocată — nu avem ce face */ }
}

// migrare din versiunea anterioară a aplicației
(function migrateOldKeys() {
  const old = lsGet("aip.apiKey");
  if (old && !lsGet(STORAGE.key)) lsSet(STORAGE.key, old);
})();

function getApiKey() {
  return lsGet(STORAGE.key).trim();
}

// Alege furnizorul: setarea manuală sau ghicit după formatul cheii
function getProvider(key = getApiKey()) {
  const chosen = lsGet(STORAGE.provider) || "auto";
  if (chosen === "gemini" || chosen === "groq") return chosen;
  if (key.startsWith("gsk_")) return "groq";
  return "gemini"; // cheile Gemini încep cu "AIza"
}

/* =========================================================
   STĂRILE ROBOȚELULUI — sincronizare JS ↔ CSS
   Clase pe #pet: .listening / .thinking / .speaking
   (.speaking se pune și direct pe gură și ochi)
   ========================================================= */

let state = "idle";

const STATUS_TEXT = {
  idle: "Gata de conversație",
  listening: "Te ascult…",
  thinking: "Mă gândesc (adânc, foarte adânc)…",
  speaking: "Vorbesc…",
};

function setState(next, statusText) {
  state = next;

  pet.classList.toggle("listening", next === "listening");
  pet.classList.toggle("thinking", next === "thinking");
  pet.classList.toggle("speaking", next === "speaking");
  petMouth.classList.toggle("speaking", next === "speaking");
  petEyes.forEach((eye) => eye.classList.toggle("speaking", next === "speaking"));

  if (next !== "idle") stopWander();
  if (next !== "speaking") resetTalk();

  micBtn.classList.toggle("active", next === "listening" || next === "speaking");
  micBtn.classList.toggle("busy", next === "thinking");
  micBtn.setAttribute(
    "aria-label",
    next === "listening" ? "Oprește ascultarea" : next === "speaking" ? "Oprește vocea" : "Pornește microfonul"
  );
  statusEl.textContent = statusText || STATUS_TEXT[next];
}

function showUserText(text, interim = false) {
  userTextEl.textContent = text || "…";
  userTextEl.classList.toggle("muted", interim);
}
function showAiText(text, isError = false) {
  aiTextEl.textContent = text;
  aiTextEl.classList.toggle("error", isError);
}

function updateKeyWarning() {
  settingsBtn.classList.toggle("attention", !getApiKey());
}

/* =========================================================
   VOCI ROMÂNEȘTI — încărcare asincronă (onvoiceschanged)
   ========================================================= */

const synth = window.speechSynthesis || null;
let voices = [];
let chosenVoice = null;

function isRomanian(v) {
  return /^ro([-_]|$)/i.test(v.lang || "");
}

// scor mai mare = voce mai naturală
function voiceScore(v) {
  const name = v.name.toLowerCase();
  let score = 0;
  if (isRomanian(v)) score += 50;
  if ((v.lang || "").replace("_", "-").toLowerCase() === "ro-ro") score += 10;
  if (name.includes("google") && (name.includes("român") || name.includes("roman"))) score += 40;
  if (name.includes("microsoft") && (name.includes("alina") || name.includes("emil"))) {
    score += 30;
    if (name.includes("online") || name.includes("natural")) score += 15;
  } else if (name.includes("alina") || name.includes("emil")) {
    score += 25;
  }
  if (!v.localService) score += 2; // vocile online sună de obicei mai natural
  return score;
}

function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices() || [];
  if (!voices.length) {
    // încă se încarcă; revenim automat pe onvoiceschanged
    voiceSelect.innerHTML = '<option value="">Se încarcă vocile…</option>';
    return;
  }

  const roVoices = voices.filter(isRomanian).sort((a, b) => voiceScore(b) - voiceScore(a));
  const saved = lsGet(STORAGE.voice);
  chosenVoice = roVoices.find((v) => v.name === saved) || roVoices[0] || null;

  // lista din setări
  voiceSelect.innerHTML = "";
  if (!roVoices.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "⚠ Browserul nu are voce română — folosesc vocea implicită";
    voiceSelect.appendChild(opt);
    return;
  }
  roVoices.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    opt.selected = chosenVoice && v.name === chosenVoice.name;
    voiceSelect.appendChild(opt);
  });
}

if (synth) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
  // unele browsere (ex. Safari) nu trimit evenimentul — mai încercăm de câteva ori
  [300, 1000, 2500].forEach((ms) => setTimeout(() => { if (!voices.length) loadVoices(); }, ms));
}

/* =========================================================
   TEXT-TO-SPEECH — robust pentru Chrome / Edge / Android
   ========================================================= */

let speechUnlocked = false;
let currentUtterance = null; // referință globală: Chrome "uită" altfel evenimentul onend
let keepAliveTimer = null;
let fakeTalkTimer = null;
let talkDecay = null;

// Pe mobil, vocea trebuie "deblocată" în timpul unui click al utilizatorului.
function unlockSpeech() {
  if (!synth || speechUnlocked) return;
  speechUnlocked = true;
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    u.lang = LANG;
    synth.speak(u);
  } catch { /* ignorăm */ }
}

function cleanForSpeech(text) {
  return text
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[*_#`>~|]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pulseTalk(strength = 1) {
  pet.style.setProperty("--talk", String(strength));
  pet.classList.add("beat");
  petEyes.forEach((eye) => eye.classList.add("beat"));
  clearTimeout(talkDecay);
  talkDecay = setTimeout(resetTalk, 140);
}
function resetTalk() {
  clearTimeout(talkDecay);
  pet.style.setProperty("--talk", "0");
  pet.classList.remove("beat");
  petEyes.forEach((eye) => eye.classList.remove("beat"));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function speak(text) {
  const clean = cleanForSpeech(text);
  if (!synth || !clean) return;

  // Bug Chrome: cancel() urmat imediat de speak() poate înghiți vorbirea.
  if (synth.speaking || synth.pending) {
    synth.cancel();
    await wait(80);
  }
  if (!voices.length) loadVoices();

  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(clean);
    currentUtterance = utter;
    utter.lang = chosenVoice ? chosenVoice.lang : LANG;
    if (chosenVoice) utter.voice = chosenVoice;
    utter.rate = 1.05;
    utter.pitch = 1.15;
    utter.volume = 1;

    let started = false;
    let gotBoundary = false;
    let done = false;

    const finish = (reason) => {
      if (done) return;
      done = true;
      clearInterval(keepAliveTimer);
      clearInterval(fakeTalkTimer);
      clearTimeout(startGuard);
      clearTimeout(endGuard);
      if (currentUtterance === utter) currentUtterance = null;
      if (state === "speaking") setState("idle", reason === "nostart" ? "Browserul nu a redat vocea — verifică volumul" : undefined);
      resolve();
    };

    utter.onstart = () => {
      started = true;
      setState("speaking");
      // Rezervă: unele voci (ex. Google online) nu trimit "boundary" —
      // atunci gura pulsează simulat în ritmul vorbirii.
      fakeTalkTimer = setInterval(() => {
        if (!gotBoundary) pulseTalk(0.55 + Math.random() * 0.6);
      }, 220);
      // Bug Chrome: vocile online se opresc după ~15 secunde fără asta.
      keepAliveTimer = setInterval(() => {
        if (synth.speaking && !synth.paused) { synth.pause(); synth.resume(); }
      }, 10000);
    };
    utter.onboundary = (e) => {
      if (e.name && e.name !== "word") return;
      gotBoundary = true;
      pulseTalk(0.8 + Math.random() * 0.5);
    };
    utter.onend = () => finish("end");
    utter.onerror = (e) => {
      // "interrupted"/"canceled" = l-am oprit noi; restul sunt erori reale
      if (e.error && !["interrupted", "canceled"].includes(e.error)) {
        statusEl.textContent = `Eroare voce: ${e.error}`;
      }
      finish("error");
    };

    // dacă vorbirea nu pornește deloc în 5 secunde, nu blocăm aplicația
    const startGuard = setTimeout(() => { if (!started) { synth.cancel(); finish("nostart"); } }, 5000);
    // dacă onend nu vine niciodată (bug cunoscut), închidem după durata estimată
    const endGuard = setTimeout(() => finish("timeout"), 5000 + clean.length * 110);

    // afișăm starea "speaking" imediat, apoi pornim vocea
    setState("speaking");
    synth.resume(); // Chrome rămâne uneori pe "pauză"
    synth.speak(utter);
  });
}

function stopSpeaking() {
  if (synth) synth.cancel();
  setState("idle");
}

/* =========================================================
   SPEECH-TO-TEXT — pornit DOAR din click-ul utilizatorului
   ========================================================= */

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recognition = null;
let listenTimer = null;
let transcript = "";
let handled = false;

function showMicHelp(reason) {
  micHelpReason.textContent = reason;
  openModal(micHelp);
}

// Creăm o instanță NOUĂ la fiecare apăsare — instanțele refolosite
// se pot bloca în Chrome după o eroare.
function createRecognition() {
  const rec = new SpeechRecognitionAPI();
  rec.lang = LANG;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    setState("listening");
  };

  rec.onsoundstart = rec.onspeechstart = () => { voiceEnergy = 1; };

  rec.onresult = (event) => {
    let finalText = "";
    let interim = "";
    for (let i = 0; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    transcript = finalText.trim();
    showUserText((finalText + " " + interim).trim(), !finalText);
    voiceEnergy = 1;
  };

  rec.onerror = (event) => {
    clearTimeout(listenTimer);
    handled = true; // nu mai procesăm nimic din sesiunea asta
    const err = event.error;

    if (err === "not-allowed" || err === "service-not-allowed") {
      setState("idle", "Microfon blocat");
      showAiText("Nu am voie la microfon. Ți-am arătat pe ecran cum îmi dai acces.", true);
      showMicHelp(
        err === "not-allowed"
          ? "Browserul a refuzat accesul la microfon pentru această pagină."
          : "Browserul nu permite recunoașterea vocală aici (de ex. în modul incognito sau într-un browser din altă aplicație)."
      );
      return;
    }

    const messages = {
      "no-speech": "N-am auzit nimic. Apasă din nou și vorbește.",
      "audio-capture": "Nu găsesc niciun microfon. E conectat?",
      network: "Recunoașterea vocală are nevoie de internet.",
      "language-not-supported": "Browserul nu recunoaște limba română.",
      aborted: "Gata de conversație",
    };
    setState("idle", messages[err] || `Eroare microfon: ${err}`);
  };

  rec.onend = () => {
    clearTimeout(listenTimer);
    if (handled) {
      if (state === "listening") setState("idle");
      return;
    }
    handled = true;
    const text = transcript.trim();
    if (text) handleUserMessage(text);
    else if (state === "listening") setState("idle", "N-am prins nimic. Mai încearcă!");
  };

  return rec;
}

function startListening() {
  if (!SpeechRecognitionAPI) {
    setState("idle", "Browser fără recunoaștere vocală");
    showAiText("Of, browserul ăsta nu mă aude. Deschide-mă în Chrome sau Edge și o să fim cei mai buni prieteni.", true);
    return;
  }
  if (!window.isSecureContext) {
    showMicHelp("Microfonul merge doar pe o adresă https:// (de ex. linkul GitHub Pages).");
    return;
  }

  // oprim orice sesiune veche, apoi pornim una nouă — SINCRON, în click
  if (recognition) {
    try { recognition.onend = recognition.onerror = recognition.onresult = null; recognition.abort(); } catch { /* ignorăm */ }
  }
  transcript = "";
  handled = false;
  recognition = createRecognition();

  try {
    recognition.start();
    setState("listening"); // feedback imediat, înainte să vină onstart
  } catch (e) {
    setState("idle", "Microfonul e ocupat. Mai apasă o dată.");
    return;
  }

  // siguranță: dacă browserul nu închide singur sesiunea, o închidem noi
  clearTimeout(listenTimer);
  listenTimer = setTimeout(() => {
    if (state !== "listening") return;
    try { recognition.stop(); } catch { /* ignorăm */ }
    setTimeout(() => {
      if (state === "listening") {
        try { recognition.abort(); } catch { /* ignorăm */ }
        if (!handled) {
          handled = true;
          if (transcript) handleUserMessage(transcript);
          else setState("idle");
        }
      }
    }, 2000);
  }, LISTEN_TIMEOUT_MS);
}

function stopListening() {
  try { recognition && recognition.stop(); } catch { /* ignorăm */ }
}

// verificare discretă la pornire: dacă microfonul e deja blocat, anunțăm
async function checkMicPermission() {
  try {
    if (!navigator.permissions?.query) return;
    const status = await navigator.permissions.query({ name: "microphone" });
    const apply = () => {
      if (status.state === "denied") {
        statusEl.textContent = "Microfon blocat — apasă butonul pentru ajutor";
      }
    };
    apply();
    status.onchange = apply;
  } catch { /* unele browsere nu suportă interogarea */ }
}

/* =========================================================
   APEL AI — fetch() către Gemini sau Groq
   ========================================================= */

const chatHistory = []; // { role: "user" | "assistant", text }

function pushHistory(role, text) {
  chatHistory.push({ role, text });
  while (chatHistory.length > MAX_HISTORY) chatHistory.shift();
  // conversația trimisă trebuie să înceapă cu o replică a utilizatorului
  while (chatHistory.length && chatHistory[0].role !== "user") chatHistory.shift();
}

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function postJSON(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || res.statusText || "Eroare necunoscută";
      throw new ApiError(msg, res.status, data?.error?.code || data?.error?.status);
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError") throw new ApiError("timeout", 0, "TIMEOUT");
    if (err instanceof ApiError) throw err;
    throw new ApiError("Fără conexiune la serverul AI", 0, "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}

const isModelMissing = (err) =>
  err.status === 404 || /model.*(not found|not exist|decommission|deprecated)/i.test(err.message);

async function callGemini(key, messages) {
  let lastErr;
  for (const model of GEMINI_MODELS) {
    const generationConfig = { temperature: 0.9, maxOutputTokens: 300 };
    // modelele 2.5 "gândesc" implicit — oprim asta ca răspunsul să vină repede
    if (model.startsWith("gemini-2.5")) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    try {
      const data = await postJSON(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { "x-goog-api-key": key },
        {
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.text }],
          })),
          generationConfig,
        }
      );
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
      if (!text) {
        const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
        throw new ApiError(reason ? `Răspuns blocat (${reason})` : "Răspuns gol", 200, "EMPTY");
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (!isModelMissing(err)) throw err;
    }
  }
  throw lastErr;
}

async function callGroq(key, messages) {
  let lastErr;
  for (const model of GROQ_MODELS) {
    try {
      const data = await postJSON(
        "https://api.groq.com/openai/v1/chat/completions",
        { Authorization: `Bearer ${key}` },
        {
          model,
          temperature: 0.9,
          max_tokens: 300,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...messages.map((m) => ({ role: m.role, content: m.text })),
          ],
        }
      );
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) throw new ApiError("Răspuns gol", 200, "EMPTY");
      return text;
    } catch (err) {
      lastErr = err;
      if (!isModelMissing(err)) throw err;
    }
  }
  throw lastErr;
}

async function askAI(messages, key = getApiKey(), provider = getProvider(key)) {
  if (!key) throw new ApiError(NO_KEY_MESSAGE, 0, "NO_KEY");
  return provider === "groq" ? callGroq(key, messages) : callGemini(key, messages);
}

function friendlyError(err) {
  if (err.code === "NO_KEY") return NO_KEY_MESSAGE;
  if (err.code === "TIMEOUT") return "Serverul AI doarme. Am așteptat 25 de secunde și am renunțat. Mai încearcă.";
  if (err.code === "NETWORK") return "Nu ajung la serverul AI. Verifică internetul.";
  if (err.status === 400 && /api key|API_KEY/i.test(err.message)) return "Cheia API nu e validă. Verific-o în setări.";
  if (err.status === 401 || err.status === 403) return "Cheia API e greșită sau n-are drepturi. Verific-o în setări.";
  if (err.status === 429) return "Am vorbit prea mult pe planul gratuit. Mai așteaptă un minut și revin.";
  if (err.status >= 500) return "Serverul AI are o zi proastă. Mai încearcă puțin mai târziu.";
  return `Mi s-a încurcat un circuit: ${err.message}`;
}

async function handleUserMessage(text) {
  showUserText(text);

  if (!getApiKey()) {
    showAiText(NO_KEY_MESSAGE, true);
    setState("idle", NO_KEY_MESSAGE);
    updateKeyWarning();
    speak("Te rog adaugă cheia API din setări!");
    return;
  }

  pushHistory("user", text);
  setState("thinking"); // tumba + ochii dați peste cap pornesc ÎNAINTE de fetch

  try {
    const reply = await askAI(chatHistory);
    pushHistory("assistant", reply);
    showAiText(reply);
    await speak(reply);
  } catch (err) {
    if (chatHistory.at(-1)?.role === "user") chatHistory.pop();
    const msg = friendlyError(err);
    console.warn("[AI]", err);
    showAiText(msg, true);
    setState("idle", "Ceva n-a mers");
    if ([400, 401, 403].includes(err.status)) settingsBtn.classList.add("attention");
    await speak(msg);
  }
}

/* ---------------- Butonul mare de microfon ---------------- */

micBtn.addEventListener("click", () => {
  unlockSpeech(); // deblochează vocea pe mobil (trebuie făcut în click)

  if (state === "listening") return stopListening();
  if (state === "speaking") return stopSpeaking();
  if (state === "thinking") return; // așteptăm răspunsul

  if (synth && (synth.speaking || synth.pending)) synth.cancel();
  startListening(); // pornit sincron, direct din gestul utilizatorului
});

// bară de spațiu = microfon (pe desktop)
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || isAnyModalOpen()) return;
  if (e.target.closest("input, select, textarea, button")) return;
  e.preventDefault();
  micBtn.click();
});

/* =========================================================
   WAVEFORM ANIMAT (canvas)
   Nu deschidem microfonul a doua oară (asta bloca recunoașterea
   vocală pe unele dispozitive); valurile reacționează la sunetul
   detectat de recunoaștere și la ritmul vocii robotului.
   ========================================================= */

let voiceEnergy = 0;
const BARS = 48;
const levels = new Array(BARS).fill(0);
const WAVE_COLORS = {
  idle: ["#3df2ff", "#39ff9f"],
  listening: ["#3df2ff", "#39ff9f"],
  thinking: ["#b44dff", "#ffd23d"],
  speaking: ["#39ff9f", "#3df2ff"],
};

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawWaveform(t) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  voiceEnergy *= 0.96;
  const talk = parseFloat(pet.style.getPropertyValue("--talk")) || 0;

  for (let i = 0; i < BARS; i++) {
    const center = 1 - Math.abs(i - BARS / 2) / (BARS / 2); // mai înalt la mijloc
    let target;
    if (state === "listening") {
      target = (0.18 + voiceEnergy * 0.75) * (0.35 + center * 0.65) * (0.5 + 0.5 * Math.abs(Math.sin(t / 110 + i * 0.75)));
    } else if (state === "speaking") {
      target = (0.25 + talk * 0.7) * (0.3 + center * 0.7) * (0.55 + 0.45 * Math.sin(t / 70 + i * 1.3));
    } else if (state === "thinking") {
      const scan = (t / 18) % (BARS + 10);
      target = Math.max(0, 1 - Math.abs(i - scan) / 4) * 0.7 + 0.04;
    } else {
      target = 0.04 + 0.04 * Math.sin(t / 600 + i * 0.4);
    }
    levels[i] += (Math.max(0, target) - levels[i]) * 0.25;
  }

  const gap = 3;
  const barW = Math.max(2, (w - gap * (BARS - 1)) / BARS);
  const colors = WAVE_COLORS[state] || WAVE_COLORS.idle;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, colors[0]);
  grad.addColorStop(0.5, colors[1]);
  grad.addColorStop(1, colors[0]);
  ctx.fillStyle = grad;
  ctx.shadowColor = colors[1];
  ctx.shadowBlur = 12;

  for (let i = 0; i < BARS; i++) {
    const bh = Math.max(2, levels[i] * (h - 6));
    const x = i * (barW + gap);
    const y = (h - bh) / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, barW, bh, Math.min(barW / 2, bh / 2));
    else ctx.rect(x, y, barW, bh);
    ctx.fill();
  }

  requestAnimationFrame(drawWaveform);
}

/* =========================================================
   PLIMBARE ALEATORIE (random wander)
   ========================================================= */

const PET_W = 150;
const PET_H = 236;
let petX = 0;
let petY = 0;
let wanderEndTimer = null;
let nextWanderAt = 0;

const rand = (min, max) => min + Math.random() * (max - min);

function bounds() {
  const r = stage.getBoundingClientRect();
  return { maxX: Math.max(0, r.width - PET_W), maxY: Math.max(0, r.height - PET_H) };
}

function placePet(x, y) {
  const { maxX, maxY } = bounds();
  petX = Math.min(Math.max(0, x), maxX);
  petY = Math.min(Math.max(0, y), maxY);
  pet.style.setProperty("--x", `${petX}px`);
  pet.style.setProperty("--y", `${petY}px`);
}

function centerPet() {
  const { maxX, maxY } = bounds();
  pet.style.transition = "none";
  placePet(maxX / 2, maxY / 2);
  requestAnimationFrame(() => requestAnimationFrame(() => (pet.style.transition = "")));
}

function wander() {
  if (state !== "idle" || document.hidden || isAnyModalOpen()) return;
  const { maxX, maxY } = bounds();

  let x, y, tries = 0;
  do {
    x = rand(0, maxX);
    y = rand(0, maxY);
    tries++;
  } while (Math.hypot(x - petX, y - petY) < Math.min(120, maxX / 3) && tries < 8);

  pet.style.setProperty("--dir", x >= petX ? "1" : "-1");
  pet.classList.add("wandering");
  placePet(x, y);

  clearTimeout(wanderEndTimer);
  wanderEndTimer = setTimeout(() => pet.classList.remove("wandering"), 3200);
}

function stopWander() {
  clearTimeout(wanderEndTimer);
  pet.classList.remove("wandering");
}

function scheduleNextWander() {
  nextWanderAt = Date.now() + rand(WANDER_MIN_MS, WANDER_MAX_MS);
}

// setInterval verifică în fiecare secundă dacă a venit momentul plimbării
// (intervalul real e aleator, între 15 și 20 de secunde)
setInterval(() => {
  if (Date.now() < nextWanderAt) return;
  wander();
  scheduleNextWander();
}, 1000);

// atinge roboțelul — reacție amuzantă
pet.addEventListener("click", () => {
  pet.classList.remove("boop");
  void pet.offsetWidth;
  pet.classList.add("boop");
  setTimeout(() => pet.classList.remove("boop"), 520);
});

/* =========================================================
   MODALE (setări + ajutor microfon)
   ========================================================= */

let lastFocus = null;

function openModal(modal) {
  lastFocus = document.activeElement;
  modal.hidden = false;
  const first = modal.querySelector("input, select, button.neon-btn, button");
  if (first) setTimeout(() => first.focus(), 30);
}
function closeModal(modal) {
  modal.hidden = true;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
function isAnyModalOpen() {
  return !settingsModal.hidden || !micHelp.hidden;
}

[settingsModal, micHelp].forEach((modal) => {
  modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeModal(modal);
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!settingsModal.hidden) closeModal(settingsModal);
  if (!micHelp.hidden) closeModal(micHelp);
});

function openSettings() {
  apiKeyInput.value = getApiKey();
  apiKeyInput.type = "password";
  providerSelect.value = lsGet(STORAGE.provider) || "auto";
  apiTestResult.textContent = "";
  apiTestResult.className = "test-result";
  loadVoices();
  openModal(settingsModal);
}

settingsBtn.addEventListener("click", openSettings);

toggleKeyBtn.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

settingsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const key = apiKeyInput.value.trim();
  // salvare locală: localStorage.setItem('ai_key', cheie)
  try {
    if (key) localStorage.setItem("ai_key", key);
    else localStorage.removeItem("ai_key");
  } catch { /* stocare blocată */ }
  lsSet(STORAGE.provider, providerSelect.value === "auto" ? "" : providerSelect.value);
  if (voiceSelect.value) {
    lsSet(STORAGE.voice, voiceSelect.value);
    chosenVoice = voices.find((v) => v.name === voiceSelect.value) || chosenVoice;
  }
  updateKeyWarning();
  closeModal(settingsModal);

  if (key) {
    setState("idle", "Setări salvate — hai să vorbim!");
    showAiText("Creier conectat! Apasă butonul neon și zi ceva deștept. Sau măcar amuzant.");
  } else {
    setState("idle", NO_KEY_MESSAGE);
    showAiText(NO_KEY_MESSAGE, true);
  }
});

clearKeyBtn.addEventListener("click", () => {
  apiKeyInput.value = "";
  lsSet(STORAGE.key, "");
  updateKeyWarning();
  apiTestResult.textContent = "Cheia a fost ștearsă din acest browser.";
  apiTestResult.className = "test-result";
});

testApiBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  const chosen = providerSelect.value;
  const provider = chosen === "auto" ? (key.startsWith("gsk_") ? "groq" : "gemini") : chosen;
  if (!key) {
    apiTestResult.textContent = "Lipește mai întâi o cheie.";
    apiTestResult.className = "test-result bad";
    return;
  }
  testApiBtn.disabled = true;
  apiTestResult.textContent = `Testez ${provider === "groq" ? "Groq" : "Gemini"}…`;
  apiTestResult.className = "test-result";
  try {
    const reply = await askAI([{ role: "user", text: "Spune salut într-o propoziție scurtă." }], key, provider);
    apiTestResult.textContent = `✓ Merge! Răspuns: „${reply.slice(0, 90)}”`;
    apiTestResult.className = "test-result ok";
  } catch (err) {
    apiTestResult.textContent = `✗ ${friendlyError(err)}`;
    apiTestResult.className = "test-result bad";
  } finally {
    testApiBtn.disabled = false;
  }
});

voiceSelect.addEventListener("change", () => {
  chosenVoice = voices.find((v) => v.name === voiceSelect.value) || chosenVoice;
});

testVoiceBtn.addEventListener("click", () => {
  unlockSpeech();
  chosenVoice = voices.find((v) => v.name === voiceSelect.value) || chosenVoice;
  speak("Salut! Eu sunt roboțelul tău. Sună bine vocea asta, sau vrei alta?");
});

/* =========================================================
   PORNIRE
   ========================================================= */

window.addEventListener("resize", () => {
  resizeCanvas();
  placePet(petX, petY);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state === "listening") stopListening();
});

resizeCanvas();
centerPet();
scheduleNextWander();
requestAnimationFrame(drawWaveform);
updateKeyWarning();
checkMicPermission();

if (!getApiKey()) {
  setState("idle", NO_KEY_MESSAGE);
  showAiText(`Salut! ${NO_KEY_MESSAGE} (rotița din dreapta sus)`);
} else {
  setState("idle");
}
