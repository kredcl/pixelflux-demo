// web/app/a/[token]/page.tsx
export const metadata = {
  robots: { index: false, follow: false },
  openGraph: {
    title: "Digital Audit · PixelFlux",
    description: "See how your customers find and perceive your business.",
    images: [{ url: "/og-audit.png" }],
  },
  twitter: { card: "summary_large_image" },
};

import AuditBasicClient from "./AuditBasicClient";

export default function Page({ params }: { params: { token: string } }) {
  return <AuditBasicClient token={params.token} />;
}