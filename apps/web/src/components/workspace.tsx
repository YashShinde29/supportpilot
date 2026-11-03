"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction, type FormEvent } from "react";
import { api, ApiError, type Conversation, type Customer, type Draft, type Thread } from "@/lib/api";
import { DEMO_AGENT_EMAIL, DEMO_AGENT_PASSWORD } from "@/lib/demo-agent";

const errorText = (error: unknown) => error instanceof Error ? error.message : "Please try again.";
const draftFailure = (code?: string | null) => {
  if (code === "PROVIDER_UNAVAILABLE") return "The AI service could not complete the request. Your message is saved. Please wait a little, then retry.";
  if (code === "RATE_LIMITED") return "The AI usage limit was reached. Wait for the limit to reset before retrying.";
  if (code === "TIMEOUT") return "The AI request took too long. Your message is saved. Please retry.";
  if (code === "AUTH_ERROR" || code === "MODEL_UNAVAILABLE") return "The AI configuration needs attention. Check the API key and model on the server.";
  return "Draft generation failed. You can try again.";
};
const time = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function Notice({ text }: { text: string }) { return text ? <p role="alert" className="my-3 rounded-xl bg-red-50 p-3 text-sm text-red-800">{text}</p> : null; }

export function Workspace() {
  const [mode, setMode] = useState("customer");
  const [selectedCustomer, setSelectedCustomer] = useState("");
  return <main className="mx-auto max-w-7xl px-4 py-6 sm:px-8"><header className="mb-8 flex flex-wrap items-center justify-between gap-5 border-b border-stone-200 pb-6"><div><p className="eyebrow">Verdant & Co</p><h1 className="mt-1 text-2xl font-semibold">SupportPilot<span className="text-emerald-700">.</span></h1></div><nav aria-label="Workspace" className="flex rounded-full bg-stone-200 p-1">{["customer", "agent"].map((value) => <button key={value} onClick={() => setMode(value)} aria-pressed={mode === value} className={`rounded-full px-6 py-2 text-sm font-semibold capitalize ${mode === value ? "bg-white text-emerald-900 shadow-sm" : "text-stone-600"}`}>{value}</button>)}</nav></header>{mode === "customer" ? <CustomerWorkspace selected={selectedCustomer} setSelected={setSelectedCustomer} /> : <AgentWorkspace />}<footer className="mt-6 text-center text-xs text-stone-500">Verdant & Co support demo · Replies are reviewed by a person.</footer></main>;
}

