// web/app/p/[token]/page.tsx
export const metadata = {
  robots: { index: false, follow: false },
  openGraph: {
    title: "Digital Audit · PixelFlux",
    description: "See how your customers find and perceive your business.",
    images: [{ url: "/og-audit.png" }],
  },
  twitter: { card: "summary_large_image" },
};

import AuditPremiumClient from "./AuditPremiumClient";

export default function Page({ params }: { params: { token: string } }) {
  return <AuditPremiumClient token={params.token} />;
}