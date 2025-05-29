from flask import Flask, render_template, request, jsonify, redirect, url_for, send_from_directory, render_template, session
from flask_session import Session
from dotenv import load_dotenv
import os
import json
import threading
from record_audio import start_recording_thread, stop_recording
from datetime import datetime
from openai import AzureOpenAI
import uuid
from smart_problems_azureembeddings import chunk_text, get_embeddings_batched, build_inverted_index, hybrid_search, ask_gpt
import numpy as np
import re
import pdfplumber

# Load environment
load_dotenv()
openai_api_key = os.getenv("AZURE_OPENAI_API_KEY")

# --- Define deployment names here ---
deploy_chat = os.getenv("AZURE_DEPLOYMENT_NAME")
deploy_embed = os.getenv("AZURE_EMBEDDING_DEPLOYMENT_NAME", deploy_chat)

# Initialize Azure OpenAI client
client = AzureOpenAI(
    api_key=openai_api_key,
    api_version="2024-02-15-preview",
    azure_endpoint="https://spd-prod-openai-va-apim.azure-api.us/api"
)

app = Flask(__name__)

# Get FLASK_SECRET_KEY
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-flask-key")

# Ensure required folders exist
REQUIRED_DIRS = [
    "chunks",
    "transcripts",
    "temp_pdf",
    os.path.join("templates", "default"),
    os.path.join("templates", "custom"),
]

for folder in REQUIRED_DIRS:
    os.makedirs(folder, exist_ok=True)

# For the smart module management on Explore
MODULES_DIR = "modules"

# --- Use server-side session storage ---
app.config["SESSION_TYPE"] = "filesystem"
app.config["SESSION_FILE_DIR"] = os.path.join(os.getcwd(), ".flask_session")
app.config["SESSION_PERMANENT"] = False
Session(app)

# Global variable to track recording state
is_recording = False

