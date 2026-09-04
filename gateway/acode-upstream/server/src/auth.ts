import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "./config.js";

type Session = {
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
};

const sessions = new Map<string, Session>();
const sessionsFilePath = path.join(config.gatewayDataDir, "auth-sessions.json");
const loginAttempts = new Map<string, { startedAt: number; failures: number }>();
const loginWindowMs = 60_000;
const maxLoginFailures = 8;
const maxAuthSessions = 10_000;

function loadSessions() {
  try {
    mkdirSync(path.dirname(sessionsFilePath), { recursive: true });
    const parsed = JSON.parse(readFileSync(sessionsFilePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const value = item as Partial<Session>;
      if (typeof value.tokenHash !== "string" || typeof value.createdAt !== "number" || typeof value.expiresAt !== "number") continue;
      if (value.expiresAt > now) sessions.set(value.tokenHash, {
        tokenHash: value.tokenHash,
        createdAt: value.createdAt,
        expiresAt: value.expiresAt
      });
    }
    pruneSessions(now);
  } catch {
    // A missing or corrupt cache should not prevent the Gateway from starting.
  }
}

function persistSessions() {
  try {
    mkdirSync(path.dirname(sessionsFilePath), { recursive: true });
    const temporaryPath = `${sessionsFilePath}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, JSON.stringify(Array.from(sessions.values())), { encoding: "utf8", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    try {
      renameSync(temporaryPath, sessionsFilePath);
    } catch {
      writeFileSync(sessionsFilePath, JSON.stringify(Array.from(sessions.values())), { encoding: "utf8", mode: 0o600 });
      chmodSync(sessionsFilePath, 0o600);
      unlinkSync(temporaryPath);
    }
  } catch {
    // Authentication remains available in memory if the optional cache cannot be written.
  }
}

loadSessions();

export function allowLoginAttempt(ip: string) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (!attempt || now - attempt.startedAt >= loginWindowMs) {
    loginAttempts.set(ip, { startedAt: now, failures: 0 });
    return true;
  }
  return attempt.failures < maxLoginFailures;
}

export function recordLoginFailure(ip: string) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (!attempt || now - attempt.startedAt >= loginWindowMs) {
    loginAttempts.set(ip, { startedAt: now, failures: 1 });
  } else {
    attempt.failures += 1;
  }
  if (loginAttempts.size > 10_000) {
    for (const [key, value] of loginAttempts) {
      if (now - value.startedAt >= loginWindowMs) loginAttempts.delete(key);
      if (loginAttempts.size <= 5_000) break;
    }
  }
}

export function clearLoginFailures(ip: string) {
  loginAttempts.delete(ip);
}

function hmac(value: string) {
  return crypto.createHmac("sha256", config.sessionSecret).update(value).digest("hex");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function verifyAdminToken(token: string) {
  return safeEqual(hmac(token), hmac(config.adminToken));
}

export function createSession() {
  pruneSessions(Date.now());
  if (sessions.size >= maxAuthSessions) {
    const oldest = sessions.keys().next().value;
    if (typeof oldest === "string") sessions.delete(oldest);
  }
  const token = nanoid(48);
  const tokenHash = hmac(token);
  const now = Date.now();
  sessions.set(tokenHash, {
    tokenHash,
    createdAt: now,
    expiresAt: now + config.sessionTtlHours * 60 * 60 * 1000
  });
  persistSessions();
  return {
    token,
    expiresAt: new Date(sessions.get(tokenHash)!.expiresAt).toISOString()
  };
}

export function verifySession(token: string | undefined) {
  if (!token) return false;
  if (token === config.gatewayAuthToken) return true;
  const tokenHash = hmac(token);
  const session = sessions.get(tokenHash);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    sessions.delete(tokenHash);
    persistSessions();
    return false;
  }
  return true;
}

function pruneSessions(now: number) {
  for (const [hash, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(hash);
  }
  while (sessions.size > maxAuthSessions) {
    const oldest = sessions.keys().next().value;
    if (typeof oldest !== "string") break;
    sessions.delete(oldest);
  }
}

export function revokeSession(token: string | undefined) {
  if (!token) return false;
  const deleted = sessions.delete(hmac(token));
  if (deleted) persistSessions();
  return deleted;
}

export function getBearerToken(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return undefined;
  return token;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!verifySession(getRequestToken(request))) {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

export function getRequestToken(request: FastifyRequest) {
  const queryToken = (request.query as { token?: unknown } | undefined)?.token;
  const allowQueryToken = process.env.NODE_ENV !== "production" || process.env.CODEHARBOR_ALLOW_QUERY_TOKEN === "true";
  return getBearerToken(request) ?? (allowQueryToken && typeof queryToken === "string" ? queryToken : undefined);
}

export function getWebSocketProtocolToken(header: string | string[] | undefined) {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  for (const value of values) {
    for (const rawProtocol of value.split(",")) {
      const protocol = rawProtocol.trim();
      if (protocol.startsWith("codeharbor-v1.")) {
        const token = protocol.slice("codeharbor-v1.".length).trim();
        if (token) return token;
      }
    }
  }
  return undefined;
}

export function validateGatewayLogin(username: string, password: string) {
  return safeEqual(username, config.gatewayAuthUsername) && safeEqual(password, config.gatewayAuthPassword);
}
