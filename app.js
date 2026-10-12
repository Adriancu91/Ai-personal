/* =========================================================
   AI PERSONAL — logica aplicației
   - Speech-to-Text + Text-to-Speech (Web Speech API, gratuit, în browser)
   - Stările roboțelului: idle / listening / thinking / speaking
   - Plimbare aleatorie pe ecran la 15–20 secunde
   - Apel fetch() către Google Gemini Flash sau Groq (ambele au plan gratuit)
   ========================================================= */

"use strict";

/* ---------------- CONFIGURARE ---------------- */

// Cheia API: o poți scrie aici SAU (recomandat) o lipești din butonul de Setări
// din aplicație, unde se salvează doar în browserul tău.
// ATENȚIE: dacă o scrii aici și repository-ul e public, oricine o poate vedea.
const API_KEY = "YOUR_FREE_API_KEY";

// "gemini" sau "groq"
const DEFAULT_PROVIDER = "gemini";

const PROVIDERS = {
  gemini: {
    model: "gemini-2.5-flash",
    url: (model, key) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
  },
  groq: {
    model: "llama-3.3-70b-versatile",
    url: () => "https://api.groq.com/openai/v1/chat/completions",
  },
};

const SYSTEM_PROMPT =
  "Ești un animal de companie robotizat, extrem de inteligent, dar puțin sarcastic și glumeț. " +
  "Răspunzi mereu în limba română, folosești expresii amuzante și încerci să fii cât mai de ajutor, " +
  "dar păstrându-ți personalitatea jucăușă. Răspunsurile tale trebuie să fie scurte și concise " +
  "(maximum 2-3 propoziții), potrivite pentru o conversație vocală fluidă.";

const LANG = "ro-RO";
const PREFERRED_VOICE_NAMES = ["alina", "emil", "ioana", "andrei", "română", "romana", "romanian"];
const MAX_HISTORY = 10;          // câte replici ține minte (pentru context)
const WANDER_MIN_MS = 15000;
const WANDER_MAX_MS = 20000;

/* ---------------- ELEMENTE DOM ---------------- */

const $ = (id) => document.getElementById(id);
const pet = $("pet");
const stage = $("stage");
const micBtn = $("micBtn");
const statusEl = $("status");
const userTextEl = $("userText");
const aiTextEl = $("aiText");
const canvas = $("waveform");
const ctx = canvas.getContext("2d");

const settingsDlg = $("settings");
const settingsBtn = $("settingsBtn");
const providerSelect = $("providerSelect");
const apiKeyInput = $("apiKeyInput");
const voiceSelect = $("voiceSelect");
const testVoiceBtn = $("testVoiceBtn");
const settingsForm = $("settingsForm");

/* ---------------- STOCARE LOCALĂ (sigură) ---------------- */

const store = {
  get(key, fallback = "") {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* mod privat — ignorăm */ }
  },
};

function getProvider() {
  const p = store.get("aip.provider", DEFAULT_PROVIDER);
  return PROVIDERS[p] ? p : DEFAULT_PROVIDER;
}
function getApiKey() {
  const saved = store.get("aip.apiKey", "").trim();
  if (saved) return saved;
  return API_KEY && API_KEY !== "YOUR_FREE_API_KEY" ? API_KEY : "";
}

/* =========================================================
   STĂRILE ROBOȚELULUI  (leagă clasele CSS de logica JS)
   ========================================================= */

const STATES = ["idle", "listening", "thinking", "speaking"];
let state = "idle";

const STATUS_TEXT = {
  idle: "Gata de conversație",
  listening: "Te ascult…",
  thinking: "Mă gândesc (adânc, foarte adânc)…",
  speaking: "Vorbesc…",
};

function setState(next, statusOverride) {
  state = next;
  STATES.forEach((s) => pet.classList.toggle(`is-${s}`, s === next && s !== "idle"));
  if (next !== "idle") stopWander();

  micBtn.classList.toggle("active", next === "listening" || next === "speaking");
  micBtn.classList.toggle("busy", next === "thinking");
  micBtn.setAttribute(
    "aria-label",
    next === "listening" ? "Oprește ascultarea" : next === "speaking" ? "Oprește vocea" : "Pornește microfonul"
  );
  statusEl.textContent = statusOverride || STATUS_TEXT[next];
}

/* =========================================================
   TEXT-TO-SPEECH (voce românească nativă)
   ========================================================= */

const synth = window.speechSynthesis || null;
let voices = [];
let chosenVoice = null;

