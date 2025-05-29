document.addEventListener("DOMContentLoaded", async () => {
    console.log("Initializing Explore page...");

    // Restore session data
    if (typeof SessionManager !== "undefined") {
        try {
            await SessionManager.loadFromSession();
            console.log("Session data restored from server.");
        } catch (err) {
            console.error("Failed to restore session data from server:", err);
        }
    }

    // Load dynamic modules
    try {
        await loadModules();
    } catch (err) {
        console.error("Failed to load modules:", err);
    }

    // Restore module results if available
    if (typeof SessionManager !== "undefined" && SessionManager.lastLoadedData) {
        if (SessionManager.lastLoadedData.explore && SessionManager.lastLoadedData.explore.moduleResults) {
            SessionManager.restoreModuleResults(SessionManager.lastLoadedData.explore.moduleResults);
        }
    }

    // --- AUTOSAVE on input changes ---
    const autosaveFields = [
        "chunkText",
        "exploreSearchBox",
        "invertedSearchBox"
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

    // Handle chart embedding
    const embedBtn = document.getElementById("embedChartBtn");
    if (embedBtn) {
        embedBtn.onclick = async function () {
            const chartText = document.getElementById("chunkText").value;
            try {
                const res = await fetch("/process_chart_chunk", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: chartText })
                });
                if (res.ok) {
                    console.log("Chart data embedded successfully.");
                } else {
                    console.error("Failed to embed chart data.");
                }
            } catch (err) {
                console.error("Error embedding chart data:", err);
            }
        };
    }

    // Initialize drop zone for PDF input
    const dropZone = document.getElementById("dropZone");
    if (dropZone) {
        const textArea = document.getElementById("chunkText");
        const status = document.getElementById("chunkStatus");

        // Drop zone event handlers
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
            document.body.addEventListener(eventName, preventDefaults, false);
        });

        // Handle drag enter/leave
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, highlight, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, unhighlight, false);
        });

        // Handle drops
        dropZone.addEventListener('drop', handleDrop, false);

        function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
        }

        let dragCounter = 0;

        function highlight(e) {
            dragCounter++;
            dropZone.classList.add('dragging');
        }
        
        function unhighlight(e) {
            // If dropping, always reset
            if (e.type === "drop") {
                dragCounter = 0;
                dropZone.classList.remove('dragging');
                return;
            }
            // For dragleave, only remove highlight if leaving the drop zone entirely
            if (e.type === "dragleave") {
                // If relatedTarget is null (left window) or not a child of dropZone
                if (!e.relatedTarget || !dropZone.contains(e.relatedTarget)) {
                    dragCounter = 0;
                    dropZone.classList.remove('dragging');
                } else {
                    dragCounter = Math.max(0, dragCounter - 1);
                    if (dragCounter === 0) {
                        dropZone.classList.remove('dragging');
                    }
                }
            }
        }

        async function handleDrop(e) {
            const dt = e.dataTransfer;
            const file = dt.files[0];

            if (file && file.type === 'application/pdf') {
                status.textContent = "Processing PDF...";

                const formData = new FormData();
                formData.append('pdf', file);

                try {
                    const response = await fetch('/upload_pdf', {
                        method: 'POST',
                        body: formData
                    });

                    const data = await response.json();
                    if (data.error) {
                        status.textContent = `Error: ${data.error}`;
                    } else {
                        textArea.value = data.text;
                        status.textContent = "PDF processed successfully!";
                        updateChartPagesFromChunkText(); // Call the function to update chart pages
                        if (typeof SessionManager !== "undefined") {
                            await SessionManager.saveToSession(); // Save session after processing
                        }
                    }
                } catch (err) {
                    status.textContent = `Error: ${err.message}`;
                }
            } else {
                status.textContent = "Please drop a PDF file.";
            }
        }
    }

    // Wire up the Keyword Search button to open the modal
    const openKeywordModalBtn = document.getElementById("openKeywordModalBtn");
    if (openKeywordModalBtn) {
        openKeywordModalBtn.addEventListener("click", function () {
            // Optionally reset the modal input
            const modalKeywordInput = document.getElementById("modalKeywordInput");
            if (modalKeywordInput) {
                modalKeywordInput.value = "";
                modalKeywordInput.dispatchEvent(new Event('input'));
                modalKeywordInput.focus();
            }
            // Show the modal (you may need to implement openChartModal or similar)
            if (typeof openChartModal === "function") {
                openChartModal(0, null, "");
            } else {
                // Fallback: just show the modal if you use display:none/block
                document.getElementById("chartModal").style.display = "block";
            }
        });
    }

    // OpenAI Query with Markdown & Clickable Citations
    const exploreSearchBox = document.getElementById("exploreSearchBox");
    if (exploreSearchBox) {
        exploreSearchBox.addEventListener("keypress", async (e) => {
            if (e.key === "Enter") {
                await runExploreSearch();
            }
        });
    }
});
    // --- Modal Keyword Search Across All Pages ---

