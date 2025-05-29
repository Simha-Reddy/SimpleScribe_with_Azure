document.addEventListener("DOMContentLoaded", async () => {
    console.log("Initializing Scribe page...");

    // Restore session data
    if (typeof SessionManager !== "undefined") {
        try {
            await SessionManager.loadFromSession();
            console.log("Session data restored from server.");
        } catch (err) {
            console.error("Failed to restore session data from server:", err);
        }
    }

    // --- AUTOSAVE on input changes ---
    const autosaveFields = [
        "visitNotes",
        "patientInstructionsBox",
        "promptPreview",
        "feedbackInput"
    ];
    autosaveFields.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener("input", async () => {
                if (typeof SessionManager !== "undefined" && SessionManager.saveToSession) {
                    await SessionManager.saveToSession();
                }
            });
        }
    });

    // --- Patient Instructions ---
    const genBtn = document.getElementById("generatePatientInstructionsBtn");
    const printBtn = document.getElementById("printPatientInstructionsBtn");
    const instructionsBox = document.getElementById("patientInstructionsBox");
    const previewDiv = document.getElementById("patientInstructionsPreview");

    if (instructionsBox && previewDiv) {
        // Live preview of Markdown
        instructionsBox.addEventListener("input", function () {
            previewDiv.innerHTML = marked.parse(instructionsBox.value);
        });
    }

    if (genBtn && instructionsBox) {
        genBtn.onclick = generatePatientInstructions;
    }

    if (printBtn && instructionsBox) {
        printBtn.onclick = async function () {
            const html = previewDiv ? previewDiv.innerHTML : "";
            const win = window.open("", "_blank");
            win.document.write(`
                <html>
                <head>
                    <title>Patient Instructions</title>
                    <style>
                        body { font-family: 'Segoe UI', Arial, sans-serif; margin: 40px; }
                        h2 { color: #3498db; }
                        .markdown-body { font-size: 1.1em; }
                    </style>
                </head>
                <body>
                    <h2>Patient Instructions</h2>
                    <div class="markdown-body">${html}</div>
                </body>
                </html>
            `);
            win.document.close();
            win.focus();
            setTimeout(() => win.print(), 500);
        };
    }

    // --- Poll Scribe Status ---
    pollScribeStatus();
    setInterval(pollScribeStatus, 3000);

    // --- Prompt Selector ---
    loadPrompts();
});

// --- Poll Scribe Status ---
function pollScribeStatus() {
    const transcriptEl = document.getElementById("rawTranscript");
    if (!transcriptEl) return;

    fetch('/live_transcript')
        .then(res => res.text())
        .then(text => {
            transcriptEl.value = text;
            transcriptEl.scrollTop = transcriptEl.scrollHeight;
        })
        .catch(err => console.error('Error polling live transcript:', err));

    // (Optional) Keep status indicator logic if you want
    fetch('/scribe_status')
        .then(r => r.json())
        .then(data => {
            const statusEl = document.getElementById('statusIndicator');
            if (statusEl) {
                if (data.is_recording) {
                    statusEl.textContent = 'Recording...';
                } else if (data.pending_chunks > 0) {
                    statusEl.textContent = 'Transcribing...';
                } else {
                    statusEl.textContent = '';
                }
            }
        })
        .catch(err => console.error('Error polling status:', err));
}

// --- Create Note & chat feedback ---
async function createNote() {
    console.log("createNote fired");

    const transcript = document.getElementById("rawTranscript").value;
    const visitNotes  = document.getElementById("visitNotes").value;
    const promptText = document.getElementById("promptPreview").value;    // <-- full prompt
    const noteBox    = document.getElementById("feedbackReply");

    noteBox.innerText = "Loading…";

    const res = await fetch('/create_note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            transcript:   transcript,
            visit_notes:   visitNotes,
            prompt_text:  promptText
        })
    });

    const data = await res.json();
    noteBox.innerText  = data.note;
    // Autosave after feedback reply is updated
    if (typeof SessionManager !== "undefined" && SessionManager.saveToSession) {
        await SessionManager.saveToSession();
    }
    chatHistory        = data.messages || [
        { role: "system",    content: "Note‐edit session" },
        { role: "assistant", content: data.note }
    ];
}


async function submitFeedback() {
  const input    = document.getElementById("feedbackInput");
  const replyDiv = document.getElementById("feedbackReply");
  const userMsg  = input.value.trim();
  if (!userMsg) return;

  // 1) Disable the input and show loading text
  input.disabled     = true;
  const oldPlaceholder = input.placeholder;
  input.placeholder  = "Loading AI response…";
  replyDiv.innerText = "Loading…";

  // 2) Send the request
  chatHistory.push({ role: 'user', content: userMsg });
  let data;
  try {
    const res = await fetch('/chat_feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory })
    });
    data = await res.json();
  } catch (err) {
    replyDiv.innerText = "Error: " + err.message;
    data = { reply: "" };
  }

  // 3) Display the reply
  if (data.reply) {
    chatHistory.push({ role: 'assistant', content: data.reply });
    replyDiv.innerText = data.reply;
  }

  // 4) Re-enable the input and restore placeholder
  input.disabled    = false;
  input.placeholder = oldPlaceholder;
  input.value       = "";
  input.focus();
}


