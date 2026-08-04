"use client";
import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const API = process.env.NEXT_PUBLIC_API_BASE_URL || "https://demo-api.pixelfluxcreative.com";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const res = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password })
    });
    if (res.ok) window.location.href = "/panel";
    else setError(`Invalid login (status ${res.status})`);
  };

  return (
    <main className="grid place-items-center h-screen p-6">
      <form onSubmit={submit} className="bg-white rounded-2xl shadow p-8 w-full max-w-md border border-light">
        <h1 className="text-2xl font-semibold mb-6 text-dark">PixelFlux — Sign in</h1>
        <label className="block text-sm mb-2">Email</label>
        <input className="w-full border rounded p-2 mb-4" type="email" value={email} onChange={e=>setEmail(e.target.value)} required />
        <label className="block text-sm mb-2">Password</label>
        <input className="w-full border rounded p-2 mb-6" type="password" value={password} onChange={e=>setPassword(e.target.value)} required />
        {error && <p className="text-red-600 mb-4">{error}</p>}
        <button className="w-full bg-primary text-dark font-medium rounded-md py-2 hover:opacity-90">Sign in</button>
      </form>
    </main>
  );
}