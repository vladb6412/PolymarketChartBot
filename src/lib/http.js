import { config } from "../config.js";

export async function fetchJson(url, { signal } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  if (signal) {
    signal.addEventListener(
      "abort",
      () => controller.abort(signal.reason),
      { once: true }
    );
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}: ${url}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
