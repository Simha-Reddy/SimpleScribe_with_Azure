// SessionManager.js

// Deep merge utility
function deepMerge(target, source) {
  for (const key in source) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key])
    ) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

const SessionManager = {
  scribeRestored: false, // Flag to indicate if Scribe data has been restored
  exploreRestored: false, // Flag to indicate if Explore data has been restored

  async saveToSession() {
    const newData = await this.collectData();
    let mergedData = {};

    // Try to load existing session data first
    try {
      const response = await fetch('/load_session');
      if (response.ok) {
        const existingData = await response.json();
        mergedData = deepMerge(existingData, newData);
      } else {
        mergedData = newData;
      }
    } catch (err) {
      console.warn("Could not load existing session, saving only current page data.");
      mergedData = newData;
    }

    // Save merged data
    try {
      const response = await fetch('/save_session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mergedData),
      });
      if (response.ok) {
        console.log('Session saved to server.');
        this.lastLoadedData = mergedData; // <-- Add this line
      } else {
        console.error('Failed to save session to server.');
      }
    } catch (err) {
      console.error('Error saving session to server:', err);
    }
  },

  async loadFromSession() {
    try {
      const response = await fetch('/load_session');
      if (response.ok) {
        const data = await response.json();
        this.lastLoadedData = data; // <-- Store for later
        this.restoreData(data);
        console.log('Session loaded from server:', data);
      } else {
        console.error('Failed to load session from server.');
      }
    } catch (err) {
      console.error('Error loading session from server:', err);
    }
  },

  async clearSession() {
    try {
      const response = await fetch('/clear_session', { method: 'POST' });
      if (response.ok) {
        console.log('Session cleared on server.');
      } else {
        console.error('Failed to clear session on server.');
      }
    } catch (err) {
      console.error('Error clearing session on server:', err);
    }
  },

  async saveFullSession(name) {
    const data = await this.collectData();
    try {
      const response = await fetch('/save_full_session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ...data }),
      });
      if (response.ok) {
        const result = await response.json();
        console.log('Full session saved to server:', result);
      } else {
        console.error('Failed to save full session to server.');
      }
    } catch (err) {
      console.error('Error saving full session to server:', err);
    }
  },

  async loadSavedSession(filename) {
    try {
      const response = await fetch(`/load_saved_session/${filename}`);
      if (response.ok) {
        const data = await response.json();
        this.restoreData(data.data);
        console.log('Saved session loaded from server:', data);
      } else {
        console.error('Failed to load saved session from server.');
      }
    } catch (err) {
      console.error('Error loading saved session from server:', err);
    }
  },

  async listSessions() {
    try {
      const response = await fetch('/list_sessions');
      if (response.ok) {
        const sessions = await response.json();
        console.log('Available sessions:', sessions);
        return sessions;
      } else {
        console.error('Failed to list sessions from server.');
        return [];
      }
    } catch (err) {
      console.error('Error listing sessions from server:', err);
      return [];
    }
  },

  async deleteSession(filename) {
    try {
      const response = await fetch(`/delete_session/${filename}`, { method: 'DELETE' });
      if (response.ok) {
        console.log(`Session ${filename} deleted from server.`);
      } else {
        console.error(`Failed to delete session ${filename} from server.`);
      }
    } catch (err) {
      console.error(`Error deleting session ${filename} from server:`, err);
    }
  },

  async endSession(sessionName) {
    if (!sessionName) {
      console.warn("⚠️ No session name provided. Session not ended.");
      return;
    }

    try {
      // Save the session to the server
      const saveResponse = await fetch('/save_full_session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: sessionName }),
      });

      if (!saveResponse.ok) {
        console.error("❌ Failed to save session to server.");
        alert("Failed to save session. Please try again.");
        return;
      }

      const saveResult = await saveResponse.json();
      console.log("✅ Session saved to server:", saveResult);

      // Clear the session from the server
      const clearResponse = await fetch('/clear_session', { method: 'POST' });

      if (!clearResponse.ok) {
        console.error("❌ Failed to clear session on server.");
        alert("Failed to clear session. Please try again.");
        return;
      }

      // Clear live_transcript.txt on the server
      await fetch('/clear_live_transcript', { method: 'POST' });
      
      console.log("✅ Session cleared on server.");
      alert(`Session "${sessionName}" has been saved and cleared.`);
    } catch (err) {
      console.error("❌ Error ending session:", err);
      alert("An error occurred while ending the session. Please try again.");
    }
  },

  collectData: async function() {
    const data = {};

    // Scribe page data
    // Always fetch from backend, not from the text box
    try {
        const res = await fetch('/live_transcript');
        const transcript = await res.text();
        data.scribe = { transcript };
    } catch (err) {
        console.error("Failed to fetch live transcript for session save:", err);
        // fallback to text box if needed
        const transcriptEl = document.getElementById('rawTranscript');
        if (transcriptEl) data.scribe = { transcript: transcriptEl.value };
    }

    const visitNotesEl = document.getElementById('visitNotes');
    if (visitNotesEl) data.scribe.visitNotes = visitNotesEl.value;

    const instructionsBox = document.getElementById('patientInstructionsBox');
    if (instructionsBox) data.scribe.patientInstructions = instructionsBox.value;

    const previewDiv = document.getElementById('patientInstructionsPreview');
    if (previewDiv) data.scribe.patientInstructionsPreview = previewDiv.innerHTML;

    const promptSelectorEl = document.getElementById('promptSelector');
    if (promptSelectorEl) data.scribe.promptTemplate = promptSelectorEl.value;

    const feedbackReplyEl = document.getElementById('feedbackReply');
    if (feedbackReplyEl) data.scribe.feedbackReply = feedbackReplyEl.innerText;

    // Explore page data
    const chunkTextEl = document.getElementById('chunkText');
    if (chunkTextEl) data.explore = { chunkText: chunkTextEl.value };

    const exploreResultsEl = document.getElementById('exploreGptAnswer');
    if (exploreResultsEl) data.explore.exploreResults = exploreResultsEl.innerHTML;

    // Explore page module results
    const moduleResults = {};
    document.querySelectorAll('.panel').forEach(panel => {
        const title = panel.querySelector('h2')?.textContent || "";
        const output = panel.querySelector('.module-output')?.innerHTML || "";
        if (title) moduleResults[title] = output;
    });
    if (Object.keys(moduleResults).length) {
        data.explore = data.explore || {};
        data.explore.moduleResults = moduleResults;
    }

    return data;
  },

  async restoreData(data) {
    if (!data) return;

    // Restore Scribe data
    if (data.scribe) {
      const transcriptEl = document.getElementById('rawTranscript');
      if (transcriptEl) transcriptEl.value = data.scribe.transcript || '';

      const visitNotesEl = document.getElementById('visitNotes');
      if (visitNotesEl) visitNotesEl.value = data.scribe.visitNotes || '';

      const instructionsBox = document.getElementById('patientInstructionsBox');
      if (instructionsBox && data.scribe.patientInstructions !== undefined) {
          instructionsBox.value = data.scribe.patientInstructions;
      }
      const previewDiv = document.getElementById('patientInstructionsPreview');
      if (previewDiv && data.scribe.patientInstructionsPreview !== undefined) {
          previewDiv.innerHTML = data.scribe.patientInstructionsPreview;
      }

      const promptSelectorEl = document.getElementById('promptSelector');
      if (promptSelectorEl) promptSelectorEl.value = data.scribe.promptTemplate || '';

      const feedbackReplyEl = document.getElementById('feedbackReply');
      if (feedbackReplyEl) feedbackReplyEl.innerText = data.scribe.feedbackReply || '';

      if (data.scribe && data.scribe.transcript) {
        await fetch('/set_live_transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: data.scribe.transcript })
        });
      }
    }

    // Restore Explore data
    if (data.explore) {
      const chunkTextEl = document.getElementById('chunkText');
      if (chunkTextEl) chunkTextEl.value = data.explore.chunkText || '';

      const exploreResultsEl = document.getElementById('exploreGptAnswer');
      if (exploreResultsEl) exploreResultsEl.innerHTML = data.explore.exploreResults || '';
    }
  },

  restoreModuleResults(moduleResults) {
    if (!moduleResults) return;
    document.querySelectorAll('.panel').forEach(panel => {
      const title = panel.querySelector('h2')?.textContent || "";
      if (title && moduleResults[title]) {
        const outputEl = panel.querySelector('.module-output');
        if (outputEl) outputEl.innerHTML = moduleResults[title];
      }
    });
  },
};

// Expose globally
window.SessionManager = SessionManager;

// Only register autosave with exit on pages with session data
if (document.getElementById('rawTranscript') || document.getElementById('chunkText')) {
  window.addEventListener('beforeunload', async () => {
    console.log("Page is unloading. Attempting to save session...");
    if (typeof SessionManager !== "undefined" && SessionManager.saveToSession) {
      await SessionManager.saveToSession();
    }
  });
}