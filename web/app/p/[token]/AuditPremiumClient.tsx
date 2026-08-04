// web/app/p/[token]/AuditPremiumClient.tsx
"use client";

import { useEffect, useState } from "react";

const API =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://demo-api.pixelfluxcreative.com";

// The final CTA doesn't navigate anywhere in this demo — in the real system
// it opens a WhatsApp conversation, but here it only shows DemoActionModal.

type Benchmark = {
  name: string;
  rating?: number | null;
  reviews_count?: number | null;
  website?: string | null;
  maps_url?: string | null;
};

type AuditPremiumPayload = {
  headline?: string;
  kind?: string;
  business: {
    name: string;
    city?: string | null;
    region?: string | null;
    country?: string | null;
    phone?: string | null;
    website?: string | null;
    rating?: number | null;
    maps_url?: string | null;
    query?: string | null;
  };
  diagnostics: {
    website_type?: string | null;
    http_status?: number | null;
    https_enabled?: boolean;
    has_mailto?: boolean;
    has_whatsapp?: boolean;
    has_social?: boolean;
    score?: number;
    intention_score?: number;
    priority_score?: number;
    issues?: any[];
  };
  summary?: string;
  benchmarks?: Benchmark[];
  campaign?: { id: number; name: string } | null;
  _meta?: {
    expires_at?: string;
  };
};

