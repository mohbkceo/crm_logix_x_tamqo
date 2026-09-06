import axios from "axios";
import { AppError, assert } from "../../errors.js";
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
      return (
        await this.http.request({
          method,
          url,
          data,
          headers: {
            token: this.credentials.token,
            key: this.credentials.key,
          },
        })
      ).data;
    } catch (error) {
      throw new AppError(
        error.code === "ECONNABORTED"
          ? "Courier request timed out; verify the parcel before retrying."
          : `Courier request failed${error.response?.status ? ` (HTTP ${error.response.status})` : ""}. Verify the parcel before retrying.`,
        502,
        "DELIVERY_ERROR",
      );
    }
  }
  testCredentials() {
    return this.request("GET", "/token");
  }
  createPackages(payload) {
    return this.request("POST", "/add_colis", payload);
  }
  readPackages(trackings) {
    return this.request("POST", "/lire", {
      Package: trackings.map((Tracking) => ({ Tracking })),
    });
  }
  readyPackages(trackings) {
    return this.request("POST", "/pret", {
      Package: trackings.map((Tracking) => ({ Tracking })),
    });
  }
  getPricing() {
    return this.request("POST", "/tarification");
  }
  getLatestUpdatedPackages() {
    // Supplied HTML labels GET /tarification as updates, but POST /tarification as pricing.
    // No alternate endpoint is assumed. Enable only after confirmation from ABEX.
    const path = process.env.DELIVERY_LATEST_PATH,
      method = process.env.DELIVERY_LATEST_METHOD || "GET";
    assert(
      path &&
        /^\/[a-z0-9_/-]+$/i.test(path) &&
        ["GET", "POST"].includes(method),
      "Latest-updates endpoint is unverified; configure it after provider confirmation.",
      503,
    );
    return this.request(method, path);
  }
}
export const deliveryClient = new DeliveryClient();
