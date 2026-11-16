# NotePulse — SyllabiQ Study Engine

Turn heavy 90-page PDFs, textbook photos, Word lecture notes, and pasted syllabi into crisp, exam-ready study guides in seconds.

## Features

- **Multi-File Upload**: Attach multiple PDFs, Word documents (`.docx`), text files (`.txt`, `.md`), and textbook or whiteboard photos (`.png`, `.jpg`, `.jpeg`, `.webp`) all at once.
- **6 Study Formats**:
  - **Compact Cheat Sheet**: High-yield definitions, bolded terms, and formulas without textbook fluff.
  - **Exam IMPs (1M & 4M)**: Splits material into 1-mark short Q&As and 4-mark long analytical questions.
  - **Memory Tricks**: Acronym-based mnemonics and quick recall cues for processes and lists.
  - **Visual Topic Tree**: Hierarchical topic map connecting chapters, sub-topics, and core concepts.
  - **Quick Summary**: Crisp 5-to-7 bullet 60-second chapter overview.
  - **Practice Quiz (5 MCQs)**: Interactive 5-question multiple-choice quiz with instant feedback, explanations, and live score tracking.
- **Ready to Share & Print**: Copy notes in one click, save as a Word document (`.doc`) or plain text (`.txt`), or print a clean black-on-white PDF sheet.
- **Works Online or Offline**: Uses Gemini (`gemini-2.5-flash`) when `GEMINI_API_KEY` is configured in `.env`, and automatically falls back to a built-in Python study-guide extraction engine when offline.

---

## Project Structure

```
/backend
  ├── app.py               # Python Flask API & multi-format file extraction engine
  └── requirements.txt     # Lightweight Python dependencies
/frontend
  ├── index.html           # Consumer-facing NotePulse study workbench
  ├── style.css            # Deep Obsidian & Electric Violet/Cyan theme + print styles
  └── app.js               # Interactive drag-and-drop, quiz engine & export actions
/README.md
```

---

## Getting Started

### 1. Set up the Python Backend

Make sure Python 3.9+ is installed, then install the dependencies:

```bash
cd backend
pip install -r requirements.txt
```

*(Optional)* If you want AI-enhanced study guides, create a `.env` file inside `/backend` with your key:

```env
GEMINI_API_KEY=your_key_here
```

*(Optional)* To scan text directly from photos of textbook pages or lecture boards offline, install [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) on your computer. PDFs and Word documents work right away without Tesseract.

Start the backend server on port `5000`:

```bash
python app.py
```

### 2. Open the Frontend

Open `frontend/index.html` directly in your browser (or serve the `frontend/` folder with any local static web server, such as `python -m http.server 8080` inside `frontend/`).
