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

export async function getAssistantModel(): Promise<string | null> {
  const result = await chrome.storage.local.get("assistantModel");
  return (result.assistantModel as string) ?? null;
}

export async function setAssistantModel(model: string): Promise<void> {
  await chrome.storage.local.set({ assistantModel: model });
}

export async function getAssistantEffort(): Promise<string | null> {
  const result = await chrome.storage.local.get("assistantEffort");
  return (result.assistantEffort as string) ?? null;
}

export async function setAssistantEffort(effort: string): Promise<void> {
  await chrome.storage.local.set({ assistantEffort: effort });
}
