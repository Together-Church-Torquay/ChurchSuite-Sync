import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadConfig() {
  try {
    // Try multiple possible paths for config.json
    const possiblePaths = [
      path.join(__dirname, "../config.json"),
      path.join(process.cwd(), "config.json"),
      "./config.json"
    ];
    
    for (const configPath of possiblePaths) {
      try {
        const raw = await fs.readFile(configPath, "utf8");
        return JSON.parse(raw);
      } catch (e) {
        // Try next path
        continue;
      }
    }
    throw new Error("config.json not found in any expected location");
  } catch (err) {
    throw new Error(`Failed to load config: ${err.message}`);
  }
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
  try {
    // Try to load config, but fall back to environment variables
    let config;
    let CHURCHSUITE_DOMAIN;
    
    try {
      config = await loadConfig();
      CHURCHSUITE_DOMAIN = config.churchsuiteDomain;
    } catch (configError) {
      // If config file can't be loaded, use environment variable
      CHURCHSUITE_DOMAIN = process.env.CHURCHSUITE_DOMAIN;
      console.error("Config file error:", configError.message);
    }

    const CHURCHSUITE_API_KEY = process.env.CHURCHSUITE_API_KEY;
    const BREVO_API_KEY = process.env.BREVO_API_KEY;

    if (!CHURCHSUITE_DOMAIN || CHURCHSUITE_DOMAIN === "CHANGE_ME") {
      return res.status(500).json({ 
        ok: false, 
        error: "CHURCHSUITE_DOMAIN not configured. Set CHURCHSUITE_DOMAIN environment variable or ensure config.json is accessible." 
      });
    }

    if (!CHURCHSUITE_API_KEY) {
      return res.status(500).json({ 
        ok: false, 
        error: "CHURCHSUITE_API_KEY environment variable is not set" 
      });
    }

    const contacts = await fetchWithRetry(
      `https://${CHURCHSUITE_DOMAIN}/api/v1/addressbook/contacts`,
      { headers: { "X-Auth": CHURCHSUITE_API_KEY } }
    );

    res.status(200).json({ ok: true, contacts: contacts.results.length });

  } catch (err) {
    console.error("Handler error:", err);
    res.status(500).json({ 
      ok: false, 
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}
