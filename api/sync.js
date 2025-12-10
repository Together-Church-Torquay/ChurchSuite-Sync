import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

export const config = {
  runtime: "nodejs20.x"
};

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

function normalizeChurchSuiteDomain(domain) {
  if (!domain) return domain;
  // If domain already includes .churchsuite.com, return as is
  if (domain.includes('.churchsuite.com')) {
    return domain;
  }
  // Otherwise, append .churchsuite.com
  return `${domain}.churchsuite.com`;
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

function mapContactToBrevo(contact) {
  const email =
    contact?.email ||
    contact?.email_address ||
    contact?.emailAddress ||
    contact?.emails?.find?.(e => e.is_default)?.address ||
    contact?.emails?.[0]?.address;

  if (!email) return null;

  const attributes = {
    FIRSTNAME: contact.first_name || contact.firstName,
    LASTNAME: contact.last_name || contact.lastName,
    SMS: contact.mobile || contact.mobile_number || contact.mobileNumber,
    PHONE: contact.telephone || contact.phone,
    ADDRESS: [
      contact.address_line1 || contact.addressLine1,
      contact.address_line2 || contact.addressLine2,
      contact.address_line3 || contact.addressLine3,
      contact.address_line4 || contact.addressLine4
    ]
      .filter(Boolean)
      .join(", "),
    CITY: contact.town || contact.city,
    ZIPCODE: contact.postcode || contact.postal_code || contact.postalCode,
    COUNTRY: contact.country,
    DATEOFBIRTH: contact.date_of_birth || contact.dateOfBirth
  };

  // Remove undefined/empty attributes
  Object.keys(attributes).forEach(key => {
    const value = attributes[key];
    if (value === undefined || value === null || value === "") {
      delete attributes[key];
    }
  });

  return { email, attributes };
}

async function fetchAllChurchSuiteContacts(domain, apiKey, filters) {
  const normalizedDomain = normalizeChurchSuiteDomain(domain);
  const contacts = [];
  let page = 1;

  while (true) {
    const url = new URL(`https://${normalizedDomain}/api/v2/addressbook/contacts`);
    url.searchParams.set("page", page);

    if (filters?.tags?.length) {
      url.searchParams.set("tags", filters.tags.join(","));
    }
    if (filters?.sites?.length) {
      url.searchParams.set("site_ids", filters.sites.join(","));
    }

    const response = await fetchWithRetry(url.toString(), {
      headers: { "X-Auth": apiKey }
    });

    const pageResults = response?.results || [];
    contacts.push(...pageResults);

    const totalPages = response?.pagination?.total_pages;
    if (totalPages && page < totalPages) {
      page += 1;
      continue;
    }

    const nextPage = response?.pagination?.next_page || response?.next_page;
    if (nextPage) {
      page += 1;
      continue;
    }

    break;
  }

  return contacts;
}

async function upsertBrevoContact(contact, brevoListId, apiKey) {
  const payload = {
    email: contact.email,
    attributes: contact.attributes,
    updateEnabled: true
  };

  if (Number.isInteger(brevoListId) && brevoListId > 0) {
    payload.listIds = [brevoListId];
  }

  await fetchWithRetry("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      accept: "application/json",
      "api-key": apiKey
    },
    body: JSON.stringify(payload)
  });
}

export default async function handler(req, res) {
  try {
    // Try to load config, but fall back to environment variables
    let config;
    let CHURCHSUITE_DOMAIN;
    let tags = [];
    let sites = [];
    let brevoListId;
    
    try {
      config = await loadConfig();
      CHURCHSUITE_DOMAIN = config.churchsuiteDomain;
      tags = Array.isArray(config.tags) ? config.tags : [];
      sites = Array.isArray(config.sites) ? config.sites : [];
      brevoListId = config.brevoListId;
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

    if (!BREVO_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "BREVO_API_KEY environment variable is not set"
      });
    }

    // Normalize domain to ensure it has .churchsuite.com suffix
    const churchSuiteContacts = await fetchAllChurchSuiteContacts(
      CHURCHSUITE_DOMAIN,
      CHURCHSUITE_API_KEY,
      { tags, sites }
    );

    const mappedContacts = churchSuiteContacts
      .map(mapContactToBrevo)
      .filter(Boolean);

    let upserted = 0;
    const failures = [];

    for (const contact of mappedContacts) {
      try {
        await upsertBrevoContact(contact, brevoListId, BREVO_API_KEY);
        upserted += 1;
      } catch (err) {
        failures.push({ email: contact.email, error: err.message });
      }
    }

    res.status(200).json({ 
      ok: true, 
      fetched: churchSuiteContacts.length,
      upserted,
      failed: failures.length,
      errors: failures.slice(0, 10) // cap response size
    });

  } catch (err) {
    console.error("Handler error:", err);
    res.status(500).json({ 
      ok: false, 
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}
