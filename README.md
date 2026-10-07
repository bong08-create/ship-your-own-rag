# Ship Your Own RAG — Globe Telecom Help Center Assistant

A streaming RAG chatbot built with [Next.js 15](https://nextjs.org/), the [Vercel AI SDK](https://sdk.vercel.ai/), and [Upstash Vector](https://upstash.com/docs/vector), answering questions over **Globe Telecom's public Philippines Help Center** (Postpaid & Platinum plans, the GlobeOne app, Rewards, and Prepaid services). Built for the AIM Generative AI and Agentic AI course, Week 14 Graded Mini Project ("Ship Your Own RAG").

**Live demo:** https://ship-your-own-rag.vercel.app

## What's here

```
14A-nextjs-rag/
├── app/
│   ├── globals.css
│   ├── layout.tsx                        # Title, description, Open Graph metadata
│   ├── page.tsx                          # Chat UI — useChat + markdown rendering + sources
│   └── api/chat/route.ts                 # RAG-as-tool-call handler + grounding system prompt
├── lib/
│   └── seed.ts                           # Chunks data/globe-telecom-help-center.pdf into Upstash
├── data/
│   └── globe-telecom-help-center.pdf     # The corpus (85 pages, scraped from globe.com.ph/help)
├── steps/                                # Original workshop reference snapshots (unused by the final app)
├── package.json
├── tsconfig.json
├── next.config.mjs
├── postcss.config.mjs
├── tailwind.config.ts
├── .env.example
├── .gitignore
└── README.md
```

## Setup (5 minutes)

```bash
# 1. install
npm install

# 2. environment
cp .env.example .env.local
```

Edit `.env.local` and fill in:

| Variable | Notes |
| --- | --- |
| `OPENAI_API_KEY` | Your OpenAI (or OpenAI-compatible proxy) API key. |
| `OPENAI_BASE_URL` | **Optional.** Only needed if you're using an OpenAI-compatible proxy instead of OpenAI directly — for example [Vocareum](https://vocareum.com/)'s proxy (`https://openai.vocareum.com/v1`). Leave unset to use the real OpenAI API. |
| `UPSTASH_VECTOR_REST_URL` | From your Upstash Vector index's dashboard. |
| `UPSTASH_VECTOR_REST_TOKEN` | Use the **full read-write Token**, not the Read-Only Token — seeding needs write access. |

```bash
# 3. seed the vector index (one-time, or whenever data/*.pdf or the chunker changes)
npm run seed
```

The seed script reads `data/globe-telecom-help-center.pdf`, chunks it (see "Chunking approach" below), embeds each chunk with `text-embedding-3-small`, and upserts to your Upstash Vector index. Re-running it overwrites the same ids, so it's idempotent.

## Run locally

```bash
npm run dev
# open http://localhost:3000
```

Try asking:

- *"How do I convert my mobile data to load on GPlan Plus?"*
- *"What are the accredited payment channels for my Postpaid bill?"*
- *"How do I activate a new eSIM?"*
- *"When do my reward points expire?"*

You'll see tokens stream into the assistant bubble (rendered as formatted markdown), then a **Sources (N)** disclosure beneath it. Expanding it shows, for each retrieved chunk: the page number and similarity score, the FAQ question that chunk came from as a heading (pulled from the chunk's own text), and a truncated excerpt with a "Show full text" toggle that swaps in the complete chunk. Useful for checking whether an answer is actually grounded in the source material, without the panel turning into a wall of raw text.

## The corpus

Scraped from Globe Telecom's public Help Center (`globe.com.ph/help`) — genuinely public FAQ content, no login or paywall. Scoped to four sections: Postpaid & Platinum plans, the GlobeOne app, Rewards (points and vouchers), and Prepaid services. GCash is deliberately excluded (it's a separate company) to keep the corpus focused on one coherent domain.

Known limitations, left undocumented rather than silently hidden:
- A handful of scraped HTML tables flattened into somewhat garbled text during PDF extraction (e.g. a payment-channels table). The chunker (below) keeps these as complete units so nothing gets silently dropped, but the underlying text itself can still read a bit jumbled in the Sources panel.
- Some FAQ boilerplate is duplicated verbatim across related Help Center articles — a corpus characteristic, not a bug.
- A few topics genuinely aren't covered (e.g. "GlobeOne Quests" — confirmed absent via direct text search, not a retrieval failure); the assistant is expected to say so rather than guess.

## Chunking approach

