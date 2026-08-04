"use client";
import { useState } from "react";

const API = process.env.NEXT_PUBLIC_API_BASE_URL || "https://demo-api.pixelfluxcreative.com";

const CARDS = [
  {
    emoji: "👋",
    title: "Demo of my Lead Intelligence Platform",
    body: "I built this system for a real business. This is a public demo, with 100% fictional data, put together as a portfolio piece for job applications.",
  },
  {
    emoji: "🎯",
    title: "Finds businesses with weak digital presence",
    body: "Scores them automatically with AI, generates a personalized audit of their site and social presence, and manages first contact — always with human oversight before anything is sent.",
  },
  {
    emoji: "📈",
    title: "10,000+ qualified leads",
    body: "With an active partnership in Canada.",
  },
  {
    emoji: "🔄",
    title: "The same architecture adapts to other domains",
    body: "Scraping + AI scoring + human-supervised outreach isn't specific to local businesses — the same pattern works, for example, for sourcing and screening international job candidates.",
  },
];

export default function LandingPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const viewDemo = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/auth/demo-login`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        window.location.href = "/panel";
      } else {
        setError("Couldn't start the demo session. Please try again in a moment.");
        setLoading(false);
      }
    } catch {
      setError("Couldn't reach the demo server. Please try again in a moment.");
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-light flex items-center justify-center p-6">
      <div className="w-full max-w-3xl">
        <div className="text-center mb-10">
          <div className="inline-block bg-dark text-primary text-sm font-semibold px-3 py-1 rounded-full mb-4">
            PixelFlux
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-dark mb-3">
            Lead Intelligence Platform
          </h1>
          <p className="text-slate-600 text-lg">
            A real product, sanitized for a public portfolio demo.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">
          {CARDS.map((c, i) => (
            <div
              key={i}
              className="bg-white rounded-2xl shadow p-5 border border-light"
            >
              <div className="text-2xl mb-2">{c.emoji}</div>
              <h2 className="font-semibold text-dark mb-1">{c.title}</h2>
              <p className="text-sm text-slate-600">{c.body}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center gap-3">
          <button
            onClick={viewDemo}
            disabled={loading}
            className="bg-primary text-dark font-semibold rounded-md px-8 py-3 text-lg hover:opacity-90 disabled:opacity-60"
          >
            {loading ? "Loading…" : "View Demo →"}
          </button>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <p className="text-xs text-slate-400 mt-2">
            No signup required — one click opens a read-only demo session.
          </p>
        </div>
      </div>
    </main>
  );
}
