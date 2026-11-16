import express from "express";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { createServer as createViteServer } from "vite";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FORMAT_LABELS: Record<string, string> = {
  compact_notes: "Compact Cheat Sheet",
  exam_blueprint: "Exam IMPs (1M & 4M)",
  mnemonics: "Memory Tricks",
  mind_map: "Visual Topic Tree",
  summarize: "Quick Summary",
  flashcard_quiz: "Practice Quiz (5 MCQs)",
};

interface UploadedFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

interface ParsedMultipart {
  fields: Record<string, string>;
  files: UploadedFile[];
}

function parseMultipart(body: Buffer, contentTypeHeader: string): ParsedMultipart {
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];

  const boundaryMatch = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    return { fields, files };
  }
  const boundaryStr = (boundaryMatch[1] || boundaryMatch[2]).trim();
  const boundaryBuf = Buffer.from(`--${boundaryStr}`);

  let pos = body.indexOf(boundaryBuf);
  while (pos !== -1) {
    const start = pos + boundaryBuf.length;
    if (body.subarray(start, start + 2).toString() === "--") {
      break;
    }
    const headerStart = body[start] === 13 && body[start + 1] === 10 ? start + 2 : start;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;

    const headersStr = body.subarray(headerStart, headerEnd).toString("utf8");
    const contentStart = headerEnd + 4;
    const nextBoundary = body.indexOf(boundaryBuf, contentStart);
    if (nextBoundary === -1) break;

    let contentEnd = nextBoundary;
    if (body[contentEnd - 2] === 13 && body[contentEnd - 1] === 10) {
      contentEnd -= 2;
    }
    const partData = body.subarray(contentStart, contentEnd);

    const nameMatch = headersStr.match(/name="([^"]+)"/i);
    const filenameMatch = headersStr.match(/filename="([^"]*)"/i);
    const mimeMatch = headersStr.match(/Content-Type:\s*([^\r\n]+)/i);

    if (nameMatch) {
      const fieldName = nameMatch[1];
      if (filenameMatch && filenameMatch[1] !== undefined) {
        if (filenameMatch[1].trim().length > 0 && partData.length > 0) {
          files.push({
            filename: filenameMatch[1].trim(),
            contentType: mimeMatch ? mimeMatch[1].trim() : "application/octet-stream",
            data: partData,
          });
        }
      } else {
        fields[fieldName] = partData.toString("utf8");
      }
    }

    pos = nextBoundary;
  }

  return { fields, files };
}

function extractDocxText(buffer: Buffer): string {
  // Minimal ZIP local/central directory reader for word/document.xml
  let offset = 0;
  while (offset + 30 < buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const filenameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + filenameLen).toString("utf8");
    const dataStart = nameStart + filenameLen + extraLen;

    // Handle data descriptor (bit 3) if compressedSize is 0
    let entrySize = compressedSize;
    if (entrySize === 0 && (buffer.readUInt16LE(offset + 6) & 0x08) !== 0) {
      const nextSig = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), dataStart);
      const cdSig = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), dataStart);
      const endPos = nextSig !== -1 ? nextSig : cdSig;
      if (endPos === -1) break;
      entrySize = endPos - dataStart;
    }

    const compressedData = buffer.subarray(dataStart, dataStart + entrySize);
    if (name === "word/document.xml") {
      const xmlBuf =
        compressionMethod === 8
          ? zlib.inflateRawSync(compressedData)
          : compressedData;
      const xml = xmlBuf.toString("utf8");
      const text = xml
        .replace(/<\/w:p>/g, "\n")
        .replace(/<\/w:tr>/g, "\n")
        .replace(/<w:tc[^>]*>/g, " | ")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return text;
    }

    offset = dataStart + entrySize;
  }
  throw new Error("Could not find readable text inside the Word document.");
}