let modalMatches = []; // {page: N, index: charIndex}
let modalCurrentIdx = 0;

// Find all matches for the keyword across all pages
function findAllModalMatches(query) {
    modalMatches = [];
    if (!query) return;
    const regex = new RegExp(escapeRegExp(query), "gi");
    chartPages.forEach((pageText, pageIdx) => {
        let match;
        while ((match = regex.exec(pageText)) !== null) {
            modalMatches.push({ page: pageIdx, index: match.index, length: match[0].length });
        }
    });
}

// Render the modal page, highlighting only the current match on that page
function renderChartModalPage(pageIdx, highlightSectionName, keyword) {
    if (pageIdx < 0 || pageIdx >= chartPages.length) return;
    const contentDiv = document.getElementById("chartModalContent");
    let pageText = chartPages[pageIdx];

    // Insert page number at the top if not present
    let pageNumLabel = `**Page ${pageIdx + 1}**\n\n`;
    pageText = pageText.replace(/^Page\s+\d+\s+of\s+\d+\s*/i, "");
    pageText = pageNumLabel + pageText;

    // Bold section headers and add spacing
    pageText = pageText.replace(
        /\n([A-Z0-9\s\-\(\)/,\.]+[:\-])\s*\n/g,
        function(_, header) {
            return `\n\n### ${header.trim()}\n\n`;
        }
    );

    // Add extra spacing for signatures, dates, etc.
    pageText = pageText.replace(/(\n\s*)(Signed by[^\n]*)/gi, "\n\n---\n\n$2\n\n---\n\n");
    pageText = pageText.replace(/(\n\s*)(Electronically signed[^\n]*)/gi, "\n\n---\n\n$2\n\n---\n\n");
    pageText = pageText.replace(/(\n\s*)(Attending: [^\n]*)/gi, "\n\n$2\n\n");
    pageText = pageText.replace(/(\n\s*)(Date[:\-][^\n]*)/gi, "\n\n$2\n\n");
    pageText = pageText.replace(/(\n\s*)(DOB[:\-][^\n]*)/gi, "\n\n$2\n\n");

    // Highlight the section if provided (for citation modal)
    if (highlightSectionName) {
        const esc = highlightSectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sectionRegex = new RegExp("(\\*\\*)" + esc + "(\\*\\*)", "i");
        pageText = pageText.replace(sectionRegex, function(_, pre, sec, post) {
            return `<span style="background:#ffe066; padding:2px 4px; border-radius:3px;">${pre}${esc}${post}</span>`;
        });
    }

    // Highlight only the current match on this page
    let keywordToHighlight = keyword;
    const modalKeywordInput = document.getElementById("modalKeywordInput");
    if (modalKeywordInput && modalKeywordInput.value.trim()) {
        keywordToHighlight = modalKeywordInput.value.trim();
    }
    let pageMatches = modalMatches.filter(m => m.page === pageIdx);
    let html = escapeHtml(pageText);
    if (keywordToHighlight && pageMatches.length > 0) {
        // Highlight all matches, but special highlight for current
        // Process matches in reverse order to avoid messing up indices
        pageMatches.slice().reverse().forEach((m, i, arr) => {
            const isCurrent = (modalMatches[modalCurrentIdx] && m.index === modalMatches[modalCurrentIdx].index && pageIdx === modalMatches[modalCurrentIdx].page);
            const markTag = isCurrent
                ? `<mark class="chart-modal-match" style="background:#ffe066;">`
                : `<mark class="chart-modal-match">`;
            html = html.slice(0, m.index) + markTag + html.slice(m.index, m.index + m.length) + "</mark>" + html.slice(m.index + m.length);
        });
    }
    contentDiv.innerHTML = typeof marked !== "undefined"
        ? marked.parse(html)
        : html.replace(/\n/g, "<br>");
    document.getElementById("chartModalPageLabel").textContent = `Page ${pageIdx + 1} of ${chartPages.length}`;

    // Show match count
    updateModalMatchLabel();

    // Attach modal handlers for new content
    attachChartModalHandlers();
    scrollToModalMatch();
}

