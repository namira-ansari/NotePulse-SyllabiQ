import io
import json
import math
import os
import re
from collections import Counter
from typing import Any, Dict, List, Tuple

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS
from PIL import Image
from pypdf import PdfReader
from docx import Document
import pytesseract

try:
    from google import genai
    from google.genai import types as genai_types
    HAS_GENAI = True
except ImportError:
    HAS_GENAI = False

load_dotenv()

app = Flask(__name__)
CORS(app)

FORMAT_LABELS = {
    "compact_notes": "Compact Cheat Sheet",
    "exam_blueprint": "Exam IMPs (1M & 4M)",
    "mnemonics": "Memory Tricks",
    "mind_map": "Visual Topic Tree",
    "summarize": "Quick Summary",
    "flashcard_quiz": "Practice Quiz (5 MCQs)",
}

STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "from", "are", "was", "were",
    "have", "has", "had", "not", "but", "you", "your", "can", "will", "into",
    "its", "their", "there", "which", "when", "where", "what", "who", "how",
    "all", "any", "each", "more", "most", "other", "some", "such", "than",
    "then", "them", "these", "those", "only", "also", "very", "used", "using",
    "use", "one", "two", "three", "about", "been", "being", "between", "both",
    "could", "does", "done", "during", "even", "every", "first", "following",
    "given", "however", "important", "include", "includes", "including", "known",
    "large", "like", "made", "make", "many", "may", "might", "much", "must",
    "need", "often", "over", "part", "same", "should", "since", "small", "still",
    "take", "they", "through", "time", "under", "upon", "way", "well", "while",
    "within", "without", "would", "chapter", "section", "page", "notes", "lecture",
}


def extract_pdf_text(file_bytes: bytes, filename: str) -> str:
    try:
        reader = PdfReader(io.BytesIO(file_bytes))
        if reader.is_encrypted:
            try:
                decrypt_result = reader.decrypt("")
                if decrypt_result == 0:
                    raise ValueError(
                        f'"{filename}" is password-protected. Please unlock the PDF first and try uploading it again.'
                    )
            except ValueError:
                raise
            except Exception:
                raise ValueError(
                    f'"{filename}" is password-protected. Please unlock the PDF first and try uploading it again.'
                )

        pages_text: List[str] = []
        for idx, page in enumerate(reader.pages, start=1):
            text = (page.extract_text() or "").strip()
            if text:
                pages_text.append(f"[Page {idx}]\n{text}")

        if not pages_text:
            raise ValueError(
                f'"{filename}" looks like a scanned PDF without selectable text. Try taking a photo or screenshot of the page, or paste the text directly.'
            )
        return "\n\n".join(pages_text)
    except ValueError:
        raise
    except Exception:
        raise ValueError(
            f'We could not open "{filename}". Please make sure it is a valid, uncorrupted PDF file.'
        )


def extract_docx_text(file_bytes: bytes, filename: str) -> str:
    try:
        doc = Document(io.BytesIO(file_bytes))
        blocks: List[str] = []

        for para in doc.paragraphs:
            text = para.text.strip()
            if text:
                blocks.append(text)

        for table in doc.tables:
            for row in table.rows:
                row_cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
                if row_cells:
                    blocks.append(" | ".join(row_cells))

        if not blocks:
            raise ValueError(f'"{filename}" appears to be empty.')
        return "\n".join(blocks)
    except ValueError:
        raise
    except Exception:
        raise ValueError(
            f'We could not read "{filename}". Please make sure it is a standard Word (.docx) document.'
        )


def extract_image_text(file_bytes: bytes, filename: str) -> Tuple[str, str]:
    try:
        image = Image.open(io.BytesIO(file_bytes))
        image.load()
    except Exception:
        raise ValueError(
            f'We could not open "{filename}" as an image. Please upload a PNG, JPG, or WebP photo.'
        )

    try:
        ocr_text = pytesseract.image_to_string(image).strip()
        if not ocr_text:
            return "", f'No clear readable text was detected in "{filename}". Try a sharper, well-lit photo.'
        return ocr_text, ""
    except Exception:
        return (
            "",
            "Photo scanning needs Tesseract OCR installed on your computer. PDFs and Word docs work right away!",
        )


