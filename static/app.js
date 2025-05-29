// --- State & globals ---
let chatHistory = [];
let isRecordingActive = false;
let lastServerTranscript = "";
let audioContext, analyser, microphone, animationId;

// --- Spinner for thinking/loading state ---
function showThinkingSpinner(text = "Thinking...") {
    return `
        <span class="module-loading" style="font-size:1.2em; color:#888;">
            <svg width="24" height="24" viewBox="0 0 50 50" style="vertical-align:middle;">
                <circle cx="25" cy="25" r="20" fill="none" stroke="#888" stroke-width="5" stroke-linecap="round" stroke-dasharray="31.4 31.4" transform="rotate(-90 25 25)">
                    <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1s" repeatCount="indefinite"/>
                </circle>
            </svg>
            ${text}
        </span>
    `;
}

// --- Mic visualization ---
function startMicFeedback() {
    const btn = document.getElementById("recordBtn");
    if (!navigator.mediaDevices?.getUserMedia) return;

    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser();
            microphone = audioContext.createMediaStreamSource(stream);
            microphone.connect(analyser);

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            function animate() {
                analyser.getByteTimeDomainData(dataArray);
                const volume = Math.max(...dataArray) - 128;
                const intensity = Math.min(Math.abs(volume) / 128, 1);
                const glow = Math.floor(intensity * 50);
                btn.style.boxShadow = `0 0 ${glow}px red`;
                animationId = requestAnimationFrame(animate);
            }
            animate();
        })
        .catch(err => console.error("Mic access error:", err));
}

function stopMicFeedback() {
    if (animationId) cancelAnimationFrame(animationId);
    if (audioContext) audioContext.close();
    document.getElementById("recordBtn").style.boxShadow = "none";
}

// --- Utility ---
function escapeHtml(text) {
    return text.replace(/[&<>"']/g, function (m) {
        return ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[m];
    });
}
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// End Session Button
const endBtn = document.getElementById("endSessionBtn");
if (endBtn) {
    endBtn.addEventListener("click", async () => {
        console.log("End-Session button clicked");
        if (!confirm("End session and archive transcript?")) return;

        const sessionName = prompt("Enter a name for this session:", `session_${new Date().toISOString().replace(/[:.]/g, "_")}`);
        if (!sessionName) return;

        try {
            await SessionManager.endSession(sessionName);
            window.location.reload();
        } catch (err) {
            alert(err.message || "Failed to save session.");
        }
    });
} else {
    console.warn("⚠️ endSessionBtn not found in DOM!");
}

// BroadcastChannel for syncing state across tabs
const recordingChannel = new BroadcastChannel('recording_channel');

async function getRecordingStatus() {
    const res = await fetch('/recording_status');
    const data = await res.json();
    return data.is_recording;
}

async function setRecordBtnState(isRecording) {
    const btn = document.getElementById('recordBtn');
    if (!btn) return;
    btn.textContent = isRecording ? 'Stop Recording' : 'Start Recording';
    btn.classList.toggle('stop-button', isRecording);
    btn.classList.toggle('start-button', !isRecording);

    if (isRecording) {
        startMicFeedback(); // Start glow effect
    } else {
        stopMicFeedback(); // Stop glow effect
    }
}

async function toggleRecording() {
    const isRecording = await getRecordingStatus();
    if (isRecording) {
        await fetch('/stop_recording', { method: 'POST' });
        recordingChannel.postMessage({ isRecording: false });
        await setRecordBtnState(false);
    } else {
        await fetch('/start_recording', { method: 'POST' });
        recordingChannel.postMessage({ isRecording: true });
        await setRecordBtnState(true);
    }
}

// Listen for state changes from other tabs
recordingChannel.onmessage = (event) => {
    setRecordBtnState(event.data.isRecording);
};

// Ensure SessionManager is defined
if (typeof SessionManager === "undefined") {
    console.error("⚠️ SessionManager is not defined. Ensure SessionManager.js is loaded before app.js.");
}

document.addEventListener("DOMContentLoaded", function() {
    const hamburgerBtn = document.getElementById("hamburgerBtn");
    const mobileMenu = document.getElementById("mobileMenu");
    if (hamburgerBtn && mobileMenu) {
        hamburgerBtn.addEventListener("click", function() {
            mobileMenu.classList.toggle("open");
        });
        // Optional: close menu when clicking outside
        document.addEventListener("click", function(e) {
            if (!mobileMenu.contains(e.target) && !hamburgerBtn.contains(e.target)) {
                mobileMenu.classList.remove("open");
            }
        });
    }
});

document.addEventListener("DOMContentLoaded", async () => {
    console.log("Page loaded. Attempting to restore session...");

    if (typeof SessionManager !== "undefined") {
        try {
            await SessionManager.loadFromSession();
            console.log("Session data restored from server.");
        } catch (err) {
            console.error("Failed to restore session data from server:", err);
        }
    } else {
        console.error("⚠️ SessionManager is not defined. Ensure SessionManager.js is loaded before app.js.");
    }

    // --- Recording Button (all pages with recordBtn) ---
    const btn = document.getElementById('recordBtn');
    if (btn) {
        const isRecording = await getRecordingStatus();
        setRecordBtnState(isRecording);
        btn.onclick = toggleRecording;
    }
});