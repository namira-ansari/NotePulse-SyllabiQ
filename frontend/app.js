(() => {
  const API_BASE =
    window.location.protocol === "file:" ||
    (window.location.port && window.location.port !== "5000" && window.location.port !== "3000")
      ? "http://127.0.0.1:5000"
      : "";

  const form = document.getElementById("study-form");
  const courseInput = document.getElementById("course-input");
  const notesInput = document.getElementById("notes-input");
  const formatCards = Array.from(document.querySelectorAll(".format-card"));
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const fileList = document.getElementById("file-list");
  const errorBanner = document.getElementById("error-banner");
  const noticeBanner = document.getElementById("notice-banner");
  const generateBtn = document.getElementById("generate-btn");
  const ctaLabel = generateBtn.querySelector(".cta-label");
  const ctaSpinner = generateBtn.querySelector(".cta-spinner");

  const selectedFormatPill = document.getElementById("selected-format-pill");
  const timeSavedPill = document.getElementById("time-saved-pill");
  const outputCanvas = document.getElementById("output-canvas");
  const quizContainer = document.getElementById("quiz-container");
  const quizCards = document.getElementById("quiz-cards");
  const quizScoreEl = document.getElementById("quiz-score");
  const retakeQuizBtn = document.getElementById("retake-quiz-btn");

  const printTitle = document.getElementById("print-title");
  const printSubtitle = document.getElementById("print-subtitle");

  const copyBtn = document.getElementById("copy-btn");
  const exportDocBtn = document.getElementById("export-doc-btn");
  const exportTxtBtn = document.getElementById("export-txt-btn");
  const printBtn = document.getElementById("print-btn");

  let selectedFormat = "compact_notes";
  let selectedFormatLabel = "✨ Compact Cheat Sheet";
  let attachedFiles = [];
  let currentResult = null;
  let quizAnswers = {};

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatInlineMarkdown(text) {
    let safe = escapeHtml(text);
    safe = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    safe = safe.replace(/\*(.+?)\*/g, "<em>$1</em>");
    safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
    return safe;
  }

  function renderStudyGuideHtml(markdown) {
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let inUl = false;
    let inOl = false;
    let treeBuffer = [];

    function closeLists() {
      if (inUl) {
        html.push("</ul>");
        inUl = false;
      }
      if (inOl) {
        html.push("</ol>");
        inOl = false;
      }
    }

    function flushTree() {
      if (treeBuffer.length > 0) {
        html.push(`<div class="tree-diagram">${escapeHtml(treeBuffer.join("\n"))}</div>`);
        treeBuffer = [];
      }
    }

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      const trimmed = line.trim();

      const isTreeLine =
        selectedFormat === "mind_map" &&
        (trimmed.includes("├──") ||
          trimmed.includes("└──") ||
          trimmed.startsWith("│") ||
          (treeBuffer.length > 0 && trimmed.length > 0 && !trimmed.startsWith("#")));

      if (isTreeLine) {
        closeLists();
        treeBuffer.push(line);
        continue;
      }

      if (
        selectedFormat === "mind_map" &&
        treeBuffer.length === 0 &&
        trimmed &&
        !trimmed.startsWith("#") &&
        !trimmed.startsWith("-") &&
        !trimmed.startsWith("*")
      ) {
        closeLists();
        treeBuffer.push(line);
        continue;
      }

      flushTree();

      if (!trimmed) {
        closeLists();
        continue;
      }

      if (trimmed.startsWith("### ")) {
        closeLists();
        html.push(`<h3>${formatInlineMarkdown(trimmed.slice(4))}</h3>`);
      } else if (trimmed.startsWith("## ")) {
        closeLists();
        html.push(`<h2>${formatInlineMarkdown(trimmed.slice(3))}</h2>`);
      } else if (trimmed.startsWith("# ")) {
        closeLists();
        html.push(`<h1>${formatInlineMarkdown(trimmed.slice(2))}</h1>`);
      } else if (/^[-*•]\s+/.test(trimmed)) {
        if (inOl) {
          html.push("</ol>");
          inOl = false;
        }
        if (!inUl) {
          html.push("<ul>");
          inUl = true;
        }
        html.push(`<li>${formatInlineMarkdown(trimmed.replace(/^[-*•]\s+/, ""))}</li>`);
      } else if (/^\d+\.\s+/.test(trimmed)) {
        if (inUl) {
          html.push("</ul>");
          inUl = false;
        }
        if (!inOl) {
          html.push("<ol>");
          inOl = true;
        }
        html.push(`<li>${formatInlineMarkdown(trimmed.replace(/^\d+\.\s+/, ""))}</li>`);
      } else {
        closeLists();
        html.push(`<p>${formatInlineMarkdown(trimmed)}</p>`);
      }
    }

    closeLists();
    flushTree();
    return html.join("\n");
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  }

  function clearError() {
    errorBanner.textContent = "";
    errorBanner.hidden = true;
  }

  function renderFileList() {
    fileList.innerHTML = "";
    if (attachedFiles.length === 0) {
      dropZone.classList.remove("has-files");
      return;
    }

    dropZone.classList.add("has-files");
    attachedFiles.forEach((file, index) => {
      const li = document.createElement("li");
      li.className = "file-chip";

      const nameSpan = document.createElement("span");
      nameSpan.className = "file-chip-name";
      nameSpan.textContent = file.name;
      nameSpan.title = file.name;

      const sizeSpan = document.createElement("span");
      sizeSpan.className = "file-chip-size";
      sizeSpan.textContent = formatFileSize(file.size);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "file-remove-btn";
      removeBtn.textContent = "×";
      removeBtn.setAttribute("aria-label", `Remove ${file.name}`);
      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        attachedFiles.splice(index, 1);
        renderFileList();
      });

      li.appendChild(nameSpan);
      li.appendChild(sizeSpan);
      li.appendChild(removeBtn);
      fileList.appendChild(li);
    });
  }

  function addFiles(newFiles) {
    clearError();
    const existingKeys = new Set(attachedFiles.map((f) => `${f.name}:${f.size}`));
    for (const file of Array.from(newFiles || [])) {
      const key = `${file.name}:${file.size}`;
      if (!existingKeys.has(key)) {
        attachedFiles.push(file);
        existingKeys.add(key);
      }
    }
    renderFileList();
  }

  // Format Selection
  formatCards.forEach((card) => {
    card.addEventListener("click", () => {
      formatCards.forEach((c) => {
        c.classList.remove("active");
        c.setAttribute("aria-pressed", "false");
      });
      card.classList.add("active");
      card.setAttribute("aria-pressed", "true");
      selectedFormat = card.dataset.format;
      selectedFormatLabel = card.dataset.label;
      selectedFormatPill.textContent = selectedFormatLabel;
    });
  });

  // Drag & Drop + File Picker
  dropZone.addEventListener("click", (event) => {
    if (event.target.closest(".file-remove-btn")) return;
    fileInput.click();
  });

  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length > 0) {
      addFiles(fileInput.files);
      fileInput.value = "";
    }
  });

  ["dragenter", "dragover"].forEach((evtName) => {
    dropZone.addEventListener(evtName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropZone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((evtName) => {
    dropZone.addEventListener(evtName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropZone.classList.remove("drag-over");
    });
  });

  dropZone.addEventListener("drop", (event) => {
    const dtFiles = event.dataTransfer ? event.dataTransfer.files : null;
    if (dtFiles && dtFiles.length > 0) {
      addFiles(dtFiles);
    }
  });

  function setLoading(isLoading) {
    generateBtn.disabled = isLoading;
    ctaSpinner.hidden = !isLoading;
    ctaLabel.textContent = isLoading ? "Crafting Your Study Guide..." : "✨ Create My Study Guide";

    if (isLoading) {
      quizContainer.hidden = true;
      outputCanvas.hidden = false;
      outputCanvas.innerHTML = `
        <div class="loading-state">
          <div class="loading-orb" aria-hidden="true"></div>
          <p class="loading-title">Reading your study material...</p>
          <p class="loading-sub">Organizing key ideas into ${escapeHtml(selectedFormatLabel)}.</p>
        </div>
      `;
    }
  }

  function setExportEnabled(enabled) {
    copyBtn.disabled = !enabled;
    exportDocBtn.disabled = !enabled;
    exportTxtBtn.disabled = !enabled;
    printBtn.disabled = !enabled;
  }

  function renderQuiz(quizData) {
    quizAnswers = {};
    const total = quizData.length;
    quizScoreEl.textContent = `Score: 0 / ${total}`;
    quizCards.innerHTML = "";

    const letters = ["A", "B", "C", "D"];

    quizData.forEach((item, qIndex) => {
      const card = document.createElement("article");
      card.className = "quiz-card";

      const questionEl = document.createElement("h3");
      questionEl.className = "quiz-question";
      questionEl.textContent = `Q${qIndex + 1}. ${item.question}`;

      const optionsWrap = document.createElement("div");
      optionsWrap.className = "quiz-options";

      const explanationEl = document.createElement("div");
      explanationEl.className = "quiz-explanation";
      explanationEl.hidden = true;

      (item.options || []).forEach((optText, optIndex) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "quiz-option";

        const badge = document.createElement("span");
        badge.className = "quiz-option-letter";
        badge.textContent = letters[optIndex] || String(optIndex + 1);

        const textSpan = document.createElement("span");
        textSpan.textContent = optText;

        btn.appendChild(badge);
        btn.appendChild(textSpan);

        btn.addEventListener("click", () => {
          if (quizAnswers[qIndex] !== undefined) return;
          const isCorrect = optIndex === item.correct_index;
          quizAnswers[qIndex] = isCorrect;

          const allBtns = optionsWrap.querySelectorAll(".quiz-option");
          allBtns.forEach((b, idx) => {
            b.disabled = true;
            if (idx === item.correct_index) {
              b.classList.add("is-correct");
            } else if (idx === optIndex && !isCorrect) {
              b.classList.add("is-wrong");
            }
          });

          const score = Object.values(quizAnswers).filter(Boolean).length;
          quizScoreEl.textContent = `Score: ${score} / ${total}`;

          explanationEl.innerHTML = `<strong>${isCorrect ? "✅ Spot on!" : "💡 Quick Tip:"}</strong> ${escapeHtml(item.explanation || "")}`;
          explanationEl.hidden = false;
        });

        optionsWrap.appendChild(btn);
      });

      card.appendChild(questionEl);
      card.appendChild(optionsWrap);
      card.appendChild(explanationEl);
      quizCards.appendChild(card);
    });
  }

  retakeQuizBtn.addEventListener("click", () => {
    if (currentResult && Array.isArray(currentResult.quiz_data) && currentResult.quiz_data.length > 0) {
      renderQuiz(currentResult.quiz_data);
    }
  });

  function buildPlainTextOutput() {
    if (!currentResult) return "";
    const title = currentResult.course_info || "Study Guide";
    const header = `${title}\n${currentResult.format_label || selectedFormatLabel} · Saves ~${currentResult.time_saved_mins || 1} mins of reading\n${"=".repeat(50)}\n\n`;

    if (currentResult.study_format === "flashcard_quiz" && Array.isArray(currentResult.quiz_data)) {
      const letters = ["A", "B", "C", "D"];
      const quizText = currentResult.quiz_data
        .map((q, i) => {
          const opts = q.options.map((o, idx) => `   ${letters[idx]}. ${o}`).join("\n");
          const ans = letters[q.correct_index] || "A";
          return `Q${i + 1}. ${q.question}\n${opts}\n   Answer: ${ans} — ${q.explanation}`;
        })
        .join("\n\n");
      return header + quizText;
    }

    return header + (currentResult.study_guide || "");
  }

  // Export & Action Buttons
  copyBtn.addEventListener("click", async () => {
    const text = buildPlainTextOutput();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const original = copyBtn.textContent;
      copyBtn.textContent = "✅ Copied!";
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 1800);
    } catch {
      showError("Could not copy automatically. Please select the text and press Ctrl+C / Cmd+C.");
    }
  });

  exportTxtBtn.addEventListener("click", () => {
    const text = buildPlainTextOutput();
    if (!text) return;
    const slug = (currentResult.course_info || "notepulse-study-guide")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slug || "notepulse-study-guide"}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  exportDocBtn.addEventListener("click", () => {
    if (!currentResult) return;
    const title = escapeHtml(currentResult.course_info || "NotePulse Study Guide");
    const bodyHtml =
      currentResult.study_format === "flashcard_quiz" && Array.isArray(currentResult.quiz_data)
        ? currentResult.quiz_data
            .map(
              (q, i) => `
              <h3>Q${i + 1}. ${escapeHtml(q.question)}</h3>
              <ul>${q.options.map((o, idx) => `<li>${["A", "B", "C", "D"][idx]}. ${escapeHtml(o)}</li>`).join("")}</ul>
              <p><strong>Answer:</strong> ${["A", "B", "C", "D"][q.correct_index]} — ${escapeHtml(q.explanation)}</p>
            `
            )
            .join("")
        : renderStudyGuideHtml(currentResult.study_guide || "");

    const wordHtml = `
      <html xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:w="urn:schemas-microsoft-com:office:word"
            xmlns="http://www.w3.org/TR/REC-html40">
      <head>
        <meta charset="utf-8" />
        <title>${title}</title>
        <style>
          body { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.6; color: #111827; }
          h1 { font-size: 18pt; color: #4c1d95; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
          h2 { font-size: 13pt; color: #5b21b6; margin-top: 16px; }
          h3 { font-size: 11.5pt; color: #0e7490; }
          .meta { color: #4b5563; font-size: 9.5pt; margin-bottom: 18px; }
          .tree-diagram { font-family: Consolas, monospace; white-space: pre-wrap; background: #f8fafc; padding: 10px; border: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <h1>${title}</h1>
        <p class="meta">Created with NotePulse · ${escapeHtml(currentResult.format_label || selectedFormatLabel)} · Saves ~${currentResult.time_saved_mins || 1} mins of reading</p>
        ${bodyHtml}
      </body>
      </html>
    `;

    const slug = (currentResult.course_info || "notepulse-study-guide")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const blob = new Blob(["\ufeff", wordHtml], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slug || "notepulse-study-guide"}.doc`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  printBtn.addEventListener("click", () => {
    window.print();
  });

  // Form Submission
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();
    noticeBanner.hidden = true;

    const rawNotes = notesInput.value.trim();
    if (attachedFiles.length === 0 && !rawNotes) {
      showError("Please attach at least one file or paste some notes before creating your study guide.");
      return;
    }

    const formData = new FormData();
    formData.append("course_info", courseInput.value.trim());
    formData.append("study_format", selectedFormat);
    formData.append("text_content", rawNotes);
    attachedFiles.forEach((file) => {
      formData.append("documents", file);
    });

    setLoading(true);
    setExportEnabled(false);

    try {
      const response = await fetch(`${API_BASE}/api/generate`, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(
          data.error || "Something went wrong while preparing your study guide. Please try again."
        );
      }

      currentResult = data;
      selectedFormatPill.textContent = selectedFormatLabel;

      const mins = Math.max(1, Number(data.time_saved_mins) || 1);
      timeSavedPill.textContent = `⏱️ Saves ~${mins} ${mins === 1 ? "min" : "mins"} of reading`;
      timeSavedPill.hidden = false;

      printTitle.textContent = data.course_info || "NotePulse Study Guide";
      printSubtitle.textContent = `${selectedFormatLabel} · Saves ~${mins} ${mins === 1 ? "min" : "mins"} of reading`;

      if (data.notice) {
        noticeBanner.textContent = data.notice;
        noticeBanner.hidden = false;
      }

      if (data.study_format === "flashcard_quiz" && Array.isArray(data.quiz_data) && data.quiz_data.length > 0) {
        outputCanvas.hidden = true;
        quizContainer.hidden = false;
        renderQuiz(data.quiz_data);
      } else {
        quizContainer.hidden = true;
        outputCanvas.hidden = false;
        outputCanvas.innerHTML = renderStudyGuideHtml(data.study_guide || "");
      }

      setExportEnabled(true);
    } catch (err) {
      outputCanvas.hidden = false;
      quizContainer.hidden = true;
      outputCanvas.innerHTML = `
        <div class="empty-state">
          <div class="empty-illustration" aria-hidden="true">💬</div>
          <h3 class="empty-title">We couldn't finish that request</h3>
          <p class="empty-copy">${escapeHtml(err.message || "Please check your files or connection and try again.")}</p>
        </div>
      `;
      showError(err.message || "Unable to create your study guide right now. Please try again.");
    } finally {
      setLoading(false);
    }
  });
})();
