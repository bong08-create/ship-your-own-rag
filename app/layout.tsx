import type { Metadata } from 'next';
import './globals.css';

const TITLE = 'Globe Help Assistant';
const DESCRIPTION =
  "Ask about Globe Telecom's Postpaid & Platinum plans, the GlobeOne app, Rewards, and Prepaid services. Grounded in Globe's public Help Center articles, with sources cited under every answer.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
