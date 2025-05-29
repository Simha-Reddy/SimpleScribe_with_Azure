import os
import re
import json
import numpy as np
from sklearn.neighbors import NearestNeighbors
from tqdm import tqdm
from collections import defaultdict
from openai import AzureOpenAI
from dotenv import load_dotenv

load_dotenv()  # <-- Make sure to load .env at the top

def chunk_text(text):
    chunks = []
    # Find all page breaks using "Page X of Y"
    page_breaks = [m.start() for m in re.finditer(r'Page\s+(\d+)\s+of\s+\d+', text)]
    page_breaks.append(len(text))  # Add end of text as last break

    # Build list of (page_number, page_text)
    pages = []
    last = 0
    for idx, start in enumerate(page_breaks[:-1]):
        # Extract page number
        match = re.search(r'Page\s+(\d+)\s+of\s+\d+', text[start:start+20])
        page_num = int(match.group(1)) if match else idx + 1
        end = page_breaks[idx+1]
        page_text = text[start:end]
        pages.append((page_num, page_text))
        last = end

    section_regex = r"(\n[A-Z0-9\s\-\(\)/,\.]+[:\-]\s*\n)"
    for page_num, page_text in pages:
        section_splits = re.split(section_regex, page_text)
        current_section = None
        current_body = []

        for part in section_splits:
            if re.match(section_regex, part):
                if current_section and current_body:
                    body = "\n".join(current_body).strip()
                    if body:
                        chunks.append({
                            "section": current_section,
                            "text": body,
                            "page": page_num
                        })
                current_section = part.strip()
                current_body = []
            else:
                current_body.append(part.strip())

        if current_section and current_body:
            body = "\n".join(current_body).strip()
            if body:
                chunks.append({
                    "section": current_section,
                    "text": body,
                    "page": page_num
                })

    return chunks

def get_embeddings_batched(client, deploy_embed, texts, batch_size=300):
    embeddings = []
    for i in tqdm(range(0, len(texts), batch_size), desc="Embedding batches"):
        batch = texts[i:i + batch_size]
        try:
            response = client.embeddings.create(
                input=batch,
                model=deploy_embed
            )
            embeddings.extend([np.array(d.embedding) for d in response.data])
        except Exception as e:
            print(f"[ERROR] Embedding batch {i // batch_size + 1} failed: {e}")
    return np.array(embeddings)

def rank_chunks(client, deploy_embed, chunks, vectors, query, top_k=20):
    query_vec = get_embeddings_batched(client, deploy_embed, [query])[0]
    index = NearestNeighbors(n_neighbors=min(top_k, len(vectors)), metric="cosine")
    index.fit(vectors)
    _, indices = index.kneighbors([query_vec])
    return [chunks[i] for i in indices[0]]

def ask_gpt(client, deploy_chat, top_chunks, query=None):
    context = "\n\n".join([
        f"### Source: {c['section']} (Page {c['page']})\n{c['text']}"
        for c in top_chunks
    ])
    if query:
        prompt = f"""You are a clinical assistant. Given the medical record segments below, write a concise narrative summary that answers the following question: "{query}". For each fact or statement, cite the section and page number in parentheses, e.g., (ACTIVE PROBLEMS, Page 58).

{context}
"""
    else:
        prompt = f"""You are a clinical assistant. Given the medical record segments below, write a concise narrative summary of the patient's active medical problems, treatments, and complications. For each fact or statement, cite the section and page number in parentheses, e.g., (ACTIVE PROBLEMS, Page 58).

{context}
"""

    print("\n==== PROMPT SENT TO OPENAI ====\n")
    print(prompt)
    print("\n==== END PROMPT ====\n")

    try:
        response = client.chat.completions.create(
            model=deploy_chat,
            messages=[
                {"role": "system", "content": "You are a clinical reasoning assistant."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.2
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"[ERROR] GPT call failed: {e}")
        return None

def build_inverted_index(chunks):
    index = defaultdict(set)
    for i, chunk in enumerate(chunks):
        words = set(re.findall(r'\b\w+\b', chunk['text'].lower()))
        for word in words:
            index[word].add(i)
    return index

def hybrid_search(client, deploy_embed, query, chunks, vectors, inverted_index, top_k=20):
    # Keyword search
    words = set(re.findall(r'\b\w+\b', query.lower()))
    keyword_hits = set()
    for word in words:
        keyword_hits.update(inverted_index.get(word, set()))
    keyword_chunks = [chunks[i] for i in keyword_hits]

    # Semantic search
    query_vec = get_embeddings_batched(client, deploy_embed, [query])[0]
    index = NearestNeighbors(n_neighbors=min(top_k, len(vectors)), metric="cosine")
    index.fit(vectors)
    _, indices = index.kneighbors([query_vec])
    semantic_chunks = [chunks[i] for i in indices[0]]

    # Combine, prioritizing semantic, then keyword
    seen = set()
    results = []
    for c in semantic_chunks + keyword_chunks:
        key = (c['section'], c['page'])
        if key not in seen:
            results.append(c)
            seen.add(key)
        if len(results) >= top_k:
            break
    return results

if __name__ == "__main__":
    # Example usage for CLI/testing only
    print("Paste chart text below. Press Ctrl+D (Linux/Mac) or Ctrl+Z (Windows) when done:\n")
    text = ""
    try:
        while True:
            text += input() + "\n"
    except EOFError:
        pass

    # Use .env variables as provided
    openai_api_key = os.getenv("AZURE_OPENAI_API_KEY")
    azure_endpoint = os.getenv("AZURE_ENDPOINT")
    api_version = os.getenv("AZURE_API_VERSION", "2024-02-15-preview")
    deploy_chat = os.getenv("AZURE_DEPLOYMENT_NAME")
    deploy_embed = os.getenv("AZURE_EMBEDDING_DEPLOYMENT_NAME", deploy_chat)

    client = AzureOpenAI(
        api_key=openai_api_key,
        api_version=api_version,
        azure_endpoint=azure_endpoint
    )

    chunks = chunk_text(text)
    print(f"[INFO] Created {len(chunks)} chunks.")

    texts = [c["text"] for c in chunks]
    vectors = get_embeddings_batched(client, deploy_embed, texts)
    print("[INFO] Completed Azure embedding batching.")

    query = "List the patient's active medical problems or conditions, and for each condition, any associated diagnostic labs or studies, treatments and complications."
    top_chunks = rank_chunks(client, deploy_embed, chunks, vectors, query)
    print("[INFO] Retrieved top relevant chunks.")

    result = ask_gpt(client, deploy_chat, top_chunks)
    print("\n==== GPT RESULT ====")
    print(result)
