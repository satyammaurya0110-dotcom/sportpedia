let isLoginMode = true;
let authModalInstance = null;
let triggeredByVoice = false;
let currentSpeakingBtn = null;
let currentAudio = null;
let availableVoices = [];
const clientAudioCache = new Map(); // Instant browser-side audio cache

document.addEventListener("DOMContentLoaded", () => {
    const modalEl = document.getElementById("authModal");
    if (modalEl && typeof bootstrap !== "undefined") {
        authModalInstance = new bootstrap.Modal(modalEl);
    }

    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
        searchInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter") {
                triggeredByVoice = false;
                performSearch();
            }
        });
    }

    if ("speechSynthesis" in window) {
        availableVoices = window.speechSynthesis.getVoices();
        window.speechSynthesis.onvoiceschanged = () => {
            availableVoices = window.speechSynthesis.getVoices();
        };
    }

    window.addEventListener("beforeunload", () => {
        stopAllSpeech();
    });

    checkUserSession();
});

// --- VOICE SEARCH (MICROPHONE SPEECH-TO-TEXT) ---
function startVoiceSearch() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const voiceBtn = document.getElementById("voiceBtn");
    const searchInput = document.getElementById("searchInput");
    const voiceStatus = document.getElementById("voiceStatus");

    stopAllSpeech();

    if (!SpeechRecognition) {
        voiceStatus.textContent = "⚠️ Please open http://127.0.0.1:5000 in Chrome or Edge to use the microphone.";
        voiceStatus.classList.remove("d-none");
        return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-IN";
    recognition.interimResults = false;

    recognition.onstart = () => {
        voiceBtn.classList.add("listening");
        voiceStatus.textContent = "🎙️ Listening... Speak a sport or athlete name now";
        voiceStatus.classList.remove("d-none");
    };

    recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript.replace(/\.$/, "");
        searchInput.value = transcript;
        triggeredByVoice = true;
        performSearch();
    };

    recognition.onerror = (event) => {
        voiceStatus.textContent = "⚠️ Microphone error (" + event.error + "). Make sure you are in Chrome/Edge.";
        voiceStatus.classList.remove("d-none");
    };

    recognition.onend = () => {
        voiceBtn.classList.remove("listening");
        setTimeout(() => voiceStatus.classList.add("d-none"), 3000);
    };

    recognition.start();
}

// --- DEEP BARITONE DICTATION (INSTANT STREAM + PREFETCH) ---
function stopAllSpeech() {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
    }
    if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }
    if (currentSpeakingBtn) {
        currentSpeakingBtn.classList.remove("speaking");
        currentSpeakingBtn.innerHTML = `<i class="bi bi-volume-up-fill"></i> <span>Listen</span>`;
        currentSpeakingBtn = null;
    }
}

// Pre-fetches neural audio in the background as soon as search results render
async function preloadSpeech(text) {
    if (!text || clientAudioCache.has(text)) return;
    try {
        const res = await fetch(`/api/tts?text=${encodeURIComponent(text)}`);
        if (res.ok) {
            const blob = await res.blob();
            clientAudioCache.set(text, URL.createObjectURL(blob));
        }
    } catch (e) {
        // Ignore background prefetch errors
    }
}

function getDeepBaritoneVoice() {
    if (availableVoices.length === 0 && "speechSynthesis" in window) {
        availableVoices = window.speechSynthesis.getVoices();
    }
    const indianMale = availableVoices.find(v =>
        (v.lang.includes("en-IN") || v.lang.includes("hi-IN")) &&
        (v.name.toLowerCase().includes("prabhat") ||
         v.name.toLowerCase().includes("madhur") ||
         v.name.toLowerCase().includes("ravi") ||
         v.name.toLowerCase().includes("hemant") ||
         v.name.toLowerCase().includes("male"))
    );
    if (indianMale) return indianMale;

    const anyIndian = availableVoices.find(v => v.lang.includes("en-IN") || v.lang.includes("hi-IN"));
    if (anyIndian) return anyIndian;

    const englishMale = availableVoices.find(v =>
        v.lang.startsWith("en") &&
        (v.name.toLowerCase().includes("male") || v.name.toLowerCase().includes("david") || v.name.toLowerCase().includes("daniel"))
    );
    return englishMale || availableVoices[0] || null;
}

