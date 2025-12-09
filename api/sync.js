// vercel.json
export const config = {
  runtime: "nodejs20.x"
};

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadConfig() {
  const configPath = path.join(__dirname, "../config.json");
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
}

async function fetchWithRetry(url, options, retries = 3) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  } catch (err) {
    if (retries === 0) throw err;
    await new Promise(r => setTimeout(r, 1000));
    return fetchWithRetry(url, options, retries - 1);
  }
}

export default async function handler(req, res) {
  const config = await loadConfig();
  const CHURCHSUITE_DOMAIN = config.churchsuiteDomain;
  const CHURCHSUITE_API_KEY = process.env.CHURCHSUITE_API_KEY;
  const BREVO_API_KEY = process.env.BREVO_API_KEY;

  try {
    if (!CHURCHSUITE_DOMAIN || CHURCHSUITE_DOMAIN === "CHANGE_ME")
      throw new Error("Please update churchsuiteDomain in config.json");

    const contacts = await fetchWithRetry(
      `https://${CHURCHSUITE_DOMAIN}.churchsuite.com/api/v1/addressbook/contacts`,
      { headers: { "X-Auth": CHURCHSUITE_API_KEY } }
    );

    res.status(200).json({ ok: true, contacts: contacts.results.length });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
