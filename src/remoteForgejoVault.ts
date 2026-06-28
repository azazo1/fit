import { LocalStores } from "@/localStores";
import { ApplyChangesResult, IRemoteVault, VaultError, VaultReadResult } from "./vault";
import { FileChange, FileStates } from "./util/changeTracking";
import { BlobSha, CommitSha, EMPTY_TREE_SHA, TreeSha } from "./util/hashing";
import { FileContent } from "./util/contentEncoding";
import { fitLogger } from "./logger";
import { detectNormalizationIssues } from "./util/filePath";
import { withSlowOperationMonitoring } from "./util/asyncMonitoring";
import * as Encryption from "./encryption";
import { normalizeBaseUrl } from "./remotes/forgejoConnection";
import { forgejoRequest } from "./remotes/forgejoHttp";

type ForgejoTreeNode = {
	path?: string;
	type?: string;
	sha?: string;
};

type ForgejoBranchResponse = {
	commit?: {
		id?: string;
		sha?: string;
		commit?: {
			tree?: {
				sha?: string;
			};
		};
	};
};

type ForgejoCommitResponse = {
	tree?: {
		sha?: string;
	};
	commit?: {
		tree?: {
			sha?: string;
		};
	};
};

type ForgejoTreeResponse = {
	sha?: string;
	tree?: ForgejoTreeNode[];
};

type ForgejoBlobResponse = {
	content?: string;
	encoding?: string;
	sha?: string;
};

type ForgejoFileChangeResponse = {
	commit?: {
		sha?: string;
		id?: string;
	};
};

type ForgejoContentsItem = {
	name?: string;
	path?: string;
	sha?: string;
	type?: string;
};

type ForgejoContentsResponse = ForgejoContentsItem | ForgejoContentsItem[];

export class RemoteForgejoVault implements IRemoteVault {
	private baseUrl: string;
	private token: string;
	private owner: string;
	private repo: string;
	private branch: string;
	private deviceName: string;

	private latestKnownCommitSha: CommitSha | null = null;
	private latestKnownTreeSha: TreeSha | null = null;
	private latestKnownState: FileStates | null = null;

	constructor(
		baseUrl: string,
		token: string,
		owner: string,
		repo: string,
		branch: string,
		deviceName: string
	) {
		this.baseUrl = normalizeBaseUrl(baseUrl);
		this.token = token;
		this.owner = owner;
		this.repo = repo;
		this.branch = branch;
		this.deviceName = deviceName;
	}

	getOwner(): string {
		return this.owner;
	}

	getRepo(): string {
		return this.repo;
	}

	getBranch(): string {
		return this.branch;
	}

	async readFromSource(ignoreCache: boolean = false): Promise<VaultReadResult<"remote">> {
		const { commitSha, treeSha } = await this.getLatestCommitAndTreeSha();

		if (!ignoreCache && commitSha === this.latestKnownCommitSha && this.latestKnownState !== null) {
			fitLogger.log(`... [RemoteVault] Using cached Forgejo state (${commitSha.slice(0, 7)})`);
			return { state: { ...this.latestKnownState }, commitSha, treeSha };
		}

		const newState = await withSlowOperationMonitoring(
			this.buildStateFromTree(treeSha),
			"Remote vault tree fetch from Forgejo",
			{ warnAfterMs: 10000 }
		);

		this.latestKnownCommitSha = commitSha;
		this.latestKnownTreeSha = treeSha;
		this.latestKnownState = newState;

		const normalizationInfo = detectNormalizationIssues(Object.keys(newState), "remote (Forgejo)");
		fitLogger.log(
			`... [RemoteVault] Fetched ${Object.keys(newState).length} files from Forgejo`,
			normalizationInfo ? { nfdPaths: normalizationInfo.nfdCount } : undefined
		);

		return { state: { ...newState }, commitSha, treeSha };
	}

