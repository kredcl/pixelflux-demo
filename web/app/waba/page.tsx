"use client";
import { useEffect, useMemo, useRef, useState } from "react";

type Contact = { id:number; wa_id:string; name:string; last_message_at:string|null };
type Msg = {
  wamid:string;
  direction:"in"|"out";
  type:string;
  text?:string|null;
  template_name?:string|null;
  status?:string|null;
  ts:string;
};
type TemplateItem = { name:string; language:string; category:string; body_params:number };

function Tick({ status }: { status?: string | null }) {
  // sent: ✓  delivered: ✓✓  read: ✓✓ (azul)  failed: !
  if (!status || status === "sent") return <span className="text-[10px] ml-2 opacity-60">✓</span>;
  if (status === "delivered")     return <span className="text-[10px] ml-2 opacity-60">✓✓</span>;
  if (status === "read")          return <span className="text-[10px] ml-2 text-blue-600">✓✓</span>;
  if (status === "failed")        return <span className="text-[10px] ml-2 text-red-600 font-semibold">!</span>;
  return null;
}

export default function WabaPage() {
  const API = process.env.NEXT_PUBLIC_API_BASE_URL || "https://demo-api.pixelfluxcreative.com";

  // Estado base
  const [contacts, setContacts]   = useState<Contact[]>([]);
  const [activeWa, setActiveWa]   = useState<string>("");
  const [messages, setMessages]   = useState<Msg[]>([]);
  const [loadingContacts, setLoadingContacts]   = useState(true);
  const [initialLoadingMsgs, setInitialLoadingMsgs] = useState(false);
  const [text, setText]           = useState("");
  const [sending, setSending]     = useState(false);

  // Plantillas
  const [showTpl, setShowTpl]     = useState(false);
  const [tpls, setTpls]           = useState<TemplateItem[]>([]);
  const [tplName, setTplName]     = useState<string>("");
  const [tplLang, setTplLang]     = useState<string>("es_CL");
  const [tplParams, setTplParams] = useState<string[]>([]);
  const [sendingTpl, setSendingTpl] = useState(false);

  // Refs & memos
  const chatRef   = useRef<HTMLDivElement>(null);
  const lastTsRef = useRef<string>(""); // cursor incremental
  const prevCount = useRef<number>(0);
  const activeContact = useMemo(() => contacts.find(c => c.wa_id === activeWa), [contacts, activeWa]);

  const scrollToBottom = () => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // -------- Helpers de datos --------
  const loadContacts = async () => {
    setLoadingContacts(true);
    try {
      const r = await fetch(`${API}/waba/contacts`, { credentials: "include" });
      if (!r.ok) throw new Error();
      const d = await r.json();
      setContacts(d.items || []);
      if (!activeWa && d.items?.length) setActiveWa(d.items[0].wa_id);
    } finally {
      setLoadingContacts(false);
    }
  };

  const initialLoadMessages = async (wa: string) => {
    setInitialLoadingMsgs(true);
    try {
      const r = await fetch(`${API}/waba/messages?wa_id=${encodeURIComponent(wa)}`, { credentials: "include" });
      const d = await r.json();
      const items: Msg[] = d.items || [];
      setMessages(items);
      lastTsRef.current = items.length ? items[items.length - 1].ts : "";
      scrollToBottom();
    } finally {
      setInitialLoadingMsgs(false);
    }
  };

  const appendNewMessages = async () => {
    if (!activeWa) return;
    const url = lastTsRef.current
      ? `${API}/waba/messages?wa_id=${encodeURIComponent(activeWa)}&since=${encodeURIComponent(lastTsRef.current)}`
      : `${API}/waba/messages?wa_id=${encodeURIComponent(activeWa)}`;
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) return;
    const d = await r.json();
    const news: Msg[] = d.items || [];
    if (!news.length) return;

    setMessages(prev => {
      const seen = new Set(prev.map(m => m.wamid));
      const merged = [...prev];
      for (const m of news) if (!seen.has(m.wamid)) merged.push(m);
      return merged;
    });

    lastTsRef.current = news[news.length - 1].ts;

    // refrescar contactos si hubo novedades
    fetch(`${API}/waba/contacts`, { credentials: "include" })
      .then(rr => rr.ok ? rr.json() : Promise.reject(rr))
      .then(d2 => setContacts(d2.items || []))
      .catch(() => {});
  };

  const refreshStatuses = async () => {
    if (!activeWa) return;
    const r = await fetch(
      `${API}/waba/statuses?wa_id=${encodeURIComponent(activeWa)}&limit=120&out_only=1`,
      { credentials: "include" }
    );
    if (!r.ok) return;
    const d = await r.json();
    const map = new Map<string, string | null | undefined>(
      (d.items || []).map((i: any) => [i.wamid as string, i.status as string])
    );
    if (map.size === 0) return;

    setMessages(prev =>
      prev.map(m => (m.direction === "out" && map.has(m.wamid) && m.status !== map.get(m.wamid)
        ? { ...m, status: map.get(m.wamid) || null }
        : m))
    );
  };

  // -------- Cargas iniciales --------
  useEffect(() => { loadContacts(); }, []);

  // Cargar plantillas una vez
  useEffect(() => {
    fetch(`${API}/waba/templates`, { credentials: "include" })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(d => {
        const items: TemplateItem[] = d.items || [];
        setTpls(items);
        if (items.length) {
          setTplName(items[0].name);
          setTplLang(items[0].language || "es");
          setTplParams(Array(Math.max(0, items[0].body_params)).fill(""));
        }
      })
      .catch(() => {});
  }, []);

  // Al cambiar contacto: reset hilo y cargar
  useEffect(() => {
    if (!activeWa) return;
    setMessages([]);
    lastTsRef.current = "";
    initialLoadMessages(activeWa);
  }, [activeWa]);

  // Polling incremental (3s) y polling de statuses (4s)
  useEffect(() => {
    if (!activeWa) return;
    const id1 = setInterval(appendNewMessages, 3000);
    const id2 = setInterval(refreshStatuses, 4000);
    return () => { clearInterval(id1); clearInterval(id2); };
  }, [activeWa]);

  // Autoscroll al llegar mensajes nuevos
  useEffect(() => {
    if (messages.length > prevCount.current) scrollToBottom();
    prevCount.current = messages.length;
  }, [messages.length]);

  // Cuando cambia la plantilla elegida, recalcular params/lang por defecto
  useEffect(() => {
    const t = tpls.find(x => x.name === tplName);
    if (!t) return;
    setTplLang(t.language || "es");
    setTplParams(Array(Math.max(0, t.body_params)).fill(""));
  }, [tplName, tpls]);

  // -------- Acciones --------
  const send = async () => {
    if (!text.trim() || !activeWa) return;
    const toSend = text;
    setText("");
    setSending(true);
    try {
      const res = await fetch(`${API}/waba/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ to: activeWa, type: "text", text: toSend })
      });
      if (!res.ok) {
        const err = await res.text();
        alert("Could not send:\n" + err);
        return;
      }
      await appendNewMessages();
      scrollToBottom();
    } finally {
      setSending(false);
    }
  };

  const sendTemplate = async () => {
    if (!activeWa || !tplName) return;
    setSendingTpl(true);
    try {
      const components = [{ type: "body", parameters: tplParams.map(p => ({ type:"text", text:p })) }];
      const res = await fetch(`${API}/waba/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          to: activeWa,
          type: "template",
          template_name: tplName,
          language: tplLang,
          components
        })
      });
      if (!res.ok) {
        const err = await res.text();
        alert("Could not send template:\n" + err);
        return;
      }
      setShowTpl(false);
      await appendNewMessages();
      scrollToBottom();
    } finally {
      setSendingTpl(false);
    }
  };

  // -------- UI --------
  return (
    <main className="min-h-screen grid grid-cols-[320px_1fr]">
      {/* Sidebar contactos */}
      <aside className="bg-dark text-white p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Conversations</h2>
          <a className="text-xs underline opacity-80 hover:opacity-100" href="/panel">Back</a>
        </div>
        <div className="text-[11px] opacity-70 mb-3">
          Simulated conversations — no real WhatsApp messages are sent from this demo.
        </div>
        {loadingContacts ? (
          <div className="opacity-80">Loading contacts…</div>
        ) : contacts.length === 0 ? (
          <div className="opacity-80">No contacts yet.</div>
        ) : (
          <ul className="space-y-2">
            {contacts.map(c => (
              <li key={c.wa_id}>
                <button
                  className={"w-full text-left px-3 py-2 rounded-md " + (c.wa_id===activeWa ? "bg-white text-dark" : "bg-white/10")}
                  onClick={() => setActiveWa(c.wa_id)}
                >
                  <div className="font-medium">{c.name || c.wa_id}</div>
                  <div className="text-xs opacity-80">{c.wa_id}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Panel principal */}
      <section className="flex flex-col h-screen">
        {/* Header */}
        <div className="border-b p-4">
          {activeContact ? (
            <div>
              <div className="text-xl font-semibold">{activeContact.name || activeContact.wa_id}</div>
              <div className="text-sm opacity-70">{activeContact.wa_id}</div>
            </div>
          ) : (
            <div className="text-lg">Select a contact</div>
          )}
        </div>

        {/* Panel de Plantilla (opcional) */}
        {showTpl && (
          <div className="border-b p-3 bg-white/70">
            <div className="flex flex-wrap gap-2 items-center">
              <select
                className="border rounded-md px-2 py-1"
                value={tplName}
                onChange={e=>setTplName(e.target.value)}
              >
                {tpls.map(t => (
                  <option key={t.name} value={t.name}>
                    {t.name} ({t.language})
                  </option>
                ))}
              </select>

              <input
                className="border rounded-md px-2 py-1 w-28"
                value={tplLang}
                onChange={e=>setTplLang(e.target.value)}
                placeholder="language (e.g.: es_CL)"
              />

              {tplParams.map((v, i) => (
                <input
                  key={i}
                  className="border rounded-md px-2 py-1"
                  placeholder={`{{${i+1}}}`}
                  value={v}
                  onChange={e=>{
                    const arr = [...tplParams]; arr[i]=e.target.value; setTplParams(arr);
                  }}
                />
              ))}

              <button
                type="button"
                className="bg-primary text-dark rounded-md px-3 py-2 font-medium disabled:opacity-50"
                onClick={sendTemplate}
                disabled={sendingTpl}
              >
                {sendingTpl ? "Sending…" : "Send template"}
              </button>
            </div>
          </div>
        )}

        {/* Mensajes */}
        <div ref={chatRef} className="flex-1 overflow-y-auto p-4 space-y-2 bg-[#F1F7F6]">
          {initialLoadingMsgs ? (
            <div className="opacity-70">Loading messages…</div>
          ) : messages.length === 0 ? (
            <div className="opacity-70">No messages yet.</div>
          ) : (
            messages.map(m => (
              <div
                key={m.wamid}
                className={
                  "max-w-[70%] rounded-lg px-3 py-2 " +
                  (m.direction==='out' ? "ml-auto bg-[#00DF81] text-[#032221]" : "mr-auto bg-white")
                }
              >
                {m.text ?? (m.template_name ? `📄 template: ${m.template_name}` : (m.type || ""))}
                <div className="text-[10px] opacity-70 mt-1 flex items-center">
                  {new Date(m.ts).toLocaleString()}
                  {m.direction === "out" && <Tick status={m.status} />}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={(e)=>{e.preventDefault(); send();}}
          className="border-t p-3 flex gap-2"
        >
          <button
            type="button"
            className="border rounded-md px-3 py-2 bg-white"
            onClick={() => setShowTpl(v => !v)}
            title="Send template"
          >
            {showTpl ? "✖" : "📄 Template"}
          </button>

          <input
            className="flex-1 border rounded-md px-3 py-2"
            placeholder={activeWa ? "Type a message…" : "Select a contact to send to"}
            value={text}
            onChange={e=>setText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }}}
            disabled={!activeWa || sending}
          />
          <button
            className="bg-primary text-dark rounded-md px-4 py-2 font-medium disabled:opacity-50"
            disabled={!activeWa || sending || !text.trim()}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </form>
      </section>
    </main>
  );
}