def ask_openai(system_prompt, field_chunks):
        print("Calling OpenAI API...")
        try:
            context = "\n\n".join([
                f"### Source: {c.get('section','Unknown')} (Page {c.get('page','?')})\n{c['text']}"
                for c in field_chunks
            ])
            prompt = f"{system_prompt}\n\n{context}"
            response = client.chat.completions.create(
                model=deploy_chat,
                messages=[
                    {"role": "system", "content": "You are a clinical assistant."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3
            )
            print("OpenAI API call completed.")
            return response.choices[0].message.content.strip()
        except Exception as e:
            print("Error during OpenAI call:", e)
            return f"Error: {e}"
        
def openai_rank_problems(client, deploy_chat, chunks):
    """
    Given a list of chunk dicts, ask OpenAI for a rank-ordered problem list.
    Returns a list of problem strings.
    """
    context = "\n\n".join([f"{c.get('section','Unknown')} (Page {c.get('page','?')}):\n{c['text']}" for c in chunks])
    prompt = (
        "Given the following chart text, list the most important patient problems or diagnoses, "
        "rank-ordered by severity. Output as a numbered list, one problem per line.\n\n"
        f"{context}"
    )
    try:
        response = client.chat.completions.create(
            model=deploy_chat,
            messages=[
                {"role": "system", "content": "You are a clinical assistant."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3
        )
        result = response.choices[0].message.content.strip()
        # Parse result into a list of problems
        problems = []
        for line in result.splitlines():
            if line.strip() and (line[0].isdigit() or line.startswith("-")):
                # Remove leading number/dash and dot/space
                problem = line.lstrip(" -0123456789.").strip()
                if problem:
                    problems.append(problem)
        return problems
    except Exception as e:
        print("Error in openai_rank_problems:", e)
        return []

def openai_problem_details(client, deploy_chat, problem, chunks):
    """
    For a problem and supporting chunks, ask OpenAI for diagnostics, therapeutics, complications with citations.
    Returns a markdown string.
    """
    context = "\n\n".join([f"{c.get('section','Unknown')} (Page {c.get('page','?')}):\n{c['text']}" for c in chunks])
    prompt = (
        f"For the problem: {problem}, use the following chart text to find and "
        "list any important diagnostics (notable studies, labs, imaging), therapeutics, and any notable complications. "
        "For each item, include a parenthetical citation in the format (SECTION, Page N) based on the provided text. "
        "Output as markdown bullet points under headings for Diagnostics, Therapeutics, and Complications/Symptoms.\n\n"
        f"{context}"
    )
    try:
        response = client.chat.completions.create(
            model=deploy_chat,
            messages=[
                {"role": "system", "content": "You are a clinical assistant."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        print("Error in openai_problem_details:", e)
        return f"Error: {e}"

def extract_json_from_code_block(text):
    # Remove ```json ... ``` or ``` ... ```
    match = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", text)
    if match:
        return match.group(1)
    return text

@app.route('/recording_status')
def recording_status():
    """
    Endpoint to get the current recording state.
    Returns:
        JSON: {'is_recording': True/False}
    """
    global is_recording
    return jsonify({'is_recording': is_recording})

@app.route('/start_recording', methods=['POST'])
def start_recording_route():
    """
    Endpoint to start recording. Updates the global state.
    """
    global is_recording
    if not is_recording:
        start_recording_thread()  # Starts the recording thread
        is_recording = True
    return "Recording started", 200

@app.route('/stop_recording', methods=['POST'])
def stop_recording_route():
    """
    Endpoint to stop recording. Updates the global state.
    """
    global is_recording
    if is_recording:
        stop_recording()  # Stops the recording process
        is_recording = False
    return "Recording stopped", 200

@app.route("/live_transcript")
def live_transcript():
    try:
        with open("live_transcript.txt", "r", encoding="utf-8") as f:
            return f.read(), 200, {'Content-Type': 'text/plain; charset=utf-8'}
    except FileNotFoundError:
        return "", 200

@app.route("/create_note", methods=["POST"])
def create_note():
    data        = request.get_json()
    transcript  = data.get("transcript", "")
    visit_notes  = data.get("visit_notes", "")
    prompt_text = data.get("prompt_text", "").strip()
    prompt_type = data.get("prompt_type", "")   # optional: can drop if unused

    # 1) if client gave us a prompt_text, use it; otherwise fallback:
    if not prompt_text:
        prompt_clean = prompt_type.replace("(Custom)", "").strip()
        base_default = os.path.join("templates", "default", prompt_clean)
        base_custom  = os.path.join("templates", "custom", prompt_clean)

        for ext in [".txt", ".md"]:
            if os.path.exists(base_default + ext):
                with open(base_default + ext, "r", encoding="utf-8") as f:
                    prompt_text = f.read()
                break
            elif os.path.exists(base_custom + ext):
                with open(base_custom + ext, "r", encoding="utf-8") as f:
                    prompt_text = f.read()
                break

    if not prompt_text:
        return jsonify({"note": f"Prompt template for '{prompt_type}' not found."}), 404

    # 2) build the chat messages
    messages = [
        {"role": "system", "content": "You are a helpful clinical documentation assistant."},
        {"role": "user",   "content": prompt_text
                                + "\n\nNOTES DURING VISIT:\n" + visit_notes.strip()
                                + "\n\nTRANSCRIPT:\n" + transcript.strip()}
    ]

    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            temperature=0.5
        )
        note = response.choices[0].message.content.strip()
        # return both for client‐side chatHistory seeding
        return jsonify({"note": note, "messages": messages})
    except Exception as e:
        return jsonify({"note": f"Error generating note: {e}"}), 500

@app.route('/chat_feedback', methods=['POST'])
def chat_feedback():
    # Client sends full message history; server remains stateless
    data = request.get_json()
    messages = data.get('messages', [])

    if not messages:
        return jsonify({'reply': 'No conversation context provided.'}), 400

    try:
        resp = client.chat.completions.create(
            model='gpt-4o',
            messages=messages,
            temperature=0.5
        )
        reply = resp.choices[0].message.content.strip()
       # Client will append this to its local history
        return jsonify({'reply': reply})
    except Exception as e:
        return jsonify({'reply': f'Error: {str(e)}'}), 500

@app.route('/')
def index():
    return render_template('landing.html')

@app.route("/scribe")
def scribe():
    default_dir = os.path.join("templates", "default")
    custom_dir = os.path.join("templates", "custom")

    default_templates = []
    custom_templates = []

    if os.path.exists(default_dir):
        default_templates = [os.path.splitext(f)[0] for f in os.listdir(default_dir) if f.endswith((".txt", ".md"))]
    if os.path.exists(custom_dir):
        custom_templates = [os.path.splitext(f)[0] for f in os.listdir(custom_dir) if f.endswith((".txt", ".md"))]

    return render_template("scribe.html", default_templates=default_templates, custom_templates=custom_templates)

@app.route("/scribe_status")
def scribe_status():
    chunk_dir = "chunks"
    wavs = [f for f in os.listdir(chunk_dir) if f.endswith(".wav")]
    txts = [f for f in os.listdir(chunk_dir) if f.endswith(".txt")]
    txt_basenames = {os.path.splitext(f)[0] for f in txts}
    pending = [f for f in wavs if os.path.splitext(f)[0] not in txt_basenames]

    transcript_path = "live_transcript.txt"
    try:
        with open(transcript_path, "r") as f:
            transcript = f.read()
    except FileNotFoundError:
        transcript = ""

    return jsonify({
        "pending_chunks": len(pending),
        "transcript": transcript
    })

@app.route("/explore")
def explore():
    return render_template("explore.html")

@app.route("/modules", methods=["GET"])
def get_modules():
    """
    Reads all .txt files in the 'modules' folder and returns their contents as JSON.
    """
    modules_dir = os.path.join(os.getcwd(), "modules")
    if not os.path.exists(modules_dir):
        return jsonify({"error": "Modules folder not found"}), 404

    modules = []
    for filename in os.listdir(modules_dir):
        if filename.endswith(".txt"):
            filepath = os.path.join(modules_dir, filename)
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()
                modules.append({"filename": filename, "content": content})

    return jsonify(modules)

def run_module_by_name(module_name, data, chunks, vectors, inverted_index, client, deploy_chat, deploy_embed, override_query=None):
    print("=== run_module_by_name ===")
    print("Module:", module_name)
    print("Input data keys:", list(data.keys()))
    print("Input data chunkText length:", len(data.get("chunkText", "")))
    print("Chunks available:", len(chunks) if chunks else 0)
    print("Vectors shape:", getattr(vectors, "shape", None))
    print("Inverted index keys:", len(inverted_index.keys()) if inverted_index else [])

    # Load module definition
    modules_dir = os.path.join(os.getcwd(), "modules")
    module_file = os.path.join(modules_dir, f"{module_name}.txt")
    if not os.path.exists(module_file):
        return f"Module {module_name} not found."

    with open(module_file, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f.readlines()]
    chain = []
    output = module_name
    prompt = ""
    query = ""
    for line in lines:
        if line.startswith("Output:"):
            output = line.replace("Output:", "").strip()
        elif line.startswith("Chain:"):
            chain = [s.strip() for s in line.replace("Chain:", "").split(",") if s.strip()]
        elif line.startswith("AI Prompt:"):
            prompt = line.replace("AI Prompt:", "").strip()
        elif line.startswith("Query:"):
            query = line.replace("Query:", "").strip()

    # Prepare prompt_vars from data (all fields except module, prompt, query, selected_fields)
    prompt_vars = {k: v for k, v in data.items() if k not in ("module", "prompt", "query", "selected_fields") and v is not None}
    print("Initial prompt_vars keys:", list(prompt_vars.keys()))
    if "chunkText" in prompt_vars:
        print("chunkText length in prompt_vars:", len(prompt_vars["chunkText"]))

    # Use override_query if provided (for chaining), else use module's query
    search_query = override_query if override_query is not None else query

    # If chunkText is present, generate top_chunks and use them
    if "chunkText" in prompt_vars and prompt_vars["chunkText"].strip():
        if len(chunks) and vectors is not None and inverted_index:
            top_chunks = hybrid_search(client, deploy_embed, search_query, chunks, vectors, inverted_index, top_k=20)
            print("Top chunks found:", len(top_chunks))
            total_top_chunks_length = sum(len(c['text']) for c in top_chunks)
            print("Total top_chunks text length:", total_top_chunks_length)
            prompt_vars["top_chunks"] = "\n\n".join(
                f"### Source: {c.get('section','Unknown')} (Page {c.get('page','?')})\n{c['text']}" for c in top_chunks
            )
        else:
            print("No embedded chart data found in session for hybrid search.")
            prompt_vars["top_chunks"] = ""
    # Always remove chunkText so it is never appended
    prompt_vars.pop("chunkText", None)

    # Format the prompt
    try:
        formatted_prompt = prompt.format(**prompt_vars)
    except Exception as e:
        print("Prompt formatting error:", e)
        formatted_prompt = prompt

    # Append any prompt_vars not referenced in the prompt itself (except chunkText, which is never appended)
    fields_to_append = []
    for field, value in prompt_vars.items():
        if f"{{{field}}}" not in prompt:
            label = field.replace("_", " ").upper()
            fields_to_append.append(f"\n\n{label}:\n{value}")
            print(f"Appending field '{field}' to prompt, length: {len(str(value))}")

    if fields_to_append:
        formatted_prompt += "".join(fields_to_append)

    print("Final formatted_prompt length:", len(formatted_prompt))
    print("First 1000 chars of formatted_prompt:\n", formatted_prompt[:1000])
    print("Calling ask_openai...")

    result = ask_openai(formatted_prompt, [])

    # --- Chaining logic for multiple modules ---
    chain_results = {}
    if chain:
        json_text = extract_json_from_code_block(result)
        try:
            items = json.loads(json_text)
            if not isinstance(items, list):
                items = [items]
        except Exception:
            items = []
        for chained_module in chain:
            chain_results[chained_module] = []
            for item in items:
                child_data = dict(data)
                child_data["item"] = item
                child_data["modResult"] = item 
                # Load child module's query
                child_module_file = os.path.join(modules_dir, f"{chained_module}.txt")
                child_query = chained_module  # fallback
                if os.path.exists(child_module_file):
                    with open(child_module_file, "r", encoding="utf-8") as f:
                        for line in f:
                            if line.startswith("Query:"):
                                child_query = line.replace("Query:", "").strip()
                            elif line.startswith("Query for chunkText chunk matching:"):
                                child_query = line.replace("Query for chunkText chunk matching:", "").strip()
                try:
                    formatted_child_query = child_query.format(**child_data)
                except Exception:
                    formatted_child_query = child_query
                child_result = run_module_by_name(
                    chained_module, child_data, chunks, vectors, inverted_index, client, deploy_chat, deploy_embed, override_query=formatted_child_query
                )
                chain_results[chained_module].append({"item": item, "result": child_result})

    return {output: result, **chain_results}

@app.route("/run_module", methods=["POST"])
def run_module():
    data = request.get_json()
    module_name = data.get("module")
    prompt = data.get("prompt", "")
    query = data.get("query", "")
    selected_fields = data.get("selected_fields", [])
    # All other fields are considered inputs
    prompt_vars = {k: v for k, v in data.items() if k not in ("module", "prompt", "query", "selected_fields") and v is not None}

    # Load embedded chart data from session
    chunks = session.get("explore_chunks", [])
    vectors = np.array(session.get("explore_vectors", []))
    inverted_index = {k: set(v) for k, v in session.get("explore_index", {}).items()}

    print("=== /run_module ===")
    print("Module:", module_name)
    print("Prompt vars keys:", list(prompt_vars.keys()))
    print("Chunks available:", len(chunks))
    print("Vectors shape:", getattr(vectors, "shape", None))
    print("Inverted index keys:", len(inverted_index.keys()) if inverted_index else [])

    # Load module definition
    modules_dir = os.path.join(os.getcwd(), "modules")
    module_file = os.path.join(modules_dir, f"{module_name}.txt")
    if not os.path.exists(module_file):
        return jsonify({"error": f"Module {module_name} not found."}), 404

    with open(module_file, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f.readlines()]
    chain = []
    output = module_name
    for line in lines:
        if line.startswith("Output:"):
            output = line.replace("Output:", "").strip()
        elif line.startswith("Chain:"):
            chain = [s.strip() for s in line.replace("Chain:", "").split(",") if s.strip()]

    # If chunkText is present, generate top_chunks and use them
    if "chunkText" in prompt_vars and prompt_vars["chunkText"].strip():
        if len(chunks) and vectors is not None and inverted_index:
            top_chunks = hybrid_search(client, deploy_embed, query, chunks, vectors, inverted_index, top_k=20)
            print("Top chunks found:", len(top_chunks))
            total_top_chunks_length = sum(len(c['text']) for c in top_chunks)
            print("Total top_chunks text length:", total_top_chunks_length)
            prompt_vars["top_chunks"] = "\n\n".join(
                f"### Source: {c.get('section','Unknown')} (Page {c.get('page','?')})\n{c['text']}" for c in top_chunks
            )
        else:
            print("No embedded chart data found in session for hybrid search.")
            prompt_vars["top_chunks"] = ""
    # Always remove chunkText so it is never appended
    prompt_vars.pop("chunkText", None)

    # Format the prompt
    try:
        formatted_prompt = prompt.format(**prompt_vars)
    except Exception as e:
        print("Prompt formatting error:", e)
        formatted_prompt = prompt

    # Append any prompt_vars not referenced in the prompt itself (except chunkText, which is never appended)
    fields_to_append = []
    for field, value in prompt_vars.items():
        if f"{{{field}}}" not in prompt:
            label = field.replace("_", " ").upper()
            fields_to_append.append(f"\n\n{label}:\n{value}")
            print(f"Appending field '{field}' to prompt, length: {len(str(value))}")

    if fields_to_append:
        formatted_prompt += "".join(fields_to_append)

    print("Final formatted_prompt length:", len(formatted_prompt))
    print("First 1000 chars of formatted_prompt:\n", formatted_prompt[:1000])
    print("Calling ask_openai...")

    result = ask_openai(formatted_prompt, [])

    # --- Chaining logic for multiple modules ---
    chain_results = {}
    if chain:
        json_text = extract_json_from_code_block(result)
        try:
            items = json.loads(json_text)
            if not isinstance(items, list):
                items = [items]
        except Exception:
            items = []
        for chained_module in chain:
            chain_results[chained_module] = []
            for item in items:
                child_data = dict(data)
                child_data["item"] = item
                child_data["modResult"] = item
                # Recursively run the chained module
                child_result = run_module_by_name(
                    chained_module, child_data, chunks, vectors, inverted_index, client, deploy_chat, deploy_embed
                )
                chain_results[chained_module].append({"item": item, "result": child_result})

    print("Returning:", {output: result, **chain_results})
    return jsonify({output: result, **chain_results})


@app.route("/process_chart_chunk", methods=["POST"])
def process_chart_chunk():
    print("=== process_chart_chunk triggered ===")
    data = request.get_json()
    text = data.get("text", "").strip()
    label = data.get("label", "")
    selected_fields = data.get("selected_fields", [])
    existing_outputs = data.get("existing_outputs", {})
    timestamp = datetime.now().isoformat()

    print(f">>> Received chart chunk: {text[:100]}...")
    print(f">>> Label: {label}")
    print(f">>> Selected fields to update: {selected_fields}")

    if "chartChunks" not in session:
        session["chartChunks"] = []
        print("Initialized session['chartChunks']")
    if "outputs" not in session:
        session["outputs"] = {}

    chunk = {
        "id": str(uuid.uuid4()),
        "label": label,
        "text": text,
        "timestamp": timestamp
    }
    session["chartChunks"].append(chunk)
    print("Appended new chunk to session['chartChunks']")

    def load_prompt(field, fallback):
        try:
            with open(f"prompts/explore/{field}.txt", "r", encoding="utf-8") as f:
                print(f"Loaded prompt for {field} from file.")
                return f.read().strip()
        except Exception as e:
            print(f"Could not load file prompt for {field}, using fallback.")
            return fallback

    # --- Chunk and embed chart text only if present ---
    if text:
        chunks = chunk_text(text)
        vectors = get_embeddings_batched(client, deploy_embed, [c["text"] for c in chunks])
        inverted_index = build_inverted_index(chunks)
        session["explore_chunks"] = chunks
        session["explore_vectors"] = vectors.tolist()
        session["explore_index"] = {k: list(v) for k, v in inverted_index.items()}
    else:
        chunks = []
        vectors = []
        inverted_index = {}

    # --- Dynamic module processing ---
    for field in selected_fields:
        print(f"Processing field: {field}")
        module_result = run_module_by_name(
            field, data, chunks, vectors, inverted_index, client, deploy_chat, deploy_embed
        )
        session["outputs"][field] = module_result

    print(">>> Returning JSON to client")
    if len(selected_fields) == 1:
        field = selected_fields[0]
        return jsonify({field: session["outputs"][field]})
    else:
        return jsonify(session["outputs"])

@app.route("/settings")
def settings():
    prompt_files = os.listdir("templates/custom")
    return render_template("settings.html", prompt_templates=prompt_files)

@app.route("/archive")
def archive():
    transcripts = []
    transcript_dir = "transcripts"

    if (os.path.exists(transcript_dir)):
        files = sorted(os.listdir(transcript_dir), reverse=True)

        for f in files:
            path = os.path.join(transcript_dir, f)
            with open(path, "r", encoding="utf-8") as file:
                content = file.read()

            # Try to parse timestamp from filename
            try:
                base = os.path.splitext(f)[0]  # remove .txt
                ts = base.replace("session_", "")  # e.g., "20250422_1119"
                dt = datetime.strptime(ts, "%Y%m%d_%H%M")
                readable_time = dt.strftime("%B %d, %Y at %I:%M %p")  # "April 22, 2025 at 11:19 AM"
            except Exception:
                readable_time = f  # fallback to filename

            transcripts.append({
                "filename": f,
                "display_time": readable_time,
                "content": content
            })

    return render_template("archive.html", transcripts=transcripts)

@app.route("/delete_transcripts", methods=["POST"])
def delete_transcripts():
    filenames = request.form.getlist("filenames")
    for fname in filenames:
        path = os.path.join("transcripts", fname)
        if os.path.exists(path):
            os.remove(path)
    return redirect("/archive")

@app.route("/save_config", methods=["POST"])
def save_config():
    data = request.get_json()
    with open("config.json", "w") as f:
        json.dump(data, f)

    import psutil
    import subprocess
    for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
        try:
            if proc.info['cmdline'] and "transcribe_chunks.py" in proc.info['cmdline'][-1]:
                proc.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    subprocess.Popen(["python", "transcribe_chunks.py"])
    return "", 204

@app.route("/load_patient_instructions_prompt")
def load_patient_instructions_prompt():
    path = os.path.join("templates", "patient_instructions", "patient_instructions.txt")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    return "", 404

@app.route("/save_patient_instructions_prompt", methods=["POST"])
def save_patient_instructions_prompt():
    data = request.get_json()
    text = data.get("text", "")
    os.makedirs(os.path.join("templates", "patient_instructions"), exist_ok=True)
    path = os.path.join("templates", "patient_instructions", "patient_instructions.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return jsonify({"status": "saved"})

@app.route("/default_patient_instructions_prompt")
def default_patient_instructions_prompt():
    path = os.path.join("templates", "patient_instructions", "default_instructions.txt")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read(), 200
    return "", 404

@app.route("/save_template", methods=["POST"])
def save_template():
    data = request.get_json()
    name = data.get("name")
    text = data.get("text")
    if name and text:
        os.makedirs("templates/custom", exist_ok=True)
        if not name.endswith((".txt", ".md")):
            name += ".txt"
        with open(os.path.join("templates/custom", name), "w", encoding="utf-8") as f:
            f.write(text)
        return redirect(url_for("settings"))
    return "Invalid data", 400

@app.route("/load_template/<name>")
def load_template(name):
    base = os.path.join("templates", "custom", name)
    for ext in [".txt", ".md"]:
        path = base + ext
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
    return "", 404

@app.route("/list_custom_templates")
def list_custom_templates():
    folder = os.path.join("templates", "custom")
    if not os.path.exists(folder):
        return jsonify([])
    files = [os.path.splitext(f)[0] for f in os.listdir(folder) if f.endswith((".txt", ".md"))]
    return jsonify(files)

@app.route('/templates/custom/<filename>')
def serve_custom_template(filename):
    return send_from_directory('templates/custom', filename)

@app.route("/delete_template/<name>", methods=["DELETE"])
def delete_template(name):
    base = os.path.join("templates", "custom", name)
    for ext in [".txt", ".md"]:
        path = base + ext
        if os.path.exists(path):
            os.remove(path)
            return "Deleted", 200
    return "Not found", 404

@app.route("/get_prompts")
def get_prompts():
    prompts = {}
    default_path = "templates/default"
    custom_path = "templates/custom"
    for folder in [default_path, custom_path]:
        if os.path.exists(folder):
            for file in os.listdir(folder):
                if file.endswith((".txt", ".md")):
                    with open(os.path.join(folder, file), "r", encoding="utf-") as f:
                        name = os.path.splitext(file)[0]
                        prompts[name] = f.read()
    return jsonify(prompts)

@app.route("/transcription_complete")
def transcription_complete():
    # Check for any JSON file corresponding to a final chunk
    chunk_dir = "chunks"
    completed_jsons = [
        f for f in os.listdir(chunk_dir)
        if f.endswith("_final.wav.json")
    ]
    return jsonify({"done": len(completed_jsons) > 0})

@app.route("/render_markdown", methods=["POST"])
def render_markdown():
    """
    Accepts JSON: { "markdown": "..." }
    Returns: { "html": "<div>...</div>" }
    """
    data = request.get_json()
    md_text = data.get("markdown", "")
    try:
        import markdown
        html = markdown.markdown(md_text, extensions=["extra", "sane_lists"])
        return jsonify({"html": html})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/upload_pdf", methods=["POST"])
def upload_pdf():
    if 'pdf' not in request.files:
        return jsonify({"error": "No PDF file uploaded"})
    
    file = request.files['pdf']
    if not file.filename.endswith('.pdf'):
        return jsonify({"error": "File must be a PDF"})

    try:
        # Ensure temp_pdf directory exists
        if not os.path.exists("temp_pdf"):
            os.makedirs("temp_pdf")
            
        # Save temporarily
        temp_path = os.path.join("temp_pdf", file.filename)
        file.save(temp_path)
        
        # Convert to text while preserving markdown-like structure
        markdown_text = convert_pdf_to_markdown(temp_path)
        
        # Clean up
        if os.path.exists(temp_path):
            os.remove(temp_path)
        
        return jsonify({"text": markdown_text})
    except Exception as e:
        return jsonify({"error": f"PDF processing error: {str(e)}"})
    
def convert_pdf_to_markdown(pdf_path):
    # Use pdfplumber to preserve structure
    import pdfplumber
    
    markdown_text = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            # Add page marker
            markdown_text.append(f"\n## Page {page.page_number}\n")
            
            text = page.extract_text()
            
            # Preserve headers (all caps lines as markdown headers)
            lines = text.split('\n')
            for line in lines:
                if line.isupper():
                    markdown_text.append(f"### {line}\n")
                else:
                    markdown_text.append(line + "\n")
                    
            markdown_text.append("\n---\n")  # Page separator
    
    return "".join(markdown_text)

@app.route("/end_session", methods=["POST"])
def end_session():
    """
    Save the current session to disk and clear the session data.
    """
    from datetime import datetime

    # Generate a filename based on the patient name and timestamp
    patient_name = session.get("scribe", {}).get("patient_name", "session").strip().replace(" ", "_") or "session"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    filename = f"{patient_name}_{timestamp}.json"

    # Save the session data to a file
    os.makedirs("transcripts", exist_ok=True)
    filepath = os.path.join("transcripts", filename)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump({"scribe": session.get("scribe", {}), "explore": session.get("explore", {})}, f)

    # Clear the session data
    session.pop('scribe', None)
    session.pop('explore', None)

    return jsonify({"status": "Session ended", "filename": filename}), 200

@app.route("/transcripts/<filename>")
def get_transcript(filename):
    folder = "transcripts"
    path = os.path.join(folder, filename)
    if not os.path.exists(path):
        return jsonify({"error": "Not found"}), 404
    with open(path, "r", encoding="utf-8") as f:
        return f.read(), 200, {'Content-Type': 'application/json'}

@app.route("/delete_session/<filename>", methods=["DELETE"])
def delete_session(filename):
    folder = "transcripts"
    path = os.path.join(folder, filename)
    if os.path.exists(path):
        os.remove(path)
        return jsonify({"status": "deleted"})
    return jsonify({"error": "Not found"}), 404

@app.route("/list_sessions", methods=['GET'])
def list_sessions():
    """
    List all saved session files in the transcripts directory.
    """
    transcript_dir = "transcripts"
    if not os.path.exists(transcript_dir):
        return jsonify([])

    files = [f for f in os.listdir(transcript_dir) if f.endswith('.json')]
    return jsonify(files), 200

@app.route("/shutdown", methods=["POST"])
def shutdown():
    shutdown_func = request.environ.get("werkzeug.server.shutdown")
    if shutdown_func:
        shutdown_func()
    return "Server shutting down..."

@app.route("/list_modules")
def list_modules():
    files = [f for f in os.listdir(MODULES_DIR) if f.endswith(".txt")]
    return jsonify(files)

@app.route("/load_module/<name>")
def load_module(name):
    path = os.path.join(MODULES_DIR, name)
    if not os.path.isfile(path):
        return "Not found", 404
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

@app.route("/save_module", methods=["POST"])
def save_module():
    data = request.get_json()
    name = data.get("name")
    content = data.get("content")
    if not name or not content:
        return "Missing name or content", 400
    path = os.path.join(MODULES_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return "OK"

@app.route("/delete_module/<name>", methods=["DELETE"])
def delete_module(name):
    path = os.path.join(MODULES_DIR, name)
    if os.path.isfile(path):
        os.remove(path)
        return "OK"
    return "Not found", 404

@app.route("/explore_search", methods=["POST"])
def explore_search():
    data = request.get_json()
    query = data.get("query", "")
    # These are all the chunks for the current chart
    all_chunks = session.get("explore_chunks", [])
    vectors = np.array(session.get("explore_vectors", []))
    inverted_index = {k: set(v) for k, v in session.get("explore_index", {}).items()}
    if not all_chunks or not len(vectors):
        return jsonify({"error": "No chart data loaded."}), 400
    # Top chunks for GPT answer
    top_chunks = hybrid_search(client, deploy_embed, query, all_chunks, vectors, inverted_index, top_k=20)
    answer = ask_gpt(client, deploy_chat, top_chunks, query)
    return jsonify({
        "chunks": all_chunks,   # <-- Return ALL chunks for chart display/citation scrolling
        "answer": answer
    })

@app.route("/save_full_session", methods=["POST"])
def save_full_session():
    """
    Save the current session data to a JSON file on disk.
    """
    data = request.get_json()
    name = data.get("name")
    scribe = session.get("scribe", {})
    explore = session.get("explore", {})

    if not name:
        return jsonify({"error": "No session name provided"}), 400

    os.makedirs("transcripts", exist_ok=True)
    filename = f"{name}.json"
    filepath = os.path.join("transcripts", filename)

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump({"scribe": scribe, "explore": explore}, f)

    return jsonify({"status": "Session saved to disk", "filename": filename}), 200

@app.route('/save_session', methods=['POST'])
def save_session():
    """
    Save session data (scribe and explore) to the server.
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    # Save scribe and explore data to the session
    session['scribe'] = data.get('scribe', {})
    session['explore'] = data.get('explore', {})
    return jsonify({"status": "Session saved"}), 200


@app.route('/load_session', methods=['GET'])
def load_session():
    """
    Load session data (scribe and explore) from the server.
    """
    scribe = session.get('scribe', {})
    explore = session.get('explore', {})
    return jsonify({"scribe": scribe, "explore": explore}), 200

@app.route('/clear_session', methods=['POST'])
def clear_session():
    """
    Clear the current session data from the server.
    """
    session.pop('scribe', None)
    session.pop('explore', None)
    return jsonify({"status": "Session cleared"}), 200

@app.route('/clear_live_transcript', methods=['POST'])
def clear_live_transcript():
    try:
        with open("live_transcript.txt", "w", encoding="utf-8") as f:
            f.write("")
        return jsonify({"status": "cleared"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/load_saved_session/<filename>', methods=['GET'])
def load_saved_session(filename):
    """
    Load a saved session from a JSON file.
    """
    filepath = os.path.join("transcripts", filename)
    if not os.path.exists(filepath):
        return jsonify({"error": "File not found"}), 404

    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Restore the session data
    session['scribe'] = data.get('scribe', {})
    session['explore'] = data.get('explore', {})
    return jsonify({"status": "Session loaded", "data": data}), 200

@app.route('/set_live_transcript', methods=['POST'])
def set_live_transcript():
    data = request.get_json()
    text = data.get("text", "")
    try:
        with open("live_transcript.txt", "w", encoding="utf-8") as f:
            f.write(text)
        return jsonify({"status": "set"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    # debug=False and no reloader so this process stays alive
    app.run(host="127.0.0.1", port=5000,
            debug=True, use_reloader=True)
