// web/app/a/[token]/AuditBasicClient.tsx
"use client";

import { useEffect, useState } from "react";

const API =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://api.pixelfluxcreative.com";
const WABA_URL = process.env.NEXT_PUBLIC_WABA_URL || "/waba";
const CALENDAR_URL =
  process.env.NEXT_PUBLIC_CALENDAR_URL || "https://calendar.google.com";

// Demo-safe placeholder — not a real number. In production this points to a
// real sales phone number via NEXT_PUBLIC_WHATSAPP_TO.
const WHATSAPP_TO =
  process.env.NEXT_PUBLIC_WHATSAPP_TO || "10000000000"; // no leading +, includes country code

function waMeLink(text: string) {
  return `https://wa.me/${WHATSAPP_TO}?text=${encodeURIComponent(text)}`;
}

type AuditPayload = {
  headline?: string;
  kind?: string;
  business: {
    name: string;
    city?: string | null;
    country?: string | null;
    category?: string | null;
    query?: string | null;
  };
  website?: {
    url?: string | null;
    http_status?: number | null;
  } | null;
  presence?: {
    website?: {
      has_website?: boolean;
      url?: string | null;
      http_status?: number | null;
      mobile_friendly?: boolean | null;
      https?: boolean | null;
      load_time_ms?: number | null;
    };
    gmb?: {
      has_gmb?: boolean;
      rating?: number | null;
      reviews_count?: number | null;
    };
    social?: {
      has_instagram?: boolean;
      has_facebook?: boolean;
      has_whatsapp?: boolean;
      has_email?: boolean;
    };
  };
  scores?: {
    visibility_score?: number;
    trust_score?: number;
    conversion_score?: number;
    overall_score?: number;
    intention_score?: number;
    priority_score?: number;
    issues?: any[];
  };
  summary?: string;
  campaign?: { id: number; name: string } | null;
  cta_variant?: string;
  _meta?: {
    expires_at?: string;
  };
};

