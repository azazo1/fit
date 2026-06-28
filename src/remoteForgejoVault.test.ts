import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
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

function jsonResponse(status: number, body: unknown = {}, text = "") {
	return {
		status,
		json: body,
		text,
		headers: { "Content-Type": "application/json" },
		arrayBuffer: new ArrayBuffer(0),
	};
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
	let hideAlreadyExistsPathFromTree = false;
	let returnShallowRootTree = false;
	let failContentsListing = false;
	let state = new Map<string, string>([
		["notes/a.md", "sha-a"],
	]);
	let blobs = new Map<string, string>([
		["sha-a", "YWxwaGE="],
	]);

	const requestUrlMock = vi.mocked(requestUrl);
	requestUrlMock.mockImplementation((async (request: any) => {
		const url = request.url;
		const method = request.method ?? "GET";
		const body = request.body ? JSON.parse(String(request.body)) : undefined;
		requests.push({ method, url, body });
		const apiPath = url.replace(`${BASE_URL}/api/v1`, "");
		const apiPathWithoutQuery = apiPath.split("?")[0];

		if (method === "GET" && apiPath === `/repos/${OWNER}/${REPO}/branches/${BRANCH}`) {
			return jsonResponse(200, {
				commit: {
					id: currentCommit,
					commit: { tree: { sha: currentTree } },
				},
			});
		}

		if (method === "GET" && apiPath === `/repos/${OWNER}/${REPO}/git/trees/${currentTree}`) {
			if (returnShallowRootTree) {
				return jsonResponse(200, {
					sha: currentTree,
					tree: [
						{ path: "notes", type: "tree", sha: "tree-notes" },
					],
				});
			}
			return jsonResponse(200, {
				sha: currentTree,
				tree: [
					...Array.from(state.entries())
						.filter(([path]) => !(hideAlreadyExistsPathFromTree && path === "notes/race.md"))
						.map(([path, sha]) => ({ path, type: "blob", sha })),
					{ path: "notes", type: "tree", sha: "tree-dir" },
					{ path: "submodule", type: "commit", sha: "commit-sub" },
				],
			});
		}

		if (method === "GET" && apiPath === `/repos/${OWNER}/${REPO}/git/trees/tree-notes`) {
			return jsonResponse(200, {
				sha: "tree-notes",
				tree: [
					{ path: "a.md", type: "blob", sha: "sha-a" },
					{ path: "nested/b.md", type: "blob", sha: "sha-b" },
				],
			});
		}

		if (method === "GET" && apiPathWithoutQuery.startsWith(`/repos/${OWNER}/${REPO}/contents`)) {
			const rawPath = apiPathWithoutQuery.replace(`/repos/${OWNER}/${REPO}/contents`, "").replace(/^\//, "");
			const path = decodeURIComponent(rawPath);
			if (failContentsListing) {
				return jsonResponse(500, { message: "contents unavailable" });
			}
			const sha = state.get(path);
			if (sha && path) {
				return jsonResponse(200, {
					name: path.split("/").pop(),
					path,
					type: "file",
					sha,
				});
			}
			const prefix = path ? `${path}/` : "";
			const children = new Map<string, {name: string; path: string; type: string; sha?: string}>();
			for (const [filePath, fileSha] of state.entries()) {
				if (!filePath.startsWith(prefix)) continue;
				const rest = filePath.slice(prefix.length);
				if (!rest) continue;
				const [name, ...remaining] = rest.split("/");
				const childPath = joinMockPath(prefix, name);
				children.set(childPath, remaining.length === 0
					? { name, path: childPath, type: "file", sha: fileSha }
					: { name, path: childPath, type: "dir" });
			}
			return children.size > 0
				? jsonResponse(200, Array.from(children.values()))
				: jsonResponse(404, { message: "file not found" });
		}

		if (method === "GET" && apiPath.startsWith(`/repos/${OWNER}/${REPO}/git/blobs/`)) {
			const sha = decodeURIComponent(apiPath.split("/").pop() ?? "");
			const content = blobs.get(sha);
			return content
				? jsonResponse(200, { content, encoding: "base64", sha })
				: jsonResponse(404, { message: "blob not found" });
		}

		if (method === "POST" && apiPath === `/repos/${OWNER}/${REPO}/git/blobs`) {
			const sha = `blob-${blobs.size + 1}`;
			blobs.set(sha, body.content);
			return jsonResponse(200, { sha });
		}

		if (method === "POST" && apiPath === `/repos/${OWNER}/${REPO}/git/trees`) {
			for (const node of body.tree ?? []) {
				const path = node.path;
				if (!path) continue;
				if (node.sha === null) {
					state.delete(path);
				} else {
					state.set(path, node.sha);
				}
			}
			commitIndex += 1;
			currentTree = `tree-${commitIndex}`;
			return jsonResponse(200, {
				sha: currentTree,
				tree: body.tree ?? [],
			});
		}

		if (method === "POST" && apiPath === `/repos/${OWNER}/${REPO}/git/commits`) {
			commitIndex += 1;
			currentCommit = `commit-${commitIndex}`;
			return jsonResponse(200, { sha: currentCommit });
		}

		if (method === "PATCH" && apiPath === `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`) {
			currentCommit = body.sha;
			return jsonResponse(200, { object: { sha: currentCommit } });
		}

		return jsonResponse(500, { message: `Unhandled ${method} ${apiPath}` });
	}) as any);

	return {
		requests,
		requestUrlMock,
		state,
		blobs,
		hideAlreadyExistsPathFromTree() {
			hideAlreadyExistsPathFromTree = true;
		},
		returnShallowRootTree() {
			returnShallowRootTree = true;
			state.set("notes/nested/b.md", "sha-b");
			blobs.set("sha-b", "YmV0YQ==");
		},
		failContentsListing() {
			failContentsListing = true;
		},
	};
}

function joinMockPath(prefix: string, name: string): string {
	return prefix ? `${prefix}${name}` : name;
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

	it("reads repository state through tree API", async () => {
		installForgejoFetchMock();
		const vault = makeVault();

		const result = await vault.readFromSource();

		expect(result).toEqual({
			state: { "notes/a.md": "sha-a" },
			commitSha: "commit-1",
			treeSha: "tree-1",
		});
	});

	it("falls back to child tree fetches when contents API is unavailable", async () => {
		const forgejo = installForgejoFetchMock();
		forgejo.returnShallowRootTree();
		forgejo.failContentsListing();
		const vault = makeVault();

		const result = await vault.readFromSource();

		expect(result.state).toEqual({
			"notes/a.md": "sha-a",
			"notes/nested/b.md": "sha-b",
		});
		expect(forgejo.requests.some(r => r.method === "GET" && r.url.endsWith("/git/trees/tree-notes"))).toBe(true);
	});

	it("reads file content from the latest loaded remote state", async () => {
		installForgejoFetchMock();
		const vault = makeVault();

		await vault.readFromSource();
		const content = await vault.readFileContent("notes/a.md");

		expect(content).toEqual(FileContent.fromBase64("YWxwaGE="));
	});

	it("applies added, modified, and deleted files through git commit API", async () => {
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
			"notes/a.md": "blob-3",
			"notes/b.md": "blob-4",
		});
		expect(requests.filter(r => r.method === "POST" && r.url.endsWith("/git/commits"))).toHaveLength(1);
		expect(requests.some(r => r.method === "PATCH" && r.url.endsWith(`/git/refs/heads/${BRANCH}`))).toBe(true);
		expect(requests.some(r => r.method === "POST" && r.url.endsWith("/git/trees"))).toBe(true);
	});

	it("uses custom commit message when provided", async () => {
		const { requests } = installForgejoFetchMock();
		const vault = makeVault();

		await vault.applyChanges(
			[{ path: "notes/manual.md", content: FileContent.fromPlainText("manual") }],
			[],
			{ commitMessage: "Manual vault update" }
		);

		const commitRequest = requests.find(r => r.method === "POST" && r.url.endsWith("/git/commits"));
		expect(commitRequest?.body.message).toBe("Manual vault update");
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
