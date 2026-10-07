/**
 * Seed Upstash Vector with chunks from data/globe-telecom-help-center.pdf
 * (Globe Telecom Help Center: Postpaid & Platinum, GlobeOne app, Rewards, Prepaid).
 *
 * Run once before starting the chat:
 *   npm run seed
 *
 * Re-run any time you replace the PDF in data/ with a different document.
 * Existing chunks are overwritten by id (we use deterministic ids).
 */
import { config as loadEnv } from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';

// Next.js reads .env.local automatically; this script does not.
loadEnv({ path: path.join(process.cwd(), '.env.local') });
import { Index } from '@upstash/vector';
import { embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
// pdf-parse uses CommonJS; default-import the parser fn
import pdfParse from 'pdf-parse';

const PDF_PATH = path.join(process.cwd(), 'data', 'globe-telecom-help-center.pdf');

// Vocareum (and other OpenAI-compatible proxies) require a custom baseURL;
// defaults to the real OpenAI API if OPENAI_BASE_URL is not set.
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});
const MAX_CHUNK_SIZE = 1200; // hard cap so one unusually long answer doesn't balloon into a giant chunk
const MIN_CHUNK_SIZE = 50;   // fragments shorter than this get merged into a neighbor rather than kept standalone
const CHUNK_OVERLAP = 100;   // overlap used only by the size-cap fallback splitter below

type Chunk = { text: string; page: number };

/**
 * FAQ-aware chunker.
 *
 * This corpus (scraped Globe Telecom Help Center pages) is a dense,
 * continuous stream of "Question? Answer text. Next question? Answer
 * text..." with no blank-line separators between Q&A pairs -- the only
 * reliable boundary is a line ending in "?" that starts a new question.
 *
 * The original naive ~800-char sliding-window chunker ignored this
 * structure and could cut a chunk boundary mid-answer, severing an answer
 * from its own question. This was caught concretely during Phase 5 testing:
 * an "eSIM replacement" answer (take a selfie, visit a Globe Store) got
 * retrieved and presented as general "new eSIM" guidance, because the
 * retrieved chunk started mid-sentence with its "...replacement..." question
 * heading left behind in the previous chunk -- the model had no way to know
 * which scenario the text actually applied to, because that context simply
 * wasn't in what it received.
 *
 * This chunker instead walks each page line by line and starts a new unit
 * whenever it hits a line that looks like a question (ends in "?"), so each
 * chunk is a complete question + its full answer. Units shorter than
 * MIN_CHUNK_SIZE (e.g. a stray section header before the first real
 * question) are merged into a neighboring unit rather than kept as their
 * own low-value, context-free chunk. Units longer than MAX_CHUNK_SIZE (e.g.
 * a long numbered-steps answer) fall back to the old sliding-window split so
 * no single chunk gets too large for embedding quality.
 */
function chunkText(text: string, page: number): Chunk[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  // Group lines into question-led units.
  const units: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    const looksLikeQuestion = /\?\s*$/.test(line);
    if (looksLikeQuestion && buf.length > 0) {
      units.push(buf.join(' '));
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length > 0) units.push(buf.join(' '));

  // Merge fragments shorter than MIN_CHUNK_SIZE into a neighbor: forward if
  // it's the first unit on the page (typically a stray header before the
  // first question), backward otherwise.
  const merged = [...units];
  for (let idx = 0; idx < merged.length; idx++) {
    if (merged[idx].length >= MIN_CHUNK_SIZE) continue;
    if (idx === 0 && merged.length > 1) {
      merged[1] = (merged[0] + ' ' + merged[1]).trim();
      merged[0] = '';
    } else if (idx > 0) {
      merged[idx - 1] = (merged[idx - 1] + ' ' + merged[idx]).trim();
      merged[idx] = '';
    }
  }
  const cleaned = merged.filter((u) => u.length > 0);

  // Cap oversized units with the sliding-window split as a fallback.
  const out: Chunk[] = [];
  for (const unit of cleaned) {
    if (unit.length <= MAX_CHUNK_SIZE) {
      out.push({ text: unit, page });
    } else {
      out.push(...slidingWindowSplit(unit, page));
    }
  }
  return out;
}

/** Fallback splitter for a single unit that's longer than MAX_CHUNK_SIZE. */
function slidingWindowSplit(text: string, page: number): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + MAX_CHUNK_SIZE);
    if (end < text.length) {
      const lookahead = text.slice(end, end + 200);
      const m = lookahead.match(/[.!?]\s/);
      if (m && m.index !== undefined) end += m.index + 1;
    }
    const piece = text.slice(i, end).trim();
    if (piece.length > 0) out.push({ text: piece, page });
    if (end >= text.length) break;
    i = end - CHUNK_OVERLAP;
  }
  return out;
}

// pdf-parse's default page renderer joins pages with plain "\n\n" -- there is
// NO form-feed or other unambiguous page-boundary marker in its output by
// default (confirmed against the installed pdf-parse version's source:
// node_modules/pdf-parse/lib/pdf-parse.js just does
// `ret.text = ret.text + '\n\n' + pageText`). Splitting on '\f' against that
// default output always finds exactly one "page" no matter how many real
// PDF pages exist, which silently mislabels every chunk's page metadata.
// To get real per-page boundaries we supply our own pagerender (mirrors the
// library's default text-extraction logic exactly) that appends an explicit
// form-feed marker, which we then split on below.
async function renderPageWithBoundary(pageData: any): Promise<string> {
  const textContent = await pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  let lastY: number | undefined;
  let text = '';
  for (const item of textContent.items as { str: string; transform: number[] }[]) {
    if (lastY === item.transform[5] || lastY === undefined) {
      text += item.str;
    } else {
      text += '\n' + item.str;
    }
    lastY = item.transform[5];
  }
  return text + '\f';
}

async function loadAndChunkPdf(filePath: string): Promise<Chunk[]> {
  const buf = await fs.readFile(filePath);
  const parsed = await pdfParse(buf, { pagerender: renderPageWithBoundary });
  const pages = parsed.text.split('\f');
  const chunks: Chunk[] = [];
  pages.forEach((pageText, pageIdx) => {
    if (pageText.trim().length === 0) return;
    chunks.push(...chunkText(pageText.trim(), pageIdx + 1));
  });
  console.log(`  pdf-parse reports ${parsed.numpages} actual PDF page(s)`);
  return chunks;
}

async function main() {
  if (!process.env.UPSTASH_VECTOR_REST_URL || !process.env.UPSTASH_VECTOR_REST_TOKEN) {
    console.error('Missing UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN. Set them in .env.local.');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in .env.local.');
    process.exit(1);
  }

  console.log(`Loading and chunking ${PDF_PATH}…`);
  const chunks = await loadAndChunkPdf(PDF_PATH);
  console.log(`  produced ${chunks.length} chunks across ${new Set(chunks.map(c => c.page)).size} page(s)`);

  console.log('Embedding…');
  const { embeddings } = await embedMany({
    model: openai.embedding('text-embedding-3-small'),
    values: chunks.map((c) => c.text),
  });

  const index = new Index();
  const records = chunks.map((c, i) => ({
    id: `chunk_${i}`,
    vector: embeddings[i],
    metadata: { text: c.text, page: c.page },
  }));

  console.log(`Upserting ${records.length} chunks to Upstash Vector…`);
  // Upstash supports up to 1000 vectors per upsert; chunk if needed.
  const BATCH = 100;
  for (let i = 0; i < records.length; i += BATCH) {
    await index.upsert(records.slice(i, i + BATCH));
  }
  console.log('✅ Done. Run `npm run dev` and chat at http://localhost:3000');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