This corpus is a dense, continuous stream of `Question? Answer. Next question? Answer...` FAQ content with no blank-line separators between entries. A plain fixed-size sliding window (the original starter's approach) can cut a chunk boundary mid-answer — severing an answer from its own question. In testing this caused a real bug: an eSIM-*replacement* answer ("visit a Globe Store, take a selfie") got retrieved and presented as general new-eSIM guidance, because the chunk boundary had split off its disambiguating question heading ("How do I request an eSIM replacement...") into the previous chunk.

The first fix made `chunkText` FAQ-aware but still per-page: it walked each PDF page's lines independently and started a new chunk whenever a line ended in `?`. That fixed the eSIM bug, but the per-page boundary turned out to be its own hidden version of the same problem. Any FAQ answer long enough to physically spill from the bottom of one PDF page onto the next still got cut in half — a truncated fragment on the first page, and an orphaned, heading-less continuation on the next. The worst real case, found after deploying and testing the live site with actual questions: asking "How do I redeem my Rewards?" returned a source that was *nothing but* the bare question, because its entire answer lived on the following page.

`lib/seed.ts`'s `chunkLines` now processes the whole document as one continuous stream of lines (each still tagged with the page it came from) instead of resetting at every page break, so a question and its full answer stay together as one chunk no matter where the physical page boundary falls. The chunk is tagged with whichever page its question started on, since that's what a citation should point to. Short fragments (e.g. a stray section header) still merge into a neighboring chunk; unusually long answers still fall back to a size-capped sliding-window split. This fixed both the eSIM case above, a payment-channels completeness gap (dropped bank names), and the cross-page splitting case found post-deploy.

## Other notable fixes along the way

- **PDF page-boundary bug**: `pdf-parse` doesn't insert a page separator between pages by default — it just joins everything with `\n\n`. A custom `pagerender` callback in `lib/seed.ts` inserts an explicit form-feed so each chunk gets correct per-page metadata.
- **Corpus-generation footer artifact**: `fetch_globe_corpus.py` draws a "Page N" footer on every generated PDF page (a standard FPDF footer callback). That footer is literal text content like anything else on the page, so it was getting captured and tacked onto whichever chunk happened to be the last one on a page — only showing up in *some* Sources panel entries, which is what made it noticeable rather than an obvious, consistent bug. `lib/seed.ts` now strips a trailing `Page \d+` pattern from each page's raw text before chunking.
- **Grounding / hallucination fixes** in `app/api/chat/route.ts`'s system prompt: echo the retrieved text's exact terminology instead of substituting a more "natural"-sounding word, explicitly correct a wrong premise in the user's question rather than quietly working around it, synthesize across *all* retrieved chunks rather than just the top one or two, and surface dated caveats/deprecation notices. `temperature` is set to `0.2` (down from the SDK default of `1.0`) to bias generation toward the source text's actual wording.
- **Markdown rendering**: the assistant generates markdown (bold, bullet lists); `app/page.tsx` renders it with `react-markdown` + `remark-gfm` instead of showing literal `**asterisks**`.

## Stretch goals

Picked two from the brief's list, both aimed at how a grader (or a real user) would actually open this on day one:

- **Suggested-prompt chips**: the empty state used to be a plain bulleted list of example questions. It's now a row of clickable chips (`app/page.tsx`) that call `useChat`'s `append()` directly, so trying the bot takes one click instead of retyping a question.
- **Mobile-friendly layout**: the UI had no responsive Tailwind classes at all. Added `sm:` breakpoints for the page padding, header size, and chat bubble / Sources panel max-width, plus an explicit Next.js `viewport` export, so the live URL is usable on a phone, not just a laptop.

## Deploy to Vercel

```bash
npm i -g vercel  # if you don't have it
vercel           # first run: log in, link the project
vercel link
vercel env add OPENAI_API_KEY
vercel env add OPENAI_BASE_URL          # only if using a proxy like Vocareum
vercel env add UPSTASH_VECTOR_REST_URL
vercel env add UPSTASH_VECTOR_REST_TOKEN
vercel --prod
```

You'll get a public URL like `https://ship-your-own-rag-xxx.vercel.app`. The index is already seeded — you don't need to re-run `npm run seed` for deployment, regardless of where the chat app is hosted.

## Common errors

| Symptom | Fix |
| --- | --- |
| `Error: missing UPSTASH_VECTOR_REST_URL` | Run `npm run seed` after setting `.env.local`. Verify in Upstash. |
| Page renders but submitting hangs | Route handler missing `toDataStreamResponse()`. Check `route.ts`. |
| Empty / very short answer after a tool call | `maxSteps` not set or set to 1. Set `maxSteps: 3` on `streamText`. |
| `Cannot use useChat in a Server Component` | Forgot `'use client'` at the top of `page.tsx`. |
| Build error: `Type '...' is not assignable to ...` | Run `npx tsc --noEmit` to see the full type error. |
| `vercel --prod` build fails on missing env vars | `vercel env add ...` and pick **Production** when prompted. |
| `Invalid Key. Expired: ...` | Time-limited proxy keys (e.g. Vocareum) expire — get a fresh key and update `OPENAI_API_KEY`. |
| A `route.ts` change doesn't seem to take effect | Restart `npm run dev` — API route hot-reload isn't always reliable. |
| Re-asking the same question gives a different/worse result with no sources | The model can recall its prior answer from chat history instead of re-querying. Reload the page to test in a fresh conversation. |
| Chunks look garbled / duplicated in the Sources panel | Likely a scraped HTML table that didn't flatten cleanly — see "The corpus" above. Usually not worth chasing with prompt changes; it's an extraction-quality issue. |

## Reference: original workshop steps

The `/steps` folder contains the original Week 14A workshop's incremental snapshots (plain chat → RAG-as-tool-call → sources rendering) and isn't used by the final app — kept for reference only.
