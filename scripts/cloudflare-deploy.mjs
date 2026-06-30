#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const targets = {
  production: {
    wranglerEnv: "",
    databaseName: "observatory",
    databasePlaceholder: "REPLACE_WITH_OBSERVATORY_D1_DATABASE_ID",
    queueName: "observatory-runner",
  },
  staging: {
    wranglerEnv: "staging",
    databaseName: "observatory-staging",
    databasePlaceholder: "REPLACE_WITH_OBSERVATORY_STAGING_D1_DATABASE_ID",
    queueName: "observatory-runner-staging",
  },
}

const targetName = process.argv[2] || process.env.OBSERVATORY_DEPLOY_TARGET || "production"
const target = targets[targetName]

if (!target) {
  fail(`Unknown deploy target '${targetName}'. Expected one of: ${Object.keys(targets).join(", ")}.`)
}

if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  fail("CLOUDFLARE_ACCOUNT_ID is required for Cloudflare Workers Builds.")
}

console.log(`Preparing ${targetName} Cloudflare Worker deployment.`)

const d1List = JSON.parse(
  run("bunx", ["wrangler", "d1", "list", "--json"], { capture: true }).stdout
)
const d1Database = d1List.find((database) => database.name === target.databaseName)
const d1DatabaseId = d1Database?.uuid ?? d1Database?.id

if (!d1DatabaseId) {
  fail(
    `D1 database '${target.databaseName}' was not found. Run the bootstrap workflow or create the Cloudflare resources before deploying.`
  )
}

injectD1DatabaseId(target.databasePlaceholder, d1DatabaseId)
console.log(`Resolved D1 '${target.databaseName}' and injected its database id into wrangler.toml.`)

const queuesList = run("bunx", ["wrangler", "queues", "list"], { capture: true }).stdout
if (!new RegExp(`(^|\\s)${escapeRegExp(target.queueName)}(\\s|$)`, "m").test(queuesList)) {
  fail(
    `Queue '${target.queueName}' was not found. Run the bootstrap workflow or create the Cloudflare resources before deploying.`
  )
}
console.log(`Verified Queue '${target.queueName}'.`)

const envArgs = target.wranglerEnv ? ["--env", target.wranglerEnv] : ["--env", ""]
run("bunx", [
  "wrangler",
  "d1",
  "migrations",
  "apply",
  target.databaseName,
  "--remote",
  ...envArgs,
])

run("bunx", ["wrangler", "deploy", ...envArgs])

function injectD1DatabaseId(placeholder, databaseId) {
  const wranglerPath = new URL("../wrangler.toml", import.meta.url)
  const wranglerConfig = readFileSync(wranglerPath, "utf8")

  if (!wranglerConfig.includes(placeholder)) {
    fail(`Could not find '${placeholder}' in wrangler.toml.`)
  }

  writeFileSync(wranglerPath, wranglerConfig.replaceAll(placeholder, databaseId))
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    env: process.env,
  })

  if (result.error) {
    fail(`${command} ${args.join(" ")} failed: ${result.error.message}`)
  }

  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with status ${result.status}.`)
  }

  return result
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}
