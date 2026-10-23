import { ApiError, appOrigin, cookie, decrypt, encrypt, ok, parseCookies, randomToken, rateLimit, readJson, sha256Hex, timingSafeEqual } from './lib';
import { requireUser } from './auth';
import type { Ctx, Env } from './types';

const SAML_STATE_COOKIE = 'aq_saml_state';
const SESSION_COOKIE = 'aq_session';
const SESSION_TTL = 30 * 24 * 3600;
const CLOCK_SKEW_MS = 5 * 60 * 1000; // <= 5 minutes clock-skew tolerance

interface SamlConfigRow {
  id: string;
  team_id: string;
  entity_id: string;
  sso_url: string;
  cert_enc: string;
  idp_metadata_enc: string | null;
  role_mapping_json: string | null;
  created_at: number;
  updated_at: number;
}

// Generates SAML 2.0 SP EntityDescriptor metadata XML
export async function samlMetadata(c: Ctx): Promise<Response> {
  const origin = appOrigin(c.env, c.url);
  const entityId = `${origin}/api/auth/saml/metadata`;
  const acsUrl = `${origin}/api/auth/saml/acs`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:transient</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/samlmetadata+xml; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    },
  });
}

// SP-initiated login
export async function samlLogin(c: Ctx): Promise<Response> {
  const teamId = c.url.searchParams.get('team') || 'default';
  const origin = appOrigin(c.env, c.url);
  const spEntityId = `${origin}/api/auth/saml/metadata`;
  const acsUrl = `${origin}/api/auth/saml/acs`;

  const row = await c.env.DB.prepare('SELECT * FROM saml_configs WHERE team_id = ? ORDER BY updated_at DESC LIMIT 1')
    .bind(teamId)
    .first<SamlConfigRow>();

  let ssoUrl = c.env.SAML_IDP_SSO_URL;
  if (row) {
    ssoUrl = row.sso_url;
  }
  if (!ssoUrl) {
    throw new ApiError(501, 'SAML SSO is not configured for this team. Please configure it in Team Settings.', 'saml_not_configured');
  }

  const requestId = '_' + crypto.randomUUID().replace(/-/g, '');
  const issueInstant = new Date().toISOString();
  const relayState = c.url.searchParams.get('relay') || '/dashboard/';

  const authnRequestXml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${requestId}" Version="2.0" IssueInstant="${issueInstant}" Destination="${ssoUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" AssertionConsumerServiceURL="${acsUrl}">
  <saml:Issuer>${spEntityId}</saml:Issuer>
  <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>
</samlp:AuthnRequest>`;

  const stateData = JSON.stringify({ requestId, teamId, relayState, exp: Date.now() + 10 * 60 * 1000 });
  const signedState = await encrypt(c.env, stateData);

  const u = new URL(ssoUrl);
  u.searchParams.set('SAMLRequest', btoa(authnRequestXml));
  u.searchParams.set('RelayState', relayState);

  return new Response(null, {
    status: 302,
    headers: {
      location: u.toString(),
      'set-cookie': cookie(c.url, SAML_STATE_COOKIE, signedState, 600),
      'cache-control': 'no-store',
    },
  });
}

// Extract XML element or attribute helper
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1]!.trim() : null;
}

function extractAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*\\b${attr}=["']([^"']+)["']`, 'i');
  const m = xml.match(re);
  return m ? m[1]! : null;
}

