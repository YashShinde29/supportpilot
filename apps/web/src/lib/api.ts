export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error?.message ?? "Unable to reach SupportPilot. Please try again.", response.status);
  return data as T;
}
export type Customer = { id: string; name: string; phone: string };
export type Draft = { id: string; status: "pending" | "ready" | "failed" | "used"; text: string | null; errorCode?: string | null };
export type Message = { id: string; sender: "customer" | "agent"; text: string; sentAt: string; replyToMessageId: string | null; draft?: Draft | null };
export type Thread = { messages: Message[]; total: number };
export type Conversation = { id: string; customer: Customer; lastActivityAt: string; latestMessage: Message | null };
