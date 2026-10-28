# SERVIA knowledge base

These files are the **only** business facts the assistant may use. Edit them freely — no code changes needed —
then run `npm run knowledge:reload` (or `POST /admin/knowledge/reload`).

## Format

- One topic per file. Markdown (`.md`) and text-based PDF (`.pdf`) are supported.
- The first `# Heading` is the document title. Each `## Section` becomes one searchable passage
  (long sections are split by paragraph). Passage IDs look like `pricing-and-commercial-policies#2`
  and are stored on every answer for auditing.
- Write each fact in English **and** Arabic. Customers write in Arabic and English, and search matches words,
  so a fact written only in English will not be found for an Arabic question.
- Lines starting with `> OWNER` and `<!-- comments -->` are notes for you; they are **not** indexed and the
  assistant never sees them.
- Files whose names start with `_`, and this README, are ignored.

## Rules

- Write only facts you have verified. If something is not decided yet (prices, timelines), say so plainly,
  e.g. "Pricing is not published; the SERVIA team shares it after understanding the clinic's needs."
- Never write guarantees, testimonials, client names or results unless they are true and you are allowed to share them.
- The values marked **UNCONFIRMED** were not available when this knowledge base was created
  (getservia.tech could not be read from the build environment). Replace each `> OWNER TODO` with real facts.
