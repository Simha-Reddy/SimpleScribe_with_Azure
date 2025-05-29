document.addEventListener("DOMContentLoaded", async () => {
    console.log("Initializing Settings page...");

    // Load the patient instructions prompt into the editor
    loadPatientInstructionsPrompt();
    document.getElementById("savePatientInstructionsPromptBtn").onclick = savePatientInstructionsPrompt;
    document.getElementById("clearPatientInstructionsPromptBtn").onclick = clearPatientInstructionsPrompt;
    document.getElementById("resetPatientInstructionsPromptBtn").onclick = resetPatientInstructionsPrompt;
    
    // Load the list of custom templates
    loadCustomTemplateList();

    // Automatically load the selected template into the editor
    const customTemplateDropdown = document.getElementById("customTemplateDropdown");
    if (customTemplateDropdown) {
        customTemplateDropdown.addEventListener("change", async () => {
            const selectedTemplate = customTemplateDropdown.value;
            if (selectedTemplate) {
                await loadCustomTemplateForEdit(selectedTemplate);
            } else {
                clearCustomTemplateEditor(); // Clear the editor if no template is selected
            }
        });
    }

    // Load the list of modules
    loadModuleList();

    // Automatically load the selected module into the edit area
    const moduleDropdown = document.getElementById("moduleDropdown");
    if (moduleDropdown) {
        moduleDropdown.addEventListener("change", async () => {
            const selectedModule = moduleDropdown.value;
            if (selectedModule) {
                await loadModuleForEdit(selectedModule);
            } else {
                clearModuleEditor(); // Clear the editor if no module is selected
            }
        });
    }
});

// --- Custom Prompt Template Functions ---
async function loadCustomTemplateList() {
    const dropdown = document.getElementById("customTemplateDropdown");
    if (!dropdown) return;
    dropdown.innerHTML = '<option value="">-- Choose a template --</option>';
    const resp = await fetch("/list_custom_templates");
    const templates = await resp.json();
    templates.forEach(name => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        dropdown.appendChild(opt);
    });
}

async function loadCustomTemplateForEdit(name) {
    const resp = await fetch(`/load_template/${encodeURIComponent(name)}`);
    const text = await resp.text();
    document.getElementById("customTemplateName").value = name;
    document.getElementById("customTemplateText").value = text;
}

function clearCustomTemplateEditor() {
    document.getElementById("customTemplateName").value = "";
    document.getElementById("customTemplateText").value = "";
}

async function saveCustomTemplate() {
    const name = document.getElementById("customTemplateName").value.trim();
    const text = document.getElementById("customTemplateText").value.trim();
    if (!name) {
        alert("Please enter a template name.");
        return;
    }
    await fetch("/save_template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, text })
    });
    alert("Template saved.");
    loadCustomTemplateList();
}

async function deleteCustomTemplate() {
    const name = document.getElementById("customTemplateName").value.trim();
    if (!name) {
        alert("Please select a template to delete.");
        return;
    }
    if (confirm(`Delete template "${name}"?`)) {
        await fetch(`/delete_template/${encodeURIComponent(name)}`, { method: "DELETE" });
        loadCustomTemplateList();
        clearCustomTemplateEditor();
        alert("Template deleted.");
    }
}

// --- Patient Instructions Prompt Functions ---
async function loadPatientInstructionsPrompt() {
    const resp = await fetch("/load_patient_instructions_prompt");
    const text = await resp.ok ? await resp.text() : "";
    document.getElementById("patientInstructionsPromptText").value = text;
}

async function savePatientInstructionsPrompt() {
    const text = document.getElementById("patientInstructionsPromptText").value.trim();
    await fetch("/save_patient_instructions_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
    });
    document.getElementById("patientInstructionsPromptStatus").textContent = "Saved!";
    setTimeout(() => {
        document.getElementById("patientInstructionsPromptStatus").textContent = "";
    }, 2000);
}

function clearPatientInstructionsPrompt() {
    document.getElementById("patientInstructionsPromptText").value = "";
    document.getElementById("patientInstructionsPromptStatus").textContent = "";
}

async function resetPatientInstructionsPrompt() {
    const resp = await fetch("/default_patient_instructions_prompt");
    if (resp.ok) {
        const text = await resp.text();
        document.getElementById("patientInstructionsPromptText").value = text;
        document.getElementById("patientInstructionsPromptStatus").textContent = "Reset to default!";
        setTimeout(() => {
            document.getElementById("patientInstructionsPromptStatus").textContent = "";
        }, 2000);
    } else {
        document.getElementById("patientInstructionsPromptStatus").textContent = "Could not load default.";
    }
}