// --- Copy final note ---
function copyFinalNote() {
  const txt = document.getElementById("feedbackReply").innerText;
  navigator.clipboard.writeText(txt)
    .then(() => alert("Final note copied!"))
    .catch(() => alert("Copy failed"));
}

// --- Prompt & custom template loaders ---
let promptData = {};  // <-- store all name→text mappings

function loadPrompts() {
    fetch("/get_prompts")
        .then(r => r.json())
        .then(data => {
            const sel = document.getElementById("promptSelector");
            const preview = document.getElementById("promptPreview");
            if (!sel || !preview) {
                console.error("promptSelector or promptPreview not found!");
                return;
            }

            // Clear out any old options
            sel.innerHTML = "";

            // Populate options
            for (let name in data) {
                const opt = document.createElement("option");
                opt.value = name;
                opt.text = name;
                sel.appendChild(opt);
            }

            // Restore last choice (or default to first)
            const last = localStorage.getItem("lastPrompt");
            if (last && data[last]) {
                sel.value = last;
            }
            // Set initial preview
            preview.value = data[sel.value] || "";

            // Update preview on selection change
            sel.addEventListener("change", () => {
                const v = sel.value;
                preview.value = data[v] || "";
                localStorage.setItem("lastPrompt", v);
            });
        })
        .catch(err => console.error("Error loading prompts:", err));
}

function saveCustomTemplate() {
    const name = document.getElementById("customTemplateName").value;
    const text = document.getElementById("customTemplateText").value;
    fetch("/save_template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, text })
    })
    .then(response => {
        if (response.redirected) {
            window.location.href = response.url;
        } else {
            alert("Saved.");
        }
    });
}

let customTemplates = {};  // name → text

function loadCustomTemplateList() {
  const ul = document.getElementById("customTemplateList");
  ul.innerHTML = "";

  fetch("/list_custom_templates")
    .then(r => r.json())
    .then(names => {
      names.forEach(name => {
        // list item
        const li = document.createElement("li");
        li.style.marginBottom = "8px";

        // show button
        const showBtn = document.createElement("button");
        showBtn.textContent = "Show";
        showBtn.style.marginRight = "8px";

        // when clicked, fetch & display the template
        showBtn.addEventListener("click", () => {
          // if we already loaded it, just toggle visibility
          if (customTemplates[name]) {
            editor.style.display = editor.style.display === "none" ? "block" : "none";
            textarea.value   = customTemplates[name];
            return;
          }

          // else fetch it
          fetch(`/load_template/${encodeURIComponent(name)}`)
            .then(res => res.text())
            .then(text => {
              customTemplates[name] = text;
              textarea.value       = text;
              editor.style.display = "block";
            })
            .catch(err => console.error("Error loading template:", err));
        });

        // name label
        const nameSpan = document.createElement("span");
        nameSpan.textContent = name;
        nameSpan.style.marginRight = "12px";

        // hidden editor div
        const editor = document.createElement("div");
        editor.style.display = "none";
        editor.style.marginTop = "6px";

        // textarea for preview/edit
        const textarea = document.createElement("textarea");
        textarea.rows = 6;
        textarea.style.width = "100%";
        textarea.value = "";  // filled in on demand

        // save + delete buttons
        const saveBtn = document.createElement("button");
        saveBtn.textContent = "Save";
        saveBtn.style.marginRight = "6px";
        saveBtn.addEventListener("click", () => {
          fetch("/save_template", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, text: textarea.value })
          }).then(() => {
            customTemplates[name] = textarea.value;
            alert("Saved.");
          });
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", () => {
          if (!confirm(`Delete "${name}"?`)) return;
          fetch(`/delete_template/${encodeURIComponent(name)}`, { method: "DELETE" })
            .then(() => loadCustomTemplateList());
        });

        editor.append(textarea, saveBtn, deleteBtn);
        li.append(showBtn, nameSpan, editor);
        ul.appendChild(li);
      });
    })
    .catch(err => console.error("Error loading custom templates:", err));
}

async function generatePatientInstructions() {
    const instructionsBox = document.getElementById("patientInstructionsBox");
    const previewDiv = document.getElementById("patientInstructionsPreview");
    instructionsBox.value = "Loading patient instructions...";
    const transcript = document.getElementById("rawTranscript").value;
    const visitNotes = document.getElementById("visitNotes").value;

    // Fetch the patient instructions prompt template
    const promptTemplate = await fetch('/load_patient_instructions_prompt')
        .then(res => res.ok ? res.text() : "");

    // Add instruction for Markdown output
    const mdInstruction = "Please format your output as Markdown (using -, *, **, etc. as appropriate) for clear printing.\n\n";
    const prompt = mdInstruction +
        promptTemplate
            .replace(/\{\{transcript\}\}/g, transcript)
            .replace(/\{\{visit_notes\}\}/g, visitNotes);

    try {
        const res = await fetch('/create_note', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcript, visit_notes: visitNotes, prompt_text: prompt })
        });
        const data = await res.json();
        // Render as Markdown
        instructionsBox.value = data.note || ""; // Fill textarea for further editing
        if (previewDiv) {
            previewDiv.innerHTML = marked.parse(instructionsBox.value);
        }
        if (typeof SessionManager !== "undefined" && SessionManager.saveToSession) {
            await SessionManager.saveToSession();
        }
    } catch (err) {
        console.error("Error generating patient instructions:", err);
        instructionsBox.value = "Error generating instructions.";
    }
}