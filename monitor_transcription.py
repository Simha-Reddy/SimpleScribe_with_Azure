import os
import time
import requests
import json
from dotenv import load_dotenv

CHUNK_DIR = "chunks"
TRANSCRIPT_DIR = "transcripts"
LIVE_TRANSCRIPT = "live_transcript.txt"

def append_to_transcripts(text):
    with open(LIVE_TRANSCRIPT, "a", encoding="utf-8") as f:
        f.write(text.strip() + "\n")

def azure_speech(wav_path, api_key):
    endpoint = "https://spd-prod-openai-va-apim.azure-api.us"
    request_url = f"{endpoint}/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed"
    headers = {
        "api-key": api_key,
        "Content-Type": "audio/wav"
    }

    try:
        with open(wav_path, "rb") as f:
            audio_data = f.read()

        response = requests.post(request_url, headers=headers, data=audio_data)
        if response.status_code == 200:
            result = response.json()
            return result.get("DisplayText", "").strip()
        else:
            print(f"[ERROR] Azure Speech API error: {response.status_code} - {response.text}")
    except Exception as e:
        print(f"[ERROR] Exception during transcription: {e}")

    return ""

def monitor_chunks():
    load_dotenv()
    os.makedirs(TRANSCRIPT_DIR, exist_ok=True)
    os.makedirs(CHUNK_DIR, exist_ok=True)
    with open(LIVE_TRANSCRIPT, "w", encoding="utf-8") as f:
        f.write("")

    api_key = os.getenv("AZURE_SPEECH_KEY")
    if not api_key:
        print("[ERROR] Missing Azure Speech key in environment.")
        return

    processed = set()
    print("[INFO] Azure transcription monitor started...")

    while True:
        for fname in sorted(os.listdir(CHUNK_DIR)):
            if fname.endswith(".wav") and fname not in processed:
                wav_path = os.path.join(CHUNK_DIR, fname)
                print(f"[NEW] Found chunk: {fname}")

                try:
                    result = azure_speech(wav_path, api_key)
                    if result:
                        append_to_transcripts(result)
                        print(f"[✓] Appended transcript for {fname}")
                        os.remove(wav_path)
                    else:
                        print(f"[SKIP] Empty result for {fname}")
                        os.remove(wav_path)
                except Exception as e:
                    print(f"[ERROR] Failed to transcribe {fname}: {e}")

                processed.add(fname)
        time.sleep(2)

if __name__ == "__main__":
    monitor_chunks()
