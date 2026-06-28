import { VaultError } from "../vault";

export interface ForgejoUser {
	owner: string;
	avatarUrl: string;
}

export class ForgejoConnection {
	private baseUrl: string;
	private token: string;

	constructor(baseUrl: string, token: string) {
		this.baseUrl = normalizeBaseUrl(baseUrl);
		this.token = token;
	}

	get isConfigured(): boolean {
		return this.baseUrl.length > 0 && this.token.length > 0;
	}

	async getAuthenticatedUser(): Promise<ForgejoUser> {
		const data = await this.request<{ login: string; avatar_url?: string }>("GET", "/user");
		return {
			owner: data.login,
			avatarUrl: data.avatar_url ?? "",
		};
	}

	async getAccessibleOwners(): Promise<string[]> {
		const authUser = await this.getAuthenticatedUser();
		const owners = new Set<string>([authUser.owner]);
		const orgs = await this.request<Array<{ username?: string; name?: string; full_name?: string }>>("GET", "/user/orgs");
		for (const org of orgs) {
			const owner = org.username ?? org.name ?? org.full_name;
			if (owner) owners.add(owner);
		}
		return Array.from(owners).sort();
	}

	async getReposForOwner(owner: string): Promise<string[]> {
		const authUser = await this.getAuthenticatedUser();
		const endpoint = owner === authUser.owner
			? "/user/repos"
			: `/orgs/${encodeURIComponent(owner)}/repos`;
		try {
			const repos = await this.request<Array<{ name: string }>>("GET", endpoint);
			return repos.map(repo => repo.name).sort();
		} catch (error) {
			if (owner !== authUser.owner) {
				const repos = await this.request<Array<{ name: string; owner?: { login?: string; username?: string } }>>("GET", "/user/repos");
				return repos
					.filter(repo => (repo.owner?.login ?? repo.owner?.username) === owner)
					.map(repo => repo.name)
					.sort();
			}
			throw error;
		}
	}

	async getBranches(owner: string, repo: string): Promise<string[]> {
		const branches = await this.request<Array<{ name: string }>>(
			"GET",
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`
		);
		return branches.map(branch => branch.name);
	}

	private async request<T>(method: string, path: string): Promise<T> {
		try {
			const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
				method,
				headers: {
					"Accept": "application/json",
					"Authorization": `token ${this.token}`,
				},
			});

			if (!response.ok) {
				await this.throwResponseError(response);
			}

			return await response.json() as T;
		} catch (error) {
			if (error instanceof VaultError) throw error;
			throw VaultError.network(
				error instanceof Error ? error.message : "Couldn't reach Forgejo API",
				{ originalError: error }
			);
		}
	}

	private async throwResponseError(response: Response): Promise<never> {
		const message = await readErrorMessage(response);
		if (response.status === 401 || response.status === 403) {
			throw VaultError.authentication(message || "Authentication failed. Check your Forgejo token.");
		}
		if (response.status === 404) {
			throw VaultError.remoteNotFound(message || "Forgejo resource not found");
		}
		throw VaultError.network(message || `Forgejo API request failed with status ${response.status}`);
	}
}

export function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

async function readErrorMessage(response: Response): Promise<string> {
	try {
		const data = await response.json() as { message?: string };
		return data.message ?? response.statusText;
	} catch {
		return response.statusText;
	}
}