function buildOfflineFallback(
  courseInfo: string,
  studyFormat: string,
  combinedText: string
): { study_guide: string; quiz_data: Array<Record<string, unknown>> } {
  const subject = courseInfo || "Your Study Material";
  const sentences = combinedText
    .replace(/--- Source:.*?---/g, "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);

  const lines = combinedText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("--- Source:"));

  if (studyFormat === "flashcard_quiz") {
    const baseFacts = sentences.length >= 3 ? sentences : lines;
    const quizData = Array.from({ length: 5 }, (_, idx) => {
      const fact = baseFacts[idx % Math.max(1, baseFacts.length)] || `Core concepts in ${subject}`;
      return {
        question: `Which of the following accurately reflects key points from ${subject} (Topic ${idx + 1})?`,
        options: [
          fact.length > 120 ? `${fact.slice(0, 117)}...` : fact,
          "An unrelated administrative guideline outside the syllabus",
          "A blank placeholder rule with no technical meaning",
          "A deprecated note excluded from all coursework",
        ],
        correct_index: 0,
        explanation: fact,
      };
    });
    return { study_guide: "", quiz_data: quizData };
  }

  if (studyFormat === "exam_blueprint") {
    return {
      study_guide: [
        `# Important Exam Questions (IMPs): ${subject}`,
        "",
        "## Part A: High-Yield 1-Mark Short Questions & Answers",
        ...sentences.slice(0, 4).map((s, i) => `${i + 1}. **Q: Summarize key point ${i + 1} from ${subject}.**\n   **Ans:** ${s}`),
        "",
        "## Part B: Important 4-Mark Long Analytical Questions",
        `1. **Explain the core principles of ${subject} with examples.** *(4 Marks)*`,
        ...(sentences.slice(0, 3).map((s) => `   - ${s}`)),
      ].join("\n"),
      quiz_data: [],
    };
  }

  if (studyFormat === "mind_map") {
    const branches = sentences.slice(0, 4);
    return {
      study_guide: [
        `# Visual Topic Tree: ${subject}`,
        "",
        subject,
        ...branches.map((b, i) => `${i === branches.length - 1 ? "└──" : "├──"} ${b.slice(0, 95)}`),
      ].join("\n"),
      quiz_data: [],
    };
  }

  return {
    study_guide: [
      `# ${FORMAT_LABELS[studyFormat] || "Study Guide"}: ${subject}`,
      "",
      ...sentences.slice(0, 6).map((s) => `- ${s}`),
    ].join("\n"),
    quiz_data: [],
  };
}