function updateModalMatchLabel() {
    const matchLabel = document.getElementById("modalMatchLabel");
    if (matchLabel) {
        if (modalMatches.length > 0) {
            matchLabel.textContent = `${modalCurrentIdx + 1} of ${modalMatches.length} matches`;
        } else {
            matchLabel.textContent = "No matches";
        }
    }
}

function scrollToModalMatch() {
    const marks = document.querySelectorAll("#chartModalContent mark.chart-modal-match");
    if (marks.length > 0 && marks[modalCurrentIdx]) {
        marks.forEach((m, i) => m.style.background = (i === modalCurrentIdx) ? "#ffe066" : "#ffff99");
        marks[modalCurrentIdx].scrollIntoView({ behavior: "smooth", block: "center" });
    }
}

// Attach modal handlers for navigation and keyword input
function attachChartModalHandlers() {
    // Page turn buttons
    const prevBtn = document.getElementById("modalPrevBtn");
    if (prevBtn) prevBtn.onclick = () => gotoChartModalPage(-1);

    const nextBtn = document.getElementById("modalNextBtn");
    if (nextBtn) nextBtn.onclick = () => gotoChartModalPage(1);

    const closeBtn = document.getElementById("closeChartModalBtn");
    if (closeBtn) closeBtn.onclick = closeChartModal;

    // Keyword search input
    const keywordInput = document.getElementById("modalKeywordInput");
    if (keywordInput) {
        keywordInput.removeEventListener("input", keywordInput._modalInputHandler || (()=>{}));
        keywordInput._modalInputHandler = function () {
            modalCurrentIdx = 0;
            findAllModalMatches(this.value.trim());
            if (modalMatches.length > 0) {
                const match = modalMatches[modalCurrentIdx];
                currentModalPage = match.page;
                renderChartModalPage(currentModalPage, highlightSection, this.value.trim());
                scrollToModalMatch();
            } else {
                renderChartModalPage(currentModalPage, highlightSection, this.value.trim());
                updateModalMatchLabel();
            }
        };
        keywordInput.addEventListener("input", keywordInput._modalInputHandler);
    }

    // Modal match navigation
    const prevModalBtn = document.getElementById("prevModalMatchBtn");
    if (prevModalBtn) {
        prevModalBtn.onclick = function () {
            if (modalMatches.length === 0) return;
            modalCurrentIdx = (modalCurrentIdx - 1 + modalMatches.length) % modalMatches.length;
            const match = modalMatches[modalCurrentIdx];
            currentModalPage = match.page;
            renderChartModalPage(currentModalPage, highlightSection, keywordInput.value.trim());
            scrollToModalMatch();
        };
    }
    const nextModalBtn = document.getElementById("nextModalMatchBtn");
    if (nextModalBtn) {
        nextModalBtn.onclick = function () {
            if (modalMatches.length === 0) return;
            modalCurrentIdx = (modalCurrentIdx + 1) % modalMatches.length;
            const match = modalMatches[modalCurrentIdx];
            currentModalPage = match.page;
            renderChartModalPage(currentModalPage, highlightSection, keywordInput.value.trim());
            scrollToModalMatch();
        };
    }
}

// When opening the modal, always recalculate matches for the current keyword
window.openChartModal = function(pageIdx, sectionName, keyword) {
    if (!chartPages || chartPages.length === 0) {
        alert("No chart data loaded. Please load or enter chart data first.");
        return;
    }
    currentModalPage = pageIdx;
    highlightSection = sectionName || null;
    const modalKeywordInput = document.getElementById("modalKeywordInput");

    // If no keyword is passed, clear the input and don't highlight
    if (!keyword && modalKeywordInput) {
        modalKeywordInput.value = "";
        keywordHighlight = "";
        findAllModalMatches(""); // Clear matches
    } else {
        keywordHighlight = keyword || (modalKeywordInput ? modalKeywordInput.value.trim() : "");
        findAllModalMatches(keywordHighlight);
    }

    // If there are matches, jump to the first one on this page
    if (modalMatches.length > 0) {
        let idx = modalMatches.findIndex(m => m.page === currentModalPage);
        modalCurrentIdx = idx !== -1 ? idx : 0;
        currentModalPage = modalMatches[modalCurrentIdx].page;
    } else {
        modalCurrentIdx = 0;
    }
    document.getElementById("chartModal").style.display = "flex";
    renderChartModalPage(currentModalPage, highlightSection, keywordHighlight);
};

