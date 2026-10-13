export type Runbook = {
	id: string;
	title: string;
	tags: string;
	body: string;
};

export const SEED_VERSION = "1";

export const RUNBOOKS: Runbook[] = [
	{
		id: "missing-shipment",
		title: "Missing shipment",
		tags: "shipping lost delivery tracking order",
		body: "Northline waits 7 calendar days after the carrier's last scan before declaring a parcel lost. Ask for the order id (NL- prefix) and the last tracking event. If the window has passed, offer a replacement or a refund to the original payment method. Do not ask the customer to file the carrier claim themselves. Expedited replacements ship from the Portland warehouse within one business day.",
	},
	{
		id: "damaged-item",
		title: "Damaged item",
		tags: "damage broken tent pole photo return",
		body: "A damaged item needs one photo of the product and one photo of the packaging. Tents, stoves, and packs are replaced, not repaired, on the first claim. Poles snapped in transit are a warehouse issue: ship a replacement pole kit at no charge and do not require the customer to return the broken set. Wear after 30 days of use is a warranty claim, not a damage claim.",
	},
	{
		id: "duplicate-charge",
		title: "Duplicate charge",
		tags: "billing refund payment duplicate charge",
		body: "If two captures share the same order id, refund the duplicate within 5 business days. Do not refund both charges. If the customer was charged and the order was cancelled before fulfillment, refund the full amount. Store credit is only offered when the customer asks for it. Never ask for a full card number; the last four digits on the receipt are enough.",
	},
	{
		id: "warranty",
		title: "Warranty",
		tags: "warranty tent stove repair two years",
		body: "Tents and stoves carry a 2-year warranty against manufacturing defects. Zipper wear, UV fade, and damage from an unapproved repair are excluded. A warranty replacement does not reset the original purchase date. The customer keeps the product until the replacement arrives, then recycles the failed item locally. Northline does not operate a mail-in repair shop.",
	},
	{
		id: "subscription-pause",
		title: "Trail Club pause",
		tags: "subscription pause trail club membership",
		body: "Trail Club can be paused for 1, 2, or 3 months from the next renewal date. A pause does not refund the current period. After the pause, billing resumes automatically. Cancelling is separate from pausing: cancellation stops the next renewal and leaves remaining club credits valid for 90 days.",
	},
	{
		id: "returns",
		title: "Return window",
		tags: "return exchange unused 30 days",
		body: "Unused gear can be returned within 30 days of delivery. The item must include original tags. Return shipping is free for defects and paid by the customer for a change of mind. Refunds go to the original payment method after the warehouse scans the return. Exchanges for a different size ship as soon as the return is scanned, not after it is inspected.",
	},
];

export function searchRunbooks(runbooks: Runbook[], query: string): Runbook[] {
	const terms = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 2);

	if (terms.length === 0) return runbooks.slice(0, 3);

	return runbooks
		.map((book) => {
			const haystack = `${book.title} ${book.tags} ${book.body}`.toLowerCase();
			const score = terms.reduce(
				(total, term) => total + (haystack.includes(term) ? 1 : 0),
				0,
			);
			return { book, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 3)
		.map((entry) => entry.book);
}

export function workspaceName(raw: string | null | undefined): string {
	const cleaned = (raw ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "")
		.slice(0, 40);
	return cleaned || "northline";
}