export default function AuditPremiumClient({ token }: { token: string }) {
  const [data, setData] = useState<AuditPremiumPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [demoModal, setDemoModal] = useState<{ title: string; body: string } | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(
          `${API}/audits/view/${encodeURIComponent(token)}`,
          { cache: "no-store" }
        );
        if (!r.ok) {
          throw new Error(
            r.status === 404
              ? "This link is no longer available."
              : "The audit couldn't be loaded."
          );
        }
        const j = await r.json();
        setData(j as AuditPremiumPayload);
        setErr(null);
      } catch (e: any) {
        console.error(e);
        setErr(e?.message || "Error loading the audit.");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  if (loading && !data) {
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-slate-500 text-sm">Loading audit…</div>
      </main>
    );
  }

  if (err || !data) {
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="max-w-md rounded-xl bg-white shadow p-6 text-center">
          <div className="text-lg font-semibold mb-2">
            We couldn't display the audit
          </div>
          <div className="text-sm text-slate-600 mb-3">{err}</div>
          <div className="text-xs text-slate-400">
            If you think this is a mistake, reply to the message where you
            received the link and we'll help you out.
          </div>
        </div>
      </main>
    );
  }

  const { business, diagnostics, benchmarks, headline, summary, _meta } = data;

  const rating = business.rating ?? null;
  const httpStatus = diagnostics.http_status ?? null;
  const httpsEnabled = !!diagnostics.https_enabled;
  const hasWhatsapp = !!diagnostics.has_whatsapp;
  const hasMailto = !!diagnostics.has_mailto;

  const opportunityScore = diagnostics.priority_score ?? diagnostics.score ?? 0;
  const intentionScore = diagnostics.intention_score ?? 0;

  const formatExpires = (iso?: string) => {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "2-digit",
      });
    } catch {
      return null;
    }
  };

  const expiresAt = formatExpires(_meta?.expires_at);

  const summaryText =
    summary ||
    "Your current digital presence has clear opportunities for improvement. Below we show you what's happening today, who Google compares you against, and what steps we recommend for the coming days.";

  const websiteStatusText = () => {
    const hasWebsite = !!business.website;
    if (!hasWebsite) {
      return "There's no website linked on your Google listing, so your customers only see basic information and reviews.";
    }
    if (httpStatus === null) {
      return "We detected a linked site, but couldn't confirm that it responds correctly in every case.";
    }
    if (httpStatus >= 200 && httpStatus < 400) {
      return `Your website responds correctly (status code ${httpStatus}), but the content and clarity for the customer could still be improved.`;
    }
    return `There are problems loading the linked site (status code ${httpStatus}). That makes a bad first impression and can discourage inquiries.`;
  };

  const contactSummary = () => {
    if (!hasWhatsapp && !hasMailto) {
      return "We didn't see a clear direct contact channel (like a visible WhatsApp or email). A motivated customer has to work too hard to reach you.";
    }
    if (hasWhatsapp && hasMailto) {
      return "You have contact channels (WhatsApp and email), but they could be better integrated into a clear website that explains what you offer.";
    }
    if (hasWhatsapp) {
      return "You have WhatsApp visible. Integrating it into a clear website with your offer and details can significantly increase conversion.";
    }
    return "You have email visible. Adding a WhatsApp button and a clear website would make it much easier for customers to reach you from their phone.";
  };

  const reputationSummary = () => {
    if (rating && rating > 0) {
      return "The reviews visible from your customers are positive, but you're not yet getting the full value out of that reputation (they're not shown on a website of your own, there's no active response strategy, etc.).";
    }
    return "It's not clear, from a digital standpoint, how satisfied your customers are. Working on reviews and testimonials can significantly increase trust.";
  };

  const plan7days = [
    "Define the structure of a simple website for your business (1-3 sections) with the essentials: what you offer, photos, and contact.",
    "Make sure the site loads well on mobile and, if applicable, runs on HTTPS (the secure-site padlock).",
    "Respond to recent reviews on Google to show attentiveness and care.",
  ];

  const plan30days = [
    "Ask your best customers for new reviews with a clear, easy-to-follow message.",
    "Update key photos (product/service, location, team) and use them on both the website and your Google listing.",
    "If applicable, prepare a small perk or promotion for people who contact you directly via WhatsApp or the website.",
  ];

  function DemoActionModal() {
    if (!demoModal) return null;
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        onClick={() => setDemoModal(null)}
      >
        <div
          className="max-w-sm w-full rounded-xl bg-white shadow-lg p-5"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="text-base font-semibold text-slate-900">
            {demoModal.title}
          </h3>
          <p className="text-sm text-slate-600 mt-2 leading-relaxed">
            {demoModal.body}
          </p>
          <button
            onClick={() => setDemoModal(null)}
            className="mt-4 w-full rounded-lg bg-slate-900 text-white px-4 py-2 text-sm font-medium hover:bg-slate-800 transition"
          >
            Got it
          </button>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Demo disclosure banner */}
        <div className="mb-6 rounded-lg border border-slate-200 bg-slate-100 px-4 py-2.5 text-xs text-slate-600">
          This is a real audit report generated by the actual production
          code — for a fictional business, as part of a public portfolio
          demo.
        </div>

        {/* Header */}
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-emerald-700 font-semibold">
              Digital Audit · Premium
            </div>
            <h1 className="text-2xl font-bold text-slate-900 mt-1">
              {headline || "Digital Audit (Premium)"}
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              {business.name}
              {business.city ? ` · ${business.city}` : ""}
              {business.country ? ` · ${business.country}` : ""}
            </p>
          </div>
          {expiresAt && (
            <div className="mt-2 sm:mt-0 text-xs text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
              Valid until: <span className="font-medium">{expiresAt}</span>
            </div>
          )}
        </header>

        <section className="mt-6 space-y-6">
          {/* Overall summary */}
          <div className="rounded-xl bg-white shadow-sm p-5">
            <h2 className="text-base font-semibold text-slate-900">
              Overall summary
            </h2>
            <p className="text-sm text-slate-700 mt-2 leading-relaxed">
              {summaryText}
            </p>
          </div>

          {/* Diagnosis: Opportunity / Intent */}
          <div className="rounded-xl bg-white shadow-sm p-5">
            <h2 className="text-base font-semibold text-slate-900">
              Diagnosis of your digital presence
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3">
                <div className="text-xs font-semibold text-emerald-800 uppercase">
                  Opportunity
                </div>
                <div className="flex items-baseline gap-1 mt-1">
                  <span className="text-2xl font-bold text-emerald-900">
                    {opportunityScore}
                  </span>
                  <span className="text-xs text-emerald-800">/ 100</span>
                </div>
                <p className="text-xs text-emerald-900 mt-1 leading-relaxed">
                  There's room and demand in your industry to show up and
                  attract customers through Google and your digital presence.
                </p>
              </div>
              <div className="rounded-lg bg-amber-50 border border-amber-100 p-3">
                <div className="text-xs font-semibold text-amber-800 uppercase">
                  Current digital intent
                </div>
                <div className="flex items-baseline gap-1 mt-1">
                  <span className="text-2xl font-bold text-amber-900">
                    {intentionScore}
                  </span>
                  <span className="text-xs text-amber-800">/ 100</span>
                </div>
                <p className="text-xs text-amber-900 mt-1 leading-relaxed">
                  What you've done so far with your website, reviews, and
                  contact options is still far from the full potential you
                  could be tapping into.
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-2 text-sm text-slate-700">
              <p>{websiteStatusText()}</p>
              <p>{contactSummary()}</p>
              <p>{reputationSummary()}</p>
            </div>
          </div>

          {/* Benchmarks */}
          {benchmarks && benchmarks.length > 0 && (
            <div className="rounded-xl bg-white shadow-sm p-5">
              <h2 className="text-base font-semibold text-slate-900">
                Who Google compares you to today
              </h2>
              <p className="text-sm text-slate-700 mt-2 leading-relaxed">
                These are a few references similar to your business that show
                up alongside you or for similar searches. The idea isn't to
                copy them, but to understand the level of presence that
                currently appears as a benchmark.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {benchmarks.map((p, idx) => (
                  <div
                    key={idx}
                    className="rounded-lg border border-slate-100 bg-slate-50 p-3 flex flex-col justify-between"
                  >
                    <div>
                      <div className="text-xs font-semibold text-slate-900 line-clamp-2">
                        {p.name}
                      </div>
                      {typeof p.rating === "number" && (
                        <div className="text-[11px] text-slate-600 mt-1">
                          Approx. rating:{" "}
                          <span className="font-medium">
                            {p.rating.toFixed(1)}
                          </span>{" "}
                          / 5
                        </div>
                      )}
                    </div>
                    <div className="mt-2 space-x-1">
                      {p.website && (
                        <a
                          href={p.website}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-block text-[11px] text-emerald-700 hover:underline"
                        >
                          View site
                        </a>
                      )}
                      {p.maps_url && (
                        <a
                          href={p.maps_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-block text-[11px] text-slate-600 hover:underline"
                        >
                          View on Google Maps
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action plan */}
          <div className="rounded-xl bg-white shadow-sm p-5">
            <h2 className="text-base font-semibold text-slate-900">
              Recommended action plan
            </h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Next 7 days
                </h3>
                <ul className="mt-2 space-y-2 text-sm text-slate-700">
                  {plan7days.map((item, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-[3px] h-4 w-4 flex-none rounded-full bg-emerald-100 text-emerald-700 text-[10px] flex items-center justify-center">
                        ✓
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Next 30 days
                </h3>
                <ul className="mt-2 space-y-2 text-sm text-slate-700">
                  {plan30days.map((item, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-[3px] h-4 w-4 flex-none rounded-full bg-sky-100 text-sky-700 text-[10px] flex items-center justify-center">
                        ✓
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-3">
              By implementing this plan, your business looks much more
              professional online and you convert more searches into
              inquiries and real sales.
            </p>
          </div>

          {/* Final CTA */}
          <div className="rounded-xl bg-white shadow-sm p-5 border border-emerald-100 bg-emerald-50">
            <h2 className="text-base font-semibold text-emerald-900">
              How we can help you implement this
            </h2>
            <p className="text-sm text-emerald-900 mt-2 leading-relaxed">
              We can handle the technical side for you: designing and
              publishing the site, setting up WhatsApp, HTTPS, and guidance
              for working on your reviews. In a short call we'll figure out
              what type of website makes the most sense for your business and
              go over 2-3 investment options.
            </p>
            <button
              onClick={() =>
                setDemoModal({
                  title: "This would open WhatsApp",
                  body: "In the real system, this button opens a WhatsApp conversation to finalize the meeting and move toward closing the deal. This is a public demo, so it doesn't navigate anywhere or open real conversations.",
                })
              }
              className="inline-block mt-4 rounded-lg bg-emerald-600 text-white px-4 py-2 text-sm font-medium hover:bg-emerald-700 transition"
            >
              I want to see options to implement this
            </button>
          </div>
        </section>
      </div>
      <DemoActionModal />
    </main>
  );
}