window.closeChartModal = function() {
    document.getElementById("chartModal").style.display = "none";
};

window.gotoChartModalPage = function(delta) {
    let newPage = currentModalPage + delta;
    if (newPage < 0 || newPage >= chartPages.length) return;
    currentModalPage = newPage;
    renderChartModalPage(currentModalPage, highlightSection, keywordHighlight);
    // If a keyword search is active, re-apply highlight and match navigation
    const modalKeywordInput = document.getElementById("modalKeywordInput");
    if (modalKeywordInput && modalKeywordInput.value.trim()) {
        modalKeywordInput.dispatchEvent(new Event('input'));
    }
};

// --- Explore Page functions ---
async function loadModules() {
    try {
        const response = await fetch("/modules");
        const modules = await response.json();

        if (modules.error) {
            console.error("Error loading modules:", modules.error);
            return;
        }

        // Use the dedicated container
        const container = document.getElementById("dynamicModules");
        if (!container) {
            console.error("dynamicModules container not found!");
            return;
        }
        container.innerHTML = ""; // Clear previous modules

        let row = document.createElement("div");
        row.className = "side-by-side";
        modules.forEach((module, i) => {
            const moduleData = parseModuleContent(module.content);
            const moduleEl = createModuleElement(moduleData);
            row.appendChild(moduleEl);
            // 2 panels per row (adjust as needed)
            if ((i + 1) % 2 === 0 || i === modules.length - 1) {
                container.appendChild(row);
                row = document.createElement("div");
                row.className = "side-by-side";
            }
        });
    } catch (err) {
        console.error("Failed to load modules:", err);
    }
}

