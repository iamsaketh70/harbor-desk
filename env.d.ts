declare namespace Cloudflare {
	interface Env {
		AI: Ai;
		WEBHOOK_TOKEN: string;
		DeskAgent: DurableObjectNamespace<import("./src/server").DeskAgent>;
	}
}

interface Env extends Cloudflare.Env {}
