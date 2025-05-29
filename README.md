# SimpleScribeVA

SimpleScribeVA is a clinical documentation assistant designed for healthcare providers. It streamlines the process of transcribing, summarizing, and exploring patient visit data using AI-powered tools and customizable templates.

---

## Features

- **Real-time Transcription:** Record and transcribe patient visits.
- **Prompt Templates:** Use or customize note templates for SOAP, Discharge, and more.
- **Explore Chart Data:** Query and search chart data in natural language, with answers that cite the chart source. Make your own smart modules to pull data in the way that works best for you.
- **Patient Instructions:** Generate clear, patient-centered after-visit instructions using AI.
- **PDF Export:** Print or save patient instructions as a formatted PDF.
- **Session Management:** Save, restore, and archive transcripts and notes.

---

## Getting Started

### 1. Clone the Repository

```sh
git clone https://github.com/Simha-Reddy/SimpleScribe_with_Azure.git
cd SimpleScribe_with_Azure
```

### 2. Install Dependencies

Make sure you have Python 3.8+ and pip installed.

```sh
pip install -r requirements.txt
```

### 3. Configure Environment Variables

Edit the `.env` file with your Azure/OpenAI and Flask keys.

```env
AZURE_OPENAI_API_KEY=your-key
AZURE_ENDPOINT=your-endpoint
AZURE_API_VERSION=2024-02-15-preview
AZURE_DEPLOYMENT_NAME=gpt-4
AZURE_EMBEDDING_DEPLOYMENT_NAME=text-embedding-ada-002
AZURE_SPEECH_KEY=your-speech-key
FLASK_SECRET_KEY=your-secret
```

### 4. Run the Application

```sh
python run_local_server.py
```

Then open [http://127.0.0.1:5000](http://127.0.0.1:5000) in your browser.

**A Better alternative:**  
Run `Setup.bat` followed by `StartSimpleScribeVA.bat` on Windows.

## Usage Overview

### Scribe Page
- Record, transcribe, and edit visit notes
- Generate patient instructions and print as PDF

### Explore Page
- Paste or prepare chart data
- Run queries and use keyword search

### Archive
- View and manage saved transcripts

### Settings
- Customize prompt templates and modules

## Folder Structure

- `templates/` — HTML templates for the web interface and prompts for making notes
- `static/` — JavaScript, CSS, and client assets
- `modules/` — Custom smart modules for chart data exploration

## Contributing

1. Fork the repository and create your branch
2. Make your changes and commit them
3. Push to your fork and submit a pull request

## License

This project is for internal VA use and research.  
Contact the maintainer for licensing questions.

## Contact

For questions or support, contact [simha.reddy@va.gov](mailto:simha.reddy@va.gov)
