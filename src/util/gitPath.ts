export function isGitInternalPath(path: string): boolean {
	return path.split("/").some(part => part === ".git");
}