// SAML Assertion Consumer Service (ACS)
export async function samlAcs(c: Ctx): Promise<Response> {
  await rateLimit(c.env, 'saml-acs', 60, 600);
  const formData = await c.req.formData().catch(() => null);
  if (!formData) throw new ApiError(400, 'Invalid SAML ACS form submission');

  const samlResponseBase64 = formData.get('SAMLResponse');
  const relayState = (formData.get('RelayState') as string) || '/dashboard/';

  if (typeof samlResponseBase64 !== 'string' || !samlResponseBase64) {
    throw new ApiError(400, 'Missing SAMLResponse parameter');
  }

  let xml: string;
  try {
    xml = atob(samlResponseBase64);
  } catch {
    throw new ApiError(400, 'Invalid Base64 in SAMLResponse');
  }

  // 1. Verify Status
  const statusCode = extractAttr(xml, 'StatusCode', 'Value') || '';
  if (!statusCode.includes('Success')) {
    throw new ApiError(401, `SAML authentication failed at IdP: ${statusCode.split(':').pop() || 'Unknown'}`);
  }

  // 2. Validate Timestamps with clock-skew tolerance <= 5 min
  const now = Date.now();
  const notBeforeStr = extractAttr(xml, 'Conditions', 'NotBefore') || extractAttr(xml, 'SubjectConfirmationData', 'NotBefore');
  const notOnOrAfterStr = extractAttr(xml, 'Conditions', 'NotOnOrAfter') || extractAttr(xml, 'SubjectConfirmationData', 'NotOnOrAfter');

  if (notBeforeStr) {
    const notBefore = new Date(notBeforeStr).getTime();
    if (!isNaN(notBefore) && now + CLOCK_SKEW_MS < notBefore) {
      throw new ApiError(401, 'SAML assertion is not yet valid (clock skew exceeded 5 minutes)');
    }
  }

  if (notOnOrAfterStr) {
    const notOnOrAfter = new Date(notOnOrAfterStr).getTime();
    if (!isNaN(notOnOrAfter) && now - CLOCK_SKEW_MS > notOnOrAfter) {
      throw new ApiError(401, 'SAML assertion has expired (clock skew exceeded 5 minutes)');
    }
  }

  // 3. Extract Subject NameID & Attributes
  const nameId = extractTag(xml, 'NameID');
  if (!nameId) {
    throw new ApiError(400, 'SAML assertion does not contain a NameID');
  }

  // Extract common attribute statements
  let email = nameId;
  let displayName = '';
  let idpRole = 'member';

  const attrRegex = /<(?:[\w-]+:)?Attribute[^>]*Name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Attribute>/gi;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRegex.exec(xml)) !== null) {
    const attrName = attrMatch[1]!.toLowerCase();
    const valMatch = attrMatch[2]!.match(/<(?:[\w-]+:)?AttributeValue[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?AttributeValue>/i);
    const attrValue = valMatch ? valMatch[1]!.trim() : '';

    if (attrName.includes('email') || attrName.includes('mail') || attrName.endsWith('emailaddress')) {
      email = attrValue || email;
    } else if (attrName.includes('displayname') || attrName.includes('name') || attrName.endsWith('name')) {
      displayName = attrValue;
    } else if (attrName.includes('role') || attrName.includes('group')) {
      idpRole = attrValue;
    }
  }

  const loginHandle = email.includes('@') ? email.split('@')[0]!.replace(/[^a-zA-Z0-9_-]/g, '') : nameId.slice(0, 30);

  // 4. JIT Account Provisioning (Just-In-Time)
  // Check if user already exists via SAML ID or email
  const existing = await c.env.DB.prepare(
    'SELECT * FROM users WHERE saml_id = ? OR login = ?'
  ).bind(nameId, loginHandle).first<any>();

  let userId: string;
  if (existing) {
    userId = existing.id;
    await c.env.DB.prepare(
      'UPDATE users SET saml_id = ?, name = COALESCE(?, name), plan_id = "team" WHERE id = ?'
    ).bind(nameId, displayName || null, userId).run();
  } else {
    userId = crypto.randomUUID();
    await c.env.DB.prepare(
      'INSERT INTO users (id, login, name, saml_id, plan_id, role, created_at) VALUES (?, ?, ?, ?, "team", ?, ?)'
    ).bind(userId, loginHandle, displayName || loginHandle, nameId, idpRole.toLowerCase().includes('admin') ? 'owner' : 'member', Date.now()).run();
  }

  // Ensure subscription record is set to team
  await c.env.DB.prepare(
    `INSERT INTO user_subscriptions (user_id, plan_id, cycle_start, status, builds_used, updated_at)
     VALUES (?, 'team', ?, 'active', 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET plan_id = 'team', updated_at = excluded.updated_at`
  ).bind(userId, Date.now(), Date.now()).run();

  // Create session
  const sessionToken = randomToken(32);
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(sessionToken), userId, Date.now() + SESSION_TTL * 1000)
    .run();

  const redirectUrl = relayState && relayState.startsWith('/') ? relayState : '/dashboard/';
  const headers = new Headers({ location: redirectUrl, 'cache-control': 'no-store' });
  headers.append('set-cookie', cookie(c.url, SESSION_COOKIE, sessionToken, SESSION_TTL));
  headers.append('set-cookie', cookie(c.url, SAML_STATE_COOKIE, '', 0));

  return new Response(null, { status: 302, headers });
}

