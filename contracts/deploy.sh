#!/bin/bash
set -e

echo "🚀 Soroban Contract Deployment Script"
echo "====================================="
echo ""

# Configuration
NETWORK="${1:-testnet}"
IDENTITY="${2:-deployer}"
CONTRACT="${3:-soroban-explorer-contract}"
WASM_PATH="../target/wasm32-unknown-unknown/release/${CONTRACT}.wasm"

echo "Network: ${NETWORK}"
echo "Identity: ${IDENTITY}"
echo "Contract: ${CONTRACT}"
echo "WASM: ${WASM_PATH}"
echo ""

# 1. Check WASM exists
if [ ! -f "${WASM_PATH}" ]; then
    echo "❌ WASM not found at ${WASM_PATH}"
    echo "   Run: cargo build --release --target wasm32-unknown-unknown -p ${CONTRACT}"
    exit 1
fi
echo "✅ WASM found"

# 2. Fund deployer on testnet
if [ "${NETWORK}" = "testnet" ]; then
    echo ""
    echo "💰 Funding deployer via Friendbot..."
    ADDR=$(soroban config identity address "${IDENTITY}")
    curl -sf "https://friendbot.stellar.org?addr=${ADDR}" > /dev/null
    echo "   ✅ Friendbot request sent"
    
    # Wait for funding
    sleep 3
fi

# 3. Verify balance
echo ""
echo "🔍 Verifying balance..."
if [ "${NETWORK}" = "testnet" ]; then
    ADDR=$(soroban config identity address "${IDENTITY}")
    BALANCE=$(curl -sf "https://horizon-testnet.stellar.org/accounts/${ADDR}" | jq -r '.balances[] | select(.asset_type=="native") | .balance')
else
    BALANCE=$(stellar account show "${IDENTITY}" --network "${NETWORK}" | grep -E 'XLM\s+' | awk '{print $2}')
fi

echo "   Balance: ${BALANCE} XLM"

BALANCE_NUM=$(echo "${BALANCE}" | awk '{print $1}')
if (( $(echo "${BALANCE_NUM} < 10" | bc -l) )); then
    echo "❌ Insufficient balance: ${BALANCE} XLM (need ≥ 10 XLM)"
    exit 1
fi
echo "   ✅ Sufficient balance"

# 4. Deploy contract
echo ""
echo "📦 Deploying contract..."
DEPLOY_OUTPUT=$(soroban contract deploy \
    --wasm "${WASM_PATH}" \
    --source "${IDENTITY}" \
    --network "${NETWORK}")

CONTRACT_ID=$(echo "${DEPLOY_OUTPUT}" | tail -n1 | awk '{print $NF}')
echo "   Contract ID: ${CONTRACT_ID}"
echo "   ✅ Deployment successful"

# 5. Register contract in explorer registry
echo ""
echo "📋 Registering contract in explorer registry..."
REGISTRY_ID="CDZ7J3QJ5FQJ7K5Y6K5Y6K5Y6K5Y6K5Y6K5Y6K5Y6K5Y6K5Y6K5Y6K5"

soroban contract invoke \
    --id "${REGISTRY_ID}" \
    --source "${IDENTITY}" \
    --network "${NETWORK}" \
    -- \
    register_contract \
    --contract_id "${CONTRACT_ID}" \
    --meta '{"version":1,"abi_version":0,"min_ledger":0,"name":"'${CONTRACT}'","description":"Soroban Explorer Contract","registered_by":"'${IDENTITY}'","functions":[]}'

echo "   ✅ Contract registered"

echo ""
echo "🎉 Deployment complete!"
echo "   Network: ${NETWORK}"
echo "   Contract ID: ${CONTRACT_ID}"
echo "   Explorer: https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}"