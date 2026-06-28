import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteForgejoVault } from "./remoteForgejoVault";
import { FileContent } from "./util/contentEncoding";
import { fitLogger } from "./logger";
import { init as initEncryption } from "./encryption";

type RequestRecord = {
	method: string;
	url: string;
	body: any;
};

const BASE_URL = "https://git.acodev.top";
const OWNER = "azazo1";
const REPO = "mynote";
const BRANCH = "main";

function jsonResponse(status: number, body: unknown = {}, statusText = ""): Response {
	return new Response(JSON.stringify(body), {
		status,
		statusText,
		headers: { "Content-Type": "application/json" },
	});
}

function makeVault() {
	return new RemoteForgejoVault(
		BASE_URL,
		"token",
		OWNER,
		REPO,
		BRANCH,
		"test-device"
	);
}

function installForgejoFetchMock() {
	const requests: RequestRecord[] = [];
	let commitIndex = 1;
	let currentCommit = "commit-1";
	let currentTree = "tree-1";
	let state = new Map<string, string>([
		["notes/a.md", "sha-a"],
	]);
	let blobs = new Map<string, string>([
		["sha-a", "YWxwaGE="],
	]);

	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		requests.push({ method, url, body });
		const apiPath = url.replace(`${BASE_URL}/api/v1`, "");

		if (method === "GET" && apiPath === `/repos/${OWNER}/${REPO}/branches/${BRANCH}`) {
			return jsonResponse(200, {
				commit: {
					id: currentCommit,
					commit: { tree: { sha: currentTree } },
				},
			});
		}

		if (method === "GET" && apiPath === `/repos/${OWNER}/${REPO}/git/trees/${currentTree}?recursive=true`) {
			return jsonResponse(200, {
				sha: currentTree,
				tree: [
					...Array.from(state.entries()).map(([path, sha]) => ({ path, type: "blob", sha })),
					{ path: "notes", type: "tree", sha: "tree-dir" },
					{ path: "submodule", type: "commit", sha: "commit-sub" },
				],
			});
		}

		if (method === "GET" && apiPath.startsWith(`/repos/${OWNER}/${REPO}/git/blobs/`)) {
			const sha = decodeURIComponent(apiPath.split("/").pop() ?? "");
			const content = blobs.get(sha);
			return content
				? jsonResponse(200, { content, encoding: "base64", sha })
				: jsonResponse(404, { message: "blob not found" });
		}

		if ((method === "POST" || method === "PUT") && apiPath.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
			const path = decodeURIComponent(apiPath.replace(`/repos/${OWNER}/${REPO}/contents/`, ""));
			const nextSha = `${path}-sha-${commitIndex + 1}`;
			state.set(path, nextSha);
			blobs.set(nextSha, body.content);
			commitIndex += 1;
			currentCommit = `commit-${commitIndex}`;
			currentTree = `tree-${commitIndex}`;
			return jsonResponse(200, { commit: { sha: currentCommit } });
		}

		if (method === "DELETE" && apiPath.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
			const path = decodeURIComponent(apiPath.replace(`/repos/${OWNER}/${REPO}/contents/`, ""));
			state.delete(path);
			commitIndex += 1;
			currentCommit = `commit-${commitIndex}`;
			currentTree = `tree-${commitIndex}`;
			return jsonResponse(200, { commit: { sha: currentCommit } });
		}

		return jsonResponse(500, { message: `Unhandled ${method} ${apiPath}` });
	});

	vi.stubGlobal("fetch", fetchMock);
	return { requests, fetchMock, state, blobs };
}

describe("RemoteForgejoVault", () => {
	beforeEach(() => {
		vi.spyOn(fitLogger, "log").mockImplementation(() => {});
		initEncryption({ settings: { encryptionPassword: "" } } as any);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("reads tree state and filters non-blob nodes", async () => {
		installForgejoFetchMock();
		const vault = makeVault();

		const result = await vault.readFromSource();

		expect(result).toEqual({
			state: { "notes/a.md": "sha-a" },
			commitSha: "commit-1",
			treeSha: "tree-1",
		});
	});

	it("reads file content from the latest loaded remote state", async () => {
		installForgejoFetchMock();
		const vault = makeVault();

		await vault.readFromSource();
		const content = await vault.readFileContent("notes/a.md");

		expect(content).toEqual(FileContent.fromBase64("YWxwaGE="));
	});

	it("applies added, modified, and deleted files through contents API", async () => {
		const { requests, state, blobs } = installForgejoFetchMock();
		state.set("notes/remove.md", "sha-remove");
		blobs.set("sha-remove", "cmVtb3Zl");
		const vault = makeVault();

		const result = await vault.applyChanges(
			[
				{ path: "notes/a.md", content: FileContent.fromPlainText("updated") },
				{ path: "notes/b.md", content: FileContent.fromPlainText("new") },
			],
			["notes/remove.md"]
		);

		expect(result.changes).toEqual([
			{ path: "notes/a.md", type: "MODIFIED" },
			{ path: "notes/b.md", type: "ADDED" },
			{ path: "notes/remove.md", type: "REMOVED" },
		]);
		expect(result.newState).toEqual({
			"notes/a.md": "notes/a.md-sha-2",
			"notes/b.md": "notes/b.md-sha-3",
		});
		expect(requests.some(r => r.method === "PUT" && r.url.endsWith("/contents/notes/a.md"))).toBe(true);
		expect(requests.some(r => r.method === "POST" && r.url.endsWith("/contents/notes/b.md"))).toBe(true);
		expect(requests.some(r => r.method === "DELETE" && r.url.endsWith("/contents/notes/remove.md"))).toBe(true);
	});

	it("returns current state without writing when there are no changes", async () => {
		const { requests } = installForgejoFetchMock();
		const vault = makeVault();

		const result = await vault.applyChanges([], []);

		expect(result.changes).toEqual([]);
		expect(result.commitSha).toBe("commit-1");
		expect(result.treeSha).toBe("tree-1");
		expect(result.newState).toEqual({ "notes/a.md": "sha-a" });
		expect(requests.every(r => r.method === "GET")).toBe(true);
	});
});