def extract_plain_text(file_bytes: bytes, filename: str) -> str:
    try:
        text = file_bytes.decode("utf-8").strip()
    except UnicodeDecodeError:
        text = file_bytes.decode("latin-1", errors="replace").strip()
    if not text:
        raise ValueError(f'"{filename}" is empty.')
    return text


def split_sentences(text: str) -> List[str]:
    cleaned = re.sub(r"\s+", " ", text).strip()
    raw = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", cleaned)
    sentences = [s.strip() for s in raw if len(s.strip()) >= 25]
    if not sentences:
        sentences = [line.strip() for line in text.splitlines() if len(line.strip()) >= 12]
    return sentences


def extract_key_terms(text: str, limit: int = 12) -> List[str]:
    words = re.findall(r"\b[A-Za-z][A-Za-z0-9\-]{2,}\b", text)
    counts = Counter()
    casing_map: Dict[str, str] = {}
    for w in words:
        lw = w.lower()
        if lw in STOPWORDS or lw.isdigit():
            continue
        counts[lw] += 1
        if lw not in casing_map or (w[0].isupper() and not w.isupper()):
            casing_map[lw] = w
    return [casing_map[lw] for lw, _ in counts.most_common(limit)]


def extract_definitions(text: str) -> List[Tuple[str, str]]:
    defs: List[Tuple[str, str]] = []
    seen = set()
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for line in lines:
        if ":" in line and not line.startswith("[Page"):
            term, desc = line.split(":", 1)
            term = term.strip(" -•*\t")
            desc = desc.strip()
            if 2 <= len(term.split()) <= 6 and len(desc) >= 15 and term.lower() not in seen:
                seen.add(term.lower())
                defs.append((term, desc))
                continue

        match = re.match(
            r"^([A-Z][A-Za-z0-9\s\-/]{2,45}?)\s+(?:is defined as|refers to|means|is a|is an|is the|are)\s+(.{18,220}?)[.?!]?$",
            line,
        )
        if match:
            term = match.group(1).strip()
            desc = match.group(2).strip()
            if term.lower() not in seen:
                seen.add(term.lower())
                defs.append((term, desc))

    if len(defs) < 4:
        for sentence in split_sentences(text):
            match = re.match(
                r"^([A-Z][A-Za-z0-9\s\-/]{2,40}?)\s+(?:is|are|refers to|means)\s+(.{20,200})$",
                sentence,
            )
            if match:
                term = match.group(1).strip()
                desc = match.group(2).strip()
                if term.lower() not in seen:
                    seen.add(term.lower())
                    defs.append((term, desc))
            if len(defs) >= 8:
                break
    return defs[:10]


def rank_sentences(text: str, count: int = 7) -> List[str]:
    sentences = split_sentences(text)
    if not sentences:
        return []
    key_terms = set(t.lower() for t in extract_key_terms(text, 20))
    scored: List[Tuple[float, int, str]] = []
    for idx, sentence in enumerate(sentences):
        words = re.findall(r"\b[a-zA-Z]{3,}\b", sentence.lower())
        if not words:
            continue
        overlap = sum(1 for w in words if w in key_terms)
        length_bonus = 1.0 if 10 <= len(words) <= 32 else 0.4
        position_bonus = 0.5 if idx < 3 else 0.0
        score = (overlap / max(1, math.sqrt(len(words)))) + length_bonus + position_bonus
        scored.append((score, idx, sentence))
    scored.sort(key=lambda item: item[0], reverse=True)
    top = sorted(scored[:count], key=lambda item: item[1])
    return [item[2] for item in top]