export default function AuditBasicClient({ token }: { token: string }) {
  const [data, setData] = useState<AuditPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const res = await fetch(
          `${API}/audits/view/${encodeURIComponent(token)}`,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
            },
            cache: "no-store",
          }
        );

        if (!res.ok) {
          if (res.status === 404) {
            throw new Error(
              "This link is no longer available or the audit has expired."
            );
          }
          throw new Error("We couldn't load the audit. Please try again.");
        }

        const json = (await res.json()) as AuditPayload;

        if (!cancelled) {
          setData(json);
          setErr(null);
        }
      } catch (e: any) {
        console.error(e);
        if (!cancelled) {
          setErr(
            e?.message ||
              "An error occurred while loading the audit. Please try again."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-sm text-slate-500">Loading audit…</div>
      </main>
    );
  }

  if (err || !data) {
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="max-w-md bg-white shadow-sm rounded-xl p-6 text-center border border-slate-100">
          <h1 className="text-lg font-semibold text-slate-900 mb-2">
            We couldn't display the audit
          </h1>
          <p className="text-sm text-slate-600 mb-4">{err}</p>
          <p className="text-xs text-slate-400">
            If you think this is a mistake, reply to the message where you
            received this link and let us know what you're seeing.
          </p>
        </div>
      </main>
    );
  }

  const { headline, business, website, presence, scores, summary, cta_variant, _meta } =
    data;

  const gmb = presence?.gmb;
  const webPresence = presence?.website;
  const social = presence?.social;

  // Important: for the audit, "has a website" == owns a website.
  // If the backend sends presence.website.has_website, we use that.
  // Otherwise we fall back to the legacy website.url field.
  const hasWebsite =
    typeof webPresence?.has_website === "boolean"
      ? !!webPresence.has_website
      : !!website?.url;
  const httpStatus = (webPresence?.http_status ?? website?.http_status) ?? null;

  const visibilityScore = scores?.visibility_score ?? null;
  const trustScore = scores?.trust_score ?? null;
  const conversionScore = scores?.conversion_score ?? null;
  const overallScore = scores?.overall_score ?? null;

  const issues = scores?.issues ?? [];

  const hasWhatsapp = !!social?.has_whatsapp;
  const hasEmail = !!social?.has_email;

  const rating = gmb?.rating ?? null;
  const reviewsCount = gmb?.reviews_count ?? null;

  const loadTimeMs = webPresence?.load_time_ms ?? null;
  const hasHttps = webPresence?.https ?? null;

  const ctaVariant = cta_variant || "whatsapp_premium";

  const issueText = (i: any) => {
    const t = (i?.message ?? i?.title ?? i?.text ?? "").toString().trim();
    return t;
  };

  const visibilityIssueTexts = (issues || [])
    .filter((i: any) => i?.dimension === "visibility")
    .map(issueText)
    .filter(Boolean);

  const trustIssueTexts = (issues || [])
    .filter((i: any) => i?.dimension === "trust")
    .map(issueText)
    .filter(Boolean);

  const conversionIssueTexts = (issues || [])
    .filter((i: any) => i?.dimension === "conversion")
    .map(issueText)
    .filter(Boolean);

  // --------- Copy helpers ---------

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

  const howClientsSee = () => {
    if (!hasWebsite) {
      return `When someone searches for "${business.name}" on Google or views your listing, they don't find a website of your own where they can take their time to see what you offer, photos, approximate prices, or clear ways to contact you. Many people, when in doubt, end up choosing whoever does show all that on their page.`;
    }
    if (httpStatus === null || httpStatus < 200 || httpStatus >= 400) {
      return `Your business shows up on Google, but the site linked to your listing doesn't load properly or returns an error. That causes some people to turn back and choose another option.`;
    }
    return `Your business has a website and shows up on Google, but there are elements that could be holding back trust and contacts from more people. With a few adjustments, perception and conversion could improve a lot.`;
  };

  const visibilityText = () => {
    const q = business.query;
    if (q) {
      return `You show up when someone searches for "${q}" on Google, but your listing still doesn't stand out against similar options.`;
    }
    return `Your business can be found on Google, but you're not fully leveraging the potential to stand out against similar alternatives.`;
  };

  const trustText = () => {
    if (rating && rating > 0) {
      return `The rating your customers leave is good, but the number of reviews is still low compared to what you could have. Working on how you ask for, respond to, and showcase those reviews can make an important difference.`;
    }
    return `Right now there are almost no visible reviews of your business on Google. That makes some people hesitate before contacting you, especially when similar businesses have more visible reviews.`;
  };

  const contactText = () => {
    if (!hasWebsite && !hasWhatsapp && !hasEmail) {
      return `Several people find it hard to find a clear channel to contact you (WhatsApp, a form, email). That means some of them go with the first option that makes it easy.`;
    }
    if (!hasWebsite && (hasWhatsapp || hasEmail)) {
      return `Right now the main contact channel that's visible is ${
        hasWhatsapp && hasEmail
          ? "WhatsApp and email"
          : hasWhatsapp
          ? "WhatsApp"
          : "email"
      }. A clear website that brings them together could make the next step much easier for your customers.`;
    }
    if (hasWebsite && !hasWhatsapp && !hasEmail) {
      return `Your website exists, but it doesn't make it clear enough how to take the next step (request a quote, message you on WhatsApp, etc.).`;
    }
    if (hasWebsite && (hasWhatsapp || hasEmail)) {
      return `You have a website and visible contact channels, but the main action can still be made more direct (clear WhatsApp buttons, calls to action, etc.).`;
    }
    return `There are contact channels, but the path can still be made clearer so people know what to do next after seeing your listing or your website.`;
  };

  const formatScore = (value: number | null | undefined) => {
    if (value === null || value === undefined) return "—";
    const v = Math.round(value);
    return `${v}/100`;
  };

  const badgeColor = (value: number | null | undefined) => {
    if (value === null || value === undefined)
      return "bg-slate-100 text-slate-700";
    if (value >= 75) return "bg-emerald-100 text-emerald-800";
    if (value >= 50) return "bg-amber-100 text-amber-800";
    return "bg-rose-100 text-rose-800";
  };

  const readableLoadTime = () => {
    if (!loadTimeMs || loadTimeMs <= 0) return null;
    if (loadTimeMs < 1500) return "fast load time";
    if (loadTimeMs < 3000) return "acceptable load time";
    return "somewhat slow load time";
  };

  const bullets: string[] = [
    "Clearly show what you offer, who you help, and what makes you different.",
    "Make better use of the searches that already exist for your industry in your area.",
    "Make it easier for people to contact you and request a quote (WhatsApp, form, call).",
    "Start working on your customer reviews (asking for reviews and responding to existing ones) to build trust.",
  ];

  const expiresAt = formatExpires(_meta?.expires_at);

  const trackCtaClick = (source: string) => {
    if (!token) return;

    const url = `${API}/audits/${encodeURIComponent(token)}/events/cta-click`;
    const payload = JSON.stringify({ source });

    try {
      if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
        const blob = new Blob([payload], { type: "application/json" });
        navigator.sendBeacon(url, blob);
      } else {
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: payload,
          keepalive: true,
        }).catch(() => {
          // no-op
        });
      }
    } catch (e) {
      console.error("Error tracking CTA click", e);
    }
  };

  // --------- CTA components ---------

  function CtaWhatsAppPremium() {
    const prefill = `Hi, I just saw my basic audit for ${business.name}${
      business.city ? " in " + business.city : ""
    } and I'd like to review the Premium version with you.`;
    const href = waMeLink(prefill);

    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 mt-4">
        <div className="font-semibold text-emerald-900">
          I want to see my full audit
        </div>
        <p className="text-sm text-emerald-800 mt-1">
          We'll prepare the Premium version and walk through it with you in
          10-15 minutes over WhatsApp. There you'll see how you stack up
          against your competition and what type of website makes the most
          sense for your business.
        </p>
        <a
          href={href}
          onClick={() => trackCtaClick("basic_whatsapp_premium")}
          className="inline-block mt-3 rounded-lg bg-emerald-600 text-white px-4 py-2 text-sm font-medium hover:bg-emerald-700 transition"
        >
          See the full version on WhatsApp
        </a>
      </div>
    );
  }

  function CtaCalendar() {
    return (
      <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 mt-4">
        <div className="font-semibold text-sky-900">
          Book a 15-minute mini meeting
        </div>
        <p className="text-sm text-sky-800 mt-1">
          If you'd rather get straight to the point, book a mini meeting where
          we go through your full audit and show you what type of website
          could help you most. No obligation.
        </p>
        <a
          href={CALENDAR_URL}
          onClick={() => trackCtaClick("basic_calendar")}
          target="_blank"
          rel="noreferrer"
          className="inline-block mt-3 rounded-lg bg-sky-600 text-white px-4 py-2 text-sm font-medium hover:bg-sky-700 transition"
        >
          Book my FREE review
        </a>
      </div>
    );
  }

  function CtaWhatsAppDirect() {
    const prefill = `Hi, I saw my basic audit for ${business.name}${
      business.city ? " in " + business.city : ""
    } and I'd like you to walk me through it on WhatsApp with a quick call or voice note.`;
    const href = waMeLink(prefill);

    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 mt-4">
        <div className="font-semibold text-amber-900">
          Want us to walk you through it in 10 minutes on WhatsApp?
        </div>
        <p className="text-sm text-amber-800 mt-1">
          We'll go through your full audit with you on WhatsApp (voice note or
          quick call) so you can quickly understand what you're missing out on
          today and what you could improve.
        </p>
        <a
          href={href}
          onClick={() => trackCtaClick("basic_whatsapp_direct")}
          className="inline-block mt-3 rounded-lg bg-amber-600 text-white px-4 py-2 text-sm font-medium hover:bg-amber-700 transition"
        >
          Walk me through it
        </a>
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
              Digital Audit · Basic
            </div>
            <h1 className="text-2xl font-bold text-slate-900 mt-1">
              {business.name}
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              {headline || "Digital Audit (Basic)"}
            </p>
          </div>
          {expiresAt && (
            <div className="mt-2 sm:mt-0 text-xs text-slate-500 bg-slate-100 border border-slate-200 px-3 py-1 rounded-full">
              Valid until:{" "}
              <span className="font-medium text-slate-700">{expiresAt}</span>
            </div>
          )}
        </header>

        {/* Main grid */}
        <section className="mt-6 grid gap-5 md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)]">
          {/* Right column (on desktop). On mobile this should be the first thing they see. */}
          <aside className="order-1 md:order-2 space-y-4">
            {/* Overall score */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
              <h2 className="text-sm font-semibold text-slate-800 mb-3">
                Overall score
              </h2>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-slate-500 mb-1">Total score</div>
                  <div
                    className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${badgeColor(
                      overallScore
                    )}`}
                  >
                    {formatScore(overallScore)}
                  </div>
                </div>
              </div>

              <div className="mt-4 space-y-2 text-xs text-slate-600">
                <div className="flex items-center justify-between">
                  <span>Visibility</span>
                  <span className="font-medium">
                    {formatScore(visibilityScore)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Trust</span>
                  <span className="font-medium">{formatScore(trustScore)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Ease of contact</span>
                  <span className="font-medium">
                    {formatScore(conversionScore)}
                  </span>
                </div>
              </div>
            </div>

            {/* Quick summary */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
              <h2 className="text-sm font-semibold text-slate-800 mb-2">
                Quick summary
              </h2>
              <p className="text-xs text-slate-700 leading-relaxed">
                {summary ||
                  "Your digital presence has a good foundation, but there's still room to present your business better and make it easier for new customers to reach you."}
              </p>
            </div>

            {/* What type of website would help you most */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
              <h2 className="text-sm font-semibold text-slate-800 mb-2">
                What type of website would help you most
              </h2>
              <p className="text-xs text-slate-700 leading-relaxed">
                Not every business needs the same website. In your case, it
                would help to focus on:
              </p>
              <ul className="mt-2 space-y-1 text-xs text-slate-700 list-disc pl-4">
                {bullets.map((b, idx) => (
                  <li key={idx}>{b}</li>
                ))}
              </ul>
              <p className="text-[11px] text-slate-500 mt-3">
                In the Premium version we show you more concrete examples for
                your industry and how you could apply them.
              </p>
            </div>

            {/* Premium / Calendar / WhatsApp Direct CTA already render in the left column */}
          </aside>

          {/* Left column: explanation + what to improve */}
          <div className="order-2 md:order-1 space-y-4">
            {/* How your business looks today */}
            <div className="rounded-xl bg-white shadow-sm p-5">
              <h2 className="text-base font-semibold text-slate-900">
                How your business looks today on Google
              </h2>
              <p className="text-sm text-slate-700 mt-2 leading-relaxed">
                {howClientsSee()}
              </p>
              <p className="text-xs text-slate-500 mt-3">
                Online, the first impression is usually what a person sees on
                Google: your listing, reviews, and, if it exists, your
                website. That first impression determines whether someone
                contacts you or a similar option instead.
              </p>
            </div>

            {/* What you're making the most of and what you could improve */}
            <div className="rounded-xl bg-white shadow-sm p-5 space-y-4">
              <h2 className="text-base font-semibold text-slate-900">
                What you're making the most of today and what you could
                improve
              </h2>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <div className="text-xs font-semibold text-slate-500 uppercase">
                    Visibility
                  </div>
                  <p className="text-xs text-slate-700 mt-1 leading-relaxed">
                    {visibilityText()}
                  </p>
                  {visibilityIssueTexts.length > 0 && (
                    <ul className="mt-2 space-y-1 text-[11px] text-slate-600 list-disc pl-4">
                      {visibilityIssueTexts.slice(0, 3).map((t: string, idx: number) => (
                        <li key={idx}>{t}</li>
                      ))}
                      {visibilityIssueTexts.length > 3 && (
                        <li>…and a few more detailed points.</li>
                      )}
                    </ul>
                  )}
                </div>

                <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <div className="text-xs font-semibold text-slate-500 uppercase">
                    Trust
                  </div>
                  <p className="text-xs text-slate-700 mt-1 leading-relaxed">
                    {trustText()}
                  </p>
                  {rating && (
                    <p className="text-[11px] text-slate-500 mt-1">
                      Current rating on Google:{" "}
                      <span className="font-medium">{rating.toFixed(1)}</span> / 5
                    </p>
                  )}
                  {reviewsCount !== null && reviewsCount !== undefined && (
                    <p className="text-[11px] text-slate-500">
                      Number of reviews:{" "}
                      <span className="font-medium">{reviewsCount}</span>
                    </p>
                  )}
                  {trustIssueTexts.length > 0 && (
                    <ul className="mt-2 space-y-1 text-[11px] text-slate-600 list-disc pl-4">
                      {trustIssueTexts.slice(0, 2).map((t: string, idx: number) => (
                        <li key={idx}>{t}</li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <div className="text-xs font-semibold text-slate-500 uppercase">
                    Ease of contact
                  </div>
                  <p className="text-xs text-slate-700 mt-1 leading-relaxed">
                    {contactText()}
                  </p>
                  {conversionIssueTexts.length > 0 && (
                    <ul className="mt-2 space-y-1 text-[11px] text-slate-600 list-disc pl-4">
                      {conversionIssueTexts.slice(0, 2).map((t: string, idx: number) => (
                        <li key={idx}>{t}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            {/* Quick facts */}
            <div className="rounded-xl bg-white shadow-sm p-5">
              <h2 className="text-base font-semibold text-slate-900">
                Quick facts about your digital presence
              </h2>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2 text-xs text-slate-700">
                <div className="border border-slate-100 rounded-lg p-3">
                  <dt className="font-semibold text-slate-800">
                    Do you have a website?
                  </dt>
                  <dd className="mt-1">
                    {hasWebsite
                      ? "Yes, but how it's presented and how it connects to your contact channels can be improved."
                      : "No clear website is linked to your listing. Having one would help you bring the important information together and make contact easier."}
                  </dd>
                </div>

                <div className="border border-slate-100 rounded-lg p-3">
                  <dt className="font-semibold text-slate-800">
                    How's the speed?
                  </dt>
                  <dd className="mt-1">
                    {hasWebsite && readableLoadTime()
                      ? `Your website has a ${readableLoadTime()}.`
                      : hasWebsite
                      ? "Load speed could be measured better, but it's already worth keeping an eye on."
                      : "Without a website, your customers today only see your listing and social media, without an optimized site of your own."}
                  </dd>
                </div>

                <div className="border border-slate-100 rounded-lg p-3">
                  <dt className="font-semibold text-slate-800">
                    Do you have HTTPS (the padlock)?
                  </dt>
                  <dd className="mt-1">
                    {hasWebsite && hasHttps
                      ? "Yes, your website shows the secure-site padlock (HTTPS)."
                      : hasWebsite
                      ? "Your website could benefit from enabling HTTPS to build more trust."
                      : "Once you have a website, it's important that it runs on HTTPS (the secure-site padlock)."}
                  </dd>
                </div>

                <div className="border border-slate-100 rounded-lg p-3">
                  <dt className="font-semibold text-slate-800">
                    Visible contact channels
                  </dt>
                  <dd className="mt-1">
                    {hasWhatsapp && hasEmail
                      ? "WhatsApp and email are visible, but they could still be better integrated into a clear website."
                      : hasWhatsapp
                      ? "WhatsApp is visible; integrating it into a clear website would make contact easier."
                      : hasEmail
                      ? "Email is visible; adding a clear WhatsApp button and a website would make contact much easier."
                      : "Right now there's almost no clear direct contact channel visible (WhatsApp, email)."}
                  </dd>
                </div>
              </dl>
            </div>

            {/* What this means for your business */}
            <div className="rounded-xl bg-white shadow-sm p-5">
              <h2 className="text-base font-semibold text-slate-900">
                What this means for your business
              </h2>
              <p className="text-sm text-slate-700 mt-2 leading-relaxed">
                You're already doing the hardest part (providing a good
                service that people value), but your digital presence isn't
                fully keeping up. A customer looking for you can end up
                hesitating simply because they don't find a clear website or
                an easy way to contact you. Online, the best business doesn't
                always win — often it's whoever presents themselves more
                clearly and professionally.
              </p>
            </div>

            {/* Recommended first steps */}
            <div className="rounded-xl bg-white shadow-sm p-5">
              <h2 className="text-base font-semibold text-slate-900">
                Recommended first steps (next 7 days)
              </h2>
              <ul className="mt-3 space-y-2 text-sm text-slate-700">
                <li>
                  1. <span className="font-semibold">Sharpen your message</span>:
                  define in 2-3 sentences what you offer, who you help, and
                  why they should choose you.
                </li>
                <li>
                  2.{" "}
                  <span className="font-semibold">
                    Choose your main contact channel
                  </span>
                  : usually WhatsApp, and make sure it's clearly visible on
                  your listing and, if you have one, on your website.
                </li>
                <li>
                  3.{" "}
                  <span className="font-semibold">
                    Start collecting reviews
                  </span>
                  : ask your best customers to leave a review on Google
                  (ideally with a short guiding message).
                </li>
                <li>
                  4.{" "}
                  <span className="font-semibold">
                    Think about your "digital home"
                  </span>
                  : a simple but clear website where you bring everything
                  together (services, photos, reviews, contact).
                </li>
              </ul>

              {ctaVariant === "calendar" && <CtaCalendar />}
              {ctaVariant === "whatsapp_direct" && <CtaWhatsAppDirect />}
              {(ctaVariant === "whatsapp_premium" ||
                (ctaVariant !== "calendar" && ctaVariant !== "whatsapp_direct")) && (
                <CtaWhatsAppPremium />
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}