	async readFileContent(path: string): Promise<FileContent> {
		if (this.latestKnownState === null) {
			throw new Error(
				`Remote repository state not yet loaded. Cannot read file '${path}'. ` +
				"Sync operation should call readFromSource() first."
			);
		}

		const blobSha = this.latestKnownState[path];
		if (!blobSha) {
			throw new Error(
				`File '${path}' does not exist in remote repository ` +
				`(commit ${this.latestKnownCommitSha || "unknown"} on ${this.owner}/${this.repo}).`
			);
		}

		const blob = await this.request<ForgejoBlobResponse>(
			"GET",
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs/${blobSha}`
		);
		if (typeof blob.content !== "string") {
			throw new Error(
				`Cannot read '${path}': blob content is ${typeof blob.content} (encoding: '${blob.encoding ?? "unknown"}'). ` +
				"Forgejo may not support this blob format."
			);
		}

		let content = blob.content;
		if (Encryption.isEnabled()) {
			content = await Encryption.decryptContent(content);
		}
		return FileContent.fromBase64(content);
	}

	async applyChanges(
		filesToWrite: Array<{path: string, content: FileContent}>,
		filesToDelete: Array<string>,
		_options?: { clashPaths?: Set<string> }
	): Promise<ApplyChangesResult<"remote">> {
		const { state: currentState, commitSha: parentCommitSha, treeSha: parentTreeSha } = await this.readFromSource();
		const changes: FileChange[] = [];
		let latestCommitSha = parentCommitSha;

		for (const { path, content } of filesToWrite) {
			const remotePath = await this.toRemotePath(path);
			const fileContent = await this.toRemoteContent(content);
			const existed = currentState[path] !== undefined;
			const contentPath = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodePath(remotePath)}`;
			const response = await this.writeContent(path, contentPath, fileContent, currentState[path]);
			latestCommitSha = this.extractCommitSha(response) ?? latestCommitSha;
			changes.push({ path, type: existed ? "MODIFIED" : "ADDED" });
		}

		for (const path of filesToDelete) {
			if (!(path in currentState)) {
				continue;
			}
			const remotePath = await this.toRemotePath(path);
			const response = await this.request<ForgejoFileChangeResponse>(
				"DELETE",
				`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodePath(remotePath)}`,
				{
					branch: this.branch,
					message: this.commitMessage(),
					sha: currentState[path],
				}
			);
			latestCommitSha = this.extractCommitSha(response) ?? latestCommitSha;
			changes.push({ path, type: "REMOVED" });
		}

		if (changes.length === 0) {
			return {
				changes: [],
				commitSha: parentCommitSha,
				treeSha: parentTreeSha,
				newState: currentState,
			};
		}

		const fresh = await this.readFromSource(true);
		return {
			changes,
			commitSha: fresh.commitSha ?? latestCommitSha,
			treeSha: fresh.treeSha,
			newState: fresh.state,
		};
	}

	async clear(): Promise<LocalStores | null> {
		const { state, treeSha } = await this.readFromSource(true);
		if (treeSha === EMPTY_TREE_SHA || Object.keys(state).length === 0) return null;
		await this.applyChanges([], Object.keys(state));
		const fresh = await this.readFromSource(true);
		return {
			localShas: {},
			lastFetchedCommitSha: fresh.commitSha,
			lastFetchedRemoteShas: {},
		};
	}

	shouldTrackState(_path: string): boolean {
		return true;
	}

	private async getLatestCommitAndTreeSha(): Promise<{ commitSha: CommitSha; treeSha: TreeSha }> {
		const branch = await this.request<ForgejoBranchResponse>(
			"GET",
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/branches/${encodeURIComponent(this.branch)}`
		);
		const commitSha = branch.commit?.id ?? branch.commit?.sha;
		if (!commitSha) {
			throw VaultError.network(`Forgejo branch '${this.branch}' response did not include commit metadata`);
		}
		let treeSha = branch.commit?.commit?.tree?.sha;
		if (!treeSha) {
			const commit = await this.request<ForgejoCommitResponse>(
				"GET",
				`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits/${commitSha}`
			);
			treeSha = commit.tree?.sha ?? commit.commit?.tree?.sha;
		}
		if (!treeSha) {
			throw VaultError.network(`Forgejo commit '${commitSha}' response did not include tree metadata`);
		}
		return {
			commitSha: commitSha as CommitSha,
			treeSha: treeSha as TreeSha,
		};
	}

	private async buildStateFromTree(treeSha: TreeSha): Promise<FileStates> {
		try {
			return await this.buildStateFromGitTree(treeSha);
		} catch (error) {
			if (treeSha === EMPTY_TREE_SHA) throw error;
			fitLogger.log("[RemoteVault] Forgejo tree listing failed, falling back to contents API", error);
			return await this.buildStateFromContents();
		}
	}

	private async buildStateFromContents(): Promise<FileStates> {
		const nodes = await this.fetchContentNodes();
		return await this.buildStateFromNodes(nodes, "file");
	}

	private async buildStateFromGitTree(treeSha: TreeSha): Promise<FileStates> {
		const nodes = treeSha === EMPTY_TREE_SHA
			? [] as ForgejoTreeNode[]
			: await this.fetchTreeNodes(treeSha);

		fitLogger.log("[RemoteVault] Forgejo tree listing complete", {
			nodes: nodes.length,
			files: nodes.filter(node => node.type === "blob").length,
		});

		return await this.buildStateFromNodes(nodes, "blob");
	}

	private async buildStateFromNodes(nodes: ForgejoTreeNode[], fileType: "blob" | "file"): Promise<FileStates> {
		const state: FileStates = {};
		const failedPaths: Array<{path: string, error: unknown}> = [];

		for (const node of nodes) {
			if (node.type !== fileType || !node.path || !node.sha) {
				continue;
			}
			let path = node.path;
			try {
				if (Encryption.isEnabled()) {
					path = await Encryption.decryptPath(path);
				}
				state[path] = node.sha as BlobSha;
			} catch (error) {
				if (error instanceof ReferenceError) throw error;
				failedPaths.push({ path, error });
			}
		}

		if (failedPaths.length > 0) {
			throw new VaultError(
				"network",
				`Failed to process ${failedPaths.length} file(s) from remote vault: ${failedPaths.map(f => f.path).join(", ")}`,
				{
					originalError: failedPaths[0].error,
					failedPaths: failedPaths.map(f => f.path),
					errors: failedPaths.map(f => ({ path: f.path, error: f.error })),
				}
			);
		}

		return state;
	}

	private async fetchContentNodes(
		path: string = "",
		seen: Set<string> = new Set()
	): Promise<ForgejoTreeNode[]> {
		if (seen.has(path)) return [];
		seen.add(path);

		const response = await this.request<ForgejoContentsResponse>(
			"GET",
			this.contentsPath(path)
		);
		const items = (Array.isArray(response) ? response : [response])
			.map(item => ({
				...item,
				path: item.path ?? (item.name ? joinTreePath(path, item.name) : undefined),
			}));
		const nodes: ForgejoTreeNode[] = [];

		for (const item of items) {
			if (item.type === "dir" && item.path) {
				nodes.push(...await this.fetchContentNodes(item.path, seen));
				continue;
			}
			nodes.push(item);
		}

		return nodes;
	}

	private async fetchTreeNodes(
		treeSha: TreeSha,
		prefix: string = "",
		seen: Set<string> = new Set()
	): Promise<ForgejoTreeNode[]> {
		const seenKey = `${prefix}:${treeSha}`;
		if (seen.has(seenKey)) return [];
		seen.add(seenKey);

		const tree = await this.request<ForgejoTreeResponse>(
			"GET",
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees/${treeSha}`
		);
		const nodes = (tree.tree ?? []).map(node => ({
			...node,
			path: node.path ? joinTreePath(prefix, node.path) : node.path,
		}));
		const childNodeGroups = await mapWithConcurrency(
			nodes.filter(node => node.type === "tree" && node.path && node.sha),
			8,
			node => this.fetchTreeNodes(node.sha as TreeSha, node.path as string, seen)
		);

		return [...nodes, ...childNodeGroups.flat()];
	}