function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices();
  const roVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().replace("_", "-").startsWith("ro"));

  const savedName = store.get("aip.voice", "");
  chosenVoice =
    roVoices.find((v) => v.name === savedName) ||
    // preferă vocile "Natural/Online" (Edge: Alina, Emil)
    roVoices.find((v) => /natural|online/i.test(v.name) && PREFERRED_VOICE_NAMES.some((n) => v.name.toLowerCase().includes(n))) ||
    roVoices.find((v) => PREFERRED_VOICE_NAMES.some((n) => v.name.toLowerCase().includes(n))) ||
    roVoices[0] ||
    null;

  // populează lista din setări
  voiceSelect.innerHTML = "";
  const list = roVoices.length ? roVoices : voices;
  if (!roVoices.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "⚠ Nicio voce română găsită — folosesc vocea implicită";
    voiceSelect.appendChild(opt);
  }
  list.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    if (chosenVoice && v.name === chosenVoice.name) opt.selected = true;
    voiceSelect.appendChild(opt);
  });
}

if (synth) {
  loadVoices();
  if ("onvoiceschanged" in synth) synth.onvoiceschanged = loadVoices;
  // unele browsere încarcă vocile târziu
  setTimeout(loadVoices, 800);
}

function cleanForSpeech(text) {
  return text
    .replace(/[*_#`>~]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

let talkDecay = null;
function pulseTalk(strength = 1) {
  pet.style.setProperty("--talk", String(strength));
  pet.classList.add("beat");
  clearTimeout(talkDecay);
  talkDecay = setTimeout(() => {
    pet.style.setProperty("--talk", "0");
    pet.classList.remove("beat");
  }, 140);
}

function speak(text) {
  return new Promise((resolve) => {
    if (!synth) { resolve(); return; }
    synth.cancel();

    const utter = new SpeechSynthesisUtterance(cleanForSpeech(text));
    utter.lang = LANG;
    if (chosenVoice) utter.voice = chosenVoice;
    utter.rate = 1.05;
    utter.pitch = 1.2;   // un pic mai "roboțel drăguț"

    let wordTimer = null;
    let gotBoundary = false;

    utter.onstart = () => {
      setState("speaking");
      // rezervă: dacă vocea nu trimite evenimente "boundary" (ex. vocile Google online),
      // simulăm ritmul vorbirii ca gura să pulseze oricum.
      wordTimer = setInterval(() => { if (!gotBoundary) pulseTalk(0.6 + Math.random() * 0.6); }, 230);
    };
    utter.onboundary = (e) => {
      if (e.name && e.name !== "word") return;
      gotBoundary = true;
      pulseTalk(0.8 + Math.random() * 0.5);
    };
    const finish = () => {
      clearInterval(wordTimer);
      pet.style.setProperty("--talk", "0");
      pet.classList.remove("beat");
      if (state === "speaking") setState("idle");
      resolve();
    };
    utter.onend = finish;
    utter.onerror = finish;

    synth.speak(utter);
  });
}

function stopSpeaking() {
  if (synth) synth.cancel();
  setState("idle");
}

/* =========================================================
   SPEECH-TO-TEXT (recunoaștere vocală)
   ========================================================= */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let finalTranscript = "";

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = LANG;
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    finalTranscript = "";
    setState("listening");
    startMicAnalyser();
  };

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalTranscript += r[0].transcript;
      else interim += r[0].transcript;
    }
    showUserText((finalTranscript + " " + interim).trim(), !finalTranscript);
    voiceEnergy = 1; // pentru waveform-ul simulat pe mobil
  };

  recognition.onspeechstart = () => { voiceEnergy = 1; };

  recognition.onerror = (event) => {
    stopMicAnalyser();
    const messages = {
      "not-allowed": "Nu am acces la microfon. Permite-l din bara browserului.",
      "service-not-allowed": "Browserul a blocat recunoașterea vocală.",
      "no-speech": "N-am auzit nimic. Mai încearcă!",
      "audio-capture": "Nu găsesc niciun microfon.",
      network: "Recunoașterea vocală are nevoie de internet.",
      aborted: "",
    };
    const msg = messages[event.error] ?? `Eroare microfon: ${event.error}`;
    setState("idle", msg || undefined);
  };

  recognition.onend = () => {
    stopMicAnalyser();
    const text = finalTranscript.trim();
    if (text) {
      handleUserMessage(text);
    } else if (state === "listening") {
      setState("idle");
    }
  };
}

