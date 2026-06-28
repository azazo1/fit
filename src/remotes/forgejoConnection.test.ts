import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { ForgejoConnection, normalizeBaseUrl } from "./forgejoConnection";

function jsonResponse(status: number, body: unknown = {}, text = "") {
	return {
		status,
		json: body,
		text,
		headers: { "Content-Type": "application/json" },
		arrayBuffer: new ArrayBuffer(0),
	};
}

describe("ForgejoConnection", () => {
	const requestUrlMock = vi.mocked(requestUrl);

	beforeEach(() => {
		requestUrlMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("normalizes trailing slash from base URL", () => {
		expect(normalizeBaseUrl(" https://git.acodev.top/// ")).toBe("https://git.acodev.top");
	});

	it("maps authentication failure to VaultError.authentication", async () => {
		requestUrlMock.mockResolvedValueOnce(jsonResponse(401, { message: "bad token" }) as any);
		const connection = new ForgejoConnection("https://git.acodev.top", "token");

		await expect(connection.getAuthenticatedUser()).rejects.toMatchObject({
			name: "VaultError",
			type: "authentication",
			message: "bad token",
		});
	});

	it("maps missing repo list to VaultError.remoteNotFound", async () => {
		requestUrlMock
			.mockResolvedValueOnce(jsonResponse(200, { login: "alice" }) as any)
			.mockResolvedValueOnce(jsonResponse(404, { message: "not found" }) as any);
		const connection = new ForgejoConnection("https://git.acodev.top", "token");

		await expect(connection.getReposForOwner("alice")).rejects.toMatchObject({
			name: "VaultError",
			type: "remote_not_found",
			message: "not found",
		});
	});

	it("maps missing branch list to VaultError.remoteNotFound", async () => {
		requestUrlMock.mockResolvedValueOnce(jsonResponse(404, { message: "repo not found" }) as any);
		const connection = new ForgejoConnection("https://git.acodev.top", "token");

		await expect(connection.getBranches("alice", "missing")).rejects.toMatchObject({
			name: "VaultError",
			type: "remote_not_found",
			message: "repo not found",
		});
	});
});