function speakWithBrowserFallback(text, btnElement) {
    if (!("speechSynthesis" in window)) {
        stopAllSpeech();
        return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const chosenVoice = getDeepBaritoneVoice();
    if (chosenVoice) {
        utterance.voice = chosenVoice;
        utterance.lang = chosenVoice.lang;
    } else {
        utterance.lang = "en-IN";
    }
    utterance.pitch = 0.68;
    utterance.rate = 0.92;
    utterance.volume = 1.0;

    btnElement.innerHTML = `<i class="bi bi-stop-circle-fill"></i> <span>Stop</span>`;
    utterance.onend = () => stopAllSpeech();
    utterance.onerror = () => stopAllSpeech();
    window.speechSynthesis.speak(utterance);
}

async function toggleSpeech(btnElement) {
    if (currentSpeakingBtn === btnElement) {
        stopAllSpeech();
        return;
    }

    stopAllSpeech();

    // Reads the article directly without "Ladies and gentlemen"
    const cleanText = btnElement.getAttribute("data-speech");

    currentSpeakingBtn = btnElement;
    btnElement.classList.add("speaking");

    try {
        // Use pre-fetched audio if ready, otherwise stream directly from /api/tts
        const audioSrc = clientAudioCache.get(cleanText) || `/api/tts?text=${encodeURIComponent(cleanText)}`;

        currentAudio = new Audio(audioSrc);
        currentAudio.preload = "auto";

        btnElement.innerHTML = `<i class="bi bi-stop-circle-fill"></i> <span>Stop</span>`;

        currentAudio.onended = () => {
            stopAllSpeech();
        };

        currentAudio.onerror = () => {
            speakWithBrowserFallback(cleanText, btnElement);
        };

        await currentAudio.play();
    } catch (err) {
        console.warn("Using browser baritone fallback:", err);
        speakWithBrowserFallback(cleanText, btnElement);
    }
}

// --- SEARCH EXECUTION & ANIMATED RENDERING ---
async function performSearch(customQuery = null) {
    stopAllSpeech();

    const searchInput = document.getElementById("searchInput");
    const query = customQuery !== null ? customQuery : searchInput.value.trim();
    if (customQuery !== null) {
        searchInput.value = customQuery;
        triggeredByVoice = false;
    }

    const container = document.getElementById("resultsContainer");
    const countContainer = document.getElementById("resultsCount");

    if (!query) {
        container.innerHTML = `<div class="text-center text-secondary py-5"><h5>Enter or speak a topic to search the encyclopedia.</h5></div>`;
        countContainer.innerHTML = "";
        return;
    }

    container.innerHTML = `
        <div class="text-center py-5">
            <div class="spinner-border text-primary" role="status"></div>
            <p class="mt-2 small text-secondary font-monospace">Querying compiled C engine...</p>
        </div>`;

    try {
        const response = await fetch(`/search?q=${encodeURIComponent(query)}`);
        const data = await response.json();

        loadSearchHistory();

        if (!data || data.length === 0 || (data.length === 1 && data[0].id === -1)) {
            container.innerHTML = `
                <div class="result-card text-center py-4">
                    <h4 class="text-warning mb-2"><i class="bi bi-search"></i> No matches found for "${query}"</h4>
                    <p class="text-secondary small mb-0">Try searching for 'Virat', 'Messi', 'Cricket', 'Olympics', or 'Hamilton'.</p>
                </div>`;
            countContainer.innerHTML = "";
            return;
        }

        countContainer.innerHTML = `Found <strong>${data.length}</strong> record(s) for "<strong>${query}</strong>"`;
        let htmlOutput = "";

        data.forEach((item, index) => {
            const delay = index * 0.08;
            // Clean, direct article narration
            const rawSpeechText = `${item.title}. ${item.snippet}`;
            const escapedSpeechText = rawSpeechText.replace(/"/g, "&quot;");

            // Pre-fetch the top 2 results in the background so clicking "Listen" has zero delay
            if (index < 2) {
                preloadSpeech(rawSpeechText);
            }

            htmlOutput += `
                <div class="result-card" style="animation-delay: ${delay}s">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <span class="badge-category">${item.category || "Sports"}</span>
                        <div class="d-flex align-items-center gap-2">
                            <button type="button" class="speak-btn" onclick="toggleSpeech(this)" data-speech="${escapedSpeechText}" title="Read aloud">
                                <i class="bi bi-volume-up-fill"></i> <span>Listen</span>
                            </button>
                            <span class="text-secondary font-monospace small">Record #${item.id}</span>
                        </div>
                    </div>
                    <h3 class="h4 text-white fw-bold mb-2">${item.title}</h3>
                    <p class="text-light opacity-75 mb-0">${item.snippet}</p>
                </div>`;
        });

        container.innerHTML = htmlOutput;

        if (triggeredByVoice) {
            triggeredByVoice = false;
            const firstSpeakBtn = container.querySelector(".speak-btn");
            if (firstSpeakBtn) {
                toggleSpeech(firstSpeakBtn);
            }
        }
    } catch (err) {
        console.error(err);
        container.innerHTML = `<div class="alert alert-danger">Error communicating with C search backend.</div>`;
    }
}

// --- USER AUTHENTICATION & CLOUD HISTORY ---
async function checkUserSession() {
    try {
        const res = await fetch("/api/me");
        const data = await res.json();
        const authArea = document.getElementById("authArea");
        const historySection = document.getElementById("historySection");

        if (data.logged_in) {
            authArea.innerHTML = `
                <span class="text-light small me-2"><i class="bi bi-person-check-fill text-primary"></i> <strong>${data.username}</strong></span>
                <button class="btn btn-sm btn-outline-light rounded-pill px-3" onclick="logoutUser()">Logout</button>
            `;
            historySection.classList.remove("d-none");
            loadSearchHistory();
        } else {
            authArea.innerHTML = `
                <button class="btn btn-sm btn-outline-primary rounded-pill px-3 me-2" onclick="openAuthModal(true)">Login</button>
                <button class="btn btn-sm btn-primary rounded-pill px-3" onclick="openAuthModal(false)">Create Account</button>
            `;
            historySection.classList.add("d-none");
        }
    } catch (err) {
        console.error("Session check error:", err);
    }
}

function openAuthModal(loginMode) {
    isLoginMode = loginMode;
    document.getElementById("authModalTitle").textContent = loginMode ? "Welcome Back" : "Create Sportpedia Account";
    document.getElementById("authSubmitBtn").textContent = loginMode ? "Login" : "Sign Up";
    document.getElementById("authToggleText").innerHTML = loginMode
        ? `Don't have an account? <a href="#" onclick="openAuthModal(false); return false;" class="text-primary">Sign Up</a>`
        : `Already have an account? <a href="#" onclick="openAuthModal(true); return false;" class="text-primary">Login</a>`;
    document.getElementById("authError").classList.add("d-none");

    const modalEl = document.getElementById("authModal");
    if (!authModalInstance && modalEl && typeof bootstrap !== "undefined") {
        authModalInstance = new bootstrap.Modal(modalEl);
    }
    if (authModalInstance) {
        authModalInstance.show();
    }
}

async function submitAuthForm(event) {
    event.preventDefault();
    const username = document.getElementById("authUsername").value.trim();
    const password = document.getElementById("authPassword").value.trim();
    const errorBox = document.getElementById("authError");

    const endpoint = isLoginMode ? "/api/login" : "/api/register";
    const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (!res.ok) {
        errorBox.textContent = data.error || "Authentication failed";
        errorBox.classList.remove("d-none");
        return;
    }

    document.getElementById("authForm").reset();
    if (authModalInstance) authModalInstance.hide();
    checkUserSession();
}

async function logoutUser() {
    await fetch("/api/logout", { method: "POST" });
    checkUserSession();
}

async function loadSearchHistory() {
    try {
        const res = await fetch("/api/history");
        const history = await res.json();
        const listEl = document.getElementById("historyList");

        if (!history || history.length === 0) {
            listEl.innerHTML = `<span class="text-secondary small">Your recent searches will appear here.</span>`;
            return;
        }

        listEl.innerHTML = history
            .map(q => `<span class="history-chip" onclick="performSearch('${q.replace(/'/g, "\\'")}')"><i class="bi bi-clock-history"></i> ${q}</span>`)
            .join("");
    } catch (err) {
        console.error("History load error:", err);
    }
}

async function clearSearchHistory() {
    await fetch("/api/history", { method: "DELETE" });
    loadSearchHistory();
}