import "./styles.css";
import { useAgentChat, getToolApproval } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { workspaceName } from "./knowledge";
import type { DeskAgent } from "./server";
import { emptyDesk, type DeskState } from "./types";

const PROMPTS = [
	"Order NL-2041 never arrived. What does policy say?",
	"Open a high-priority case for Maya Chen. Her tent pole snapped in transit.",
	"Follow up on that case in 30 seconds.",
	"What timezone am I in?",
];

const TOOL_LABELS: Record<string, string> = {
	searchRunbooks: "Search runbooks",
	listCases: "Read the case board",
	getOperatorTimezone: "Check your timezone",
	openCase: "Open a case",
	queueCustomerReply: "Queue a customer reply",
	scheduleFollowUp: "Schedule a follow-up",
};

type ToolPart = {
	type: string;
	toolCallId?: string;
	toolName?: string;
	state?: string;
	input?: unknown;
	output?: unknown;
	text?: string;
};

function initialWorkspace(): string {
	const fromQuery = new URLSearchParams(location.search).get("desk");
	if (fromQuery) return workspaceName(fromQuery);
	return workspaceName(localStorage.getItem("harbor-workspace"));
}

function toolNameOf(part: ToolPart): string {
	if (part.toolName) return part.toolName;
	if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
	return "tool";
}

function App() {
	const [workspace, setWorkspace] = useState(initialWorkspace);

	function switchWorkspace(next: string) {
		const name = workspaceName(next);
		localStorage.setItem("harbor-workspace", name);
		const url = new URL(location.href);
		url.searchParams.set("desk", name);
		history.replaceState(null, "", url);
		setWorkspace(name);
	}

	return <Desk key={workspace} workspace={workspace} onWorkspace={switchWorkspace} />;
}