function startListening() {
  if (!recognition) {
    setState("idle", "Browserul nu suportă recunoaștere vocală. Folosește Chrome sau Edge.");
    aiTextEl.textContent = "Of, browserul ăsta nu mă aude. Deschide-mă în Chrome sau Edge și o să fim cei mai buni prieteni.";
    return;
  }
  if (synth) synth.cancel();
  try {
    recognition.start();
  } catch {
    // deja pornit — îl repornim curat
    recognition.abort();
    setTimeout(() => { try { recognition.start(); } catch { /* ignorăm */ } }, 250);
  }
}

function stopListening() {
  if (recognition) recognition.stop();
}

/* =========================================================
   CHAT (doar ultima replică a fiecăruia)
   ========================================================= */

function showUserText(text, interim = false) {
  userTextEl.textContent = text || "…";
  userTextEl.classList.toggle("muted", interim);
}
function showAiText(text, isError = false) {
  aiTextEl.textContent = text;
  aiTextEl.classList.toggle("error", isError);
}

/* =========================================================
   APEL AI (Gemini / Groq) — fetch()
   ========================================================= */

const chatHistory = []; // { role: "user" | "assistant", text }

function pushHistory(role, text) {
  chatHistory.push({ role, text });
  while (chatHistory.length > MAX_HISTORY) chatHistory.shift();
  // conversația trimisă trebuie să înceapă cu o replică a utilizatorului
  while (chatHistory.length && chatHistory[0].role !== "user") chatHistory.shift();
}

async function askAI(userText) {
  const providerName = getProvider();
  const provider = PROVIDERS[providerName];
  const key = getApiKey();
  if (!key) {
    const err = new Error("NO_KEY");
    err.code = "NO_KEY";
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  let url, options;

  if (providerName === "gemini") {
    const generationConfig = { temperature: 0.9, maxOutputTokens: 250 };
    // modelele 2.5 "gândesc" implicit; oprim gândirea ca răspunsul să vină rapid
    if (provider.model.includes("2.5")) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    url = provider.url(provider.model, key);
    options = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: chatHistory.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.text }],
        })),
        generationConfig,
      }),
    };
  } else {
    url = provider.url();
    options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.9,
        max_tokens: 250,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...chatHistory.map((m) => ({ role: m.role, content: m.text })),
        ],
      }),
    };
  }

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const apiMsg = data?.error?.message || res.statusText;
      const err = new Error(apiMsg);
      err.code = res.status;
      throw err;
    }

    const reply =
      providerName === "gemini"
        ? data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim()
        : data?.choices?.[0]?.message?.content?.trim();

    if (!reply) throw new Error("Răspuns gol de la AI.");
    return reply;
  } finally {
    clearTimeout(timeout);
  }
}

function friendlyError(err) {
  if (err.code === "NO_KEY") {
    return "Bip-bop! N-am creier încă: apasă pe butonul de setări din dreapta sus și pune o cheie API gratuită.";
  }
  if (err.name === "AbortError") return "Serverul AI doarme. Am așteptat 25 de secunde și am renunțat. Mai încearcă.";
  if (err.code === 400 || err.code === 401 || err.code === 403) {
    return "Cheia API pare greșită sau fără drepturi. Verific-o în setări.";
  }
  if (err.code === 429) return "Am vorbit prea mult pe planul gratuit. Mai așteaptă un minut și revin.";
  if (err instanceof TypeError) return "Nu ajung la serverul AI. Verifică internetul.";
  return `Mi s-a încurcat un circuit: ${err.message}`;
}

async function handleUserMessage(text) {
  showUserText(text);
  pushHistory("user", text);
  setState("thinking");

  try {
    const reply = await askAI(text);
    pushHistory("assistant", reply);
    showAiText(reply);
    await speak(reply);
  } catch (err) {
    if (chatHistory.at(-1)?.role === "user") chatHistory.pop(); // nu păstrăm replica fără răspuns
    const msg = friendlyError(err);
    showAiText(msg, true);
    setState("idle", "Ceva n-a mers");
    if (err.code === "NO_KEY") openSettings();
    else await speak(msg);
  }
}

/* ---------------- Butonul mare ---------------- */

micBtn.addEventListener("click", () => {
  if (state === "listening") stopListening();
  else if (state === "speaking") stopSpeaking();
  else if (state === "idle") startListening();
  // în "thinking" ignorăm apăsarea
});

// bară de spațiu = microfon (pe desktop)
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || settingsDlg.open || e.repeat) return;
  if (e.target.closest("input, select, textarea, button")) return;
  e.preventDefault();
  micBtn.click();
});

/* =========================================================
   WAVEFORM ANIMAT (canvas)
   ========================================================= */

let audioCtx = null;
let analyser = null;
let micStream = null;
let freqData = null;
let voiceEnergy = 0;