function MessageThread({ path, agent = false, revision = 0, onUnauthorized }: { path: string; agent?: boolean; revision?: number; onUnauthorized?: () => void }) {
  const [thread, setThread] = useState<Thread>({ messages: [], total: 0 });
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true; let busy = false;
    const load = async () => {
      if (busy) return; busy = true;
      try { const result = await api<Thread>(`${path}?offset=${offset}`); if (active) { setThread(result); setError(""); } }
      catch (failure) { if (active) { setError(errorText(failure)); if (failure instanceof ApiError && failure.status === 401) onUnauthorized?.(); } }
      finally { busy = false; if (active) setLoading(false); }
    };
    void load(); const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, [path, offset, revision, refresh, onUnauthorized]);
  return <div className="space-y-5"><div className="flex justify-between gap-3 text-xs text-stone-500"><span>{loading ? "Loading conversation…" : `${thread.total} messages · Updates every 5 seconds`}</span><button className="text-emerald-800 underline" onClick={() => setRefresh((value) => value + 1)}>Refresh</button></div><Notice text={error} />
    {(offset > 0 || offset + 100 < thread.total) && <div className="flex gap-4 text-sm"><button disabled={offset + 100 >= thread.total} onClick={() => setOffset(offset + 100)}>← Older</button><button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 100))}>Newer →</button></div>}
    {!loading && !thread.messages.length && <div className="py-14 text-center"><p className="text-lg font-medium">A little help, whenever you need it.</p><p className="mt-2 text-sm text-stone-500">Send a message to start this conversation.</p></div>}
    {thread.messages.map((message, index) => <article key={message.id} className={message.sender === "agent" ? "ml-4 sm:ml-16" : "mr-4 sm:mr-16"}><div className={`rounded-2xl p-4 ${message.sender === "agent" ? "border border-emerald-100 bg-emerald-50" : "bg-stone-100"}`}><div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-stone-500"><span className="font-semibold">{message.sender === "agent" ? "Verdant support" : "Customer"}</span><time dateTime={message.sentAt}>{time(message.sentAt)}</time></div>{message.sender === "agent" && message.replyToMessageId && thread.messages[index - 1]?.id !== message.replyToMessageId && <ReplyQuote original={thread.messages.find((item) => item.id === message.replyToMessageId)?.text} />}<p className="whitespace-pre-wrap break-words text-sm leading-6">{message.text}</p></div>{agent && message.draft && <DraftEditor key={message.draft.id} draft={message.draft} onChanged={() => setRefresh((value) => value + 1)} onUnauthorized={onUnauthorized} />}</article>)}
  </div>;
}

function ReplyQuote({ original }: { original?: string }) {
  return <blockquote className="mb-3 rounded-r-lg border-l-2 border-emerald-600 bg-white/70 px-3 py-2">
    <p className="mb-1 text-xs font-semibold text-emerald-900">Replying to</p>
    <p className="whitespace-pre-wrap break-words text-sm text-stone-600">{original ?? "An earlier customer message. Use Older to view it."}</p>
  </blockquote>;
}

function DraftEditor({ draft, onChanged, onUnauthorized }: { draft: Draft; onChanged: () => void; onUnauthorized?: () => void }) {
  const [text, setText] = useState(draft.text ?? ""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { setText(draft.text ?? ""); }, [draft.text]);
  async function act(action: "approve" | "retry") {
    setBusy(true); setError("");
    try {
      const result = await api<{ draft: Draft }>(`/agent/drafts/${draft.id}/${action}`, action === "approve" ? { text } : {});
      if (action === "retry" && result.draft.status === "failed") {
        setError(`Retry failed. ${draftFailure(result.draft.errorCode)}`);
      }
      onChanged();
    }
    catch (failure) { setError(errorText(failure)); if (failure instanceof ApiError && failure.status === 401) onUnauthorized?.(); }
    finally { setBusy(false); }
  }
  if (draft.status === "used") return <p className="mt-2 text-xs text-emerald-800">✓ Reply approved</p>;
  return <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50/50 p-4"><p className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-900">AI draft · Agent only</p>{draft.status === "ready" ? <><label className="sr-only" htmlFor={draft.id}>Edit reply</label><textarea id={draft.id} value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} rows={5} className="field" /><p className="my-2 text-xs text-stone-500">Review before sharing with the customer.</p><button className="primary" disabled={busy || !text.trim()} onClick={() => void act("approve")}>{busy ? "Approving…" : "Approve & reply"}</button></> : <><p className="mb-3 text-sm">{draft.status === "failed" ? draftFailure(draft.errorCode) : "Draft preparation is pending. Retry if it has stalled."}</p><button className="secondary" disabled={busy} onClick={() => void act("retry")}>{busy ? "Preparing…" : "Retry draft"}</button></>}<Notice text={error} /></div>;
}