	private async toRemotePath(path: string): Promise<string> {
		return Encryption.isEnabled() ? await Encryption.encryptPath(path) : path;
	}

	private async toRemoteContent(content: FileContent): Promise<string> {
		const base64 = content.toBase64();
		return Encryption.isEnabled() ? await Encryption.encryptContent(base64) : base64;
	}

	private commitMessage(): string {
		return `Commit from ${this.deviceName} on ${new Date().toLocaleString()}`;
	}

	private extractCommitSha(response: ForgejoFileChangeResponse): CommitSha | null {
		const sha = response.commit?.sha ?? response.commit?.id;
		return sha ? sha as CommitSha : null;
	}

	private async writeContent(
		path: string,
		contentPath: string,
		fileContent: string,
		knownSha?: string
	): Promise<ForgejoFileChangeResponse> {
		try {
			return await this.request<ForgejoFileChangeResponse>(
				knownSha ? "PUT" : "POST",
				contentPath,
				{
					branch: this.branch,
					content: fileContent,
					message: this.commitMessage(),
					...(knownSha && { sha: knownSha }),
				}
			);
		} catch (error) {
			if (!isForgejoFileExistsError(error) || knownSha) {
				throw error;
			}

			const freshSha = await this.readExistingContentSha(contentPath) ??
				(await this.readFromSource(true)).state[path];
			if (!freshSha) {
				throw error;
			}

			return await this.request<ForgejoFileChangeResponse>(
				"PUT",
				contentPath,
				{
					branch: this.branch,
					content: fileContent,
					message: this.commitMessage(),
					sha: freshSha,
				}
			);
		}
	}

	private async readExistingContentSha(contentPath: string): Promise<string | null> {
		try {
			const response = await this.request<ForgejoContentsResponse>("GET", this.withBranchRef(contentPath));
			if (Array.isArray(response)) {
				return null;
			}
			if (response.type && response.type !== "file") {
				return null;
			}
			return response.sha ?? null;
		} catch {
			return null;
		}
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		return forgejoRequest<T>(
			this.baseUrl,
			this.token,
			method,
			path,
			body,
			`Repository '${this.owner}/${this.repo}' or branch '${this.branch}' not found`
		);
	}

	private contentsPath(path: string): string {
		const encodedPath = path ? `/${encodePath(path)}` : "/";
		return this.withBranchRef(
			`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents${encodedPath}`
		);
	}

	private withBranchRef(path: string): string {
		const separator = path.includes("?") ? "&" : "?";
		return `${path}${separator}ref=${encodeURIComponent(this.branch)}`;
	}
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function joinTreePath(prefix: string, path: string): string {
	if (!prefix) return path;
	if (path.startsWith(`${prefix}/`)) return path;
	return `${prefix}/${path}`;
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	mapper: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = [];
	let nextIndex = 0;
	const workerCount = Math.min(limit, items.length);
	await Promise.all(Array.from({ length: workerCount }, async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await mapper(items[index]);
		}
	}));
	return results;
}

function isForgejoFileExistsError(error: unknown): boolean {
	return error instanceof VaultError &&
		error.type === "network" &&
		/repository file already exists|file already exists/i.test(error.message);
}