// --- Smart Module Editor functions ---
async function loadModuleList() {
    const dropdown = document.getElementById("moduleDropdown");
    if (!dropdown) return;
    dropdown.innerHTML = '<option value="">-- Choose a module --</option>';
    const resp = await fetch("/list_modules");
    const files = await resp.json();
    files.forEach(name => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        dropdown.appendChild(opt);
    });
}

async function loadModuleForEdit(name) {
    const resp = await fetch(`/load_module/${encodeURIComponent(name)}`);
    const text = await resp.text();
    document.getElementById("moduleFileName").value = name;
    // Parse fields from file
    document.getElementById("moduleTitle").value = (text.match(/^Title:\s*(.*)$/m)||[])[1]||"";
    document.getElementById("moduleOutput").value = (text.match(/^Output:\s*(.*)$/m)||[])[1]||"";
    document.getElementById("moduleChain").value = (text.match(/^Chain:\s*(.*)$/m)||[])[1]||"";
    // Inputs
    const inputChecks = document.querySelectorAll("#moduleInputs input[type=checkbox]");
    inputChecks.forEach(cb => cb.checked = false);
    (text.match(/^\[([ Xx])\]\s*(\w+)/gm)||[]).forEach(line => {
        const m = line.match(/^\[([ Xx])\]\s*(\w+)/);
        if (m && (m[1] === "X" || m[1] === "x")) {
            const cb = document.querySelector(`#moduleInputs input[value="${m[2]}"]`);
            if (cb) cb.checked = true;
        }
    });
    document.getElementById("moduleQuery").value = (text.match(/^Query:\s*(.*)$/m)||[])[1]||"";
    document.getElementById("moduleAIPrompt").value = (text.match(/^AI Prompt:\s*([\s\S]*)$/m)||[])[1]||"";
}

async function editSelectedModule() {
    const dropdown = document.getElementById("moduleDropdown");
    const name = dropdown.value;
    if (!name) {
        alert("Please select a module to edit.");
        return;
    }
    await loadModuleForEdit(name);
}

async function deleteSelectedModule() {
    const dropdown = document.getElementById("moduleDropdown");
    const name = dropdown.value;
    if (!name) {
        alert("Please select a module to delete.");
        return;
    }
    if (confirm(`Delete module "${name}"?`)) {
        await fetch(`/delete_module/${encodeURIComponent(name)}`, { method: "DELETE" });
        loadModuleList();
        clearModuleEditor();
        alert("Module deleted.");
    }
}

function clearModuleEditor() {
    document.getElementById("moduleFileName").value = "";
    document.getElementById("moduleTitle").value = "";
    document.getElementById("moduleOutput").value = "";
    document.getElementById("moduleChain").value = "";
    document.querySelectorAll("#moduleInputs input[type=checkbox]").forEach(cb => cb.checked = false);
    document.getElementById("moduleQuery").value = "";
    document.getElementById("moduleAIPrompt").value = "";
}

async function saveModule() {
    const name = document.getElementById("moduleFileName").value.trim();
    if (!name.endsWith(".txt")) {
        alert("Filename must end with .txt");
        return;
    }
    const title = document.getElementById("moduleTitle").value.trim();
    const output = document.getElementById("moduleOutput").value.trim();
    const chain = document.getElementById("moduleChain").value.trim();
    const inputs = Array.from(document.querySelectorAll("#moduleInputs input[type=checkbox]:checked")).map(cb => cb.value);
    const query = document.getElementById("moduleQuery").value.trim();
    const aiPrompt = document.getElementById("moduleAIPrompt").value.trim();

    // Enforce Output matches filename (without .txt)
    const expectedOutput = name.replace(/\.txt$/i, "");
    if (output !== expectedOutput) {
        alert(`Output must match the filename (without .txt): "${expectedOutput}"`);
        document.getElementById("moduleOutput").value = expectedOutput;
        return;
    }

    let content = `Title: ${title}\nOutput: ${output}\n`;
    if (chain) content += `Chain: ${chain}\n`;
    inputs.forEach(input => content += `[X] ${input}\n`);
    content += `\nQuery: ${query}\nAI Prompt: ${aiPrompt}\n`;

    await fetch("/save_module", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content })
    });
    alert("Module saved.");
    loadModuleList();
}

// Auto-fill Output when typing filename
const moduleFileNameInput = document.getElementById("moduleFileName");
if (moduleFileNameInput) {
    moduleFileNameInput.addEventListener("input", function() {
        const fname = this.value.trim();
        if (fname.endsWith(".txt")) {
            document.getElementById("moduleOutput").value = fname.replace(/\.txt$/i, "");
        } else {
            document.getElementById("moduleOutput").value = fname;
        }
    });
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