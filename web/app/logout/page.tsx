"use client";
import { useEffect } from "react";
import Link from "next/link";

export default function LogoutPage() {
  const API = process.env.NEXT_PUBLIC_API_BASE_URL || "https://demo-api.pixelfluxcreative.com";
  useEffect(() => {
    fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" })
      .finally(() => setTimeout(() => { window.location.href = "/"; }, 1000));
  }, []);
  return (
    <main className="grid place-items-center h-screen p-6 bg-light text-dark">
      <div className="bg-white rounded-2xl shadow p-8 w-full max-w-md border border-light text-center">
        <h1 className="text-2xl font-semibold mb-2">Demo session ended</h1>
        <p className="mb-6">Thanks for checking out PixelFlux.</p>
        <Link className="inline-block bg-primary text-dark font-medium rounded-md px-4 py-2 hover:opacity-90" href="/">
          Back to the demo intro
        </Link>
      </div>
    </main>
  );
}