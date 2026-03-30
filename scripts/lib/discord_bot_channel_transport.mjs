const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

function joinUrl(baseUrl, pathname) {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${pathname}`;
}

async function expectSuccess(response, operation) {
  if (response.ok) return response;
  let body = null;
  try {
    body = await response.text();
  } catch {
    body = null;
  }
  throw new Error(`${operation} failed with ${response.status}${body ? `: ${body}` : ""}`);
}

export class DiscordBotChannelTransport {
  constructor({
    apiBaseUrl = DISCORD_API_BASE_URL,
    token,
    fetchImpl = fetch,
  } = {}) {
    if (!token) throw new Error("Discord bot token is required for channel transport");
    this.apiBaseUrl = apiBaseUrl;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async createChannelMessage({
    channelId,
    content,
    components = null,
    messageReference = null,
    allowedMentions = { parse: [] },
  }) {
    if (!channelId) throw new Error("channelId is required");
    const url = joinUrl(this.apiBaseUrl, `/channels/${channelId}/messages`);
    const body = {
      content,
      allowed_mentions: allowedMentions,
    };
    if (components?.length) {
      body.components = components;
    }
    if (messageReference?.message_id) {
      body.message_reference = {
        message_id: messageReference.message_id,
        channel_id: messageReference.channel_id ?? channelId,
        guild_id: messageReference.guild_id ?? null,
        fail_if_not_exists: false,
      };
    }
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bot ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    await expectSuccess(response, "create channel message");
    return await response.json().catch(() => null);
  }
}
