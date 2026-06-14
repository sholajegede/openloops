// Persist and retrieve the user's Anthropic API key.
// Stored in chrome.storage.local so it never leaves the device.

export async function getApiKey(): Promise<string | null> {
  const result = await chrome.storage.local.get("anthropicApiKey");
  return (result.anthropicApiKey as string) ?? null;
}

export async function setApiKey(key: string): Promise<void> {
  await chrome.storage.local.set({ anthropicApiKey: key });
}
