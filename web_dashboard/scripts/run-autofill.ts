// @ts-nocheck — legacy CLI runner, app uses lib/prisma.ts singleton
import { registerPhase1, registerPhase2, saveAccount, type Phase1Result } from '../lib/services/BankOfAIService';
import { proxyPoolService } from '../lib/services/ProxyPoolService';
import { stickyProxyPool } from '../lib/services/StickyProxyPool';
import { StickyProxyPool } from '../lib/services/StickyProxyPool';
import { PrismaClient } from '../app/generated/prisma/client';

const prisma = new PrismaClient();

const CONCURRENCY = 500;
const BATCH_INTERVAL_MS = 10000;
const MAX_DURATION_MS = 5 * 60 * 1000;

let running = true;
let success = 0;
let failed = 0;
let ipRetired = 0;
let batches = 0;
const claimQueue: Phase1Result[] = [];
const claimPool = new StickyProxyPool();
claimPool.setBatchSize(200);
claimPool.setMaxUsesPerIp(1);

function log(msg: string) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

async function fireLogin(proxy: any) {
  try {
    const result = await registerPhase1(proxy);
    if (result.success && result.wallet && result.cookieHeader) {
      claimQueue.push(result);
    } else {
      failed++;
      ipRetired++;
    }
  } catch {
    failed++;
    ipRetired++;
  }
}

async function fireClaim(item: Phase1Result) {
  let proxy = claimPool.getNext();
  if (!proxy) { claimPool.refresh(); proxy = claimPool.getNext(); }
  if (!proxy) { failed++; return; }
  try {
    const result = await registerPhase2(item.wallet!, item.cookieHeader!, proxy);
    if (result.success) {
      await saveAccount(result);
      success++;
    } else {
      failed++;
    }
  } catch {
    failed++;
  }
}

async function runLoginPipeline() {
  while (running) {
    batches++;
    for (let i = 0; i < CONCURRENCY; i++) {
      if (!running) break;
      const proxy = stickyProxyPool.getNext();
      if (proxy) fireLogin(proxy);
    }
    if (running) await new Promise(r => setTimeout(r, BATCH_INTERVAL_MS));
  }
}

async function runClaimPipeline() {
  while (running) {
    await new Promise(r => setTimeout(r, 1000));
    const batch = claimQueue.splice(0);
    for (const item of batch) {
      if (!running) break;
      fireClaim(item);
    }
  }
}

async function main() {
  log('Starting autofill: ' + CONCURRENCY + ' concurrency, 5 minutes');
  log('Mode: cloudbypass');

  const startAccounts = await prisma.account.count();
  log('Accounts before: ' + startAccounts);

  const loginPromise = runLoginPipeline();
  const claimPromise = runClaimPipeline();

  const statusInterval = setInterval(() => {
    log('Stats: success=' + success + ' failed=' + failed + ' ipRetired=' + ipRetired + ' batches=' + batches + ' queue=' + claimQueue.length);
  }, 10000);

  await new Promise(r => setTimeout(r, MAX_DURATION_MS));
  running = false;

  clearInterval(statusInterval);
  await loginPromise;
  await claimPromise;
  await new Promise(r => setTimeout(r, 5000));

  const endAccounts = await prisma.account.count();
  log('');
  log('=== 5 Minute Report ===');
  log('Accounts before: ' + startAccounts);
  log('Accounts after: ' + endAccounts);
  log('New accounts: ' + (endAccounts - startAccounts));
  log('Success: ' + success);
  log('Failed: ' + failed);
  log('IP Retired: ' + ipRetired);
  log('Batches: ' + batches);
  log('Rate: ' + Math.round(success / 5) + '/min');

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
