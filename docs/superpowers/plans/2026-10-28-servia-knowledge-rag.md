# SERVIA Knowledge Base (RAG) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest SERVIA PDFs from `documents/`, retrieve relevant passages with BM25, and answer customer questions in Egyptian Arabic with citations, refusing to guess when the PDFs lack the answer.

**Architecture:** A pipeline of small pure modules (Arabic normalization, chunking, BM25) fed by thin I/O modules (PDF extraction, JSON store). `answer.js` takes an injected LLM client, so tests never touch the network. Two CLIs (`ingest`, `ask`) drive it.

**Tech Stack:** Node.js (CommonJS), `pdf-parse` for PDF text, `@anthropic-ai/sdk` for Claude, `node:test` and `node:assert` for tests.

**Spec:** `docs/superpowers/specs/2026-10-28-servia-knowledge-rag-design.md`

## Global Constraints

- Node.js CommonJS modules, matching `bot.js`. No TypeScript, no build step.
- `ANSWER_MODEL` env var, default `claude-sonnet-5-5`. Never hard-code a model elsewhere.
- `RETRIEVAL_MIN_SCORE` env var. Its default is set in Task 8 after the manual check; until then it defaults to `1.0` and the value is marked as provisional in code.
- Chunk size `500` characters, overlap `80` characters, `TOP_K = 5`.
- Tests make no network calls.
- `bot.js` is not modified.
- Commit after every task. Push to `claude/servia-ai-agent-messaging-099hjr`.

## Review Focus

1. **Empty or whitespace-only question** → rejected with an error result, no retrieval, no model call.
2. **Scanned PDF (no extractable text)** → ingest logs the file and page, indexes nothing for it, and does not crash.
3. **`ask` run before `ingest`** (no `data/index.json`) → clear error telling the user to run `npm run ingest`.
4. **Missing `ANTHROPIC_API_KEY`** → fails at startup with a message naming the variable.
5. **Anthropic API error twice** → `answer.js` returns `{ error }`, never an empty answer with `confident: true`.
6. **Customer text with tashkeel, tatweel, or alef variants** (e.g. "أسعار" vs "اسعار") → matches the same chunks as the plain form.
7. **Model returns `[HANDOFF]` inside a normal answer** → handoff flag is set only when the marker is the final line; the marker is stripped from the text either way.

Each line above gets its test in the task that owns the code.

---

### Task 1: Project setup