def extract_headings(text: str) -> List[str]:
    headings: List[str] = []
    seen = set()
    for raw_line in text.splitlines():
        line = raw_line.strip(" #*-•\t")
        if not line or line.startswith("--- Source:") or line.startswith("[Page"):
            continue
        is_short = 3 <= len(line) <= 70
        no_trailing_period = not line.endswith(".")
        looks_like_title = (
            raw_line.lstrip().startswith("#")
            or line.istitle()
            or re.match(r"^(?:Unit|Chapter|Module|Topic|Part|Section|\d+\.)\s+", line, re.I)
            or (is_short and no_trailing_period and len(line.split()) <= 7 and line[0].isupper())
        )
        if looks_like_title and line.lower() not in seen:
            seen.add(line.lower())
            headings.append(line)
        if len(headings) >= 6:
            break
    return headings


def offline_generate_study_guide(
    course_info: str, study_format: str, combined_text: str
) -> Tuple[str, List[Dict[str, Any]]]:
    subject = course_info.strip() or "Your Study Material"
    clean_body = re.sub(r"--- Source:.*?---", "", combined_text).strip()
    clean_body = re.sub(r"\[Page \d+\]", "", clean_body).strip()

    definitions = extract_definitions(clean_body)
    key_terms = extract_key_terms(clean_body, 12)
    top_sentences = rank_sentences(clean_body, 8)
    headings = extract_headings(combined_text)
    formulas = [
        line.strip()
        for line in clean_body.splitlines()
        if any(sym in line for sym in ["=", "->", "=>", "∑", "∫", "±"]) and 5 <= len(line.strip()) <= 100
    ][:6]

    if study_format == "compact_notes":
        lines = [f"# Compact Cheat Sheet: {subject}", ""]
        lines.append("## High-Yield Definitions & Core Terms")
        if definitions:
            for term, desc in definitions[:7]:
                lines.append(f"- **{term}**: {desc}")
        else:
            for term in key_terms[:6]:
                matching = next((s for s in top_sentences if term.lower() in s.lower()), "")
                lines.append(f"- **{term}**: {matching or 'Key concept highlighted in your notes.'}")
        lines.append("")
        lines.append("## Must-Know Exam Points")
        for sent in top_sentences[:6]:
            highlighted = sent
            for term in key_terms[:5]:
                highlighted = re.sub(rf"\b({re.escape(term)})\b", r"**\1**", highlighted, count=1)
            lines.append(f"- {highlighted}")
        if formulas:
            lines.append("")
            lines.append("## Key Formulas & Expressions")
            for f in formulas:
                lines.append(f"- `{f}`")
        return "\n".join(lines), []

    if study_format == "exam_blueprint":
        lines = [f"# Important Exam Questions (IMPs): {subject}", ""]
        lines.append("## Part A: High-Yield 1-Mark Short Questions & Answers")
        q_count = 0
        for term, desc in definitions[:5]:
            q_count += 1
            lines.append(f"{q_count}. **Q: What is {term}?**")
            lines.append(f"   **Ans:** {desc}")
        for term in key_terms:
            if q_count >= 5:
                break
            sent = next((s for s in top_sentences if term.lower() in s.lower()), "")
            if sent:
                q_count += 1
                lines.append(f"{q_count}. **Q: Briefly explain the role of {term} in {subject}.**")
                lines.append(f"   **Ans:** {sent}")
        if q_count == 0:
            for idx, sent in enumerate(top_sentences[:4], start=1):
                lines.append(f"{idx}. **Q: State a key principle covered in {subject}.**")
                lines.append(f"   **Ans:** {sent}")

        lines.append("")
        lines.append("## Part B: Important 4-Mark Long Analytical Questions")
        topics = headings[:4] if len(headings) >= 3 else key_terms[:4]
        if not topics:
            topics = [subject]
        for idx, topic in enumerate(topics[:4], start=1):
            related = [s for s in split_sentences(clean_body) if topic.lower() in s.lower()][:3]
            if not related:
                related = top_sentences[idx - 1 : idx + 1] or top_sentences[:2]
            lines.append(f"{idx}. **Discuss {topic} in detail with key properties and practical significance.** *(4 Marks)*")
            lines.append("   - **Marking Breakdown:** Core definition (1M), step-by-step explanation (2M), example or application (1M).")
            for r in related:
                lines.append(f"   - {r}")
        return "\n".join(lines), []

    if study_format == "mnemonics":
        lines = [f"# Memory Tricks & Mnemonics: {subject}", ""]
        chunk_items = [t for t, _ in definitions[:6]] if len(definitions) >= 4 else key_terms[:8]
        if not chunk_items:
            chunk_items = ["Review", "Understand", "Apply", "Test"]

        first_group = chunk_items[:5]
        acronym = "".join(item[0].upper() for item in first_group if item)
        lines.append(f"## Core Concept Acronym: **{acronym}**")
        lines.append("Use each letter to recall the main pillars in seconds:")
        for item in first_group:
            cue = next((d for t, d in definitions if t == item), "")
            if not cue:
                cue = next((s for s in top_sentences if item.lower() in s.lower()), "Core exam topic")
            lines.append(f"- **{item[0].upper()} — {item}**: {cue}")

        if len(chunk_items) > 5:
            second_group = chunk_items[5:9]
            acronym2 = "".join(item[0].upper() for item in second_group if item)
            lines.append("")
            lines.append(f"## Bonus Recall Cue: **{acronym2}**")
            for item in second_group:
                lines.append(f"- **{item[0].upper()} — {item}**")

        lines.append("")
        lines.append("## Quick 10-Second Memory Hooks")
        for sent in top_sentences[:4]:
            lines.append(f"- **Anchor Fact:** {sent}")
        return "\n".join(lines), []

    if study_format == "mind_map":
        lines = [f"# Visual Topic Tree: {subject}", ""]
        branches = headings[:5] if headings else key_terms[:4]
        if not branches:
            branches = ["Core Concepts", "Key Details"]
        lines.append(f"{subject}")
        for b_idx, branch in enumerate(branches):
            is_last_branch = b_idx == len(branches) - 1
            connector = "└──" if is_last_branch else "├──"
            prefix = "    " if is_last_branch else "│   "
            lines.append(f"{connector} {branch}")
            sub_points = [
                s for s in split_sentences(clean_body) if branch.lower() in s.lower()
            ][:3]
            if not sub_points and definitions:
                sub_points = [f"{t}: {d[:85]}..." if len(d) > 85 else f"{t}: {d}" for t, d in definitions[b_idx * 2 : b_idx * 2 + 2]]
            if not sub_points:
                sub_points = top_sentences[b_idx : b_idx + 2]
            for s_idx, point in enumerate(sub_points):
                sub_conn = "└──" if s_idx == len(sub_points) - 1 else "├──"
                short_point = point if len(point) <= 105 else point[:102].rstrip() + "..."
                lines.append(f"{prefix}{sub_conn} {short_point}")
        return "\n".join(lines), []

    if study_format == "summarize":
        lines = [f"# Quick Chapter Summary (TL;DR): {subject}", ""]
        bullets = top_sentences[:6] if top_sentences else [clean_body[:240]]
        for bullet in bullets:
            lines.append(f"- {bullet}")
        if key_terms:
            lines.append("")
            lines.append(f"**Key Terms Covered:** {', '.join(key_terms[:8])}")
        return "\n".join(lines), []

    # flashcard_quiz offline fallback
    quiz_data: List[Dict[str, Any]] = []
    all_sentences = split_sentences(clean_body)

    for idx, (term, desc) in enumerate(definitions[:5]):
        distractors = [d for t, d in definitions if t != term][:3]
        while len(distractors) < 3:
            fallback_pool = [
                f"A secondary formatting rule unrelated to {term}.",
                f"An optional manual override used only after completing {subject}.",
                "A legacy shortcut replaced in modern coursework.",
                "A general classroom guideline with no technical effect.",
            ]
            candidate = fallback_pool[len(distractors) % len(fallback_pool)]
            if candidate not in distractors:
                distractors.append(candidate)

        correct_pos = idx % 4
        options = distractors[:3]
        options.insert(correct_pos, desc if len(desc) <= 130 else desc[:127] + "...")
        quiz_data.append({
            "question": f"Which statement best describes {term}?",
            "options": options,
            "correct_index": correct_pos,
            "explanation": f"{term} — {desc}",
        })

    # Fill remaining questions up to 5 from key terms & sentences
    term_idx = 0
    while len(quiz_data) < 5 and term_idx < len(key_terms):
        term = key_terms[term_idx]
        term_idx += 1
        matching = next((s for s in all_sentences if term.lower() in s.lower()), "")
        if not matching:
            continue
        masked = re.sub(rf"\b{re.escape(term)}\b", "______", matching, count=1)
        if masked == matching:
            continue
        other_terms = [t for t in key_terms if t.lower() != term.lower()][:3]
        while len(other_terms) < 3:
            other_terms.append(f"Concept {len(other_terms) + 1}")
        correct_pos = len(quiz_data) % 4
        options = other_terms[:3]
        options.insert(correct_pos, term)
        quiz_data.append({
            "question": f"Fill in the blank from your notes: \"{masked}\"",
            "options": options,
            "correct_index": correct_pos,
            "explanation": matching,
        })

    # Final safety net to guarantee 5 questions even on very short pasted text
    defaults = [
        (
            f"What is the primary focus of your uploaded {subject} notes?",
            f"Core principles of {key_terms[0] if key_terms else subject}",
            "Unrelated administrative scheduling",
            "Blank template formatting only",
            "External bibliography citations only",
            top_sentences[0] if top_sentences else f"The material centers on {subject}.",
        ),
        (
            f"Which term appears as a recurring concept in {subject}?",
            key_terms[1] if len(key_terms) > 1 else (key_terms[0] if key_terms else subject),
            "Quantum Photosynthesis",
            "Medieval Heraldry",
            "Tectonic Subduction",
            f"This key term appears directly in your {subject} study material.",
        ),
        (
            "Which study strategy works best right after reviewing this summary?",
            "Active recall using short practice questions",
            "Re-reading the cover page repeatedly",
            "Skipping all definitions and examples",
            "Memorizing page numbers instead of concepts",
            "Testing yourself with active recall locks concepts into long-term memory.",
        ),
    ]
    d_idx = 0
    while len(quiz_data) < 5:
        q_text, ans, d1, d2, d3, exp = defaults[d_idx % len(defaults)]
        d_idx += 1
        correct_pos = len(quiz_data) % 4
        opts = [d1, d2, d3]
        opts.insert(correct_pos, ans)
        quiz_data.append({
            "question": q_text,
            "options": opts,
            "correct_index": correct_pos,
            "explanation": exp,
        })

    return "", quiz_data[:5]