function Desk({
	workspace,
	onWorkspace,
}: {
	workspace: string;
	onWorkspace: (name: string) => void;
}) {
	const [desk, setDesk] = useState<DeskState>(() => emptyDesk(workspace));
	const [live, setLive] = useState(false);
	const [draft, setDraft] = useState("");
	const [draftName, setDraftName] = useState(workspace);
	const [inbound, setInbound] = useState({
		customer: "Jonah Hale",
		subject: "Trail Club pause",
		body: "Please pause my membership for two months.",
	});
	const [localError, setLocalError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const threadRef = useRef<HTMLDivElement>(null);

	const agent = useAgent<DeskAgent, DeskState>({
		agent: "DeskAgent",
		name: workspace,
		onStateUpdate: (state) => {
			if (state) setDesk(state);
			setLive(true);
		},
	});

	const { messages, sendMessage, addToolApprovalResponse, status, error, stop, clearHistory } =
		useAgentChat({
			agent,
			onToolCall: async ({ toolCall, addToolOutput }) => {
				if (toolCall.toolName !== "getOperatorTimezone") return;
				addToolOutput({
					toolCallId: toolCall.toolCallId,
					output: {
						timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
						localTime: new Date().toLocaleString(),
					},
				});
			},
		});

	useEffect(() => {
		threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
	}, [messages, status]);

	const latest = desk.activity[0]?.text ?? "";
	const streaming = status === "streaming" || status === "submitted";

	async function run(action: () => Promise<unknown>) {
		setBusy(true);
		setLocalError(null);
		try {
			await action();
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : "Request failed");
		} finally {
			setBusy(false);
		}
	}

	function submitChat(text: string) {
		const message = text.trim();
		if (!message || streaming) return;
		setDraft("");
		void sendMessage({ text: message });
	}

	const counts = useMemo(() => {
		const open = desk.cases.filter((item) => item.status !== "resolved").length;
		return { open, total: desk.cases.length };
	}, [desk.cases]);

	return (
		<div className="app">
			<header className="top">
				<div className="brand">
					<div className="mark">H</div>
					<div>
						<h1>Harbor Desk</h1>
						<p>
							{counts.open} open · {counts.total} on this Durable Object
						</p>
					</div>
				</div>
				<div className="session">
					<span className={live ? "live on" : "live"}>
						<i />
						{live ? "WebSocket live" : "Connecting"}
					</span>
					<code>DeskAgent:{workspace}</code>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							onWorkspace(draftName);
						}}
					>
						<input
							aria-label="Workspace name"
							value={draftName}
							onChange={(event) => setDraftName(event.target.value)}
						/>
						<button className="ghost" type="submit">
							Switch
						</button>
					</form>
				</div>
			</header>

			<div className="sr" aria-live="polite">
				{latest}
			</div>

			<main className="layout">
				<section className="panel">
					<h2>Case board</h2>
					<form
						className="inbound"
						onSubmit={(event) => {
							event.preventDefault();
							void run(() =>
								agent.stub.ingestInbound({
									customer: inbound.customer,
									subject: inbound.subject,
									body: inbound.body,
									channel: "email",
								}),
							);
						}}
					>
						<strong>Simulate an inbound email</strong>
						<input
							aria-label="Customer"
							value={inbound.customer}
							onChange={(event) =>
								setInbound({ ...inbound, customer: event.target.value })
							}
						/>
						<input
							aria-label="Subject"
							value={inbound.subject}
							onChange={(event) =>
								setInbound({ ...inbound, subject: event.target.value })
							}
						/>
						<textarea
							aria-label="Message"
							rows={3}
							value={inbound.body}
							onChange={(event) =>
								setInbound({ ...inbound, body: event.target.value })
							}
						/>
						<button type="submit" disabled={busy}>
							Drop into this workspace
						</button>
					</form>
					<div className="board">
						{desk.cases.length === 0 ? (
							<p className="empty">
								No cases yet. Drop an email in, or ask Harbor to open one. A
								second workspace is a different Durable Object.
							</p>
						) : (
							desk.cases.map((item) => (
								<article className="case" key={item.id}>
									<header>
										<h3>{item.subject}</h3>
										<span>{item.id}</span>
									</header>
									<p>
										{item.customer} · {item.channel}
									</p>
									<p>{item.summary}</p>
									<div className="pills">
										<span className="pill" data-status={item.status}>
											{item.status}
										</span>
										<span className="pill" data-priority={item.priority}>
											{item.priority}
										</span>
									</div>
									{item.status !== "resolved" ? (
										<button
											className="ghost"
											type="button"
											style={{ marginTop: "0.7rem" }}
											disabled={busy}
											onClick={() => void run(() => agent.stub.resolveCase(item.id))}
										>
											Resolve
										</button>
									) : null}
								</article>
							))
						)}
					</div>
				</section>

				<section className="panel chat">
					<h2>Operator chat</h2>
					<div className="prompts">
						{PROMPTS.map((prompt) => (
							<button key={prompt} type="button" onClick={() => submitChat(prompt)}>
								{prompt}
							</button>
						))}
					</div>
					<div className="thread" ref={threadRef}>
						{messages.length === 0 ? (
							<p className="empty">
								Harbor searches the SQLite runbook, then asks before it writes a
								case, queues a reply, or arms a follow-up.
							</p>
						) : (
							messages.map((message) => (
								<article
									className={message.role === "user" ? "bubble user" : "bubble"}
									key={message.id}
								>
									{message.parts.map((part, index) => (
										<Part
											key={`${message.id}-${index}`}
											part={part as ToolPart}
											onApproval={(id, approved) =>
												void addToolApprovalResponse({ id, approved })
											}
										/>
									))}
								</article>
							))
						)}
					</div>
					{error ? <p className="error">{error.message}</p> : null}
					{localError ? <p className="error">{localError}</p> : null}
					{streaming ? <p className="hint">Harbor is working…</p> : null}
					<form
						className="composer"
						onSubmit={(event) => {
							event.preventDefault();
							submitChat(draft);
						}}
					>
						<textarea
							aria-label="Message Harbor"
							placeholder="Ask about a shipment, a refund, or a follow-up"
							rows={2}
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									submitChat(draft);
								}
							}}
						/>
						<div>
							<button type="submit" disabled={streaming || !draft.trim()}>
								Send
							</button>
							{streaming ? (
								<button className="ghost" type="button" onClick={() => void stop()}>
									Stop
								</button>
							) : (
								<button
									className="ghost"
									type="button"
									onClick={() => void clearHistory()}
								>
									Clear
								</button>
							)}
						</div>
					</form>
				</section>

				<section className="panel">
					<h2>Activity</h2>
					<div className="activity">
						{desk.activity.length === 0 ? (
							<p className="empty">
								Approvals, inbound mail, and alarm follow-ups show up here and
								stay after a refresh.
							</p>
						) : (
							desk.activity.map((item) => (
								<article className="event" key={item.id}>
									<div>
										<strong>{item.kind}</strong>
										<p>{item.text}</p>
									</div>
									<time dateTime={item.at}>
										{new Date(item.at).toLocaleTimeString([], {
											hour: "2-digit",
											minute: "2-digit",
										})}
									</time>
								</article>
							))
						)}
					</div>
				</section>
			</main>
		</div>
	);
}

function Part({
	part,
	onApproval,
}: {
	part: ToolPart;
	onApproval: (id: string, approved: boolean) => void;
}) {
	if (part.type === "text") return <span>{part.text}</span>;
	if (part.type === "reasoning") {
		return (
			<details className="tool">
				<summary>Reasoning</summary>
				<p>{part.text}</p>
			</details>
		);
	}
	if (!part.state && !part.type.startsWith("tool-")) return null;

	const name = toolNameOf(part);
	const label = TOOL_LABELS[name] ?? name;

	if (part.state === "approval-requested") {
		const approval = getToolApproval(part as never);
		if (!approval) return null;
		return (
			<div className="tool">
				<strong>{label}</strong>
				<p>This writes to the workspace. Harbor waits until you approve it.</p>
				<pre>{JSON.stringify(part.input, null, 2)}</pre>
				<div className="actions">
					<button type="button" onClick={() => onApproval(approval.id, true)}>
						Approve
					</button>
					<button
						className="reject"
						type="button"
						onClick={() => onApproval(approval.id, false)}
					>
						Reject
					</button>
				</div>
			</div>
		);
	}

	if (part.state === "output-available") {
		return (
			<details className="tool">
				<summary>{label}</summary>
				<pre>{JSON.stringify(part.output, null, 2)}</pre>
			</details>
		);
	}

	if (part.state) {
		return (
			<p className="hint">
				{label} · {part.state}
			</p>
		);
	}

	return null;
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
