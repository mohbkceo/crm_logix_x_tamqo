import axios from "axios";
import { AppError, assert } from "../../errors.js";
import { sanitizeProviderData } from "./deliveryMapper.js";
export class DeliveryClient {
  constructor(options = {}) {
    this.credentials = options.credentials || {
      token: process.env.DELIVERY_API_TOKEN,
      key: process.env.DELIVERY_API_KEY,
    };
    this.http = axios.create({
      baseURL:
        options.baseUrl ||
        process.env.DELIVERY_API_BASE_URL ||
        "https://procolis.com/api_v1",
      timeout: Number(process.env.DELIVERY_TIMEOUT_MS || 15000),
      maxRedirects: 0,
      maxContentLength: 2 * 1024 * 1024,
    });
  }
  ensureConfigured() {
    assert(
      this.credentials.token && this.credentials.key,
      "Delivery credentials are not configured on the server.",
      503,
      "DELIVERY_NOT_CONFIGURED",
    );
  }
  async request(method, url, data) {
    this.ensureConfigured();
    try {
      const response = await this.http.request({
        method,
        url,
        data,
        headers: {
          "Content-Type": "application/json",
          token: this.credentials.token,
          key: this.credentials.key,
        },
      });
      const body = this.sanitize(response.data);
      this.lastResponseStatus = response.status;
      this.lastResponse = this.sanitize({
        status: response.status,
        statusText: response.statusText,
        body,
      });
      return body;
    } catch (error) {
      const diagnostics = this.sanitize({
        endpoint: url,
        status: error.response?.status,
        statusText: error.response?.statusText,
        body: error.response?.data,
      });
      const body = diagnostics.body;
      const detail =
        typeof body === "string"
          ? body
          : [
              body?.Colis?.[0]?.MessageRetour,
              body?.Statut,
              body?.message,
              body?.Message,
              body?.error?.message,
              body?.error,
              body?.Error,
            ].find((v) => typeof v === "string");
      const failure = new AppError(
        error.code === "ECONNABORTED"
          ? "Courier request timed out; verify the parcel before retrying."
          : `Courier request failed${diagnostics.status ? ` (HTTP ${diagnostics.status})` : ""}${detail ? `: ${detail.slice(0, 1000)}` : "."} Verify the parcel before retrying.`,
        502,
        "DELIVERY_ERROR",
      );
      failure.providerData = diagnostics;
      throw failure;
    }
  }
  sanitize(value) {
    return sanitizeProviderData(value, 0, Object.values(this.credentials));
  }
  async testCredentials() {
    const response = await this.request("GET", "/token");
    return response?.Statut === "Acc\u00e8s activ\u00e9";
  }
  createPackages(payload) {
    return this.request("POST", "/add_colis", payload);
  }
  readPackages(trackings) {
    return this.request("POST", "/lire", {
      Colis: trackings.map((Tracking) => ({ Tracking })),
    });
  }
  readyPackages(trackings) {
    return this.request("POST", "/pret", {
      Colis: trackings.map((Tracking) => ({ Tracking })),
    });
  }
  async getPricing() {
    const rows = await this.request("POST", "/tarification");
    assert(Array.isArray(rows), "Unexpected Procolis pricing response", 502);
    return rows;
  }
}
export const deliveryClient = new DeliveryClient();
