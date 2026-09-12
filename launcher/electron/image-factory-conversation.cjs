const CHATGPT_ORIGIN = "https://chatgpt.com";

function verifiedImageFactoryConversationUrl(value, projectId) {
  if (typeof value !== "string" || typeof projectId !== "string") return null;
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId || !/^[A-Za-z0-9_-]{3,160}$/.test(normalizedProjectId)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== CHATGPT_ORIGIN || url.username || url.password || url.hash) return null;
  const prefix = `/g/${normalizedProjectId}`;
  if (!url.pathname.startsWith(prefix)) return null;
  const suffix = url.pathname.slice(prefix.length);
  if (!/^(?:-[A-Za-z0-9_-]{1,160})?\/c\/[A-Za-z0-9:_-]{8,160}\/?$/.test(suffix)) return null;
  return url.href;
}

module.exports = { verifiedImageFactoryConversationUrl };
