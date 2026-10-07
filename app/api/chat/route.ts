/**
 * Globe Telecom Help Center assistant — RAG-as-tool-call.
 *
 * Corpus: Globe Telecom's public Help Center articles (Postpaid & Platinum
 * plans, the GlobeOne app, Rewards, and Prepaid services).
 *
 * The model decides whether to call the getInformation tool. When it does,
 * the tool runs vector search over the Help Center corpus and returns
 * chunk text + page + score. The client renders those as collapsible
 * sources under the assistant message.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, tool, embed } from 'ai';
import { Index } from '@upstash/vector';
import { z } from 'zod';

// Vocareum (and other OpenAI-compatible proxies) require a custom baseURL;
// defaults to the real OpenAI API if OPENAI_BASE_URL is not set.
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const index = new Index();

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o-mini'),
    // Lower temperature biases generation toward the retrieved text's actual
    // wording instead of fluent-but-loose paraphrase (which is how "services"
    // from the source became "load" in testing -- a real hallucination even
    // though the correct chunk was retrieved).
    temperature: 0.2,
    system:
      'You are a helpful assistant for Globe Telecom\'s Philippines Help Center, ' +
      'covering Postpaid & Platinum plans, the GlobeOne app, Rewards (points and ' +
      'vouchers), and Prepaid services. Use the getInformation tool whenever the ' +
      'user asks a question whose answer might be in the Help Center articles. ' +
      'If the Help Center content does not cover something, say so directly ' +
      'rather than guessing -- for anything time-sensitive like current promo ' +
      'pricing or live account status, tell the user to check the GlobeOne app ' +
      'or globe.com.ph/help directly. ' +
      'Ground every answer strictly in the text returned by getInformation. When ' +
      'the retrieved text uses a specific word for a mechanism -- "swap," ' +
      '"convert," "services," "voucher," "rollover," "load" -- quote or closely ' +
      'echo that exact word rather than substituting a different one, even if a ' +
      'substitute feels more natural or familiar. These terms are NOT ' +
      'interchangeable: for example, converting unused data into "services" ' +
      '(subscriptions, vouchers, telco services via the GlobeOne app) is a ' +
      'different thing from converting into prepaid "load" (airtime credit) -- ' +
      'never say "load" unless the retrieved text itself uses that word. If the ' +
      'user\'s question assumes something the retrieved content does not ' +
      'support, say so explicitly near the start of your answer (e.g. "There\'s ' +
      'no way to convert mobile data directly into prepaid load on this plan") ' +
      'rather than quietly working their wrong term into a rephrased answer. ' +
      'Be concrete, not vague: when the retrieved text lists specific options ' +
      '(e.g. telco services, subscriptions, lifestyle vouchers), name those ' +
      'specific options in your answer instead of summarizing them as a generic ' +
      'word like "services." Synthesize across ALL of the retrieved results, ' +
      'not just the top one or two -- if multiple chunks each list valid items ' +
      '(e.g. payment channels, swap options), combine them into one complete ' +
      'answer rather than dropping items that appeared in a lower-ranked chunk. ' +
      'Also surface any dated caveats or deprecation notices found in the ' +
      'retrieved text (e.g. "X will no longer be accepted starting [date]") ' +
      'rather than omitting them. ' +
      'Watch for retrieved chunks that describe DIFFERENT scenarios using ' +
      'similar wording -- for example, a "replacement" procedure (for a lost, ' +
      'damaged, or already-issued item) is NOT the same as a "new purchase" or ' +
      '"first-time setup" procedure, even when both mention similar steps like ' +
      'visiting a store or verifying identity. Check which scenario the ' +
      'retrieved text is actually describing (look at the surrounding FAQ ' +
      'heading/context, e.g. "eSIM Replacement" vs "How do I purchase a new ' +
      'eSIM") and only use the procedure that matches the user\'s actual ' +
      'situation. If a chunk is ambiguous or you are not sure which scenario ' +
      'it applies to, say so rather than presenting it as the general answer.',
    messages,
    tools: {
      getInformation: tool({
        description:
          'Look up information from Globe Telecom\'s Help Center articles ' +
          '(Postpaid & Platinum plans, the GlobeOne app, Rewards, and Prepaid ' +
          'services). Use this whenever the user asks a substantive question ' +
          'about plans, billing, the GlobeOne app, reward points or vouchers, ' +
          'or prepaid promos.',
        parameters: z.object({
          query: z
            .string()
            .describe(
              'the Globe Telecom topic, term, or sub-question to search for (e.g. ' +
              '"GPlan Plus spending limit" or "reward points expiry")'
            ),
        }),
        execute: async ({ query }) => {
          const { embedding } = await embed({
            model: openai.embedding('text-embedding-3-small'),
            value: query,
          });
          const hits = await index.query({
            vector: embedding,
            topK: 4,
            includeMetadata: true,
          });
          return hits.map((h) => ({
            text: (h.metadata?.text as string) ?? '',
            page: (h.metadata?.page as number) ?? null,
            score: h.score,
          }));
        },
      }),
    },
    maxSteps: 3,
  });

  return result.toDataStreamResponse();
}
