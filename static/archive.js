// Load the list of archived sessions
async function loadArchiveList() {
    const resp = await fetch('/list_sessions');
    const sessions = await resp.json();
    const container = document.getElementById('archive-list');
    container.innerHTML = '';
    if (sessions.length === 0) {
        container.innerHTML = '<p>No archived sessions found.</p>';
        return;
    }
    sessions.forEach(filename => {
        const div = document.createElement('div');
        div.className = "transcript-block";
        div.innerHTML = `
            <button class="restore-btn" onclick="restoreArchivedSession('${filename}')">Restore</button>
            <input type="checkbox" class="archive-checkbox" value="${filename}">
            <span class="archive-filename">${filename.replace('.json', '')}</span>
        `;
        container.appendChild(div);
    });
}

// Restore a specific archived session
async function restoreArchivedSession(filename) {
    // 1. Clear the current session on the backend
    await fetch('/clear_session', { method: 'POST' });

    // 2. Load the archived session data
    const resp = await fetch(`/transcripts/${filename}`);
    if (!resp.ok) return alert("Failed to load session.");
    const data = await resp.json();
    if (data) {
        console.log("Restoring session data:", data);
        await SessionManager.restoreData(data); // Use SessionManager to restore data

        // 3. Save the full restored session directly to the server
        await fetch('/save_session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        alert("Session restored. Go to Scribe or Explore to continue.");
    }
}

// Delete a specific archived session
async function deleteArchivedSession(filename) {
    const resp = await fetch(`/delete_session/${filename}`, { method: 'DELETE' });
    if (resp.ok) loadArchiveList();
    else alert("Failed to delete session.");
}

// Initialize the Archive page
document.addEventListener('DOMContentLoaded', function() {
    // Load the archive list on page load
    loadArchiveList();

    // Delete selected sessions
    document.getElementById('deleteSelectedBtn').onclick = async function() {
        const checked = document.querySelectorAll('.archive-checkbox:checked');
        if (checked.length === 0) {
            alert("No sessions selected.");
            return;
        }
        if (!confirm(`Delete ${checked.length} selected session(s)?`)) return;
        for (const cb of checked) {
            await deleteArchivedSession(cb.value);
        }
        loadArchiveList();
    };

    // Select or deselect all sessions
    document.getElementById('selectAllBox').onclick = function() {
        const boxes = document.querySelectorAll('.archive-checkbox');
        boxes.forEach(cb => cb.checked = this.checked);
    };
});