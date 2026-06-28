import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgejoConnection, normalizeBaseUrl } from "./forgejoConnection";

function jsonResponse(status: number, body: unknown = {}, statusText = ""): Response {
	return new Response(JSON.stringify(body), {
		status,
		statusText,
		headers: { "Content-Type": "application/json" },
	});
}

describe("ForgejoConnection", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("normalizes trailing slash from base URL", () => {
		expect(normalizeBaseUrl(" https://git.acodev.top/// ")).toBe("https://git.acodev.top");
	});

	it("maps authentication failure to VaultError.authentication", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: "bad token" }));
		const connection = new ForgejoConnection("https://git.acodev.top", "token");

		await expect(connection.getAuthenticatedUser()).rejects.toMatchObject({
			name: "VaultError",
			type: "authentication",
			message: "bad token",
		});
	});

	it("maps missing repo list to VaultError.remoteNotFound", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse(200, { login: "alice" }))
			.mockResolvedValueOnce(jsonResponse(404, { message: "not found" }));
		const connection = new ForgejoConnection("https://git.acodev.top", "token");

		await expect(connection.getReposForOwner("alice")).rejects.toMatchObject({
			name: "VaultError",
			type: "remote_not_found",
			message: "not found",
		});
	});

	it("maps missing branch list to VaultError.remoteNotFound", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: "repo not found" }));
		const connection = new ForgejoConnection("https://git.acodev.top", "token");

		await expect(connection.getBranches("alice", "missing")).rejects.toMatchObject({
			name: "VaultError",
			type: "remote_not_found",
			message: "repo not found",
		});
	});
});