// --- General purpose result renderer ---
function renderModuleResult(result, fieldKey) {
    // Helper: extract markdown code block
    function extractMarkdownBlock(str) {
        const match = str.match(/```markdown\s*([\s\S]+?)\s*```/i);
        return match ? match[1] : null;
    }
    // Helper: extract JSON code block
    function extractJsonBlock(str) {
        const match = str.match(/```json\s*([\s\S]+?)\s*```/i);
        return match ? match[1] : null;
    }

    // --- Handle arrays of objects with item/result (problemDetails pattern) ---
    if (Array.isArray(result) && result.length && result[0] && typeof result[0] === "object" && ("item" in result[0] || "result" in result[0])) {
        return result.map(entry => {
            let itemHtml = "";
            if (entry.item && typeof entry.item === "object") {
                itemHtml = "<table class='problem-table'>";
                for (const [k, v] of Object.entries(entry.item)) {
                    itemHtml += `<tr><th style="text-align:left;vertical-align:top;">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`;
                }
                itemHtml += "</table>";
            } else if (entry.item) {
                itemHtml = `<div>${escapeHtml(String(entry.item))}</div>`;
            }
            let details = "";
            if (entry.result && typeof entry.result === "object" && entry.result.problemDetails) {
                details = extractMarkdownBlock(entry.result.problemDetails) || entry.result.problemDetails;
            } else if (entry.result) {
                details = entry.result;
            }
            let detailsHtml = details ? marked.parse(details) : "";
            return `<div class="problem-section" style="margin-bottom:2em;">
                        ${itemHtml}
                        <div class="problem-details">${detailsHtml}</div>
                    </div>`;
        }).join("");
    }

    // --- Handle arrays of objects (general) ---
    if (Array.isArray(result) && result.length && typeof result[0] === "object") {
        // If all objects have the same keys, render as a table
        const keys = Object.keys(result[0]);
        const allSameKeys = result.every(obj => typeof obj === "object" && Object.keys(obj).join() === keys.join());
        if (allSameKeys) {
            let html = "<table class='module-table'><thead><tr>";
            keys.forEach(k => html += `<th>${escapeHtml(k)}</th>`);
            html += "</tr></thead><tbody>";
            result.forEach(obj => {
                html += "<tr>";
                keys.forEach(k => html += `<td>${escapeHtml(obj[k])}</td>`);
                html += "</tr>";
            });
            html += "</tbody></table>";
            return html;
        }
        // Otherwise, render each object recursively
        return result.map(item => `<div>${renderModuleResult(item)}</div>`).join("");
    }

    // --- Handle arrays of strings or mixed ---
    if (Array.isArray(result)) {
        return "<ul>" + result.map(item => {
            if (typeof item === "string") {
                const md = extractMarkdownBlock(item);
                return `<li>${marked.parseInline(md || item)}</li>`;
            } else {
                return `<li>${renderModuleResult(item)}</li>`;
            }
        }).join("") + "</ul>";
    }

    // --- Handle objects with multiple keys (like {problemList, problemDetails}) ---
    if (typeof result === "object" && result !== null) {
        const keys = Object.keys(result);
        // If only one key, render its value recursively
        if (keys.length === 1) {
            return renderModuleResult(result[keys[0]], keys[0]);
        }
        // If keys look like a known pattern (problemList + problemDetails), render both
        if (keys.includes("problemList") && keys.includes("problemDetails")) {
            let html = "";
            // Render problemList
            let problems = [];
            if (typeof result.problemList === "string") {
                let jsonText = extractJsonBlock(result.problemList) || result.problemList;
                try {
                    problems = JSON.parse(jsonText);
                } catch (e) {
                    problems = [];
                }
            }
            if (Array.isArray(problems) && problems.length) {
                html += "<h4>Problem List</h4><ul>";
                problems.forEach(p => {
                    if (typeof p === "object" && p !== null) {
                        html += "<li>";
                        html += Object.entries(p).map(([k, v]) =>
                            `<b>${escapeHtml(k)}:</b> ${escapeHtml(v)}`
                        ).join(" &nbsp; ");
                        html += "</li>";
                    } else {
                        html += `<li>${escapeHtml(String(p))}</li>`;
                    }
                });
                html += "</ul>";
            }
            // Render problemDetails
            html += "<h4>Problem Details</h4>";
            html += renderModuleResult(result.problemDetails, "problemDetails");
            return html;
        }
        // Otherwise, render as definition list
        let html = "<dl>";
        for (const [k, v] of Object.entries(result)) {
            html += `<dt>${escapeHtml(k)}</dt><dd>${renderModuleResult(v, k)}</dd>`;
        }
        html += "</dl>";
        return html;
    }

    // --- Handle strings (markdown, code blocks, plain) ---
    if (typeof result === "string") {
        // Try markdown code block
        const md = extractMarkdownBlock(result);
        if (md) return marked.parse(md);
        // Try JSON code block
        const jsonBlock = extractJsonBlock(result);
        if (jsonBlock) {
            try {
                const arr = JSON.parse(jsonBlock);
                return renderModuleResult(arr);
            } catch (e) {
                // Not valid JSON, fall through
            }
        }
        // Otherwise, render as markdown
        return marked.parse(result);
    }

    // Fallback
    return escapeHtml(String(result));
}

function updateChartPagesFromChunkText() {
    const text = document.getElementById("chunkText")?.value || "";
    const parsed = parseChartPages(text);
    chartPages = parsed.pages;
    chartPageSections = parsed.sections;
}

// --- Modal Chart Pagination State ---
let chartPages = [];
let chartPageSections = [];
let currentModalPage = 0;
let highlightSection = null;
let keywordHighlight = "";

// --- Parse chart text into pages and sections ---
function parseChartPages(text) {
    // Split on "Page X of Y" (case-insensitive)
    const pageRegex = /Page\s+\d+\s+of\s+\d+/gi;
    let matches = [];
    let match;
    while ((match = pageRegex.exec(text)) !== null) {
        matches.push(match.index);
    }
    matches.push(text.length);

    let pages = [];
    let sections = [];
    for (let i = 0; i < matches.length - 1; ++i) {
        const start = matches[i];
        const end = matches[i + 1];
        const pageText = text.slice(start, end);
        pages.push(pageText);

        // Find all section headers in this page
        const sectionRegex = /\n([A-Z0-9\s\-\(\)/,\.]+[:\-])\s*\n/g;
        let pageSections = [];
        let m;
        while ((m = sectionRegex.exec(pageText)) !== null) {
            pageSections.push({
                name: m[1].trim(),
                index: m.index
            });
        }
        sections.push(pageSections);
    }
    return { pages, sections };
}