def generate_with_gemini(
    api_key: str,
    course_info: str,
    study_format: str,
    combined_text: str,
    image_parts: List[Tuple[bytes, str]],
) -> Tuple[str, List[Dict[str, Any]]]:
    client = genai.Client(api_key=api_key)
    subject = course_info.strip() or "General Study Material"

    mode_instructions = {
        "compact_notes": (
            "Create a Compact Cheat Sheet. Strip out conversational textbook fluff and extract "
            "high-yield definitions, clear bullet points, formulas, and **bolded key terms** so a student can learn less and score more. "
            "Use clean markdown headings (##) and bullet lists."
        ),
        "exam_blueprint": (
            "Create Important Exam Questions (IMPs) tailored for both last-minute students and professors building exam banks. "
            "Split the output cleanly into two sections:\n"
            "## Part A: High-Yield 1-Mark Short Questions & Answers (5 to 7 concise Q&A pairs)\n"
            "## Part B: Important 4-Mark Long Analytical / Programming Questions (4 to 5 structured questions with clear bulleted answer points and marking hints)."
        ),
        "mnemonics": (
            "Create Memory Tricks & Mnemonics. Scan the material for multi-step processes, lists, classifications, hardware registers, or sequences, "
            "and build catchy acronym-based memory tricks, vivid mental hooks, and quick recall cues."
        ),
        "mind_map": (
            "Create a Visual Topic Tree. Generate a clean, hierarchical visual tree diagram using Unicode tree connectors (├──, └──, │) "
            "mapping the main subject at the root, major sub-topics as branches, and core concepts underneath. Keep each node concise and crystal clear."
        ),
        "summarize": (
            "Create a Quick Chapter Summary (TL;DR). Deliver a crisp 5-to-7 bullet executive summary capturing the essence of the entire material in 60 seconds, "
            "followed by a short 'Key Takeaways' line."
        ),
        "flashcard_quiz": (
            "Create an Interactive 5-Question Multiple Choice Quiz grounded strictly in the provided material. "
            "Return ONLY a valid JSON object with a single key `quiz_data` containing an array of exactly 5 objects. "
            "Each object must have: `question` (string), `options` (array of exactly 4 strings), `correct_index` (integer 0 to 3), and `explanation` (warm, clear 1-2 sentence explanation)."
        ),
    }

    prompt = (
        f"You are SyllabiQ, an encouraging, clear study assistant for students and professors.\n"
        f"Subject / Course: {subject}\n"
        f"Requested Mode: {FORMAT_LABELS.get(study_format, study_format)}\n\n"
        f"Instructions:\n{mode_instructions[study_format]}\n\n"
        f"Write in warm, plain, accessible English with zero developer jargon.\n\n"
        f"Study Material:\n{combined_text[:120000]}"
    )

    contents: List[Any] = [prompt]
    for img_bytes, mime_type in image_parts:
        contents.append(
            genai_types.Part.from_bytes(data=img_bytes, mime_type=mime_type)
        )

    models_to_try = ["gemini-2.5-flash", "gemini-4-hydrogen"]
    last_error: Exception | None = None

    for model_name in models_to_try:
        try:
            if study_format == "flashcard_quiz":
                response = client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=genai_types.GenerateContentConfig(
                        response_mime_type="application/json",
                    ),
                )
                raw_json = (response.text or "").strip()
                parsed = json.loads(raw_json)
                quiz_list = parsed.get("quiz_data", parsed) if isinstance(parsed, dict) else parsed
                if not isinstance(quiz_list, list) or len(quiz_list) == 0:
                    raise ValueError("Invalid quiz structure returned.")
                cleaned_quiz: List[Dict[str, Any]] = []
                for q in quiz_list[:5]:
                    opts = list(q.get("options", []))[:4]
                    while len(opts) < 4:
                        opts.append("None of the above")
                    idx = int(q.get("correct_index", 0))
                    if idx < 0 or idx > 3:
                        idx = 0
                    cleaned_quiz.append({
                        "question": str(q.get("question", "")).strip(),
                        "options": [str(o).strip() for o in opts],
                        "correct_index": idx,
                        "explanation": str(q.get("explanation", "")).strip(),
                    })
                return "", cleaned_quiz

            response = client.models.generate_content(
                model=model_name,
                contents=contents,
            )
            text_out = (response.text or "").strip()
            if not text_out:
                raise ValueError("Empty response from AI.")
            return text_out, []
        except Exception as err:
            last_error = err
            continue

    raise last_error or ValueError("Unable to generate content.")


