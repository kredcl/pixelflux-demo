"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import NewsFeed from "../../components/NewsFeed";

export default function Panel() {
  const [me, setMe] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const API = process.env.NEXT_PUBLIC_API_BASE_URL || "https://demo-api.pixelfluxcreative.com";

  useEffect(() => {
    fetch(`${API}/me`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { setMe(d); setLoading(false); })
      .catch(() => { setMe(null); setLoading(false); });
  }, []);

  if (loading) return <main className="p-8">Loading…</main>;
  if (!me) { window.location.href = "/"; return null; }

  return (
    <main className="min-h-screen grid grid-cols-[240px_1fr]">
      <aside className="bg-dark text-white p-6 flex flex-col gap-3">
        <div className="text-xl font-semibold mb-4">Command Center</div>

        <Link className="bg-white/10 text-white rounded-md px-3 py-2 hover:bg-white/20" href="/panel">Home</Link>
        <Link className="bg-teal text-white rounded-md px-3 py-2" href="/leads">Leads</Link>
        <Link className="bg-white/10 text-white rounded-md px-3 py-2 hover:bg-white/20" href="/scraper">Scraper</Link>
        <Link className="bg-white/10 text-white rounded-md px-3 py-2 hover:bg-white/20" href="/campaigns">Campaigns</Link>
        <Link className="bg-primary text-dark rounded-md px-3 py-2" href="/waba">WhatsApp</Link>

        <a className="mt-auto bg-white/10 rounded px-3 py-2 text-center hover:bg-white/20" href="/logout">Exit demo</a>
      </aside>

      <section className="bg-light h-screen overflow-y-auto">
        <div className="max-w-7xl mx-auto p-8">
          <header className="mb-8">
            <h1 className="text-3xl font-bold text-dark mb-2">Welcome to the demo</h1>
            <p className="text-slate-600 text-lg">
              Use the sidebar to explore the leads catalog + dashboard, the scraper interface, campaigns/outreach, and WhatsApp conversations — all running on real code against synthetic, precomputed data.
            </p>
          </header>

          <hr className="border-slate-200 mb-8" />

          <div className="mb-6">
            <h2 className="text-xl font-semibold text-dark mb-4">Featured News</h2>
            <NewsFeed />
          </div>
        </div>
      </section>
    </main>
  );
}