function parseModuleContent(content) {
    const lines = content.split("\n").map(line => line.trim());
    const moduleData = { title: "", fields: [], query: "", prompt: "", output: "", chain: [] };

    lines.forEach(line => {
        if (line.startsWith("Title:")) {
            moduleData.title = line.replace("Title:", "").trim();
        } else if (line.startsWith("Output:")) {
            moduleData.output = line.replace("Output:", "").trim();
        } else if (line.startsWith("Chain:")) {
            moduleData.chain = line.replace("Chain:", "").split(",").map(s => s.trim()).filter(Boolean);
        } else if (line.startsWith("Query:")) {
            moduleData.query = line.replace("Query:", "").trim();
        } else if (line.startsWith("AI Prompt:")) {
            moduleData.prompt = line.replace("AI Prompt:", "").trim();
        } else if (line.match(/^\[\s*[Xx ]\s*\]/)) {
            const checked = line.match(/^\[\s*[Xx]\s*\]/);
            const fieldName = line.replace(/^\[\s*[Xx ]\s*\]/, "").trim();
            moduleData.fields.push({ name: fieldName, checked: !!checked });
        }
    });

    if (!moduleData.output) {
        moduleData.output = moduleData.title.replace(/\s+/g, '').toLowerCase();
    }

    return moduleData;
}

function createModuleElement(moduleData) {
    // Create a panel div to match built-in panels
    const moduleEl = document.createElement("div");
    moduleEl.classList.add("panel");

    // Header row: title and run button side by side
    const headerRow = document.createElement("div");
    headerRow.style.display = "flex";
    headerRow.style.alignItems = "center";
    headerRow.style.justifyContent = "space-between";
    headerRow.style.marginBottom = "8px";

    // Title
    const titleEl = document.createElement("h2");
    titleEl.textContent = moduleData.title;
    titleEl.style.fontSize = "1.2em";
    titleEl.style.margin = "0";
    headerRow.appendChild(titleEl);

    // Run button
    const runButton = document.createElement("button");
    runButton.textContent = "Run";
    runButton.className = "run-panel-btn";
    runButton.style.fontSize = "1.15em";      // Make button text bigger
    runButton.style.padding = "8px 22px";     // Make button itself bigger
    runButton.style.marginLeft = "16px";
    runButton.addEventListener("click", () => {
        runModule(moduleData, moduleEl);
    });
    headerRow.appendChild(runButton);

    moduleEl.appendChild(headerRow);

    // Output container
    const outputEl = document.createElement("div");
    outputEl.classList.add("markdown-box");
    outputEl.classList.add("module-output");
    outputEl.style.marginTop = "16px";
    outputEl.style.minHeight = "120px";
    moduleEl.appendChild(outputEl);

    return moduleEl;
}

