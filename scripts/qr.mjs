#!/usr/bin/env node
import qrcode from 'qrcode-terminal'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import process from 'node:process'

const fallbackHostname = 'liambook.capybara-ulmer.ts.net'
const path = process.argv[2] ?? '/scanner.html?world=default'
const hostname = resolveHostname()
const normalizedPath = path.startsWith('/') ? path : `/${path}`
const url = `https://${hostname}:5173${normalizedPath}`

console.log(url)
qrcode.generate(url, { small: true })

function resolveHostname() {
  if (process.env.TAILSCALE_HOSTNAME) return normalize(process.env.TAILSCALE_HOSTNAME)
  try {
    const out = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const status = JSON.parse(out)
    const dnsName = normalize(status?.Self?.DNSName ?? '')
    if (dnsName) return dnsName
  } catch {}
  try {
    const cert = readdirSync(process.cwd()).find((name) => name.endsWith('.ts.net.crt'))
    if (cert) return cert.replace(/\.crt$/, '')
  } catch {}
  return fallbackHostname
}

function normalize(value) {
  return String(value).trim().replace(/\.$/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}
