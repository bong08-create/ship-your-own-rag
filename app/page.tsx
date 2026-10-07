'use client';

import { useState } from 'react';
import { useChat } from '@ai-sdk/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Source = { text?: string; page?: number; score?: number };

// Minimal Tailwind styling for markdown elements rendered inside a chat
// bubble -- no @tailwindcss/typography plugin installed, so these are
// applied per-element instead of via a single "prose" class.
const markdownComponents = {
  p: (props: React.ComponentPropsWithoutRef<'p'>) => (
    <p className="mb-2 last:mb-0" {...props} />
  ),
  strong: (props: React.ComponentPropsWithoutRef<'strong'>) => (
    <strong className="font-semibold" {...props} />
  ),
  ul: (props: React.ComponentPropsWithoutRef<'ul'>) => (
    <ul className="list-disc list-outside pl-5 mb-2 space-y-1" {...props} />
  ),
  ol: (props: React.ComponentPropsWithoutRef<'ol'>) => (
    <ol className="list-decimal list-outside pl-5 mb-2 space-y-1" {...props} />
  ),
  li: (props: React.ComponentPropsWithoutRef<'li'>) => (
    <li className="leading-snug" {...props} />
  ),
  a: (props: React.ComponentPropsWithoutRef<'a'>) => (
    <a className="underline text-cyan-700 hover:text-cyan-800" target="_blank" rel="noreferrer" {...props} />
  ),
  code: (props: React.ComponentPropsWithoutRef<'code'>) => (
    <code className="bg-slate-100 rounded px-1 py-0.5 text-sm" {...props} />
  ),
};

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit, status, error } = useChat({
    api: '/api/chat',
  });
  // Tracks which individual sources have been expanded to their full text,
  // keyed by "<toolCallId>-<index>", so expanding one doesn't affect others.
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});

  return (
    <main className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Globe Help Assistant</h1>
        <p className="text-sm text-slate-500">
          Ask about Postpaid &amp; Platinum plans, Prepaid promos, Rewards and
          GlobeOne app. Answers are grounded in Globe&apos;s public Help
          Center articles, with sources shown under each response.
        </p>
      </header>

      <ul className="space-y-4 mb-6 min-h-[200px]">
        {messages.length === 0 && (
          <li className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">
            <p className="mb-2 font-medium text-slate-600">Try asking:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>How do I convert data to load on GPlan Plus?</li>
              <li>When do my Globe Rewards points expire?</li>
              <li>How do I create a GlobeOne account?</li>
              <li>What&apos;s the minimum spending limit for a new Postpaid line?</li>
            </ul>
          </li>
        )}
        {messages.map((m) => (
          <li
            key={m.id}
            className={
              m.role === 'user'
                ? 'flex justify-end'
                : 'flex justify-start flex-col items-start'
            }
          >
            <div
              className={
                m.role === 'user'
                  ? 'inline-block rounded-2xl bg-cyan-600 text-white px-4 py-2 max-w-[85%]'
                  : 'inline-block rounded-2xl bg-white border border-slate-200 px-4 py-2 max-w-[85%]'
              }
            >
              {m.role === 'assistant' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {m.content}
                </ReactMarkdown>
              ) : (
                m.content
              )}
            </div>

            {m.role === 'assistant' &&
              m.toolInvocations?.map(
                (inv) =>
                  inv.state === 'result' &&
                  inv.toolName === 'getInformation' && (
                    <details
                      key={inv.toolCallId}
                      className="mt-2 text-sm text-slate-600 max-w-[85%]"
                    >
                      <summary className="cursor-pointer">
                        Sources ({(inv.result as Source[]).length})
                      </summary>
                      <ul className="mt-2 space-y-2">
                        {(inv.result as Source[]).map((src, i) => {
                          const text = src.text ?? '';
                          // Our chunker groups text into FAQ-style units that
                          // start with their own question, so pull that out
                          // as a scannable heading instead of dumping the
                          // raw chunk. A "?" showing up very late usually
                          // means the chunk didn't start with a clean
                          // question, so fall back to plain truncated text.
                          const qIndex = text.indexOf('?');
                          const hasHeading = qIndex !== -1 && qIndex < 150;
                          const heading = hasHeading
                            ? text.slice(0, qIndex + 1).trim()
                            : null;
                          const body = hasHeading
                            ? text.slice(qIndex + 1).trim()
                            : text;
                          const wasTruncated = body.length > 220;
                          const excerpt = wasTruncated
                            ? body.slice(0, 220).trim() + '…'
                            : body;
                          const sourceKey = `${inv.toolCallId}-${i}`;
                          const isExpanded = expandedSources[sourceKey] ?? false;
                          return (
                            <li
                              key={i}
                              className="border-l-2 border-cyan-500 pl-3"
                            >
                              <span className="text-xs text-slate-400">
                                page {src.page ?? '?'} · score{' '}
                                {typeof src.score === 'number'
                                  ? src.score.toFixed(2)
                                  : '—'}
                              </span>
                              {heading && (
                                <p className="font-medium text-slate-700 mt-0.5">
                                  {heading}
                                </p>
                              )}
                              <p className="text-slate-600">
                                {isExpanded ? body : excerpt}
                              </p>
                              {wasTruncated && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedSources((prev) => ({
                                      ...prev,
                                      [sourceKey]: !prev[sourceKey],
                                    }))
                                  }
                                  className="text-xs text-cyan-700 hover:text-cyan-800 mt-1"
                                >
                                  {isExpanded ? 'Show less' : 'Show full text'}
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  ),
              )}
          </li>
        ))}
        {status === 'streaming' && (
          <li className="text-sm text-slate-400">…</li>
        )}
        {error && (
          <li className="text-sm text-rose-600">
            Error: {error.message}
          </li>
        )}
      </ul>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={input}
          onChange={handleInputChange}
          className="flex-1 border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:border-cyan-500"
          placeholder="Ask about GPlan Plus, GlobeOne rewards, prepaid promos…"
          disabled={status === 'streaming' || status === 'submitted'}
        />
        <button
          type="submit"
          disabled={!input || status === 'streaming' || status === 'submitted'}
          className="rounded-lg bg-slate-900 text-white px-4 py-2 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </main>
  );
}