function CustomerWorkspace({ selected, setSelected }: { selected: string; setSelected: Dispatch<SetStateAction<string>> }) {
  const [customers, setCustomers] = useState<Customer[]>([]); const [text, setText] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [revision, setRevision] = useState(0);
  const submission = useRef<{ customerId: string; text: string; clientMessageId: string; timestamp: string } | null>(null);
  const load = useCallback(async () => { try { const data = await api<{ customers: Customer[] }>("/customer/customers"); setCustomers(data.customers); setSelected((value) => value || data.customers[0]?.id || ""); setError(""); } catch (failure) { setError(errorText(failure)); } }, [setSelected]);
  useEffect(() => { void load(); }, [load]);
  async function send(event: FormEvent) {
    event.preventDefault(); if (!selected || !text.trim() || busy) return; setBusy(true); setError("");
    if (!submission.current || submission.current.customerId !== selected || submission.current.text !== text.trim()) submission.current = { customerId: selected, text: text.trim(), clientMessageId: crypto.randomUUID(), timestamp: new Date().toISOString() };
    try { await api("/customer/messages", submission.current); setText(""); submission.current = null; setRevision((value) => value + 1); }
    catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  }
  return <div className="grid items-start gap-6 lg:grid-cols-[280px_1fr]"><aside className="panel"><p className="eyebrow">Customer view</p><h2 className="mt-2 text-2xl font-semibold">Let’s talk skincare.</h2><p className="mt-3 text-sm leading-6 text-stone-600">Questions about your order or our products? Our team is here to help.</p><label htmlFor="customer" className="mt-6 mb-2 block text-sm font-medium">Test customer</label><select id="customer" className="field" value={selected} disabled={busy} onChange={(event) => { setSelected(event.target.value); setText(""); setError(""); }}>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select><p className="mt-3 text-xs leading-5 text-stone-500">Fictional conversations are public for testing. Please do not enter personal information.</p><p className="mt-7 mb-3 text-sm font-semibold">Try a question</p><div className="flex flex-col items-start gap-3">{["What is your return policy?", "Do you ship to Dubai?", "Can I pay COD for an order of ₹3,500?"].map((sample) => <button className="text-left text-sm text-emerald-800 underline underline-offset-4" key={sample} disabled={busy} onClick={() => setText(sample)}>{sample}</button>)}</div></aside>
    <section className="panel"><h2 className="text-lg font-semibold">Your conversation</h2><p className="mt-1 mb-6 text-sm text-stone-500">Only messages and approved replies appear here.</p>{selected && <MessageThread key={selected} path={`/customer/conversations/${selected}`} revision={revision} />}<Notice text={error} />{!customers.length && <button className="secondary" onClick={() => void load()}>Retry connection</button>}<form onSubmit={send} className="mt-6 border-t border-stone-100 pt-5"><label htmlFor="message" className="mb-2 block text-sm font-medium">Your message</label><textarea id="message" className="field" placeholder="How can we help?" value={text} maxLength={10000} rows={3} disabled={busy} onChange={(event) => setText(event.target.value)} /><div className="mt-3 flex items-center justify-between gap-3"><span role="status" className="text-xs text-stone-500">{busy ? "Sending your message…" : "Replies appear after review."}</span><button className="primary" disabled={busy || !selected || !text.trim()}>{busy ? "Sending…" : "Send message"}</button></div></form></section></div>;
}

