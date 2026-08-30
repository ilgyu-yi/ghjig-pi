/**
 * Scripted provider — static test-harness asset (SPEC §4.4).
 *
 * This file is COPIED into a disposable fixture's `.pi/extensions/` by
 * `test/harness/run-pi.ts` at fixture-build time. It is never installed
 * under this repository's own `.pi/` tree, so a real session never loads
 * test machinery.
 *
 * It registers a custom provider ("scripted") whose streaming function
 * reads deterministic turns from `<fixture>/script.json` (resolved
 * relative to this file's installed location: `.pi/extensions/` → up two
 * levels). No network, no model, no API key: `baseUrl` is a placeholder
 * value that satisfies validation and is never contacted (§4.4; issue #4
 * spike note, finding 3).
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type ScriptTurn =
	| { kind: "toolCall"; name: string; arguments: Record<string, unknown> }
	| { kind: "text"; text: string };

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = join(fixtureRoot, "script.json");

let turn = 0;

function streamScripted(
	model: Model<Api>,
	_context: Context,
	_options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};
		try {
			stream.push({ type: "start", partial: output });
			const script = JSON.parse(readFileSync(scriptPath, "utf8")) as ScriptTurn[];
			const current: ScriptTurn = script[turn] ?? { kind: "text", text: "SCRIPT_EXHAUSTED" };
			turn += 1;
			if (current.kind === "toolCall") {
				const call = {
					type: "toolCall" as const,
					id: `call_scripted_${turn}`,
					name: current.name,
					arguments: current.arguments,
				};
				output.content.push(call);
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
				output.stopReason = "toolUse";
			} else {
				output.content.push({ type: "text", text: current.text });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: current.text, partial: output });
				output.stopReason = "stop";
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: "error", error: output });
			stream.end();
		}
	})();
	return stream;
}

export default function scriptedProvider(pi: ExtensionAPI) {
	pi.registerProvider("scripted", {
		name: "Scripted",
		baseUrl: "http://scripted.invalid/v1",
		apiKey: "scripted-dummy-key",
		api: "openai-completions",
		models: [
			{
				id: "scripted-model",
				name: "Scripted Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: streamScripted,
	});
}
