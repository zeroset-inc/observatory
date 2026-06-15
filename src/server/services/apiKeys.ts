import { db } from "../db"
import { getEnvValue } from "../runtime"

const VALID_KEY_NAMES = [
  "supermemory",
  "mem0",
  "zep",
  "nebula",
  "openai",
  "anthropic",
  "google",
] as const

export type ApiKeyName = (typeof VALID_KEY_NAMES)[number]

export function isValidKeyName(name: string): name is ApiKeyName {
  return VALID_KEY_NAMES.includes(name as ApiKeyName)
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function getEncryptionKey(): Promise<CryptoKey> {
  const secret = getEnvValue("OBSERVATORY_SECRET")
  if (!secret) {
    throw new Error("OBSERVATORY_SECRET must be set to store user API keys")
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"])
}

async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getEncryptionKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    new TextEncoder().encode(plaintext)
  )
  return `${bytesToBase64(iv)}.${bytesToBase64(ciphertext)}`
}

async function decryptSecret(value: string): Promise<string | null> {
  const [iv, ciphertext] = value.split(".")
  if (!iv || !ciphertext) return null
  const key = await getEncryptionKey()
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(iv)) },
    key,
    toArrayBuffer(base64ToBytes(ciphertext))
  )
  return new TextDecoder().decode(plaintext)
}

export async function getUserApiKey(
  userId: string,
  keyName: ApiKeyName
): Promise<string | null> {
  const { data: keyRow } = await db
    .from<{ encrypted_key: string }>("user_api_keys")
    .select("encrypted_key")
    .eq("user_id", userId)
    .eq("key_name", keyName)
    .single()

  if (!keyRow?.encrypted_key) return null
  return decryptSecret(keyRow.encrypted_key)
}

export async function setUserApiKey(
  userId: string,
  keyName: ApiKeyName,
  key: string
): Promise<void> {
  const encrypted = await encryptSecret(key)
  const { error } = await db.from("user_api_keys").upsert(
    {
      user_id: userId,
      key_name: keyName,
      encrypted_key: encrypted,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,key_name" }
  )
  if (error) throw new Error(`Failed to save key reference: ${error.message}`)
}

export async function deleteUserApiKey(userId: string, keyName: ApiKeyName): Promise<void> {
  await db.from("user_api_keys").delete().eq("user_id", userId).eq("key_name", keyName)
}

export async function fetchAllUserKeys(userId: string): Promise<Record<string, string>> {
  const { data: keyRows } = await db
    .from<Array<{ key_name: string; encrypted_key: string }>>("user_api_keys")
    .select("key_name, encrypted_key")
    .eq("user_id", userId)

  const result: Record<string, string> = {}
  for (const row of keyRows || []) {
    const value = await decryptSecret(row.encrypted_key)
    if (value) result[row.key_name] = value
  }
  return result
}

export async function listUserApiKeyNames(userId: string): Promise<string[]> {
  const { data } = await db
    .from<Array<{ key_name: string }>>("user_api_keys")
    .select("key_name")
    .eq("user_id", userId)
  return (data || []).map((row) => row.key_name)
}
