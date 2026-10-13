import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable, getAgentByName, routeAgentRequest } from "agents";
import {
	convertToModelMessages,
	pruneMessages,
	stepCountIs,
	streamText,
	tool,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import {
	RUNBOOKS,
	SEED_VERSION,
	searchRunbooks,
	workspaceName,
	type Runbook,
} from "./knowledge";
import type {
	Activity,
	CaseChannel,
	CasePriority,
	DeskCase,
	DeskState,
	InboundMessage,
} from "./types";

const PRIORITIES = ["low", "normal", "high"] as const;
const CHANNELS = ["chat", "email", "webhook"] as const;

function isPriority(value: string): value is CasePriority {
	return (PRIORITIES as readonly string[]).includes(value);
}

function isChannel(value: string): value is CaseChannel {
	return (CHANNELS as readonly string[]).includes(value);
}

function clip(value: string, max: number): string {
	return value.trim().slice(0, max);
}

function safeEqual(left: string, right: string): boolean {
	const a = new TextEncoder().encode(left);
	const b = new TextEncoder().encode(right);
	const length = Math.max(a.length, b.length);
	let mismatch = a.length === b.length ? 0 : 1;
	for (let i = 0; i < length; i++) {
		mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return mismatch === 0;
}

export class DeskAgent extends AIChatAgent<Env, DeskState> {
	maxPersistedMessages = 100;
	chatRecovery = true;
	waitForMcpConnections = true;
	initialState: DeskState = {
		workspace: "northline",
		cases: [],
		activity: [],
	};

	override onStart() {
		this.sql`
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`;
		this.sql`
			CREATE TABLE IF NOT EXISTS runbooks (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				tags TEXT NOT NULL,
				body TEXT NOT NULL
			)
		`;

		const seeded = this.sql<{ value: string }>`
			SELECT value FROM meta WHERE key = 'seed'
		`;
		if (seeded[0]?.value !== SEED_VERSION) {
			this.sql`DELETE FROM runbooks`;
			for (const book of RUNBOOKS) {
				this.sql`
					INSERT INTO runbooks (id, title, tags, body)
					VALUES (${book.id}, ${book.title}, ${book.tags}, ${book.body})
				`;
			}
			this.sql`
				INSERT INTO meta (key, value) VALUES ('seed', ${SEED_VERSION})
				ON CONFLICT(key) DO UPDATE SET value = ${SEED_VERSION}
			`;
		}

		if (this.state.workspace !== this.name) {
			this.setState({ ...this.state, workspace: this.name });
		}
	}

	@callable()
	ingestInbound(input: InboundMessage): DeskCase | { error: string } {
		const customer = clip(input.customer ?? "", 80);
		const subject = clip(input.subject ?? "", 140);
		const summary = clip(input.body ?? "", 500);
		if (!customer || !subject || !summary) {
			return { error: "customer, subject, and body are required" };
		}

		const channel = isChannel(input.channel ?? "") ? input.channel! : "webhook";
		const opened: DeskCase = {
			id: this.nextCaseId(),
			customer,
			subject,
			summary,
			status: "open",
			priority: "normal",
			channel,
			updatedAt: new Date().toISOString(),
		};

		this.remember([opened, ...this.state.cases].slice(0, 40), {
			kind: "inbound",
			text: `${channel} from ${customer}: ${subject}`,
		});
		return opened;
	}

	@callable()
	resolveCase(caseId: string): { ok: true } | { error: string } {
		if (!this.state.cases.some((item) => item.id === caseId)) {
			return { error: `No case ${caseId}` };
		}
		const cases = this.state.cases.map((item) =>
			item.id === caseId
				? { ...item, status: "resolved" as const, updatedAt: new Date().toISOString() }
				: item,
		);
		this.remember(cases, { kind: "case", text: `Resolved ${caseId}` });
		return { ok: true };
	}

	async deliverFollowUp(payload: { caseId: string; note: string }) {
		const found = this.state.cases.some((item) => item.id === payload.caseId);
		if (!found) {
			this.remember(this.state.cases, {
				kind: "follow-up",
				text: `Follow-up fired, but ${payload.caseId} is no longer on the board`,
			});
			return;
		}

		const cases = this.state.cases.map((item) =>
			item.id === payload.caseId
				? {
						...item,
						status: "needs-attention" as const,
						updatedAt: new Date().toISOString(),
					}
				: item,
		);
		this.remember(cases, {
			kind: "follow-up",
			text: `${payload.caseId} needs attention: ${payload.note}`,
		});
	}

	override async onChatMessage(
		_onFinish: unknown,
		options?: { abortSignal?: AbortSignal; continuation?: boolean },
	) {
		const workersai = createWorkersAI({ binding: this.env.AI });
		const mcpTools = this.mcp.getAITools();

		const result = streamText({
			model: workersai("@cf/moonshotai/kimi-k2.7-code", {
				sessionAffinity: this.sessionAffinity,
			}),
			system: this.instructions(options?.continuation === true),
			messages: pruneMessages({
				messages: await convertToModelMessages(this.messages),
				toolCalls: "before-last-2-messages",
				reasoning: "before-last-message",
			}),
			tools: {
				...mcpTools,
				searchRunbooks: tool({
					description:
						"Search Northline policy runbooks stored in this agent's SQLite database. Use this before answering shipping, damage, billing, warranty, subscription, or return questions.",
					inputSchema: z.object({
						query: z.string().describe("Customer issue in a few words"),
					}),
					execute: async ({ query }) => {
						const books = this.readRunbooks();
						const matches = searchRunbooks(books, query);
						if (matches.length === 0) {
							return { found: false, matches: [] as Runbook[] };
						}
						return { found: true, matches };
					},
				}),
				listCases: tool({
					description:
						"List cases on this workspace's live board. Check this before saying a case does not exist.",
					inputSchema: z.object({}),
					execute: async () => this.state.cases,
				}),
				getOperatorTimezone: tool({
					description:
						"Read the operator's timezone and local time from their browser. Use this when a follow-up should be described in local time.",
					inputSchema: z.object({}),
				}),
				openCase: tool({
					description:
						"Open a case on the board. This writes durable state and always waits for operator approval.",
					inputSchema: z.object({
						customer: z.string(),
						subject: z.string(),
						summary: z.string(),
						priority: z.enum(PRIORITIES).default("normal"),
					}),
					needsApproval: async () => true,
					execute: async ({ customer, subject, summary, priority }) => {
						const name = clip(customer, 80);
						const title = clip(subject, 140);
						const detail = clip(summary, 500);
						if (!name || !title || !detail) {
							return { error: "customer, subject, and summary are required" };
						}
						const opened: DeskCase = {
							id: this.nextCaseId(),
							customer: name,
							subject: title,
							summary: detail,
							status: "open",
							priority: isPriority(priority) ? priority : "normal",
							channel: "chat",
							updatedAt: new Date().toISOString(),
						};
						this.remember([opened, ...this.state.cases].slice(0, 40), {
							kind: "case",
							text: `Opened ${opened.id} for ${name}`,
						});
						return opened;
					},
				}),
				queueCustomerReply: tool({
					description:
						"Record a reply for the operator to send. Harbor does not deliver email itself. Always waits for approval.",
					inputSchema: z.object({
						caseId: z.string(),
						reply: z.string().describe("The reply the operator will send"),
					}),
					needsApproval: async () => true,
					execute: async ({ caseId, reply }) => {
						const text = clip(reply, 1200);
						const current = this.state.cases.find((item) => item.id === caseId);
						if (!current) return { error: `No case ${caseId}` };
						if (!text) return { error: "Reply is empty" };
						const cases = this.state.cases.map((item) =>
							item.id === caseId
								? {
										...item,
										status: "waiting" as const,
										updatedAt: new Date().toISOString(),
									}
								: item,
						);
						this.remember(cases, {
							kind: "reply",
							text: `Reply queued on ${caseId}: ${text}`,
						});
						return {
							caseId,
							status: "waiting",
							note: "Queued for the operator. Nothing was emailed.",
							reply: text,
						};
					},
				}),
				scheduleFollowUp: tool({
					description:
						"Wake this same agent later, even if the browser is closed. Always waits for approval. Use 20 to 40 seconds when the operator wants to see it during a demo.",
					inputSchema: z.object({
						caseId: z.string(),
						note: z.string(),
						delayInSeconds: z.number().int().min(1).max(86400),
					}),
					needsApproval: async () => true,
					execute: async ({ caseId, note, delayInSeconds }) => {
						if (!this.state.cases.some((item) => item.id === caseId)) {
							return { error: `No case ${caseId}` };
						}
						const delay = Math.min(86400, Math.max(15, delayInSeconds));
						const scheduled = await this.schedule(delay, "deliverFollowUp", {
							caseId,
							note: clip(note, 240),
						});
						this.remember(this.state.cases, {
							kind: "follow-up",
							text: `Follow-up armed for ${caseId} in ${delay}s`,
						});
						return {
							caseId,
							runsInSeconds: delay,
							scheduleId: scheduled.id,
						};
					},
				}),
			},
			stopWhen: stepCountIs(8),
			abortSignal: options?.abortSignal,
		});

		return result.toUIMessageStreamResponse();
	}

	private instructions(continuation: boolean): string {
		const open = this.state.cases.filter((item) => item.status !== "resolved");
		const board =
			open.length === 0
				? "The case board is empty."
				: `Open cases: ${open
						.map((item) => `${item.id} (${item.status}, ${item.customer}: ${item.subject})`)
						.join("; ")}`;

		return [
			"You are Harbor, the operations agent for Northline, a small outdoor-gear company.",
			"You assist a human operator. Search runbooks before stating policy. Do not invent rules.",
			"Opening a case, queueing a customer reply, and scheduling a follow-up always wait for approval.",
			"You never send email. A queued reply is a note on the board.",
			"Follow-ups are Durable Object alarms. They fire if the operator closes the tab.",
			"After you open a case, keep using the returned id.",
			`Workspace: ${this.name}.`,
			board,
			continuation
				? "This turn continues a tool result or an approval. Finish the current task."
				: "Answer in a few short sentences and cite the runbook title when you use one.",
		].join("\n");
	}

	private readRunbooks(): Runbook[] {
		return this.sql<Runbook>`SELECT id, title, tags, body FROM runbooks`;
	}

	private nextCaseId(): string {
		const suffix = crypto.randomUUID().slice(0, 4).toUpperCase();
		return `NL-${suffix}`;
	}

	private remember(
		cases: DeskCase[],
		entry: { kind: Activity["kind"]; text: string },
	) {
		const activity: Activity[] = [
			{
				id: crypto.randomUUID(),
				at: new Date().toISOString(),
				kind: entry.kind,
				text: entry.text,
			},
			...this.state.activity,
		].slice(0, 30);

		this.setState({
			workspace: this.name || this.state.workspace,
			cases,
			activity,
		});
	}
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);

		if (url.pathname === "/api/health") {
			return Response.json({ ok: true, agent: "DeskAgent" });
		}

		if (url.pathname === "/api/webhooks/inbound") {
			return handleInbound(request, env);
		}

		return (
			(await routeAgentRequest(request, env)) ??
			new Response("Not found", { status: 404 })
		);
	},
} satisfies ExportedHandler<Env>;

async function handleInbound(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ error: "Use POST" }, { status: 405 });
	}

	const provided = request.headers.get("x-harbor-token") ?? "";
	if (!safeEqual(provided, env.WEBHOOK_TOKEN)) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	let payload: Partial<InboundMessage> & { workspace?: string };
	try {
		const text = await request.text();
		if (text.length > 8000) {
			return Response.json({ error: "Payload too large" }, { status: 413 });
		}
		payload = JSON.parse(text) as typeof payload;
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const workspace = workspaceName(payload.workspace);
	const desk = await getAgentByName(env.DeskAgent, workspace);
	const opened = await desk.ingestInbound({
		customer: payload.customer ?? "",
		subject: payload.subject ?? "",
		body: payload.body ?? "",
		channel: payload.channel === "email" ? "email" : "webhook",
	});

	if ("error" in opened) {
		return Response.json(opened, { status: 400 });
	}

	return Response.json({ workspace, case: opened });
}
