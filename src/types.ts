export type CaseStatus = "open" | "waiting" | "needs-attention" | "resolved";
export type CasePriority = "low" | "normal" | "high";
export type CaseChannel = "chat" | "email" | "webhook";
export type ActivityKind = "case" | "reply" | "follow-up" | "inbound" | "note";

export type DeskCase = {
	id: string;
	customer: string;
	subject: string;
	summary: string;
	status: CaseStatus;
	priority: CasePriority;
	channel: CaseChannel;
	updatedAt: string;
};

export type Activity = {
	id: string;
	at: string;
	kind: ActivityKind;
	text: string;
};

export type DeskState = {
	workspace: string;
	cases: DeskCase[];
	activity: Activity[];
};

export type InboundMessage = {
	customer: string;
	subject: string;
	body: string;
	channel?: CaseChannel;
};

export const emptyDesk = (workspace: string): DeskState => ({
	workspace,
	cases: [],
	activity: [],
});