function AgentWorkspace() {
  const [agent, setAgent] = useState<{ name: string } | null>(null); const [checking, setChecking] = useState(true); const [error, setError] = useState("");
  const [busy, setBusy] = useState(false); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const expired = useCallback(() => { setAgent(null); setError("Your session has expired. Please sign in again."); }, []);
  useEffect(() => { let active = true; void api<{ agent: { name: string } }>("/auth/me").then((result) => { if (active) setAgent(result.agent); }).catch((failure: unknown) => { if (active && !(failure instanceof ApiError && failure.status === 401)) setError(errorText(failure)); }).finally(() => { if (active) setChecking(false); }); return () => { active = false; }; }, []);
  async function login(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { const result = await api<{ agent: { name: string } }>("/auth/login", { email, password }); setAgent(result.agent); setPassword(""); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }
  async function logout() { setBusy(true); try { await api("/auth/logout", {}); setAgent(null); setError(""); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }
  if (checking) return <p role="status">Checking your session…</p>;
  if (!agent) return <section className="panel mx-auto max-w-md"><p className="eyebrow">Agent workspace</p><h2 className="mt-2 text-2xl font-semibold">Welcome back.</h2><p className="mt-2 mb-6 text-sm text-stone-500">Sign in to review drafts and help your customers.</p><aside aria-label="Demo login" className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <h3 className="text-sm font-semibold text-emerald-950">Demo login</h3>
        <p className="mt-1 text-xs leading-5 text-stone-600">Use this shared account to test conversations and approve replies. Demo activity is visible to other testers.</p>
        <dl className="mt-3 space-y-2 text-sm">
          <div><dt className="font-medium text-stone-600">Email</dt><dd className="break-all font-mono text-emerald-950">{DEMO_AGENT_EMAIL}</dd></div>
          <div><dt className="font-medium text-stone-600">Password</dt><dd className="break-all font-mono text-emerald-950">{DEMO_AGENT_PASSWORD}</dd></div>
        </dl>
        <button type="button" className="secondary mt-4" disabled={busy} onClick={() => { setEmail(DEMO_AGENT_EMAIL); setPassword(DEMO_AGENT_PASSWORD); setError(""); }}>Use demo credentials</button>
      </aside><form onSubmit={login}><label htmlFor="email" className="mb-2 block text-sm">Email</label><input id="email" className="field" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /><label htmlFor="password" className="mt-4 mb-2 block text-sm">Password</label><input id="password" className="field" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /><Notice text={error} /><button className="primary mt-5 w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button></form></section>;
  return <><div className="mb-5 flex items-center justify-between"><p className="text-sm text-stone-600">Signed in as <strong>{agent.name}</strong></p><button className="secondary" disabled={busy} onClick={() => void logout()}>Sign out</button></div><Notice text={error} /><Inbox onUnauthorized={expired} /></>;
}

function Inbox({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [items, setItems] = useState<Conversation[]>([]); const [selected, setSelected] = useState(""); const [offset, setOffset] = useState(0); const [total, setTotal] = useState(0); const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = async () => { try { const data = await api<{ items: Conversation[]; total: number }>(`/agent/conversations?offset=${offset}`); if (active) { setItems(data.items); setTotal(data.total); setSelected((value) => value || data.items[0]?.id || ""); setError(""); } } catch (failure) { if (active) { setError(errorText(failure)); if (failure instanceof ApiError && failure.status === 401) onUnauthorized(); } } };
    void load(); const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 5000); return () => { active = false; window.clearInterval(interval); };
  }, [offset, onUnauthorized]);
  const conversation = items.find((item) => item.id === selected);
  return <div className="grid items-start gap-6 lg:grid-cols-[320px_1fr]"><aside className="panel"><p className="eyebrow">Agent inbox</p><h2 className="mt-2 mb-5 text-xl font-semibold">Conversations <span className="text-stone-400">{total}</span></h2><Notice text={error} /><div className="space-y-2">{items.map((item) => <button key={item.id} onClick={() => setSelected(item.id)} aria-pressed={selected === item.id} className={`w-full rounded-xl border p-3 text-left ${selected === item.id ? "border-emerald-300 bg-emerald-50" : "border-stone-100 hover:bg-stone-50"}`}><span className="block text-sm font-semibold">{item.customer.name}</span><span className="mt-1 block truncate text-sm text-stone-600">{item.latestMessage?.text ?? "No messages"}</span><span className="mt-2 block text-xs text-stone-500">{time(item.lastActivityAt)}</span></button>)}</div><div className="mt-4 flex justify-between text-sm"><button disabled={!offset} onClick={() => { setOffset(Math.max(0, offset - 20)); setSelected(""); }}>Previous</button><button disabled={offset + 20 >= total} onClick={() => { setOffset(offset + 20); setSelected(""); }}>Next</button></div></aside><section className="panel"><h2 className="mb-1 text-lg font-semibold">{conversation?.customer.name ?? "Conversation"}</h2><p className="mb-6 text-sm text-stone-500">{conversation?.customer.phone ?? "Select a conversation to review."}</p>{selected ? <MessageThread key={selected} path={`/agent/conversations/${selected}`} agent onUnauthorized={onUnauthorized} /> : <p className="py-14 text-center text-sm text-stone-500">Incoming customer messages will appear here.</p>}</section></div>;
}
