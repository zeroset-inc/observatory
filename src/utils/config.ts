import { getEnvValue } from "../server/runtime"

export interface Config {
  supermemoryApiKey: string
  supermemoryBaseUrl: string
  mem0ApiKey: string
  zepApiKey: string
  openaiApiKey: string
  anthropicApiKey: string
  googleApiKey: string
  nebulaApiKey: string
  nebulaBaseUrl: string
}

const nebulaBaseUrl = getEnvValue("NEBULA_BASE_URL") || "https://api.trynebula.ai"

export const config: Config = {
  supermemoryApiKey: getEnvValue("SUPERMEMORY_API_KEY") || "",
  supermemoryBaseUrl: getEnvValue("SUPERMEMORY_BASE_URL") || "https://api.supermemory.ai",
  mem0ApiKey: getEnvValue("MEM0_API_KEY") || "",
  zepApiKey: getEnvValue("ZEP_API_KEY") || "",
  openaiApiKey: getEnvValue("OPENAI_API_KEY") || "",
  anthropicApiKey: getEnvValue("ANTHROPIC_API_KEY") || "",
  googleApiKey: getEnvValue("GOOGLE_API_KEY") || "",
  nebulaApiKey: getEnvValue("NEBULA_API_KEY") || "",
  nebulaBaseUrl,
}

/**
 * Get provider config. If userKeys is provided, use those keys first,
 * falling back to env vars. userKeys is a map of key_name -> plaintext value.
 */
export function getProviderConfig(
  provider: string,
  userKeys?: Record<string, string>
): { apiKey: string; baseUrl?: string } {
  switch (provider) {
    case "supermemory":
      return {
        apiKey: userKeys?.supermemory || config.supermemoryApiKey,
        baseUrl: config.supermemoryBaseUrl,
      }
    case "mem0":
      return { apiKey: userKeys?.mem0 || config.mem0ApiKey }
    case "zep":
      return { apiKey: userKeys?.zep || config.zepApiKey }
    case "nebula":
      return {
        apiKey: userKeys?.nebula || config.nebulaApiKey,
        baseUrl: config.nebulaBaseUrl,
      }
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }
}

/**
 * Get judge config. If userKeys is provided, use those keys first,
 * falling back to env vars.
 */
export function getJudgeConfig(
  judge: string,
  userKeys?: Record<string, string>
): { apiKey: string; model?: string } {
  switch (judge) {
    case "openai":
      return { apiKey: userKeys?.openai || config.openaiApiKey }
    case "anthropic":
      return { apiKey: userKeys?.anthropic || config.anthropicApiKey }
    case "google":
      return { apiKey: userKeys?.google || config.googleApiKey }
    default:
      throw new Error(`Unknown judge: ${judge}`)
  }
}