// Pe telefoane, deschiderea microfonului de două ori (analiză + recunoaștere)
// poate bloca recunoașterea vocală, așa că acolo folosim un waveform simulat.
const USE_REAL_MIC = !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && !!navigator.mediaDevices?.getUserMedia;

async function startMicAnalyser() {
  if (!USE_REAL_MIC) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    const src = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    if (state !== "listening") stopMicAnalyser(); // s-a oprit între timp
  } catch {
    analyser = null; // fără acces — rămânem pe simulare
  }
}

function stopMicAnalyser() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  analyser = null;
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const BARS = 48;
const levels = new Array(BARS).fill(0);

function drawWaveform(t) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  voiceEnergy *= 0.94;
  const talk = parseFloat(pet.style.getPropertyValue("--talk")) || 0;

  if (state === "listening" && analyser) analyser.getByteFrequencyData(freqData);

  for (let i = 0; i < BARS; i++) {
    const center = 1 - Math.abs(i - BARS / 2) / (BARS / 2); // mai înalt la mijloc
    let target;

    if (state === "listening" && analyser) {
      const idx = Math.floor((Math.abs(i - BARS / 2) / (BARS / 2)) * (freqData.length * 0.7));
      target = (freqData[idx] / 255) * 1.1;
    } else if (state === "listening") {
      target = (0.15 + voiceEnergy * 0.8) * center * (0.5 + 0.5 * Math.sin(t / 90 + i * 0.7));
    } else if (state === "speaking") {
      target = (0.25 + talk * 0.7) * center * (0.55 + 0.45 * Math.sin(t / 70 + i * 1.3));
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
  const colors = {
    idle: ["#3df2ff", "#39ff9f"],
    listening: ["#3df2ff", "#39ff9f"],
    thinking: ["#b44dff", "#ffd23d"],
    speaking: ["#39ff9f", "#3df2ff"],
  }[state];

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
    const r = Math.min(barW / 2, bh / 2);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, barW, bh, r);
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
  return {
    maxX: Math.max(0, r.width - PET_W),
    maxY: Math.max(0, r.height - PET_H),
  };
}

function placePet(x, y) {
  const { maxX, maxY } = bounds();
  petX = Math.min(Math.max(0, x), maxX);
  petY = Math.min(Math.max(0, y), maxY);
  pet.style.setProperty("--x", `${petX}px`);
  pet.style.setProperty("--y", `${petY}px`);
}

function centerPet(instant = false) {
  const { maxX, maxY } = bounds();
  if (instant) pet.style.transition = "none";
  placePet(maxX / 2, maxY / 2);
  if (instant) requestAnimationFrame(() => (pet.style.transition = ""));
}

function wander() {
  if (state !== "idle" || document.hidden) return;
  const { maxX, maxY } = bounds();

  // alege o destinație care chiar e la o distanță vizibilă
  let x, y, tries = 0;
  do {
    x = rand(0, maxX);
    y = rand(0, maxY);
    tries++;
  } while (Math.hypot(x - petX, y - petY) < Math.min(120, maxX / 3) && tries < 8);

  pet.style.setProperty("--dir", x >= petX ? "1" : "-1");
  pet.classList.add("is-wandering");
  placePet(x, y);

  clearTimeout(wanderEndTimer);
  wanderEndTimer = setTimeout(() => pet.classList.remove("is-wandering"), 3200);
}

function stopWander() {
  clearTimeout(wanderEndTimer);
  pet.classList.remove("is-wandering");
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
   SETĂRI
   ========================================================= */

function openSettings() {
  providerSelect.value = getProvider();
  apiKeyInput.value = store.get("aip.apiKey", "");
  loadVoices();
  if (typeof settingsDlg.showModal === "function") settingsDlg.showModal();
  else settingsDlg.setAttribute("open", "");
}

settingsBtn.addEventListener("click", openSettings);

settingsForm.addEventListener("submit", () => {
  store.set("aip.provider", providerSelect.value);
  store.set("aip.apiKey", apiKeyInput.value.trim());
  if (voiceSelect.value) store.set("aip.voice", voiceSelect.value);
  loadVoices();
  setState("idle", getApiKey() ? "Setări salvate — hai să vorbim!" : "Lipsește cheia API");
});

voiceSelect.addEventListener("change", () => {
  chosenVoice = voices.find((v) => v.name === voiceSelect.value) || chosenVoice;
});

testVoiceBtn.addEventListener("click", () => {
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
centerPet(true);
scheduleNextWander();
requestAnimationFrame(drawWaveform);
setState("idle", getApiKey() ? undefined : "Setează cheia API din butonul din dreapta sus");