**Files:**
- Modify: `package.json`
- Create: `.gitignore`, `documents/.gitkeep`, `src/knowledge/.gitkeep`, `src/agent/.gitkeep`, `scripts/.gitkeep`, `test/.gitkeep`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` runs `node --test test/`. Dependencies `pdf-parse`, `@anthropic-ai/sdk` installed.

- [ ] **Step 1: Install dependencies**

Run: `npm install pdf-parse @anthropic-ai/sdk`
Expected: both appear under `dependencies` in `package.json`.

- [ ] **Step 2: Add scripts and ignore rules**

Set `scripts.test` to `node --test test/` and add `scripts.ingest` = `node scripts/ingest.js`, `scripts.ask` = `node scripts/ask.js`. `.gitignore` contains `node_modules/`, `data/`, `documents/*.pdf`.

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: exits 0, reports "no tests" or 0 tests run.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .gitignore documents/.gitkeep
git commit -m "chore: set up dependencies and test script for knowledge base"
```

---

### Task 2: Arabic normalization

**Files:**
- Create: `src/knowledge/arabic.js`
- Test: `test/arabic.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `normalizeArabic(text: string) -> string`

- [ ] **Step 1: Write the failing tests**

Assertions (exact values):
- `normalizeArabic("أَسْعَار")` === `"اسعار"` (tashkeel removed, alef unified)
- `normalizeArabic("إعلان آخر")` === `"اعلان اخر"`
- `normalizeArabic("مستشفى")` === `"مستشفي"` (ى → ي)
- `normalizeArabic("خدمة")` === `"خدمه"` (ة → ه)
- `normalizeArabic("ســعر")` === `"سعر"` (tatweel removed)
- `normalizeArabic("  Price   PDF  ")` === `"price pdf"` (Latin lowercased, whitespace collapsed and trimmed)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/arabic.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `normalizeArabic` in `src/knowledge/arabic.js`**

Use regex for tashkeel `[ً-ٰٟ]`, tatweel `ـ`, alef forms `[أإآ]` → `ا`, `ى` → `ي`, `ة` → `ه`, then lowercase and collapse `\s+`, then trim. Export only this function.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/arabic.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/arabic.js test/arabic.test.js
git commit -m "feat: add Arabic text normalization for search"
```

---

### Task 3: Chunking

**Files:**
- Create: `src/knowledge/chunk.js`
- Test: `test/chunk.test.js`

**Interfaces:**
- Consumes: nothing (raw text; normalization happens later in `bm25.js`)
- Produces:
  - `type Chunk = { id: string, docName: string, page: number, text: string }`
  - `chunkPages(docName: string, pages: { page: number, text: string }[]) -> Chunk[]`
  - `id` is `${docName}#p${page}#${indexWithinPage}`

- [ ] **Step 1: Write the failing tests**

- A 1200-character page produces chunks of at most 500 characters, and consecutive chunks on the same page share exactly 80 characters.
- Each chunk keeps `docName` and `page` from its input page.
- Pages with empty or whitespace-only text produce no chunks.
- A page shorter than 500 characters produces exactly one chunk equal to the trimmed text.
- Chunk ids are unique across two pages of the same document.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/chunk.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `chunkPages` in `src/knowledge/chunk.js`**

Sliding window with step `500 - 80 = 420`. Trim each page first. Do not split on word boundaries in this version (YAGNI); the overlap covers most cut words.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/chunk.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/chunk.js test/chunk.test.js
git commit -m "feat: split page text into overlapping chunks"
```

---

### Task 4: BM25 index and search

**Files:**
- Create: `src/knowledge/bm25.js`, `src/knowledge/stopwords.js`
- Test: `test/bm25.test.js`

**Interfaces:**
- Consumes: `normalizeArabic` from Task 2; `Chunk` from Task 3
- Produces:
  - `buildIndex(chunks: Chunk[]) -> Index` (plain JSON-serializable object, so the store can save it)
  - `searchIndex(index: Index, query: string, k: number) -> { chunk: Chunk, score: number }[]`, sorted by score descending, only results with `score > 0`
  - `STOPWORDS: Set<string>` exported from `stopwords.js`, a short list of Arabic and English function words, all stored in normalized form

- [ ] **Step 1: Write the failing tests**

Build a fixture of 4 chunks: one about prices ("سعر الباقة الشهرية 500 جنيه"), one about working hours, one about refunds, one about social media management.
- `searchIndex(idx, "كام سعر الباقة الشهرية", 3)[0].chunk.id` equals the prices chunk id. (Note: "كام" is not a stopword in this list, it matches nothing, and that is fine.)
- Tashkeel variant: `searchIndex(idx, "أَسْعَار الباقة", 3)[0].chunk.id` equals the prices chunk id.
- Query made only of stopwords returns `[]`.
- Query with no shared terms returns `[]`.
- Result length is at most `k`.
- Scores are strictly positive and sorted descending.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/bm25.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Standard BM25 with `k1 = 1.5`, `b = 0.75`. Tokenize as `normalizeArabic(text).split(/[^\p{L}\p{N}]+/u)`, drop empty tokens and stopwords. Index stores per-term postings, document lengths, and average length. Keep the index a plain object so `JSON.stringify` works.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/bm25.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/bm25.js src/knowledge/stopwords.js test/bm25.test.js
git commit -m "feat: add BM25 index and search with Arabic normalization"
```

---

### Task 5: PDF text extraction

**Files:**
- Create: `src/knowledge/pdf.js`
- Create: `test/fixtures/sample.pdf` (a 2-page PDF with known English text, generated once and committed)
- Test: `test/pdf.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `extractPages(filePath: string) -> Promise<{ pages: { page: number, text: string }[], emptyPages: number[] }>`
  - `page` is 1-based. A page counts as empty when its trimmed text is shorter than 20 characters; empty pages are listed in `emptyPages` and still appear in `pages` with their text.

- [ ] **Step 1: Create the fixture**

Generate `test/fixtures/sample.pdf` with two pages: page 1 contains "SERVIA monthly plan costs 500 EGP" and page 2 contains a line of more than 20 characters. Commit it.

- [ ] **Step 2: Write the failing tests**

- Two pages are returned, and page 1 text contains "monthly plan costs 500".
- `emptyPages` is `[]` for the fixture.
- Calling `extractPages` on a missing path rejects with an error whose message contains the path.

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/pdf.test.js`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

Read the file with `fs.promises.readFile`, call `pdf-parse` with a `pagerender` callback that collects each page's text. Do not use the full-document `text` field, since page numbers are needed.

- [ ] **Step 5: Run to verify pass**

Run: `node --test test/pdf.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/knowledge/pdf.js test/pdf.test.js test/fixtures/sample.pdf
git commit -m "feat: extract per-page text from PDFs and flag scanned pages"
```

---

### Task 6: Store and ingest pipeline

**Files:**
- Create: `src/knowledge/store.js`, `src/knowledge/ingest.js`, `scripts/ingest.js`
- Test: `test/ingest.test.js`

**Interfaces:**
- Consumes: `extractPages` (Task 5), `chunkPages` (Task 3), `buildIndex` (Task 4)
- Produces:
  - `saveIndex(filePath: string, index: Index) -> Promise<void>`, writes JSON and creates the directory if missing
  - `loadIndex(filePath: string) -> Promise<Index>`, rejects with a message telling the user to run `npm run ingest` when the file is missing
  - `ingestFolder(dir: string, outPath: string) -> Promise<{ documents: number, chunks: number, emptyPages: { docName: string, page: number }[] }>`
  - `docName` is the PDF file name without the `.pdf` extension.

- [ ] **Step 1: Write the failing tests**

Use a temp directory containing a copy of `test/fixtures/sample.pdf` and a `notes.txt` file (must be ignored).
- `ingestFolder` returns `documents: 1` and `chunks >= 2`.
- The output file exists and `loadIndex` returns an object that `searchIndex` can query for "monthly plan".
- `loadIndex` on a missing path rejects with a message containing `npm run ingest`.
- An empty folder yields `documents: 0, chunks: 0` and still writes an index.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ingest.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`ingestFolder` lists `*.pdf` (case-insensitive), extracts each, logs each empty page with `console.warn`, chunks, builds the index once, and saves it. `scripts/ingest.js` calls `ingestFolder("documents", "data/index.json")` and prints the summary line.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/ingest.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Manual run**

Run: `npm run ingest`
Expected: prints a summary with 0 documents if `documents/` is empty, and exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/knowledge/store.js src/knowledge/ingest.js scripts/ingest.js test/ingest.test.js
git commit -m "feat: ingest a folder of PDFs into a persisted BM25 index"
```

---

### Task 7: Prompt module

**Files:**
- Create: `src/agent/prompt.js`
- Test: `test/prompt.test.js`

**Interfaces:**
- Consumes: `SearchHit` shape from Task 4 (`{ chunk, score }`)
- Produces:
  - `SYSTEM_PROMPT: string`, the full text drafted in the conversation for the first agent prompt, with the `[HANDOFF]` rules included verbatim
  - `HANDOFF_MARKER: "[HANDOFF]"`
  - `formatSources(hits: { chunk: Chunk, score: number }[]) -> string`, numbered blocks: `[1] (docName, صفحة N)\n<text>`, joined by a blank line
  - `buildUserMessage(question: string, hits) -> string`, returns the question followed by the formatted sources

- [ ] **Step 1: Write the failing tests**

- `SYSTEM_PROMPT` contains `[HANDOFF]` and the phrase "ONLY the information in the SOURCES".
- `formatSources` on two hits produces `[1] (sample, صفحة 1)` as the first line of the first block, and `[2]` for the second.
- `formatSources([])` returns the string `"لا توجد مصادر مطابقة."`.
- `buildUserMessage("q", [])` ends with the no-sources line and starts with `q`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/prompt.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Copy the system prompt text from the conversation into a template literal exactly as agreed, with no edits. Keep it in this one file so it is easy to find and edit.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/prompt.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent/prompt.js test/prompt.test.js
git commit -m "feat: add agent system prompt and source formatting"
```

---

### Task 8: Answer pipeline

**Files:**
- Create: `src/agent/answer.js`
- Test: `test/answer.test.js`

**Interfaces:**
- Consumes: `searchIndex` (Task 4), `SYSTEM_PROMPT`, `HANDOFF_MARKER`, `buildUserMessage` (Task 7), an injected client with the Anthropic SDK shape `client.messages.create({ model, max_tokens, system, messages }) -> Promise<{ content: { type: "text", text: string }[] }>`
- Produces:
  - `answerQuestion({ question, index, client, model, minScore, topK }) -> Promise<AnswerResult>`
  - `type AnswerResult = { confident: boolean, answer: string | null, handoff: boolean, sources: { docName: string, page: number }[], error?: string }`
  - Defaults: `topK = 5`, `minScore = Number(process.env.RETRIEVAL_MIN_SCORE ?? 1.0)`, `model = process.env.ANSWER_MODEL ?? "claude-sonnet-5-5"`, `max_tokens = 800`.

Behavior:
1. Trim the question. If empty, return `{ confident: false, answer: null, handoff: false, sources: [], error: "empty question" }` with no retrieval.
2. Search. If no hit or the top score is below `minScore`, return `{ confident: false, answer: null, handoff: false, sources: [] }` with no model call.
3. Call the model once. On a thrown error, wait 1 second and retry once. If the retry also throws, return `{ confident: false, answer: null, handoff: false, sources, error: <message> }`.
4. Read text from the response. If the last non-empty line equals `HANDOFF_MARKER`, set `handoff: true` and remove that line. Remove the marker from anywhere else it appears.
5. Return `{ confident: true, answer, handoff, sources }`, where `sources` are the unique `(docName, page)` pairs of the hits sent to the model.

- [ ] **Step 1: Write the failing tests** (fake client that records calls)

- Empty question: no model call, `error` is "empty question".
- Unrelated question with the fixture index: `confident: false`, fake client call count 0.
- Matching question: `confident: true`, the fake client receives `system` equal to `SYSTEM_PROMPT`, and `sources` contains `{ docName: "sample", page: 1 }`.
- Fake returns text ending with `\n[HANDOFF]`: `handoff: true`, `answer` does not contain the marker.
- Fake returns text containing `[HANDOFF]` mid-sentence: `handoff: false`, marker removed from the text.
- Fake throws twice: `confident: false`, `error` is set, and `answer` is `null` (never an empty string).
- Fake throws once then succeeds: `confident: true`, call count 2.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/answer.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** per the behavior list above. Use `setTimeout` promise for the 1-second wait; tests should pass a `retryDelayMs` option set to `0` to keep them fast, default `1000`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/answer.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent/answer.js test/answer.test.js
git commit -m "feat: answer questions from retrieved sources with threshold and handoff flag"
```

---

### Task 9: Ask CLI, startup checks, and manual verification

**Files:**
- Create: `scripts/ask.js`
- Modify: `README.md`
- Test: `test/ask.test.js`

**Interfaces:**
- Consumes: `loadIndex` (Task 6), `answerQuestion` (Task 8), `@anthropic-ai/sdk`
- Produces: `npm run ask -- "<question>"` prints the answer, the sources, and a `[HANDOFF]` notice when the flag is set.

- [ ] **Step 1: Write the failing tests**

Test a pure helper `checkEnv(env) -> string | null` exported from `scripts/ask.js`:
- Returns `null` when `ANTHROPIC_API_KEY` is set.
- Returns a message containing `ANTHROPIC_API_KEY` when it is missing.
- Also test `formatResult(result) -> string`: a handoff result contains the phrase `فريق SERVIA`; a no-confidence result contains `معنديش معلومة`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ask.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`scripts/ask.js` checks env with `checkEnv` and exits 1 with the message if missing. It loads `data/index.json` via `loadIndex`, creates the SDK client `new Anthropic()`, calls `answerQuestion`, and prints `formatResult(result)`. Guard the `main()` call with `if (require.main === module)` so the helpers can be imported in tests.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/ask.test.js`
Expected: PASS.

- [ ] **Step 5: Manual verification with real SERVIA PDFs**

1. Put the real SERVIA PDFs in `documents/`.
2. Run `npm run ingest`. Note the summary and every empty-page warning.
3. Run `npm run ask -- "<question>"` for 10 real questions: 5 answerable from the PDFs, 3 not answerable, 2 that should hand off (refund, complaint).
4. Record the results in a table in the PR description: question, expected, actual, confident, handoff.
5. Set `RETRIEVAL_MIN_SCORE` from these results. Choose the value that rejects the 3 unanswerable questions without rejecting the 5 answerable ones. Update the default in `answer.js` and its test in the same commit.

Expected: the 5 answerable questions return `confident: true` with the right source, the 3 unanswerable return `confident: false`, and the 2 hand-off questions return `handoff: true`.

- [ ] **Step 6: Update README**

Add a short section: install, put PDFs in `documents/`, `npm run ingest`, `npm run ask -- "..."`, and the env vars `ANTHROPIC_API_KEY`, `ANSWER_MODEL`, `RETRIEVAL_MIN_SCORE`.

- [ ] **Step 7: Commit**

```bash
git add scripts/ask.js test/ask.test.js README.md src/agent/answer.js test/answer.test.js
git commit -m "feat: add ask CLI with startup checks and document usage"
```

---

## Self-Review Notes

- **Spec coverage:** every component in the spec's table maps to a task (pdf → 5, arabic → 2, chunk → 3, bm25 → 4, store/ingest → 6, prompt → 7, answer → 8, both CLIs → 6 and 9). Threshold, retry, citations, and the no-guess rule are in tasks 8 and 9.
- **Type consistency:** `Chunk`, `Index`, `SearchHit` (`{ chunk, score }`), and `AnswerResult` are used with the same names in every task that consumes them.
- **Review Focus:** all seven lines have a test in the owning task (tasks 2, 3, 4, 5, 6, 8, 9).
- **Open risk:** Arabic extraction quality from real PDFs is only checked in task 9 step 5. If it fails there, tasks 5 and 6 need a parser change before the threshold work is valid.
