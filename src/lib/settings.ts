// Persist and retrieve API keys in chrome.storage.local so they never leave the device.

export async function getApiKey(): Promise<string | null> {
  const result = await chrome.storage.local.get("anthropicApiKey");
  return (result.anthropicApiKey as string) ?? null;
}

export async function setApiKey(key: string): Promise<void> {
  await chrome.storage.local.set({ anthropicApiKey: key });
}

export async function getContextKey(): Promise<string | null> {
  const result = await chrome.storage.local.get("contextDevApiKey");
  return (result.contextDevApiKey as string) ?? null;
}

export async function setContextKey(key: string): Promise<void> {
  await chrome.storage.local.set({ contextDevApiKey: key });
}
