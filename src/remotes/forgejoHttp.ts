import { requestUrl, type RequestUrlResponse } from "obsidian";
import { VaultError } from "../vault";

export async function forgejoRequest<T>(
	baseUrl: string,
	token: string,
	method: string,
	path: string,
	body?: unknown,
	notFoundMessage = "Forgejo resource not found"
): Promise<T> {
	try {
		const response = await requestUrl({
			url: `${baseUrl}/api/v1${path}`,
			method,
			headers: {
				"Accept": "application/json",
				"Authorization": `token ${token}`,
			},
			...(body !== undefined && {
				contentType: "application/json",
				body: JSON.stringify(body),
			}),
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			throwResponseError(response, notFoundMessage);
		}

		return response.json as T;
	} catch (error) {
		if (error instanceof VaultError) throw error;
		throw VaultError.network(
			error instanceof Error ? error.message : "Couldn't reach Forgejo API",
			{ originalError: error }
		);
	}
}

function throwResponseError(response: RequestUrlResponse, notFoundMessage: string): never {
	const message = readErrorMessage(response);
	if (response.status === 401 || response.status === 403) {
		throw VaultError.authentication(message || "Authentication failed. Check your Forgejo token.");
	}
	if (response.status === 404) {
		throw VaultError.remoteNotFound(message || notFoundMessage);
	}
	throw VaultError.network(message || `Forgejo API request failed with status ${response.status}`);
}

function readErrorMessage(response: RequestUrlResponse): string {
	const json = response.json as { message?: string } | undefined;
	return json?.message ?? response.text ?? "";
}
