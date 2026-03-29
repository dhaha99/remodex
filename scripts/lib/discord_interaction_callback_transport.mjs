const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const EPHEMERAL_FLAG = 1 << 6;

function joinUrl(baseUrl, pathname, search = "") {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${pathname}${search}`;
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

export class DiscordInteractionCallbackTransport {
  constructor({
    apiBaseUrl = DISCORD_API_BASE_URL,
    fetchImpl = fetch,
  } = {}) {
    this.apiBaseUrl = apiBaseUrl;
    this.fetchImpl = fetchImpl;
  }

  async createInteractionResponse(interaction, responseBody, { withResponse = false } = {}) {
    const query = withResponse ? "?with_response=true" : "";
    const url = joinUrl(
      this.apiBaseUrl,
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      query,
    );
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(responseBody),
    });
    await expectSuccess(response, "create interaction response");
    return response;
  }

  async deferChannelMessage(interaction, { ephemeral = true } = {}) {
    const body = {
      type: 5,
      data: ephemeral ? { flags: EPHEMERAL_FLAG } : {},
    };
    return await this.createInteractionResponse(interaction, body);
  }

  async respondAutocomplete(interaction, choices) {
    const body = {
      type: 8,
      data: {
        choices,
      },
    };
    return await this.createInteractionResponse(interaction, body);
  }

  async updateMessage(interaction, messageBody) {
    return await this.createInteractionResponse(interaction, {
      type: 7,
      data: messageBody,
    });
  }

  async deferUpdateMessage(interaction) {
    return await this.createInteractionResponse(interaction, {
      type: 6,
    });
  }

  async openModal(interaction, modalBody) {
    return await this.createInteractionResponse(interaction, {
      type: 9,
      data: modalBody,
    });
  }

  async editOriginalResponse(interaction, messageBody) {
    const url = joinUrl(
      this.apiBaseUrl,
      `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    );
    const response = await this.fetchImpl(url, {
      method: "PATCH",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(messageBody),
    });
    await expectSuccess(response, "edit original response");
    return response;
  }
}

export { EPHEMERAL_FLAG };