async function runModule(moduleData, moduleEl) {
    // Ensure session is up-to-date
    if (typeof SessionManager !== "undefined" && SessionManager.saveToSession) {
        await SessionManager.saveToSession();
        await SessionManager.loadFromSession();
    }

    // Get session data (scribe and explore)
    const sessionData = (window.SessionManager && SessionManager.lastLoadedData) || {};
    const scribe = sessionData.scribe || {};
    const explore = sessionData.explore || {};

    // Collect input values for all checked fields, from session
    const inputs = {};
    moduleData.fields.forEach(field => {
        if (field.checked) {
            if (field.name === "chunkText") {
                // Always send chunkText, even if empty
                inputs.chunkText = scribe.chunkText || explore.chunkText || "";
            } else if (scribe[field.name] !== undefined) {
                inputs[field.name] = scribe[field.name];
            } else if (explore[field.name] !== undefined) {
                inputs[field.name] = explore[field.name];
            } else {
                inputs[field.name] = "";
            }
        }
    });

    // Require chart data to be embedded if chunkText is a checked field
    if (moduleData.fields.some(f => f.name === "chunkText" && f.checked)) {
        // Just check that chart data is present in the session, don't send it
        const chunkText = (scribe.chunkText || explore.chunkText || "");
        if (!chunkText.trim()) {
            alert("Please enter and prepare chart data before running the module.");
            return;
        }
    }

    // Only send the output field name
    const selectedFields = [moduleData.output];

    // Build the POST body
    const body = {
        module: moduleData.output, // or moduleData.title or moduleData.name, as needed by backend
        prompt: moduleData.prompt,
        query: moduleData.query,
        selected_fields: selectedFields,
        ...inputs
    };

    console.log("Module POST body:", body);

    // Show loading spinner in the output area
    const outputEl = moduleEl.querySelector(".module-output");
    if (outputEl) {
        outputEl.innerHTML = `<span class="module-loading" style="font-size:1.2em; color:#888;">
            <svg width="24" height="24" viewBox="0 0 50 50" style="vertical-align:middle;">
                <circle cx="25" cy="25" r="20" fill="none" stroke="#888" stroke-width="5" stroke-linecap="round" stroke-dasharray="31.4 31.4" transform="rotate(-90 25 25)">
                    <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1s" repeatCount="indefinite"/>
                </circle>
            </svg>
            Thinking...
        </span>`;
    }

    try {
        const response = await fetch("/run_module", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        const result = await response.json();
        console.log("Module result:", result);

        // Display the result in the module's UI
        if (outputEl) {
            let html = "";
            const keys = Object.keys(result);
            if (keys.length > 1) {
                // Show all outputs (main + chained)
                for (const [key, value] of Object.entries(result)) {
                    html += `<div class="module-result-block"><h3>${escapeHtml(key)}</h3>${linkifyCitations(renderModuleResult(value, key))}</div>`;
                }
            } else {
                // Only one output, show as before
                const fieldKey = selectedFields[0];
                html = linkifyCitations(renderModuleResult(result[fieldKey] || result, fieldKey));
            }
            outputEl.innerHTML = html;
        }
        // --- Autosave after module result is rendered ---
        if (typeof SessionManager !== "undefined" && SessionManager.saveToSession) {
            await SessionManager.saveToSession();
        }
    } catch (err) {
        console.error("Error running module:", err);
        if (outputEl) {
            outputEl.innerHTML = `<span style="color:red;">Error: ${escapeHtml(err.message)}</span>`;
        }
    }
}

async function submitChartChunk() {
    updateChartPagesFromChunkText();
    const chunkText = document.getElementById("chunkText")?.value;
    const chunkLabel = document.getElementById("chunkLabel")?.value;
    const status = document.getElementById("chunkStatus");

    if (!chunkText || !chunkText.trim()) {
        alert("Please enter chart data before submitting.");
        return;
    }

    if (status) status.textContent = "⏳ Indexing chart data...";

    try {
        const res = await fetch("/process_chart_chunk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: chunkText,
                label: chunkLabel
            })
        });

        const data = await res.json();
        console.log("Returned data:", data);

        if (status) status.textContent = "✅ Chart data indexed successfully.";
    } catch (err) {
        console.error("Error submitting chart chunk:", err);
        if (status) status.textContent = "⚠️ Error processing data.";
    }
}

// --- Explore Page: Chart Data, Search, and OpenAI Integration ---

let chartText = "";
let searchMatches = [];
let currentMatchIdx = 0;

// --- Keyword Search & Highlight ---
const searchBox = document.getElementById("invertedSearchBox");
if (searchBox) {F
    searchBox.addEventListener("input", function () {
        highlightMatches(this.value);
    });
}
const prevBtn = document.getElementById("prevMatchBtn");
if (prevBtn) {
    prevBtn.onclick = function () {
        if (searchMatches.length === 0) return;
        currentMatchIdx = (currentMatchIdx - 1 + searchMatches.length) % searchMatches.length;
        scrollToMatch();
    };
}
const nextBtn = document.getElementById("nextMatchBtn");
if (nextBtn) {
    nextBtn.onclick = function () {
        if (searchMatches.length === 0) return;
        currentMatchIdx = (currentMatchIdx + 1) % searchMatches.length;
        scrollToMatch();
    };
}

function renderChartDisplay(text) {
    const chartDisplay = document.getElementById("chartDisplay");
    if (!chartDisplay) {
        console.warn("⚠️ chartDisplay not found in DOM!");
        return;
    }
    chartDisplay.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
}