@app.route("/api/generate", methods=["POST"])
def generate_study_guide():
    try:
        course_info = (request.form.get("course_info") or "").strip()
        study_format = (request.form.get("study_format") or "compact_notes").strip()
        text_content = (request.form.get("text_content") or "").strip()
        files = request.files.getlist("documents")

        if study_format not in FORMAT_LABELS:
            return jsonify({
                "success": False,
                "error": "Please pick one of the 6 study formats before creating your guide.",
            }), 400

        extracted_sections: List[str] = []
        image_parts: List[Tuple[bytes, str]] = []
        warnings: List[str] = []

        for f in files:
            filename = (f.filename or "").strip()
            if not filename:
                continue
            file_bytes = f.read()
            if not file_bytes:
                continue

            lower = filename.lower()
            if lower.endswith(".pdf"):
                text = extract_pdf_text(file_bytes, filename)
                extracted_sections.append(f"--- Source: {filename} ---\n{text}")
            elif lower.endswith(".docx"):
                text = extract_docx_text(file_bytes, filename)
                extracted_sections.append(f"--- Source: {filename} ---\n{text}")
            elif lower.endswith((".txt", ".md")):
                text = extract_plain_text(file_bytes, filename)
                extracted_sections.append(f"--- Source: {filename} ---\n{text}")
            elif lower.endswith((".png", ".jpg", ".jpeg", ".webp")):
                ext = lower.rsplit(".", 1)[-1]
                mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
                image_parts.append((file_bytes, mime))
                ocr_text, ocr_warning = extract_image_text(file_bytes, filename)
                if ocr_text:
                    extracted_sections.append(f"--- Source: {filename} (Photo Text) ---\n{ocr_text}")
                elif ocr_warning:
                    warnings.append(ocr_warning)
            else:
                return jsonify({
                    "success": False,
                    "error": f'"{filename}" is not a supported file type yet. Please upload PDFs, Word docs (.docx), text files (.txt), or photos (PNG/JPG/WebP).',
                }), 400

        if text_content:
            extracted_sections.append(f"--- Source: Pasted Notes ---\n{text_content}")

        combined_text = "\n\n".join(extracted_sections).strip()
        api_key = os.getenv("GEMINI_API_KEY", "").strip()

        if not combined_text and not (api_key and HAS_GENAI and image_parts):
            if warnings:
                return jsonify({"success": False, "error": warnings[0]}), 400
            return jsonify({
                "success": False,
                "error": "Please upload at least one file or paste some study notes so we have something to work with!",
            }), 400

        word_count = len(re.findall(r"\b\w+\b", combined_text))
        if word_count == 0 and image_parts:
            word_count = len(image_parts) * 220
        time_saved_mins = max(1, round(word_count / 200))

        study_guide = ""
        quiz_data: List[Dict[str, Any]] = []

        if api_key and HAS_GENAI:
            try:
                study_guide, quiz_data = generate_with_gemini(
                    api_key=api_key,
                    course_info=course_info,
                    study_format=study_format,
                    combined_text=combined_text or "Read the attached textbook or board photo(s) carefully.",
                    image_parts=image_parts,
                )
            except Exception:
                if not combined_text:
                    if warnings:
                        return jsonify({"success": False, "error": warnings[0]}), 400
                    return jsonify({
                        "success": False,
                        "error": "We had trouble reaching the study assistant right now. Please try again in a moment.",
                    }), 500
                study_guide, quiz_data = offline_generate_study_guide(
                    course_info, study_format, combined_text
                )
        else:
            study_guide, quiz_data = offline_generate_study_guide(
                course_info, study_format, combined_text
            )

        return jsonify({
            "success": True,
            "course_info": course_info or "General Study Guide",
            "study_format": study_format,
            "format_label": FORMAT_LABELS[study_format],
            "word_count": word_count,
            "time_saved_mins": time_saved_mins,
            "study_guide": study_guide,
            "quiz_data": quiz_data,
            "notice": warnings[0] if warnings and not (api_key and HAS_GENAI) else "",
        })

    except ValueError as err:
        return jsonify({"success": False, "error": str(err)}), 400
    except Exception:
        return jsonify({
            "success": False,
            "error": "Something unexpected happened while preparing your study guide. Please check your files and try again.",
        }), 500


if __name__ == "__main__":
    app.run(port=5000, debug=True)
