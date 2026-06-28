import { describe, expect, it } from "vitest";
import { Vault } from "obsidian";
import { Fit } from "./fit";
import { DEFAULT_SETTINGS, type FitSettings } from "./fitSettings";
import { RemoteGitHubVault } from "./remoteGitHubVault";
import { RemoteForgejoVault } from "./remoteForgejoVault";
import type { LocalStores } from "./localStores";

function makeLocalStore(): LocalStores {
	return {
		localShas: {},
		lastFetchedRemoteShas: {},
		lastFetchedCommitSha: null,
		unpushedFiles: {},
		pendingClashes: [],
	};
}

function makeSettings(overrides: Partial<FitSettings>): FitSettings {
	return {
		...DEFAULT_SETTINGS,
		pat: "github-token",
		forgejoBaseUrl: "https://git.acodev.top",
		forgejoToken: "forgejo-token",
		owner: "azazo1",
		repo: "mynote",
		branch: "main",
		deviceName: "test-device",
		...overrides,
	};
}

describe("Fit remote provider settings", () => {
	it("creates a GitHub remote vault by default", () => {
		const fit = new Fit(
			makeSettings({ remoteProvider: "github" }),
			makeLocalStore(),
			{} as unknown as Vault
		);

		expect(fit.remoteVault).toBeInstanceOf(RemoteGitHubVault);
		expect(fit.remoteVault.getOwner()).toBe("azazo1");
		expect(fit.remoteVault.getRepo()).toBe("mynote");
		expect(fit.remoteVault.getBranch()).toBe("main");
	});

	it("creates a Forgejo remote vault when selected", () => {
		const fit = new Fit(
			makeSettings({ remoteProvider: "forgejo" }),
			makeLocalStore(),
			{} as unknown as Vault
		);

		expect(fit.remoteVault).toBeInstanceOf(RemoteForgejoVault);
		expect(fit.remoteVault.getOwner()).toBe("azazo1");
		expect(fit.remoteVault.getRepo()).toBe("mynote");
		expect(fit.remoteVault.getBranch()).toBe("main");
	});
});