function highlightMatches(query) {
    const display = document.getElementById("chartDisplay");
    if (!query) {
        display.innerHTML = escapeHtml(chartText);
        searchMatches = [];
        return;
    }
    // Highlight all matches
    const regex = new RegExp(escapeRegExp(query), "gi");
    let idx = 0;
    searchMatches = [];
    let html = escapeHtml(chartText).replace(regex, function (match) {
        searchMatches.push(idx++);
        return `<mark class="chart-match">${match}</mark>`;
    });
    display.innerHTML = html;
    currentMatchIdx = 0;
    scrollToMatch();
}

function scrollToMatch() {
    const marks = document.querySelectorAll("#chartDisplay mark.chart-match");
    marks.forEach((m, i) => m.style.background = (i === currentMatchIdx) ? "#ffe066" : "#ffff99");
    if (marks[currentMatchIdx]) {
        marks[currentMatchIdx].scrollIntoView({ behavior: "smooth", block: "center" });
    }
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

// --- Utility for consistent chunk IDs ---
function chunkId(section, page) {
    return `chunk-${section.replace(/[^a-zA-Z0-9]/g, '')}-${page}`;
}

// --- OpenAI Query with Markdown & Clickable Citations ---
window.runExploreSearch = async function () {
    const query = document.getElementById("exploreSearchBox").value;
    if (!query.trim()) return;
    document.getElementById("exploreGptAnswer").innerHTML = showThinkingSpinner();    try {
        const res = await fetch("/explore_search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query })
        });
        const data = await res.json();
        if (data.error) {
            document.getElementById("exploreGptAnswer").innerText = data.error;
            return;
        }
        // Render chart chunks with IDs for citation scrolling if needed for debugging
        //document.getElementById("exploreSearchResults").innerHTML = data.chunks.map(
        //    c => `<div id="${chunkId(c.section, c.page)}"><b>${c.section}</b> (Page ${c.page}):<br>${escapeHtml(c.text).replace(/\n/g, "<br>")}</div>`
        //).join("<hr>");
        // Render answer with markdown and clickable citations
        const answerHtml = marked.parse(data.answer || "");
        document.getElementById("exploreGptAnswer").innerHTML = linkifyCitations(answerHtml);
        document.getElementById("exploreGptAnswer").scrollIntoView({ behavior: "smooth" });
        // --- Autosave after query result is rendered ---
        if (typeof SessionManager !== "undefined" && SessionManager.saveToSession) {
            await SessionManager.saveToSession();
        }
    } catch (err) {
        document.getElementById("exploreGptAnswer").innerText = "Error: " + err.message;
    }
};

function linkifyCitations(answerHtml) {
    // Replace all ( ... ) blocks
    return answerHtml.replace(/\(([^)]+)\)/g, function(fullMatch, inner) {
        // Split by semicolon or comma, but keep "Page N" together
        const parts = inner.split(/;\s*|,\s*(?=[Pp]age\s*\d+)/);
        const linked = parts.map(part => {
            // Match (Section, Page N) or (Page N)
            const match = part.match(/^(?:([A-Z0-9\s\-\(\)/,\.]+?),\s*)?[Pp]age\s*(\d+)$/i);
            if (match) {
                const section = match[1] ? match[1].trim() : "Page";
                const page = match[2];
                const id = chunkId(section, page);
                return `<a href="#" class="citation-link" data-chunkid="${id}">${part.trim()}</a>`;
            } else {
                return part; // Not a citation, leave as is
            }
        });
        return '(' + linked.join('; ') + ')';
    });
}

// --- Citation click handler (modal version) ---
document.addEventListener("click", function(e) {
    if (e.target.classList.contains("citation-link")) {
        e.preventDefault();
        // Match "Section, Page N" or "Page N"
        const match = e.target.textContent.match(/^(?:([^,]+),\s*)?[Pp]age\s*(\d+)$/);
        if (match) {
            let section = match[1] ? match[1].trim() : null;
            const pageNum = parseInt(match[2], 10);

            // If section is empty or just punctuation, treat as null
            if (!section || /^[\s,;:.\-]+$/.test(section)) section = null;

            openChartModal(pageNum - 1, section);
        } else {
            // Fallback: try to match just "Page N"
            const pageMatch = e.target.textContent.match(/[Pp]age\s*(\d+)/);
            if (pageMatch) {
                const pageNum = parseInt(pageMatch[1], 10);
                openChartModal(pageNum - 1, null);
            }
        }
    }
});