// Parse IdP XML Metadata into components
export function parseIdpMetadata(xml: string): { entityId: string; ssoUrl: string; cert: string } {
  const entityId = extractAttr(xml, 'EntityDescriptor', 'entityID') || '';
  const ssoUrl = extractAttr(xml, 'SingleSignOnService', 'Location') || '';

  // Extract certificate clean text
  const certRaw = extractTag(xml, 'X509Certificate') || '';
  const cert = certRaw.replace(/\s+/g, '');

  if (!entityId || !ssoUrl) {
    throw new ApiError(400, 'Invalid IdP metadata XML: missing entityID or SingleSignOnService Location');
  }

  return { entityId, ssoUrl, cert };
}

// Get Team SAML Configuration
export async function samlConfigGet(c: Ctx): Promise<Response> {
  const user = await requireUser(c);
  const teamId = c.url.searchParams.get('team') || user.id;

  const row = await c.env.DB.prepare('SELECT * FROM saml_configs WHERE team_id = ? ORDER BY updated_at DESC LIMIT 1')
    .bind(teamId)
    .first<SamlConfigRow>();

  if (!row) {
    return ok({ configured: false, team_id: teamId, metadata_url: `${appOrigin(c.env, c.url)}/api/auth/saml/metadata` });
  }

  let roleMapping = {};
  if (row.role_mapping_json) {
    try { roleMapping = JSON.parse(row.role_mapping_json); } catch {}
  }

  return ok({
    configured: true,
    team_id: row.team_id,
    entity_id: row.entity_id,
    sso_url: row.sso_url,
    metadata_url: `${appOrigin(c.env, c.url)}/api/auth/saml/metadata`,
    role_mapping: roleMapping,
    updated_at: row.updated_at,
  });
}

// Save or Update Team SAML Configuration (Supports XML metadata upload or manual parameters)
export async function samlConfigSave(c: Ctx): Promise<Response> {
  const user = await requireUser(c);
  const b = await readJson<Record<string, any>>(c.req, 256 * 1024);

  const teamId = String(b.team_id || user.id);
  let entityId = '';
  let ssoUrl = '';
  let cert = '';
  let rawXml: string | null = null;

  if (b.xml_metadata && typeof b.xml_metadata === 'string') {
    rawXml = b.xml_metadata.trim();
    const parsed = parseIdpMetadata(rawXml);
    entityId = parsed.entityId;
    ssoUrl = parsed.ssoUrl;
    cert = parsed.cert;
  } else {
    entityId = String(b.entity_id || '').trim();
    ssoUrl = String(b.sso_url || '').trim();
    cert = String(b.cert || '').replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, '');
  }

  if (!entityId) throw new ApiError(400, 'IdP Entity ID is required');
  if (!ssoUrl || !/^https?:\/\//i.test(ssoUrl)) throw new ApiError(400, 'Valid IdP SSO URL is required');
  if (!cert) throw new ApiError(400, 'X.509 Signing Certificate is required');

  const certEnc = await encrypt(c.env, cert);
  const xmlEnc = rawXml ? await encrypt(c.env, rawXml) : null;
  const roleMappingJson = b.role_mapping ? JSON.stringify(b.role_mapping) : null;

  const id = crypto.randomUUID();
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO saml_configs (id, team_id, entity_id, sso_url, cert_enc, idp_metadata_enc, role_mapping_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       entity_id = excluded.entity_id,
       sso_url = excluded.sso_url,
       cert_enc = excluded.cert_enc,
       idp_metadata_enc = excluded.idp_metadata_enc,
       role_mapping_json = excluded.role_mapping_json,
       updated_at = excluded.updated_at`
  ).bind(id, teamId, entityId, ssoUrl, certEnc, xmlEnc, roleMappingJson, now, now).run();

  return ok({
    configured: true,
    team_id: teamId,
    entity_id: entityId,
    sso_url: ssoUrl,
    metadata_url: `${appOrigin(c.env, c.url)}/api/auth/saml/metadata`,
  }, 201);
}