async function startServer() {
  const app = express();
  const port = 3000;

  app.post(
    "/api/generate",
    express.raw({ type: "multipart/form-data", limit: "30mb" }),
    async (req, res) => {
      try {
        const contentType = req.headers["content-type"] || "";
        const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
        const { fields, files } = parseMultipart(bodyBuf, contentType);

        const courseInfo = (fields.course_info || "").trim();
        const studyFormat = (fields.study_format || "compact_notes").trim();
        const textContent = (fields.text_content || "").trim();

        if (!FORMAT_LABELS[studyFormat]) {
          res.status(400).json({
            success: false,
            error: "Please pick one of the 6 study formats before creating your guide.",
          });
          return;
        }

        const textSections: string[] = [];
        const inlineParts: Array<{ inlineData: { data: string; mimeType: string } }> = [];

        for (const file of files) {
          const lower = file.filename.toLowerCase();
          if (lower.endsWith(".pdf")) {
            inlineParts.push({
              inlineData: {
                data: file.data.toString("base64"),
                mimeType: "application/pdf",
              },
            });
            textSections.push(`--- Source: ${file.filename} (PDF attached) ---`);
          } else if (lower.endsWith(".docx")) {
            try {
              const docText = extractDocxText(file.data);
              textSections.push(`--- Source: ${file.filename} ---\n${docText}`);
            } catch {
              res.status(400).json({
                success: false,
                error: `We could not read "${file.filename}". Please make sure it is a standard Word (.docx) document.`,
              });
              return;
            }
          } else if (lower.endsWith(".txt") || lower.endsWith(".md")) {
            const plain = file.data.toString("utf8").trim();
            if (plain) {
              textSections.push(`--- Source: ${file.filename} ---\n${plain}`);
            }
          } else if (/\.(png|jpe?g|webp)$/i.test(lower)) {
            const ext = lower.split(".").pop() || "png";
            const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
            inlineParts.push({
              inlineData: {
                data: file.data.toString("base64"),
                mimeType: mime,
              },
            });
            textSections.push(`--- Source: ${file.filename} (Photo attached) ---`);
          } else {
            res.status(400).json({
              success: false,
              error: `"${file.filename}" is not a supported file type yet. Please upload PDFs, Word docs (.docx), text files (.txt), or photos (PNG/JPG/WebP).`,
            });
            return;
          }
        }

        if (textContent) {
          textSections.push(`--- Source: Pasted Notes ---\n${textContent}`);
        }

        const combinedText = textSections.join("\n\n").trim();
        if (!combinedText && inlineParts.length === 0) {
          res.status(400).json({
            success: false,
            error: "Please upload at least one file or paste some study notes so we have something to work with!",
          });
          return;
        }

        const rawWords = combinedText.match(/\b\w+\b/g)?.length || 0;
        const wordCount = Math.max(rawWords, inlineParts.length * 450);
        const timeSavedMins = Math.max(1, Math.round(wordCount / 200));

        const apiKey = (process.env.GEMINI_API_KEY || "").trim();
        let studyGuide = "";
        let quizData: Array<Record<string, unknown>> = [];

        if (apiKey) {
          const ai = new GoogleGenAI({
            apiKey,
            httpOptions: {
              headers: {
                "User-Agent": "aistudio-build",
              },
            },
          });

          const modeInstructions: Record<string, string> = {
            compact_notes:
              "Create a Compact Cheat Sheet. Strip out conversational textbook fluff and extract high-yield definitions, clear bullet points, formulas, and **bolded key terms** so a student can learn less and score more. Use clean markdown headings (##) and bullet lists.",
            exam_blueprint:
              "Create Important Exam Questions (IMPs) tailored for both last-minute students and professors building exam banks. Split the output cleanly into two sections:\n## Part A: High-Yield 1-Mark Short Questions & Answers (5 to 7 concise Q&A pairs)\n## Part B: Important 4-Mark Long Analytical / Programming Questions (4 to 5 structured questions with clear bulleted answer points and marking hints).",
            mnemonics:
              "Create Memory Tricks & Mnemonics. Scan the material for multi-step processes, lists, classifications, hardware registers, or sequences, and build catchy acronym-based memory tricks, vivid mental hooks, and quick recall cues.",
            mind_map:
              "Create a Visual Topic Tree. Generate a clean, hierarchical visual tree diagram using Unicode tree connectors (├──, └──, │) mapping the main subject at the root, major sub-topics as branches, and core concepts underneath. Keep each node concise and crystal clear.",
            summarize:
              "Create a Quick Chapter Summary (TL;DR). Deliver a crisp 5-to-7 bullet executive summary capturing the essence of the entire material in 60 seconds, followed by a short 'Key Takeaways' line.",
            flashcard_quiz:
              "Create an Interactive 5-Question Multiple Choice Quiz grounded strictly in the provided material. Return ONLY a valid JSON object with a single key `quiz_data` containing an array of exactly 5 objects. Each object must have: `question` (string), `options` (array of exactly 4 strings), `correct_index` (integer 0 to 3), and `explanation` (warm, clear 1-2 sentence explanation).",
          };

          const prompt = `You are SyllabiQ, an encouraging, clear study assistant for students and professors.
Subject / Course: ${courseInfo || "General Study Material"}
Requested Mode: ${FORMAT_LABELS[studyFormat]}

Instructions:
${modeInstructions[studyFormat]}

Write in warm, plain, accessible English with zero developer jargon.

Study Material:
${combinedText.slice(0, 120000)}`;

          const parts: Array<Record<string, unknown>> = [{ text: prompt }, ...inlineParts];

          try {
            const response = await ai.models.generateContent({
              model: "gemini-4-hydrogen",
              contents: { parts },
              config:
                studyFormat === "flashcard_quiz"
                  ? {
                      responseMimeType: "application/json",
                      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                    }
                  : {
                      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                    },
            });

            if (studyFormat === "flashcard_quiz") {
              const parsed = JSON.parse((response.text || "{}").trim());
              const list = Array.isArray(parsed) ? parsed : parsed.quiz_data || [];
              quizData = list.slice(0, 5).map((q: Record<string, unknown>) => ({
                question: String(q.question || "").trim(),
                options: Array.isArray(q.options) ? q.options.slice(0, 4).map(String) : [],
                correct_index: Math.min(3, Math.max(0, Number(q.correct_index) || 0)),
                explanation: String(q.explanation || "").trim(),
              }));
            } else {
              studyGuide = (response.text || "").trim();
            }
          } catch (apiErr) {
            if (combinedText) {
              const fallback = buildOfflineFallback(courseInfo, studyFormat, combinedText);
              studyGuide = fallback.study_guide;
              quizData = fallback.quiz_data;
            } else {
              throw apiErr;
            }
          }
        } else {
          const fallback = buildOfflineFallback(courseInfo, studyFormat, combinedText);
          studyGuide = fallback.study_guide;
          quizData = fallback.quiz_data;
        }

        res.json({
          success: true,
          course_info: courseInfo || "General Study Guide",
          study_format: studyFormat,
          format_label: FORMAT_LABELS[studyFormat],
          word_count: wordCount,
          time_saved_mins: timeSavedMins,
          study_guide: studyGuide,
          quiz_data: quizData,
        });
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Something unexpected happened while preparing your study guide. Please try again.";
        res.status(500).json({
          success: false,
          error: message,
        });
      }
    }
  );

  // Serve the consumer-facing Vanilla frontend directly on port 3000
  app.use(express.static(path.resolve(__dirname, "frontend")));

  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);

  app.listen(port, "0.0.0.0", () => {
    console.log(`NotePulse running on http://localhost:${port}`);
  });
}

startServer();
