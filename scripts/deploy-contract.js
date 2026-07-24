import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", shell: true, cwd: rootDir, ...opts });
    return true;
  } catch (e) {
    console.error(`❌ Command failed: ${cmd}`);
    return false;
  }
}

async function main() {
  const network = process.argv[2] || "testnet";
  const identity = process.argv[3] || "deployer";

  console.log(`\n🚀 Deploying to ${network} using identity "${identity}"\n`);

  // 1. Ensure identity exists
  console.log("📋 Checking identity...");
  if (!run(`soroban config identity address ${identity}`)) {
    console.log(`\n🔑 Creating identity "${identity}"...`);
    if (!run(`soroban config identity generate ${identity}`)) {
      process.exit(1);
    }
  }

  // 2. Fund via Friendbot (testnet only)
  if (network === "testnet") {
    console.log("\n💰 Funding via Friendbot...");
    const addrCmd = `soroban config identity address ${identity}`;
    const address = execSync(addrCmd, { encoding: "utf-8", shell: true, cwd: rootDir }).trim();
    
    console.log(`   Address: ${address}`);
    const friendbotUrl = `https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`;
    
    if (!run(`curl -sf "${friendbotUrl}"`)) {
      console.error("   Friendbot request failed");
      process.exit(1);
    }
    console.log("   ✅ Friendbot request sent");
  }

  // 3. Verify balance
  console.log("\n🔍 Verifying balance...");
  const address = execSync(`soroban config identity address ${identity}`, { encoding: "utf-8", shell: true, cwd: rootDir }).trim();
  
  let balance = 0;
  if (network === "testnet") {
    const horizonUrl = `https://horizon-testnet.stellar.org/accounts/${address}`;
    const response = execSync(`curl -sf "${horizonUrl}"`, { encoding: "utf-8", shell: true }).trim();
    const data = JSON.parse(response);
    balance = data.balances.find(b => b.asset_type === "native")?.balance || 0;
  } else {
    // For mainnet/futurenet, use stellar CLI
    const output = execSync(`stellar account show ${identity} --network ${network}`, { encoding: "utf-8", shell: true, cwd: rootDir });
    const match = output.match(/XLM\s+([\d.]+)/);
    balance = match ? parseFloat(match[1]) : 0;
  }

  console.log(`   Balance: ${balance} XLM`);
  
  if (balance < 10) {
    console.error(`\n❌ Insufficient balance: ${balance} XLM (need ≥ 10 XLM)`);
    process.exit(1);
  }
  
  console.log(`\n✅ Account funded with ${balance} XLM — ready for deployment`);
}

main();