# SERVIA Knowledge Base (RAG) — Design

Status: draft, awaiting review
Scope: Step 1 of the SERVIA support agent. Ingest SERVIA PDFs and answer questions from them. Messaging channels (WhatsApp, Instagram, Messenger) and the human handoff flow are later steps.

## Goal

Given a folder of SERVIA PDFs (services, prices, FAQs), answer a customer's question in Egyptian Arabic using only what those PDFs say. Each answer cites the document and page it came from. If the PDFs do not contain the answer, the system says so and does not guess.

## Non-goals

- Messaging platform integration (later step).
- Web upload UI. Step 1 ingests the `documents/` folder through a CLI.
- OCR for scanned PDFs. Text-based PDFs only. Scanned pages are detected and reported.
- Embedding-based search (see Decision 2).
- Human handoff. Step 1 only returns a `confident` flag that the later handoff step will use.

## Decisions

1. **Runtime:** Node.js, CommonJS, matching the existing repo (`Procfile` runs a Node worker).
2. **Retrieval:** Lexical BM25 with Arabic normalization. No embedding vendor. Anthropic has no embeddings API, so embeddings would add a second vendor, key, and cost. For a set of brochure-sized PDFs, lexical search with Arabic normalization is usually enough. The retriever sits behind a small interface so embeddings can replace it later without touching the answer code.
3. **Generation:** Claude through the Messages API. The model is read from `ANSWER_MODEL`, default `claude-sonnet-5-5`. Nothing is hard-coded, so the model can be changed by environment variable.
4. **Storage:** `ingest` builds `data/index.json` from `documents/*.pdf` and rebuilds the whole index each run. No database in step 1.
5. **Threshold rule:** If the best retrieval score is below `RETRIEVAL_MIN_SCORE`, the system returns `confident: false` and makes no model call. This prevents invented answers and saves cost.

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/knowledge/pdf.js` | Extract text per page with `pdf-parse`. Flag pages with almost no text as possibly scanned. | `pdf-parse` |
| `src/knowledge/arabic.js` | Normalize text: remove tashkeel and tatweel, unify alef forms (أ إ آ → ا), ى → ي, ة → ه, collapse whitespace, lowercase Latin. Pure function. | none |
| `src/knowledge/chunk.js` | Split page text into chunks of about 500 characters with 80 characters of overlap. Each chunk keeps `docName` and `page`. Pure function. | none |
| `src/knowledge/bm25.js` | Build a BM25 index over chunks and score a query. Uses a short Arabic stopword list. | `arabic.js` |
| `src/knowledge/store.js` | Read and write `data/index.json`. | `fs` |
| `src/knowledge/ingest.js` | Folder → PDF extraction → chunks → index. Logs scanned or empty pages and continues. | the above |
| `src/agent/answer.js` | Retrieve top 5 chunks. Apply the threshold. Build the prompt and call Claude. Return `{ answer, sources, confident }`. The LLM client is injected. | `bm25`, store, Anthropic SDK |
| `src/agent/prompt.js` | System prompt and source formatting. Kept as constants so they are easy to edit. | none |
| `scripts/ingest.js` | CLI: `npm run ingest`. | `ingest.js` |
| `scripts/ask.js` | CLI: `npm run ask -- "سؤال"`. For manual testing. | `answer.js` |

The existing `bot.js` (Discord prayer-time bot) is not touched.

## Data flow

```
documents/*.pdf
   → pdf.js (text per page)
   → chunk.js (chunks with docName, page)
   → arabic.js normalize
   → bm25.js index
   → data/index.json

question
   → arabic.js normalize
   → bm25.js top 5
   → best score < RETRIEVAL_MIN_SCORE ? return { confident: false, answer: null, sources: [] }
   → Claude (system prompt + numbered sources)
   → { answer, sources: [{ docName, page }], confident: true }
```

## Prompt rules

- Answer only from the provided sources. If they do not contain the answer, say so.
- Reply in the customer's language. Default is Egyptian Arabic.
- Do not invent prices, dates, or promises.
- Cite each claim as `[document name, page N]`.

## Error handling

- Scanned or empty page: skip it, log the file and page number, and continue.
- Missing `ANTHROPIC_API_KEY`: fail at startup with a clear message.
- Anthropic API error: retry once with backoff. If it still fails, return an error result. Never return an empty answer that looks like success.
- Empty or whitespace-only question: rejected before retrieval.

## Testing

- `node:test` unit tests, no network:
  - `arabic.js`: tashkeel removal, alef and ya/alef maqsura unification, ta marbuta handling.
  - `chunk.js`: chunk size, overlap, and page metadata.
  - `bm25.js`: a query returns the expected chunk from a small fixture set. An unrelated query falls below the threshold.
  - `answer.js`: with a fake LLM client, checks the threshold path makes no model call, and the citation list matches the retrieved chunks.
- `pdf.js`: one small checked-in fixture PDF with known text under `test/fixtures/`.
- Manual check: ingest the real SERVIA PDFs and ask about 10 real questions. Record the results in the PR description.

## Risks

- **Arabic PDF extraction.** Some PDFs produce scrambled or reversed Arabic text, depending on how they were made. The first implementation task is to check extraction on the real files. If it is bad, switch the parser or ask for text-based exports.
- **Ephemeral storage.** The Procfile suggests a platform with ephemeral disks, so `documents/` and `data/index.json` could be lost on restart. Step 1 is local. Persistent storage is decided before the worker is deployed.
- **Synonyms.** Lexical search misses words like "سعر" and "تكلفة" or "ميعاد" and "موعد". A small synonym list for pricing and scheduling terms covers the obvious cases. Embeddings are the fallback if the manual check shows many misses.
- **Threshold tuning.** `RETRIEVAL_MIN_SCORE` is set from the manual check, not guessed.

## Open items for review

- Final value of `RETRIEVAL_MIN_SCORE`: set after the manual check.
- PDF library: `pdf-parse` is proposed. Confirm after the extraction check on real files.
- Persistent storage for the deployed worker: decided in the step that deploys the worker.
